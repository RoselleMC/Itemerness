package com.iroselle.itemerness.nms.v26_1_2

import com.iroselle.itemerness.api.ItemKey
import com.iroselle.itemerness.projection.MinecraftVersion
import com.iroselle.itemerness.projection.ProjectionAdapter
import com.iroselle.itemerness.projection.ProjectionAdapterDescriptor
import com.iroselle.itemerness.projection.ProjectionAdapterFactory
import com.iroselle.itemerness.projection.ProjectionRuntime
import io.netty.channel.Channel
import io.netty.channel.ChannelDuplexHandler
import io.netty.channel.ChannelHandlerContext
import io.netty.channel.ChannelPromise
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicReference
import net.kyori.adventure.key.Key
import net.minecraft.network.Connection
import net.minecraft.network.HandlerNames
import net.minecraft.network.protocol.game.ClientboundContainerSetSlotPacket
import net.minecraft.server.MinecraftServer
import net.minecraft.server.network.ServerGamePacketListenerImpl

class NmsProjectionAdapterFactory : ProjectionAdapterFactory {
    override val descriptor: ProjectionAdapterDescriptor = DESCRIPTOR

    override fun create(runtime: ProjectionRuntime): ProjectionAdapter =
        NmsProjectionAdapter(descriptor, NmsContainerSlotProjector(NmsItemStackProjector(runtime)))

    private companion object {
        val DESCRIPTOR = ProjectionAdapterDescriptor(
            id = ItemKey.parse("itemerness:nms-26_1_2"),
            minecraftVersion = MinecraftVersion(NmsAbiProbe.MINECRAFT_VERSION),
        )
    }
}

private class NmsProjectionAdapter(
    override val descriptor: ProjectionAdapterDescriptor,
    private val slotProjector: NmsContainerSlotProjector,
) : ProjectionAdapter {
    private val state = AtomicReference(LifecycleState.NEW)
    private val lifecycleLock = Any()
    private val channels = ConcurrentHashMap.newKeySet<Channel>()
    private val listener = io.papermc.paper.network.ChannelInitializeListener(::install)

    override fun start() {
        synchronized(lifecycleLock) {
            check(state.compareAndSet(LifecycleState.NEW, LifecycleState.STARTING)) {
                "The projection adapter can only be started once"
            }
            var listenerAdded = false
            try {
                NmsAbiProbe.verify()
                check(!io.papermc.paper.network.ChannelInitializeListenerHolder.hasListener(LISTENER_KEY)) {
                    "A channel initializer is already registered for $LISTENER_KEY"
                }

                // Publish STARTED before registration. A channel may be initialized immediately
                // after addListener returns, and its event-loop callback must not observe STARTING.
                state.set(LifecycleState.STARTED)
                io.papermc.paper.network.ChannelInitializeListenerHolder.addListener(LISTENER_KEY, listener)
                listenerAdded = true
                snapshotConnections().forEach(::install)
            } catch (failure: Throwable) {
                state.set(LifecycleState.CLOSED)
                if (listenerAdded) {
                    io.papermc.paper.network.ChannelInitializeListenerHolder.removeListener(LISTENER_KEY)
                }
                channels.toList().forEach(::remove)
                channels.clear()
                throw failure
            }
        }
    }

    override fun close() {
        synchronized(lifecycleLock) {
            val previous = state.getAndSet(LifecycleState.CLOSED)
            if (previous == LifecycleState.CLOSED) {
                return
            }
            if (previous == LifecycleState.STARTED) {
                io.papermc.paper.network.ChannelInitializeListenerHolder.removeListener(LISTENER_KEY)
            }
            channels.toList().forEach(::remove)
            channels.clear()
        }
    }

    private fun install(channel: Channel) {
        runOnEventLoop(channel) {
            synchronized(lifecycleLock) {
                if (state.get() != LifecycleState.STARTED) {
                    return@synchronized
                }
                val pipeline = channel.pipeline()
                if (pipeline.get(HANDLER_NAME) != null) {
                    return@synchronized
                }
                val connection = pipeline.get(HandlerNames.PACKET_HANDLER)
                check(connection is Connection) {
                    "${HandlerNames.PACKET_HANDLER} is not a Minecraft Connection"
                }
                pipeline.addBefore(
                    HandlerNames.PACKET_HANDLER,
                    HANDLER_NAME,
                    ProjectionChannelHandler(
                        connection,
                        slotProjector,
                        { state.get() == LifecycleState.STARTED },
                    ) {
                        channels.remove(channel)
                    },
                )
                channels.add(channel)
            }
        }
    }

    private fun remove(channel: Channel) {
        runOnEventLoop(channel) {
            channel.pipeline().get(HANDLER_NAME)?.let { channel.pipeline().remove(HANDLER_NAME) }
            channels.remove(channel)
        }
    }

    private fun snapshotConnections(): List<Channel> {
        val connections = MinecraftServer.getServer().connection.connections
        return synchronized(connections) {
            connections.map { connection -> connection.channel }.toList()
        }
    }

    private fun runOnEventLoop(channel: Channel, operation: () -> Unit) {
        if (channel.eventLoop().inEventLoop()) {
            operation()
        } else {
            channel.eventLoop().execute(operation)
        }
    }

    private enum class LifecycleState {
        NEW,
        STARTING,
        STARTED,
        CLOSED,
    }

    private companion object {
        val LISTENER_KEY: Key = Key.key("itemerness", "projection")
        const val HANDLER_NAME = "itemerness_projection"
    }
}

private class ProjectionChannelHandler(
    private val connection: Connection,
    private val slotProjector: NmsContainerSlotProjector,
    private val isActive: () -> Boolean,
    private val removed: () -> Unit,
) : ChannelDuplexHandler() {
    override fun write(
        context: ChannelHandlerContext,
        message: Any,
        promise: ChannelPromise,
    ) {
        // The hook remains passive until every required carrier and inbound path passes the
        // release gate. The compiled branch keeps this first vertical slice connected to the
        // exact channel ABI without exposing partial projection in production.
        val outgoing = try {
            if (
                isActive() &&
                PROJECTION_RELEASE_GATE_ENABLED &&
                message is ClientboundContainerSetSlotPacket
            ) {
                val viewerId = (connection.packetListener as? ServerGamePacketListenerImpl)?.player?.uuid
                if (viewerId == null) message else slotProjector.project(message, viewerId)
            } else {
                message
            }
        } catch (_: Exception) {
            message
        }
        context.write(outgoing, promise)
    }

    override fun handlerRemoved(context: ChannelHandlerContext) {
        removed()
        super.handlerRemoved(context)
    }

    override fun channelInactive(context: ChannelHandlerContext) {
        removed()
        super.channelInactive(context)
    }

    private companion object {
        const val PROJECTION_RELEASE_GATE_ENABLED = false
    }
}
