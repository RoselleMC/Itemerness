package com.iroselle.itemerness.nms.v26_1_1

import com.iroselle.itemerness.api.ItemKey
import com.iroselle.itemerness.projection.MinecraftVersion
import com.iroselle.itemerness.projection.ProjectionAdapter
import com.iroselle.itemerness.projection.ProjectionAdapterDescriptor
import com.iroselle.itemerness.projection.ProjectionAdapterFactory
import com.iroselle.itemerness.projection.ProjectionFailure
import com.iroselle.itemerness.projection.ProjectionFailureSink
import com.iroselle.itemerness.projection.ProjectionRefreshAdapter
import com.iroselle.itemerness.projection.ProjectionResyncSink
import com.iroselle.itemerness.projection.ProjectionRuntime
import com.iroselle.itemerness.projection.ProjectionViewerBindingAdapter
import com.mojang.logging.LogUtils
import io.netty.channel.Channel
import io.netty.channel.ChannelDuplexHandler
import io.netty.channel.ChannelHandlerContext
import io.netty.channel.ChannelPromise
import io.netty.channel.ChannelPipeline
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference
import net.kyori.adventure.key.Key
import net.minecraft.core.RegistryAccess
import net.minecraft.network.Connection
import net.minecraft.network.ConnectionProtocol
import net.minecraft.network.HandlerNames
import net.minecraft.network.protocol.Packet
import net.minecraft.network.protocol.game.ClientboundSetCursorItemPacket
import net.minecraft.network.protocol.game.ClientboundMerchantOffersPacket
import net.minecraft.network.protocol.game.ClientboundUpdateRecipesPacket
import net.minecraft.network.protocol.game.ServerboundContainerClosePacket
import net.minecraft.server.MinecraftServer
import net.minecraft.server.level.ServerPlayer
import net.minecraft.server.network.ServerGamePacketListenerImpl
import net.minecraft.world.inventory.AbstractContainerMenu
import net.minecraft.world.inventory.MerchantMenu
import org.slf4j.Logger
import java.nio.channels.ClosedChannelException
import org.bukkit.craftbukkit.entity.CraftPlayer

class NmsProjectionAdapterFactory : ProjectionAdapterFactory {
    override val descriptor: ProjectionAdapterDescriptor = DESCRIPTOR

    override fun create(runtime: ProjectionRuntime): ProjectionAdapter {
        NmsProjectionReleaseGate.requireReady()
        return NmsProjectionAdapter(
            descriptor,
            NmsOutboundPacketProjector(
                NmsItemStackProjector(runtime),
                registryAccessSource = { MinecraftServer.getServer().registryAccess() },
            ),
            runtime.resyncRequests,
            runtime.failures,
        )
    }

    private companion object {
        val DESCRIPTOR = ProjectionAdapterDescriptor(
            id = ItemKey.parse("itemerness:nms-26_1_1"),
            minecraftVersion = MinecraftVersion(NmsAbiProbe.MINECRAFT_VERSION),
        )
    }
}

internal class NmsProjectionAdapter(
    override val descriptor: ProjectionAdapterDescriptor,
    private val packetProjector: NmsOutboundPacketProjector,
    private val resyncRequests: ProjectionResyncSink,
    failureSink: ProjectionFailureSink,
) : ProjectionAdapter, ProjectionRefreshAdapter, ProjectionViewerBindingAdapter {
    private val state = AtomicReference(LifecycleState.NEW)
    private val terminal = NmsProjectionTerminal(failureSink)
    private val owner = NmsProjectionHandlerOwner { state.get() == LifecycleState.STARTED }
    private val lifecycleLock = Any()
    private val channels = ConcurrentHashMap.newKeySet<Channel>()
    private val viewers = ConcurrentHashMap<UUID, NmsViewerBinding>()
    private val nextConnectionGeneration = AtomicLong()
    private lateinit var componentHasher: NmsComponentHashGenerator
    private lateinit var registryAccess: RegistryAccess
    private val listener = io.papermc.paper.network.ChannelInitializeListener(::installAndObserve)

    override fun start() {
        synchronized(lifecycleLock) {
            NmsProjectionReleaseGate.requireReady()
            check(state.compareAndSet(LifecycleState.NEW, LifecycleState.STARTING)) {
                "The projection adapter can only be started once"
            }
            var listenerAdded = false
            try {
                NmsAbiProbe.verify()
                registryAccess = MinecraftServer.getServer().registryAccess()
                componentHasher = NmsComponentHashGenerator.create(registryAccess)
                check(!io.papermc.paper.network.ChannelInitializeListenerHolder.hasListener(LISTENER_KEY)) {
                    "A channel initializer is already registered for $LISTENER_KEY"
                }

                // A dynamically enabled adapter cannot retroactively protect already-active PLAY
                // channels. Close that finite snapshot before publishing the initializer so no
                // persisted canonical stack can cross an unguarded existing connection.
                closeChannelsAndAwait(snapshotConnections(), CLOSE_TIMEOUT_SECONDS)

                // Publish STARTED before registration. A channel may be initialized immediately
                // after addListener returns, and its event-loop callback must not observe STARTING.
                state.set(LifecycleState.STARTED)
                owner.activate()
                io.papermc.paper.network.ChannelInitializeListenerHolder.addListener(LISTENER_KEY, listener)
                listenerAdded = true
                snapshotConnections().filter(Channel::isOpen).map(::install).forEach { install ->
                    install.get(INSTALL_TIMEOUT_SECONDS, TimeUnit.SECONDS)
                }
            } catch (failure: Throwable) {
                state.set(LifecycleState.CLOSING)
                owner.beginRetirement()
                if (listenerAdded) {
                    io.papermc.paper.network.ChannelInitializeListenerHolder.removeListener(LISTENER_KEY)
                }
                try {
                    closeChannelsAndAwait(snapshotConnections(), CLOSE_TIMEOUT_SECONDS)
                    removeAllOwnedHandlers()
                    owner.completeRetirement()
                } catch (cleanupFailure: Throwable) {
                    owner.failRetirement()
                    failure.addSuppressed(cleanupFailure)
                }
                state.set(LifecycleState.CLOSED)
                viewers.clear()
                throw failure
            }
        }
    }

    override fun close() {
        synchronized(lifecycleLock) {
            val previous = state.get()
            if (previous == LifecycleState.CLOSED) {
                return
            }
            state.set(LifecycleState.CLOSING)
            owner.beginRetirement()
            if (previous == LifecycleState.STARTED) {
                io.papermc.paper.network.ChannelInitializeListenerHolder.removeListener(LISTENER_KEY)
            }
            try {
                closeChannelsAndAwait(channels.toList(), CLOSE_TIMEOUT_SECONDS)
                removeAllOwnedHandlers()
                owner.completeRetirement()
                viewers.clear()
                state.set(LifecycleState.CLOSED)
            } catch (failure: Throwable) {
                owner.failRetirement()
                state.set(LifecycleState.CLOSED)
                throw failure
            }
        }
    }

    override fun refreshViewer(viewerId: UUID, owningPlayer: Any) {
        if (state.get() != LifecycleState.STARTED) return
        val player = (owningPlayer as? CraftPlayer)?.handle
            ?: throw IllegalArgumentException("Projection refresh requires a CraftPlayer")
        check(player.uuid == viewerId) { "Projection refresh received the wrong player" }
        val channel = player.connection.connection.channel
        val binding = viewers[viewerId]?.takeIf { candidate ->
            candidate.player === player && candidate.channel === channel
        } ?: return
        val handler = binding.handler.get()?.takeIf { candidate ->
            candidate.channel() === channel && candidate.isBoundTo(binding)
        } ?: return
        runProjectionRefreshBoundary(
            viewerId = viewerId,
            refresh = { handler.refreshViewer(binding, player) },
            failure = ::failAsync,
        )
    }

    override fun bindViewer(viewerId: UUID, owningPlayer: Any) {
        if (state.get() != LifecycleState.STARTED) return
        // The caller supplies the already-owned platform player. Do not rediscover mutable player
        // state through the global player list from an entity or channel context.
        val player = (owningPlayer as? CraftPlayer)?.handle
            ?: throw IllegalArgumentException("Projection binding requires a CraftPlayer")
        check(player.uuid == viewerId) { "Resolved the wrong player for projection binding" }
        val channel = player.connection.connection.channel
        val binding = NmsViewerBinding(viewerId, player, channel)
        // Publish the exact player/channel fence before any asynchronous event-loop work. A new
        // connection with the same UUID immediately makes the old mapping ineligible for refresh.
        viewers[viewerId] = binding
        runOnEventLoop(channel) {
            if (state.get() != LifecycleState.STARTED) return@runOnEventLoop
            if (viewers[viewerId] !== binding) return@runOnEventLoop
            val handler = channel.pipeline().get(HANDLER_NAME) as? ProjectionChannelHandler
                ?: error("Projection handler is not installed for $viewerId")
            check(handler.isOwnedBy(owner)) {
                "Projection handler for $viewerId belongs to a different adapter"
            }
            handler.bindViewer(binding)
        }.whenComplete { _, failure ->
            if (failure != null) {
                viewers.remove(viewerId, binding)
                failAsync("bind viewer $viewerId", failure)
            }
        }
    }

    override fun unbindViewer(viewerId: UUID) {
        val binding = viewers.remove(viewerId) ?: return
        val handler = binding.handler.get() ?: return
        runOnEventLoop(binding.channel) {
            handler.unbindViewer(binding)
        }.whenComplete { _, failure ->
            if (failure != null) failAsync("unbind viewer $viewerId", failure)
        }
    }

    private fun installAndObserve(channel: Channel) {
        install(channel).whenComplete { _, failure ->
            if (failure != null) {
                // This connection has no proven fail-closed handler. Closing it is the only safe
                // response while the owning plugin is being retired globally.
                channel.close()
                failAsync("install a channel handler", failure)
            }
        }
    }

    private fun install(channel: Channel): CompletableFuture<Void> = runOnEventLoop(channel) {
        if (state.get() != LifecycleState.STARTED) {
            return@runOnEventLoop
        }
        val pipeline = channel.pipeline()
        if (NmsProjectionHandlerSlot.prepare(pipeline, HANDLER_NAME, owner)) {
            channels.add(channel)
            return@runOnEventLoop
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
                packetProjector,
                NmsConnectionProjectionState(
                    connectionGeneration = nextConnectionGeneration.getAndIncrement(),
                    hasher = componentHasher,
                    registryAccess = registryAccess,
                ),
                resyncRequests,
                owner,
                terminal,
                { binding, handler ->
                    binding?.handler?.set(handler)
                },
                { binding, handler ->
                    binding?.handler?.compareAndSet(handler, null)
                    if (binding != null) viewers.remove(binding.viewerId, binding)
                },
                { binding, handler ->
                    binding?.handler?.compareAndSet(handler, null)
                    if (binding != null) viewers.remove(binding.viewerId, binding)
                    channels.remove(channel)
                },
                ::failAsync,
            ),
        )
        channels.add(channel)
        if (state.get() != LifecycleState.STARTED) {
            pipeline.remove(HANDLER_NAME)
            channels.remove(channel)
        }
    }

    private fun failAsync(operation: String, failure: Throwable) {
        val terminalFailure = terminal.poison(operation, failure) ?: return
        LOGGER.error("Itemerness failed to {}; requesting terminal plugin shutdown", operation, failure)
        channels.toList().forEach { channel ->
            runOnEventLoop(channel) {
                (channel.pipeline().get(HANDLER_NAME) as? ProjectionChannelHandler)
                    ?.takeIf { it.isOwnedBy(owner) }
                    ?.onTerminalFailure(terminalFailure)
            }.whenComplete { _, notificationFailure ->
                if (notificationFailure != null) {
                    LOGGER.warn("Failed to notify an Itemerness channel of terminal failure", notificationFailure)
                    channel.close()
                }
            }
        }
    }

    private fun removeAllOwnedHandlers() {
        val snapshot = channels.toList()
        val removals = snapshot.map { channel ->
            runOnEventLoop(channel) {
                NmsProjectionHandlerSlot.removeOwned(channel.pipeline(), HANDLER_NAME, owner)
                channels.remove(channel)
            }
        }
        removals.forEach { removal -> removal.get(REMOVE_TIMEOUT_SECONDS, TimeUnit.SECONDS) }
        // Every pipeline check above ran on its channel event loop and completed before this point.
        check(channels.isEmpty()) { "Projection adapter still tracks channels after handler removal" }
        channels.clear()
    }

    private fun snapshotConnections(): List<Channel> {
        val connections = MinecraftServer.getServer().connection.connections
        return synchronized(connections) {
            connections.map { connection -> connection.channel }.toList()
        }
    }

    private fun runOnEventLoop(channel: Channel, operation: () -> Unit): CompletableFuture<Void> {
        val result = CompletableFuture<Void>()
        val guarded = Runnable {
            try {
                operation()
                result.complete(null)
            } catch (failure: Throwable) {
                result.completeExceptionally(failure)
            }
        }
        try {
            if (channel.eventLoop().inEventLoop()) {
                guarded.run()
            } else {
                channel.eventLoop().execute(guarded)
            }
        } catch (failure: Throwable) {
            result.completeExceptionally(failure)
        }
        return result
    }

    private enum class LifecycleState {
        NEW,
        STARTING,
        STARTED,
        CLOSING,
        CLOSED,
    }

    private companion object {
        val LOGGER: Logger = LogUtils.getLogger()
        val LISTENER_KEY: Key = Key.key("itemerness", "projection")
        const val HANDLER_NAME = "itemerness_projection"
        const val INSTALL_TIMEOUT_SECONDS = 5L
        const val REMOVE_TIMEOUT_SECONDS = 5L
        const val CLOSE_TIMEOUT_SECONDS = 5L
    }
}

internal class NmsViewerBinding(
    val viewerId: UUID,
    val player: ServerPlayer,
    val channel: Channel,
) {
    val handler = AtomicReference<ProjectionChannelHandler?>()
}

/** Closes a finite channel snapshot and observes every close before handler retirement. */
internal fun closeChannelsAndAwait(
    channels: Collection<Channel>,
    timeoutSeconds: Long,
) {
    require(timeoutSeconds > 0) { "Channel close timeout must be positive" }
    val closes = channels.distinct().map { channel ->
        CompletableFuture<Void>().also { completion ->
            try {
                channel.close().addListener { future ->
                    if (future.isSuccess) {
                        completion.complete(null)
                    } else {
                        completion.completeExceptionally(
                            future.cause() ?: IllegalStateException("Channel close failed without a cause"),
                        )
                    }
                }
            } catch (failure: Throwable) {
                completion.completeExceptionally(failure)
            }
        }
    }
    if (closes.isNotEmpty()) {
        CompletableFuture.allOf(*closes.toTypedArray()).get(timeoutSeconds, TimeUnit.SECONDS)
    }
    check(channels.none(Channel::isActive)) { "An active channel remained after projection retirement close" }
}

internal object NmsProjectionHandlerSlot {
    /** Returns true only when the already-installed handler belongs to the same live owner. */
    fun prepare(
        pipeline: ChannelPipeline,
        handlerName: String,
        owner: NmsProjectionHandlerOwner,
    ): Boolean {
        val existing = pipeline.get(handlerName) ?: return false
        check(existing is ProjectionChannelHandler) {
            "Channel handler name $handlerName is occupied by ${existing.javaClass.name}"
        }
        if (existing.isOwnedBy(owner)) return true
        check(existing.ownerIsRetired()) {
            "Channel handler name $handlerName belongs to an active or failed adapter"
        }
        check(!pipeline.channel().isActive) {
            "Cannot replace a retired projection handler on an active channel"
        }
        pipeline.remove(existing)
        check(pipeline.get(handlerName) == null) { "Retired projection handler could not be removed" }
        return false
    }

    /** Must be invoked on the channel event loop. */
    fun removeOwned(
        pipeline: ChannelPipeline,
        handlerName: String,
        owner: NmsProjectionHandlerOwner,
    ) {
        val handler = pipeline.get(handlerName)
        if (handler is ProjectionChannelHandler && handler.isOwnedBy(owner)) {
            check(!pipeline.channel().isActive) {
                "Cannot remove a projection handler from an active channel"
            }
            pipeline.remove(handler)
        }
        check(
            (pipeline.get(handlerName) as? ProjectionChannelHandler)?.isOwnedBy(owner) != true,
        ) { "Owned projection handler remained installed after removal" }
    }
}

internal class NmsProjectionTerminal(
    private val sink: ProjectionFailureSink = ProjectionFailureSink.REJECTING,
) {
    private val failure = AtomicReference<ProjectionFailure?>()

    /** Returns the newly published failure, or null when this runtime was already poisoned. */
    fun poison(operation: String, cause: Throwable): ProjectionFailure? {
        val published = ProjectionFailure(operation, cause)
        if (!failure.compareAndSet(null, published)) return null
        try {
            sink.offer(published)
        } catch (sinkFailure: Throwable) {
            cause.addSuppressed(sinkFailure)
        }
        return published
    }

    fun failure(): ProjectionFailure? = failure.get()
}

internal class NmsProjectionHandlerOwner(
    private val lifecycleActive: () -> Boolean = { true },
) {
    private val state = AtomicReference(State.NEW)

    fun activate() {
        check(state.compareAndSet(State.NEW, State.ACTIVE)) { "Projection handler owner cannot be activated" }
    }

    fun isActive(): Boolean = state.get() == State.ACTIVE && lifecycleActive()

    fun beginRetirement() {
        state.updateAndGet { current ->
            when (current) {
                State.NEW, State.ACTIVE -> State.RETIRING
                else -> current
            }
        }
    }

    fun completeRetirement() {
        check(state.compareAndSet(State.RETIRING, State.RETIRED)) {
            "Projection handler owner did not enter retirement"
        }
    }

    fun failRetirement() {
        state.set(State.FAILED)
    }

    fun isRetired(): Boolean = state.get() == State.RETIRED

    private enum class State { NEW, ACTIVE, RETIRING, RETIRED, FAILED }
}

internal class ProjectionChannelHandler(
    private val connection: Connection,
    private val packetProjector: NmsOutboundPacketProjector,
    private val projectionState: NmsConnectionProjectionState,
    private val resyncRequests: ProjectionResyncSink,
    private val owner: NmsProjectionHandlerOwner,
    private val terminal: NmsProjectionTerminal,
    private val viewerResolved: (NmsViewerBinding?, ProjectionChannelHandler) -> Unit,
    private val viewerUnbound: (NmsViewerBinding?, ProjectionChannelHandler) -> Unit,
    private val removed: (NmsViewerBinding?, ProjectionChannelHandler) -> Unit,
    private val terminalFailure: (String, Throwable) -> Unit,
    private val projectionEnabled: () -> Boolean = { NmsProjectionReleaseGate.ENABLED },
) : ChannelDuplexHandler() {
    private val inboundProjector = NmsInboundPacketProjector(projectionState, resyncRequests)
    private val viewerId = AtomicReference<UUID?>()
    private val viewerBinding = AtomicReference<NmsViewerBinding?>()
    private val hasEverBound = AtomicBoolean()
    private val diagnosticBudget = AtomicInteger(MAX_DIAGNOSTICS)
    private val persistentRefreshGeneration = AtomicLong()
    private var persistentRefreshSession: PersistentRefreshSession? = null
    private val pendingLoginWrites = ArrayDeque<PendingWrite>()
    private var pendingLoginTimeout: ScheduledFuture<*>? = null
    private var handlerContext: ChannelHandlerContext? = null
    private var connectionCleaned = false
    private var removalPublished = false

    override fun handlerAdded(context: ChannelHandlerContext) {
        handlerContext = context
        super.handlerAdded(context)
    }

    override fun write(
        context: ChannelHandlerContext,
        message: Any,
        promise: ChannelPromise,
    ) {
        if (message is Packet<*> && !projectionOperational()) {
            if (packetProjector.isProjectionCarrier(message)) {
                promise.tryFailure(projectionUnavailable())
                return
            }
            context.write(message, promise)
            return
        }
        if (
            message is Packet<*> &&
            viewerId.get() == null &&
            !hasEverBound.get() &&
            connection.packetListener?.protocol() == ConnectionProtocol.PLAY
        ) {
            enqueueLoginWrite(context, message, promise)
            return
        }
        val outgoing = try {
            if (
                message is Packet<*>
            ) {
                val currentViewerId = viewerId.get()
                if (currentViewerId == null) {
                    // Login sends several game carriers before PlayerJoinEvent. Project those
                    // through a context-less, non-registering session: unmanaged packets retain
                    // identity, while any managed item is sanitized until the owning-context bind
                    // and subsequent inventory refresh publish the real viewer projection.
                    if (packetProjector.isProjectionCarrier(message)) {
                        projectUnboundPacket(message)
                    } else {
                        message
                    }
                } else {
                    val projection = projectBoundPacket(message, currentViewerId)
                    try {
                        val changed = if (projection.sanitizedFallback) {
                            projectionState.observeSanitizedFallback(projection.packet)
                        } else {
                            projectionState.observeOutbound(message)
                        }
                        if (changed) onPersistentSurfaceMutation()
                    } catch (failure: NmsPersistentSurfaceIncompleteException) {
                        rejectIncompletePersistentSurface(failure, promise)
                        context.close()
                        return
                    }
                    projection.packet
                }
            } else {
                message
            }
        } catch (failure: Throwable) {
            terminalFailure("project an outbound packet", failure)
            reportFailure("outbound projection", failure)
            promise.tryFailure(failure)
            rethrowFatal(failure)
            return
        }
        context.write(outgoing, promise)
    }

    override fun channelRead(context: ChannelHandlerContext, message: Any) {
        if (message is Packet<*> && !projectionOperational()) {
            if (inboundProjector.isProjectionCarrier(message)) return
            context.fireChannelRead(message)
            return
        }
        if (
            message is Packet<*>
        ) {
            val currentViewerId = viewerId.get()
            if (currentViewerId != null) {
                try {
                    if (
                        message is ServerboundContainerClosePacket &&
                        projectionState.observeContainerClosed(message.containerId)
                    ) {
                        onPersistentSurfaceMutation()
                    }
                    when (val decision = inboundProjector.project(message, currentViewerId)) {
                        is InboundPacketDecision.Forward -> {
                            context.fireChannelRead(decision.packet)
                            return
                        }
                        is InboundPacketDecision.RejectCreative -> return
                        is InboundPacketDecision.RejectCustomClick -> return
                    }
                } catch (failure: Throwable) {
                    terminalFailure("project an inbound packet", failure)
                    reportFailure("inbound projection", failure)
                    rethrowFatal(failure)
                    return
                }
            } else {
                try {
                    if (inboundProjector.isProjectionCarrier(message)) {
                        val failure = IllegalStateException("Projection carrier reached an unbound connection")
                        terminalFailure("project an inbound packet on an unbound connection", failure)
                        reportFailure("inbound projection", failure)
                        return
                    }
                } catch (failure: Throwable) {
                    terminalFailure("classify an inbound packet", failure)
                    reportFailure("inbound projection", failure)
                    rethrowFatal(failure)
                    return
                }
            }
        }
        context.fireChannelRead(message)
    }

    override fun handlerRemoved(context: ChannelHandlerContext) {
        val unexpected = !removalPublished && context.channel().isActive && owner.isActive()
        if (unexpected) {
            // Netty unlinks a handler before invoking handlerRemoved. Close the still-active
            // connection immediately, before publishing removal untracks it, so no raw item
            // carrier can cross the pipeline while terminal plugin shutdown is being scheduled.
            context.close()
        }
        cleanupConnection()
        handlerContext = null
        publishRemoval()
        if (unexpected) {
            terminalFailure(
                "retain a channel handler",
                IllegalStateException("The Itemerness projection handler was removed from an active channel"),
            )
        }
        super.handlerRemoved(context)
    }

    override fun channelInactive(context: ChannelHandlerContext) {
        // Channel inactivity clears connection-owned state, but it is not proof that this handler
        // has left the pipeline. The adapter keeps tracking the channel until handlerRemoved runs
        // on the event loop, so close cannot complete retirement inside that window.
        cleanupConnection()
        super.channelInactive(context)
    }

    fun bindViewer(binding: NmsViewerBinding) {
        bindViewer(binding.viewerId, binding)
    }

    /** Test-only binding path for the packet handler without a platform ServerPlayer. */
    internal fun bindViewer(boundViewerId: UUID) {
        bindViewer(boundViewerId, binding = null)
    }

    private fun bindViewer(boundViewerId: UUID, binding: NmsViewerBinding?) {
        check(projectionOperational()) { "Cannot bind a viewer to a retired projection handler" }
        val previousBinding = viewerBinding.getAndSet(binding)
        val previous = viewerId.getAndSet(boundViewerId)
        hasEverBound.set(true)
        if (previous != null && (previous != boundViewerId || previousBinding !== binding)) {
            viewerUnbound(previousBinding, this)
        }
        viewerResolved(binding, this)
        flushLoginWrites(boundViewerId)
    }

    fun unbindViewer(expectedViewerId: UUID) {
        if (viewerId.compareAndSet(expectedViewerId, null)) {
            viewerUnbound(viewerBinding.getAndSet(null), this)
        }
    }

    fun unbindViewer(expectedBinding: NmsViewerBinding) {
        if (viewerBinding.compareAndSet(expectedBinding, null)) {
            viewerId.compareAndSet(expectedBinding.viewerId, null)
            viewerUnbound(expectedBinding, this)
        }
    }

    fun isOwnedBy(expectedOwner: NmsProjectionHandlerOwner): Boolean = owner === expectedOwner

    fun ownerIsRetired(): Boolean = owner.isRetired()

    fun channel(): Channel = connection.channel

    fun isBoundTo(expectedBinding: NmsViewerBinding): Boolean =
        viewerBinding.get() === expectedBinding && viewerId.get() == expectedBinding.viewerId

    fun onTerminalFailure(failure: ProjectionFailure) {
        failLoginWrites(ProjectionUnavailableException(failure))
    }

    /** Called by the platform from this viewer's owning entity context. */
    fun refreshViewer(expectedBinding: NmsViewerBinding, owningPlayer: ServerPlayer) {
        if (!projectionOperational()) return
        if (!isBoundTo(expectedBinding)) return
        if (expectedBinding.player !== owningPlayer || expectedBinding.channel !== connection.channel) return
        val listener = connection.packetListener as? ServerGamePacketListenerImpl ?: return
        if (listener.player !== owningPlayer || owningPlayer.connection.connection !== connection) return
        val generation = persistentRefreshGeneration.incrementAndGet()

        try {
            val inventoryMenu = owningPlayer.inventoryMenu
            val currentMenu = owningPlayer.containerMenu
            refreshMenu(inventoryMenu)
            if (currentMenu !== inventoryMenu) {
                refreshMenu(currentMenu)
            }
            if (currentMenu is MerchantMenu) {
                connection.send(
                    ClientboundMerchantOffersPacket(
                        currentMenu.containerId,
                        currentMenu.offers,
                        currentMenu.traderLevel,
                        currentMenu.traderXp,
                        currentMenu.showProgressBar(),
                        currentMenu.canRestock(),
                    ),
                )
            }
            connection.send(ClientboundSetCursorItemPacket(currentMenu.carried.copy()))

            val recipeManager = MinecraftServer.getServer().recipeManager
            connection.send(
                ClientboundUpdateRecipesPacket(
                    recipeManager.synchronizedItemProperties,
                    recipeManager.synchronizedStonecutterRecipes,
                ),
            )
            owningPlayer.recipeBook.sendInitialRecipeBook(owningPlayer)

            val advancements = owningPlayer.advancements
            advancements.flushDirty(owningPlayer, false)
            val advancementSnapshot = NmsPlayerAdvancementsAccess.fullSnapshot(
                advancements,
                MinecraftServer.getServer().registryAccess(),
            )
            connection.send(advancementSnapshot.advancements)
            connection.send(advancementSnapshot.selectedTab)

            schedulePersistentRefresh(
                expectedBinding,
                generation,
                currentMenu.containerId,
                projectionState.persistentSurfacePageSet(currentMenu.containerId),
            )
        } catch (failure: NmsPersistentSurfaceIncompleteException) {
            rejectIncompletePersistentSurface(failure)
            connection.channel.close()
        }
    }

    private fun schedulePersistentRefresh(
        expectedBinding: NmsViewerBinding?,
        generation: Long,
        activeContainerId: Int,
        pageSet: NmsPersistentSurfacePageSet,
    ) {
        val eventLoop = connection.channel.eventLoop()
        val install = Runnable {
            if (!persistentRefreshFenceIsCurrent(expectedBinding, generation)) return@Runnable
            val session = PersistentRefreshSession(
                expectedBinding = expectedBinding,
                generation = generation,
                activeContainerId = activeContainerId,
                pageSet = pageSet,
            )
            persistentRefreshSession = session
            runPersistentRefreshTask("start a persistent surface refresh") {
                runPersistentRefreshPage(session, pageIndex = 0)
            }
        }
        if (eventLoop.inEventLoop()) install.run() else eventLoop.execute(install)
    }

    /** Deterministic packet-handler test path; production refreshes always carry an exact binding. */
    internal fun startPersistentRefreshForTest(activeContainerId: Int): Long {
        check(viewerId.get() != null) { "A test refresh requires a bound viewer" }
        val generation = persistentRefreshGeneration.incrementAndGet()
        schedulePersistentRefresh(
            expectedBinding = null,
            generation = generation,
            activeContainerId = activeContainerId,
            pageSet = projectionState.persistentSurfacePageSet(activeContainerId),
        )
        return generation
    }

    private fun runPersistentRefreshPage(session: PersistentRefreshSession, pageIndex: Int) {
        if (!persistentRefreshSessionIsCurrent(session)) return
        if (projectionState.persistentSurfaceRevision() != session.pageSet.revision) {
            requestPersistentRefreshRestart(session)
            return
        }
        if (pageIndex >= session.pageSet.pages.size) {
            persistentRefreshSession = null
            return
        }

        for (packet in session.pageSet.pages[pageIndex]) {
            if (!persistentRefreshSessionIsCurrent(session)) return
            if (projectionState.persistentSurfaceRevision() != session.pageSet.revision) {
                requestPersistentRefreshRestart(session)
                return
            }
            writePersistentRefreshPacket(session, packet)
        }
        handlerContext?.flush()
        if (pageIndex + 1 >= session.pageSet.pages.size) {
            if (persistentRefreshSession === session) persistentRefreshSession = null
            return
        }
        connection.channel.eventLoop().schedule(
            {
                runPersistentRefreshTask("replay a persistent surface refresh page") {
                    runPersistentRefreshPage(session, pageIndex + 1)
                }
            },
            PERSISTENT_REFRESH_PAGE_DELAY_MILLIS,
            TimeUnit.MILLISECONDS,
        )
    }

    private fun onPersistentSurfaceMutation() {
        persistentRefreshSession?.let(::requestPersistentRefreshRestart)
    }

    private fun requestPersistentRefreshRestart(session: PersistentRefreshSession) {
        if (persistentRefreshSession !== session || session.restartScheduled) return
        if (!persistentRefreshFenceIsCurrent(session.expectedBinding, session.generation)) {
            persistentRefreshSession = null
            return
        }
        session.restartScheduled = true
        connection.channel.eventLoop().schedule(
            {
                runPersistentRefreshTask("restart a persistent surface refresh") {
                    restartPersistentRefresh(session)
                }
            },
            PERSISTENT_REFRESH_PAGE_DELAY_MILLIS,
            TimeUnit.MILLISECONDS,
        )
    }

    private fun restartPersistentRefresh(previous: PersistentRefreshSession) {
        if (persistentRefreshSession !== previous) return
        if (!persistentRefreshFenceIsCurrent(previous.expectedBinding, previous.generation)) {
            persistentRefreshSession = null
            return
        }
        val replacement = PersistentRefreshSession(
            expectedBinding = previous.expectedBinding,
            generation = previous.generation,
            activeContainerId = previous.activeContainerId,
            pageSet = projectionState.persistentSurfacePageSet(previous.activeContainerId),
        )
        persistentRefreshSession = replacement
        runPersistentRefreshPage(replacement, pageIndex = 0)
    }

    private fun persistentRefreshSessionIsCurrent(session: PersistentRefreshSession): Boolean =
        persistentRefreshSession === session &&
            !session.restartScheduled &&
            persistentRefreshFenceIsCurrent(session.expectedBinding, session.generation)

    private fun persistentRefreshFenceIsCurrent(
        expectedBinding: NmsViewerBinding?,
        generation: Long,
    ): Boolean =
        projectionOperational() &&
            persistentRefreshGeneration.get() == generation &&
            if (expectedBinding == null) viewerId.get() != null else isBoundTo(expectedBinding)

    private fun writePersistentRefreshPacket(session: PersistentRefreshSession, packet: Packet<*>) {
        // This direct downstream path is exclusively for NmsPersistentSurfaceCache's allowlist:
        // managed entity metadata, managed entity equipment, and the active ghost recipe. Those
        // packets are idempotent state replacements whose exact ABI hooks are guarded by tests.
        // Never reuse it for general, terminal, order-dependent, or extra-packet carriers; those
        // must retain Connection.send dispatch semantics and normal traversal through this handler.
        val context = checkNotNull(handlerContext) {
            "Persistent refresh replay requires an installed channel handler"
        }
        check(context.executor().inEventLoop()) {
            "Persistent refresh replay must run on the connection event loop"
        }
        val currentViewerId = checkNotNull(viewerId.get()) {
            "Persistent refresh replay requires a bound viewer"
        }
        val projected = projectBoundPacket(packet, currentViewerId)
        context.write(projected.packet).addListener { future ->
            if (!future.isSuccess) {
                failPersistentRefreshWrite(
                    session,
                    future.cause() ?: IllegalStateException("Persistent refresh packet write failed without a cause"),
                )
            }
        }
    }

    private fun failPersistentRefreshWrite(session: PersistentRefreshSession, failure: Throwable) {
        if (session.writeFailureHandled) return
        session.writeFailureHandled = true
        persistentRefreshGeneration.incrementAndGet()
        persistentRefreshSession = null
        val terminalWriteFailure = try {
            failure.hasTerminalPersistentRefreshCause()
        } catch (fatal: Throwable) {
            handlerContext?.close() ?: connection.channel.close()
            throw fatal
        }
        if (terminalWriteFailure) {
            terminalFailure("write a persistent surface refresh packet", failure)
        }
        reportFailure("persistent refresh downstream write", failure)
        handlerContext?.close() ?: connection.channel.close()
    }

    private fun Throwable.hasTerminalPersistentRefreshCause(): Boolean {
        var current: Throwable? = this
        var depth = 0
        while (current != null && depth < PERSISTENT_REFRESH_FAILURE_CAUSE_LIMIT) {
            current.rethrowIfFatalProjectionFailure()
            if (current.isTerminalOutboundProjectionFailure()) return true
            val next = try {
                current.cause
            } catch (failure: Throwable) {
                failure.rethrowIfFatalProjectionFailure()
                return true
            }
            if (next === current) return true
            current = next
            depth++
        }
        return current != null
    }

    private fun runPersistentRefreshTask(operation: String, task: () -> Unit) {
        try {
            task()
        } catch (failure: Throwable) {
            failPersistentRefreshTask(operation, failure)
        }
    }

    private fun failPersistentRefreshTask(operation: String, failure: Throwable) {
        persistentRefreshSession = null
        if (failure is NmsPersistentSurfaceIncompleteException) {
            rejectIncompletePersistentSurface(failure)
        } else {
            terminalFailure(operation, failure)
            reportFailure(operation, failure)
        }
        handlerContext?.close() ?: connection.channel.close()
        rethrowFatal(failure)
    }

    private fun refreshMenu(menu: AbstractContainerMenu) {
        if (
            menu.slots.size <= MAX_REFRESH_MENU_SLOTS &&
            NmsContainerMenuAccess.dataSlotCount(menu) <= MAX_REFRESH_DATA_SLOTS
        ) {
            menu.sendAllDataToRemote()
        }
    }

    private fun cleanupConnection() {
        if (connectionCleaned) return
        connectionCleaned = true
        persistentRefreshGeneration.incrementAndGet()
        persistentRefreshSession = null
        projectionState.clear()
        failLoginWrites(ClosedChannelException())
        val removedBinding = viewerBinding.getAndSet(null)
        val removedViewerId = viewerId.getAndSet(null)
        removedViewerId?.let { resyncRequests.discard(it, projectionState.connectionGeneration()) }
        removedViewerId?.let { viewerUnbound(removedBinding, this) }
    }

    private fun publishRemoval() {
        if (removalPublished) return
        removalPublished = true
        removed(viewerBinding.get(), this)
    }

    private fun reportFailure(operation: String, failure: Throwable) {
        if (diagnosticBudget.getAndDecrement() > 0) {
            LOGGER.warn("Itemerness dropped a packet after {} failure", operation, failure)
        }
    }

    private fun reportFallback(operation: String, failure: Throwable) {
        if (diagnosticBudget.getAndDecrement() > 0) {
            LOGGER.warn("Itemerness sent a canonical fallback after {} failure", operation, failure)
        }
    }

    private fun projectUnboundPacket(packet: Packet<*>): Packet<*> = try {
        packetProjector.projectUnbound(packet)
    } catch (failure: Throwable) {
        recoverOutboundPacket(packet, "unbound outbound projection", failure)
    }

    private fun projectBoundPacket(packet: Packet<*>, boundViewerId: UUID): BoundPacketProjection {
        val transaction = projectionState.beginOutboundProjection()
        val projected = try {
            packetProjector.project(packet, boundViewerId, transaction)
        } catch (failure: Throwable) {
            transaction.abort()
            return BoundPacketProjection(
                recoverOutboundPacket(packet, "outbound projection", failure),
                sanitizedFallback = true,
            )
        }
        try {
            transaction.commit()
        } catch (failure: Throwable) {
            transaction.abort()
            failure.rethrowIfFatalProjectionFailure()
            if (failure.isTerminalOutboundProjectionFailure()) throw failure
            if (failure is NmsRecoverableProjectionException) {
                return BoundPacketProjection(
                    recoverOutboundPacket(packet, "outbound capability commit", failure),
                    sanitizedFallback = true,
                )
            }
            throw NmsProjectionInfrastructureException(
                "Failed to commit an outbound projection capability transaction",
                failure,
            )
        }
        return BoundPacketProjection(projected, sanitizedFallback = false)
    }

    private fun recoverOutboundPacket(
        packet: Packet<*>,
        operation: String,
        failure: Throwable,
    ): Packet<*> {
        failure.rethrowIfFatalProjectionFailure()
        if (failure.isTerminalOutboundProjectionFailure()) throw failure
        if (failure !is NmsRecoverableProjectionException) {
            throw NmsProjectionInfrastructureException(
                "Unexpected failure during $operation",
                failure,
            )
        }
        reportFallback(operation, failure)
        return try {
            val rejectingRegistration = NmsRejectingFallbackRegistration()
            val fallback = packetProjector.canonicalFallback(packet, rejectingRegistration)
            if (rejectingRegistration.handledCustomPayload) {
                projectionState.rejectUnmanagedCustomClicks()
            }
            fallback
        } catch (fallbackFailure: Throwable) {
            fallbackFailure.rethrowIfFatalProjectionFailure()
            if (fallbackFailure.isTerminalOutboundProjectionFailure()) throw fallbackFailure
            throw NmsProjectionInfrastructureException(
                "Canonical fallback failed during $operation",
                fallbackFailure,
            )
        }
    }

    private fun rethrowFatal(failure: Throwable) {
        failure.rethrowIfFatalProjectionFailure()
    }

    private fun projectionOperational(): Boolean =
        owner.isActive() && terminal.failure() == null && projectionEnabled()

    private fun projectionUnavailable(): ProjectionUnavailableException = ProjectionUnavailableException(
        terminal.failure(),
    )

    private fun enqueueLoginWrite(
        context: ChannelHandlerContext,
        packet: Packet<*>,
        promise: ChannelPromise,
    ) {
        if (pendingLoginWrites.size >= MAX_PENDING_LOGIN_PACKETS) {
            val failure = IllegalStateException("Unbound login packet queue exceeded its hard limit")
            reportFailure("login packet queue", failure)
            terminalFailure("queue an unbound login packet", failure)
            promise.tryFailure(failure)
            failLoginWrites(failure)
            context.close()
            return
        }
        pendingLoginWrites.addLast(PendingWrite(packet, promise))
        if (pendingLoginTimeout == null) {
            pendingLoginTimeout = context.executor().schedule(
                {
                    if (viewerId.get() == null && pendingLoginWrites.isNotEmpty()) {
                        val failure = IllegalStateException("Viewer binding did not arrive during login")
                        reportFailure("login viewer binding", failure)
                        terminalFailure("resolve a login viewer", failure)
                        failLoginWrites(failure)
                        context.close()
                    }
                },
                LOGIN_BIND_TIMEOUT_SECONDS,
                TimeUnit.SECONDS,
            )
        }
    }

    private fun flushLoginWrites(boundViewerId: UUID) {
        pendingLoginTimeout?.cancel(false)
        pendingLoginTimeout = null
        val context = handlerContext ?: return
        while (pendingLoginWrites.isNotEmpty()) {
            val pending = pendingLoginWrites.removeFirst()
            try {
                val projected = projectBoundPacket(pending.packet, boundViewerId)
                try {
                    val changed = if (projected.sanitizedFallback) {
                        projectionState.observeSanitizedFallback(projected.packet)
                    } else {
                        projectionState.observeOutbound(pending.packet)
                    }
                    if (changed) onPersistentSurfaceMutation()
                } catch (failure: NmsPersistentSurfaceIncompleteException) {
                    rejectIncompletePersistentSurface(failure, pending.promise)
                    failLoginWrites(failure)
                    context.close()
                    return
                }
                context.write(projected.packet, pending.promise)
            } catch (failure: Throwable) {
                terminalFailure("project a queued login packet", failure)
                reportFailure("queued login projection", failure)
                pending.promise.tryFailure(failure)
                failLoginWrites(failure)
                context.close()
                rethrowFatal(failure)
                return
            }
        }
        context.flush()
    }

    private fun rejectIncompletePersistentSurface(
        failure: NmsPersistentSurfaceIncompleteException,
        promise: ChannelPromise? = null,
    ) {
        persistentRefreshGeneration.incrementAndGet()
        persistentRefreshSession = null
        reportFailure("persistent-surface coverage", failure)
        promise?.tryFailure(failure)
    }

    private fun failLoginWrites(failure: Throwable) {
        pendingLoginTimeout?.cancel(false)
        pendingLoginTimeout = null
        while (pendingLoginWrites.isNotEmpty()) {
            pendingLoginWrites.removeFirst().promise.tryFailure(failure)
        }
    }

    private data class PendingWrite(
        val packet: Packet<*>,
        val promise: ChannelPromise,
    )

    private data class BoundPacketProjection(
        val packet: Packet<*>,
        val sanitizedFallback: Boolean,
    )

    private class PersistentRefreshSession(
        val expectedBinding: NmsViewerBinding?,
        val generation: Long,
        val activeContainerId: Int,
        val pageSet: NmsPersistentSurfacePageSet,
        var restartScheduled: Boolean = false,
        var writeFailureHandled: Boolean = false,
    )

    private companion object {
        val LOGGER: Logger = LogUtils.getLogger()
        const val MAX_DIAGNOSTICS = 16
        const val MAX_PENDING_LOGIN_PACKETS = 512
        const val LOGIN_BIND_TIMEOUT_SECONDS = 10L
        const val MAX_REFRESH_MENU_SLOTS = 256
        const val MAX_REFRESH_DATA_SLOTS = 256
        const val PERSISTENT_REFRESH_PAGE_DELAY_MILLIS = 50L
    }
}

internal const val PERSISTENT_REFRESH_FAILURE_CAUSE_LIMIT = 16

/** Exact-version refresh boundary shared by the adapter and direct failure-boundary tests. */
internal fun runProjectionRefreshBoundary(
    viewerId: UUID,
    refresh: () -> Unit,
    failure: (String, Throwable) -> Unit,
) {
    try {
        refresh()
    } catch (refreshFailure: Throwable) {
        refreshFailure.rethrowIfFatalProjectionFailure()
        failure("refresh viewer $viewerId", refreshFailure)
    }
}

internal class ProjectionUnavailableException(
    failure: ProjectionFailure?,
) : IllegalStateException(
    if (failure == null) "Item projection is not active" else "Item projection failed during ${failure.operation}",
    failure?.cause,
)

/** Exact-version access used only to keep proactive menu refresh work hard bounded. */
internal object NmsContainerMenuAccess {
    private val dataSlotsField = AbstractContainerMenu::class.java
        .getDeclaredField("dataSlots")
        .also { field ->
            check(field.trySetAccessible()) { "Cannot access AbstractContainerMenu.dataSlots" }
        }

    fun dataSlotCount(menu: AbstractContainerMenu): Int =
        (dataSlotsField.get(menu) as List<*>).size

    fun verifyAbi() {
        check(List::class.java.isAssignableFrom(dataSlotsField.type)) {
            "AbstractContainerMenu.dataSlots is not a List"
        }
    }
}
