package com.iroselle.itemerness.nms.v1_21_11

import com.iroselle.itemerness.api.ItemKey
import com.iroselle.itemerness.projection.ItemProjector
import com.iroselle.itemerness.projection.LocaleId
import com.iroselle.itemerness.projection.ProjectionContext
import com.iroselle.itemerness.projection.ProjectionContextSource
import com.iroselle.itemerness.projection.ProjectionGeneration
import com.iroselle.itemerness.projection.ProjectionResult
import com.iroselle.itemerness.projection.ProjectionRuntime
import com.iroselle.itemerness.projection.ProjectionResyncSink
import com.iroselle.itemerness.projection.ProjectionFailureSink
import com.iroselle.itemerness.projection.RenderedDisplay
import com.iroselle.itemerness.projection.RenderedText
import com.iroselle.itemerness.projection.ViewerProjectionSnapshot
import io.netty.channel.ChannelFuture
import io.netty.channel.ChannelHandlerContext
import io.netty.channel.ChannelOutboundHandlerAdapter
import io.netty.channel.ChannelPromise
import io.netty.channel.embedded.EmbeddedChannel
import io.netty.handler.codec.EncoderException
import io.papermc.paper.configuration.GlobalConfiguration
import java.nio.channels.ClosedChannelException
import java.util.UUID
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import net.minecraft.SharedConstants
import net.minecraft.core.Holder
import net.minecraft.core.RegistryAccess
import net.minecraft.core.RegistrySynchronization
import net.minecraft.core.component.DataComponentExactPredicate
import net.minecraft.core.component.DataComponentMap
import net.minecraft.core.component.DataComponents
import net.minecraft.core.registries.BuiltInRegistries
import net.minecraft.core.registries.Registries
import net.minecraft.nbt.CompoundTag
import net.minecraft.nbt.IntTag
import net.minecraft.nbt.ListTag
import net.minecraft.nbt.NbtOps
import net.minecraft.network.Connection
import net.minecraft.network.ConnectionProtocol
import net.minecraft.network.DisconnectionDetails
import net.minecraft.network.HashedPatchMap
import net.minecraft.network.PacketListener
import net.minecraft.network.chat.Component
import net.minecraft.network.chat.ClickEvent
import net.minecraft.network.chat.HoverEvent
import net.minecraft.network.protocol.Packet
import net.minecraft.network.protocol.PacketFlow
import net.minecraft.network.protocol.common.ClientboundShowDialogPacket
import net.minecraft.network.protocol.common.ServerboundCustomClickActionPacket
import net.minecraft.network.protocol.configuration.ClientboundRegistryDataPacket
import net.minecraft.network.protocol.game.ClientboundContainerSetSlotPacket
import net.minecraft.network.protocol.game.ClientboundContainerSetContentPacket
import net.minecraft.network.protocol.game.ClientboundBundlePacket
import net.minecraft.network.protocol.game.ClientGamePacketListener
import net.minecraft.network.protocol.game.ClientboundMerchantOffersPacket
import net.minecraft.network.protocol.game.ClientboundPlaceGhostRecipePacket
import net.minecraft.network.protocol.game.ClientboundRemoveEntitiesPacket
import net.minecraft.network.protocol.game.ClientboundSetEntityDataPacket
import net.minecraft.network.protocol.game.ClientboundSetEquipmentPacket
import net.minecraft.network.protocol.game.ClientboundSystemChatPacket
import net.minecraft.network.protocol.game.ClientboundTagQueryPacket
import net.minecraft.network.protocol.common.ClientboundKeepAlivePacket
import net.minecraft.network.syncher.EntityDataSerializers
import net.minecraft.network.syncher.SynchedEntityData
import net.minecraft.resources.Identifier
import net.minecraft.server.Bootstrap
import net.minecraft.server.level.ServerPlayer
import net.minecraft.server.dialog.ActionButton
import net.minecraft.server.dialog.CommonButtonData
import net.minecraft.server.dialog.CommonDialogData
import net.minecraft.server.dialog.Dialog
import net.minecraft.server.dialog.DialogAction
import net.minecraft.server.dialog.NoticeDialog
import net.minecraft.server.dialog.action.CustomAll
import net.minecraft.server.dialog.action.StaticAction
import net.minecraft.world.item.ItemStack
import net.minecraft.world.item.Items
import net.minecraft.world.item.component.CustomData
import net.minecraft.world.item.crafting.display.SlotDisplay
import net.minecraft.world.item.crafting.display.StonecutterRecipeDisplay
import net.minecraft.world.item.trading.ItemCost
import net.minecraft.world.item.trading.MerchantOffer
import net.minecraft.world.item.trading.MerchantOffers
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Test

class NmsProjectionChannelHandlerTest {
    @Test
    fun `play packets wait for owning-context binding and flush through viewer projection`() {
        val fixture = fixture()
        val source = ClientboundContainerSetSlotPacket(2, 4, 1, canonicalStack())
        val promise = fixture.channel.newPromise()

        fixture.channel.pipeline().write(source, promise)
        fixture.channel.pipeline().flush()
        fixture.channel.runPendingTasks()
        assertFalse(promise.isDone)
        assertNull(fixture.channel.readOutbound<Any>())

        fixture.handler.bindViewer(VIEWER_ID)
        fixture.channel.runPendingTasks()

        assertTrue(promise.isSuccess)
        val projected = fixture.channel.readOutbound<ClientboundContainerSetSlotPacket>()
        assertNotNull(projected)
        assertFalse(projected.item.get(DataComponents.CUSTOM_DATA)?.contains(NmsCanonicalItemCodec.ROOT_KEY) == true)
        assertEquals("Projected login item", projected.item.itemName.string)
        assertTrue(fixture.resolved)
        fixture.channel.finishAndReleaseAll()
    }

    @Test
    fun `component budget failure sends a safe canonical fallback and keeps the runtime active`() {
        val fixture = fixture()
        fixture.handler.bindViewer(VIEWER_ID)
        fixture.channel.runPendingTasks()
        val cyclic = Component.literal("cycle")
        cyclic.append(cyclic)
        val source = ClientboundContainerSetSlotPacket(
            2,
            4,
            1,
            ItemStack(Items.STONE).also { stack -> stack.set(DataComponents.CUSTOM_NAME, cyclic) },
        )
        val promise = fixture.channel.newPromise()

        fixture.channel.pipeline().write(source, promise)
        fixture.channel.pipeline().flush()
        fixture.channel.runPendingTasks()

        assertTrue(promise.isSuccess)
        val fallback = fixture.channel.readOutbound<ClientboundContainerSetSlotPacket>()
        assertNotNull(fallback)
        assertNull(fallback.item.get(DataComponents.CUSTOM_NAME))
        assertSame(cyclic, source.item.get(DataComponents.CUSTOM_NAME))
        assertNull(fixture.terminal.failure())

        val laterPromise = fixture.channel.newPromise()
        fixture.channel.pipeline().write(
            ClientboundContainerSetSlotPacket(2, 5, 1, canonicalStack()),
            laterPromise,
        )
        fixture.channel.pipeline().flush()
        fixture.channel.runPendingTasks()
        assertTrue(laterPromise.isSuccess)
        val projected = fixture.channel.readOutbound<ClientboundContainerSetSlotPacket>()
        assertEquals("Projected login item", projected.item.itemName.string)
        assertNull(fixture.channel.readOutbound<Any>())
        fixture.channel.finishAndReleaseAll()
    }

    @Test
    fun `persistent coverage overflow closes only its connection and leaves the shared runtime active`() {
        val sharedTerminal = NmsProjectionTerminal()
        val overflowing = fixture(
            terminal = sharedTerminal,
            persistentEntityCapacity = 1,
        )
        val survivor = fixture(terminal = sharedTerminal)
        overflowing.handler.bindViewer(VIEWER_ID)
        survivor.handler.bindViewer(VIEWER_ID)

        val retained = overflowing.channel.newPromise()
        overflowing.channel.pipeline().write(
            ClientboundSetEntityDataPacket(
                41,
                listOf(SynchedEntityData.DataValue(0, EntityDataSerializers.ITEM_STACK, canonicalStack())),
            ),
            retained,
        )
        overflowing.channel.pipeline().flush()
        overflowing.channel.runPendingTasks()
        assertTrue(retained.isSuccess)
        assertNotNull(overflowing.channel.readOutbound<ClientboundSetEntityDataPacket>())

        val overflow = overflowing.channel.newPromise()
        overflowing.channel.pipeline().write(
            ClientboundSetEntityDataPacket(
                42,
                listOf(SynchedEntityData.DataValue(0, EntityDataSerializers.ITEM_STACK, canonicalStack())),
            ),
            overflow,
        )
        overflowing.channel.pipeline().flush()
        overflowing.channel.runPendingTasks()

        assertFalse(overflow.isSuccess)
        assertTrue(overflow.cause() is NmsPersistentSurfaceIncompleteException)
        assertFalse(overflowing.channel.isOpen)
        assertNull(overflowing.channel.readOutbound<Any>())
        assertNull(sharedTerminal.failure())

        val later = survivor.channel.newPromise()
        survivor.channel.pipeline().write(
            ClientboundContainerSetSlotPacket(2, 5, 1, canonicalStack()),
            later,
        )
        survivor.channel.pipeline().flush()
        survivor.channel.runPendingTasks()
        assertTrue(later.isSuccess)
        assertTrue(survivor.channel.isActive)
        assertEquals(
            "Projected login item",
            survivor.channel.readOutbound<ClientboundContainerSetSlotPacket>().item.itemName.string,
        )
        assertNull(sharedTerminal.failure())
        overflowing.channel.finishAndReleaseAll()
        survivor.channel.finishAndReleaseAll()
    }

    @Test
    fun `persistent refresh downstream write failure closes only its connection`() {
        val sharedTerminal = NmsProjectionTerminal()
        val failing = fixture(terminal = sharedTerminal)
        val survivor = fixture(terminal = sharedTerminal)
        failing.handler.bindViewer(VIEWER_ID)
        survivor.handler.bindViewer(VIEWER_ID)
        repeat(66) { entityId ->
            failing.channel.pipeline().write(metadata(entityId, "retained-$entityId"))
        }
        failing.channel.pipeline().flush()
        failing.channel.runPendingTasks()
        drainOutbound(failing.channel)
        val failingSink = DeferredFailingOutboundHandler()
        failing.channel.pipeline().addBefore(
            HANDLER_NAME,
            "failing_refresh_sink",
            failingSink,
        )

        failing.handler.startPersistentRefreshForTest(activeContainerId = 0)
        failing.channel.runPendingTasks()
        assertEquals(64, failingSink.pendingWrites)
        failingSink.failAll()
        failing.channel.runPendingTasks()

        assertFalse(failing.channel.isOpen)
        assertEquals(0, failing.connectionSendCount)
        assertNull(sharedTerminal.failure())

        val survivorWrite = survivor.channel.newPromise()
        survivor.channel.pipeline().write(
            ClientboundContainerSetSlotPacket(2, 5, 1, canonicalStack()),
            survivorWrite,
        )
        survivor.channel.pipeline().flush()
        survivor.channel.runPendingTasks()
        assertTrue(survivorWrite.isSuccess)
        assertEquals(
            "Projected login item",
            survivor.channel.readOutbound<ClientboundContainerSetSlotPacket>().item.itemName.string,
        )
        assertNull(sharedTerminal.failure())
        failing.channel.finishAndReleaseAll()
        survivor.channel.finishAndReleaseAll()
    }

    @Test
    fun `persistent refresh wrapped linkage write failure poisons the shared runtime`() {
        val sharedTerminal = NmsProjectionTerminal()
        val fixture = fixture(terminal = sharedTerminal)
        fixture.handler.bindViewer(VIEWER_ID)
        fixture.channel.pipeline().write(metadata(41, "retained"))
        fixture.channel.pipeline().flush()
        fixture.channel.runPendingTasks()
        drainOutbound(fixture.channel)
        val failingSink = DeferredFailingOutboundHandler()
        fixture.channel.pipeline().addBefore(HANDLER_NAME, "failing_refresh_sink", failingSink)

        fixture.handler.startPersistentRefreshForTest(activeContainerId = 0)
        fixture.channel.runPendingTasks()
        val failure = EncoderException(NoSuchMethodError("simulated refresh encoder ABI drift"))
        failingSink.failAll(failure)
        fixture.channel.runPendingTasks()

        assertFalse(fixture.channel.isOpen)
        assertEquals(0, fixture.connectionSendCount)
        assertSame(failure, sharedTerminal.failure()?.cause)
        fixture.channel.finishAndReleaseAll()
    }

    @Test
    fun `persistent refresh linkage beyond the write cause budget fails closed`() {
        val sharedTerminal = NmsProjectionTerminal()
        val fixture = fixture(terminal = sharedTerminal)
        fixture.handler.bindViewer(VIEWER_ID)
        fixture.channel.pipeline().write(metadata(41, "retained"))
        fixture.channel.pipeline().flush()
        fixture.channel.runPendingTasks()
        drainOutbound(fixture.channel)
        val failingSink = DeferredFailingOutboundHandler()
        fixture.channel.pipeline().addBefore(HANDLER_NAME, "failing_refresh_sink", failingSink)

        fixture.handler.startPersistentRefreshForTest(activeContainerId = 0)
        fixture.channel.runPendingTasks()
        var failure: Throwable = NoSuchMethodError("deep refresh encoder ABI drift")
        repeat(PERSISTENT_REFRESH_FAILURE_CAUSE_LIMIT + 1) { depth ->
            failure = EncoderException("encoder wrapper $depth", failure)
        }
        failingSink.failAll(failure)
        fixture.channel.runPendingTasks()

        assertFalse(fixture.channel.isOpen)
        assertSame(failure, sharedTerminal.failure()?.cause)
        fixture.channel.finishAndReleaseAll()
    }

    @Test
    fun `persistent refresh unknown write chain beyond the cause budget fails closed`() {
        val sharedTerminal = NmsProjectionTerminal()
        val fixture = fixture(terminal = sharedTerminal)
        fixture.handler.bindViewer(VIEWER_ID)
        fixture.channel.pipeline().write(metadata(41, "retained"))
        fixture.channel.pipeline().flush()
        fixture.channel.runPendingTasks()
        drainOutbound(fixture.channel)
        val failingSink = DeferredFailingOutboundHandler()
        fixture.channel.pipeline().addBefore(HANDLER_NAME, "failing_refresh_sink", failingSink)

        fixture.handler.startPersistentRefreshForTest(activeContainerId = 0)
        fixture.channel.runPendingTasks()
        var failure: Throwable = ClosedChannelException()
        repeat(PERSISTENT_REFRESH_FAILURE_CAUSE_LIMIT + 1) { depth ->
            failure = IllegalStateException("unknown wrapper $depth", failure)
        }
        failingSink.failAll(failure)
        fixture.channel.runPendingTasks()

        assertFalse(fixture.channel.isOpen)
        assertSame(failure, sharedTerminal.failure()?.cause)
        fixture.channel.finishAndReleaseAll()
    }

    @Test
    fun `persistent refresh direct context traverses only the encoder side`() {
        val projectCalls = AtomicInteger()
        val fixture = fixture(
            runtime = runtime(
                ItemProjector {
                    projectCalls.incrementAndGet()
                    ProjectionResult.Rendered(
                        RenderedDisplay(
                            displayName = RenderedText.plain("Direct context projection"),
                            lore = emptyList(),
                        ),
                    )
                },
            ),
        )
        fixture.handler.bindViewer(VIEWER_ID)
        val events = ArrayList<String>()
        val encoderProbe = OutboundProbe("encoder", events)
        val tailProbe = OutboundProbe("tail", events)
        fixture.channel.pipeline().addBefore(HANDLER_NAME, "encoder_probe", encoderProbe)
        fixture.channel.pipeline().addAfter(HANDLER_NAME, "tail_probe", tailProbe)
        fixture.channel.pipeline().write(metadata(41, "cached"))
        fixture.channel.pipeline().flush()
        fixture.channel.runPendingTasks()
        drainOutbound(fixture.channel)

        events.clear()
        encoderProbe.reset()
        tailProbe.reset()
        projectCalls.set(0)
        fixture.handler.startPersistentRefreshForTest(activeContainerId = 0)
        fixture.channel.runPendingTasks()

        assertEquals(listOf("encoder.write", "encoder.flush"), events)
        assertEquals(1, encoderProbe.writeCount)
        assertEquals(1, encoderProbe.flushCount)
        assertEquals(0, tailProbe.writeCount)
        assertEquals(0, tailProbe.flushCount)
        assertEquals(0, fixture.connectionSendCount)
        assertEquals(1, projectCalls.get())
        assertNotNull(fixture.channel.readOutbound<ClientboundSetEntityDataPacket>())

        events.clear()
        encoderProbe.reset()
        tailProbe.reset()
        projectCalls.set(0)
        fixture.channel.pipeline().write(
            ClientboundContainerSetSlotPacket(2, 4, 1, canonicalStack()),
        )
        fixture.channel.pipeline().flush()
        fixture.channel.runPendingTasks()

        assertEquals(
            listOf("tail.write", "encoder.write", "tail.flush", "encoder.flush"),
            events,
        )
        assertEquals(1, encoderProbe.writeCount)
        assertEquals(1, encoderProbe.flushCount)
        assertEquals(1, tailProbe.writeCount)
        assertEquals(1, tailProbe.flushCount)
        assertEquals(0, fixture.connectionSendCount)
        assertEquals(1, projectCalls.get())
        assertNotNull(fixture.channel.readOutbound<ClientboundContainerSetSlotPacket>())
        fixture.channel.finishAndReleaseAll()
    }

    @Test
    fun `persistent refresh cache packet allowlist retains default packet dispatch hooks`() {
        val hooks = mapOf(
            "onPacketDispatch" to listOf<Class<*>>(ServerPlayer::class.java),
            "onPacketDispatchFinish" to listOf<Class<*>>(ServerPlayer::class.java, ChannelFuture::class.java),
            "hasFinishListener" to emptyList(),
            "getExtraPackets" to emptyList(),
            "isReady" to emptyList(),
            "isTerminal" to emptyList(),
        )
        val packetTypes = listOf(
            ClientboundSetEntityDataPacket::class.java,
            ClientboundSetEquipmentPacket::class.java,
            ClientboundPlaceGhostRecipePacket::class.java,
        )

        packetTypes.forEach { packetType ->
            hooks.forEach { (name, parameters) ->
                val method = packetType.getMethod(name, *parameters.toTypedArray())
                assertEquals(
                    Packet::class.java,
                    method.declaringClass,
                    "${packetType.simpleName}.$name no longer uses the Packet default",
                )
            }
        }
    }

    @Test
    fun `paged refresh coalesces a later-page replacement and still replays its untouched peer`() {
        val epoch = AtomicLong(1)
        val fixture = fixture(runtime = revisionRuntime(epoch))
        fixture.handler.bindViewer(VIEWER_ID)
        repeat(66) { entityId ->
            fixture.channel.pipeline().write(metadata(entityId, "A-$entityId"))
        }
        fixture.channel.pipeline().flush()
        fixture.channel.runPendingTasks()
        drainOutbound(fixture.channel)

        val revision = fixture.state.persistentSurfaceRevision()
        fixture.handler.startPersistentRefreshForTest(activeContainerId = 0)
        fixture.channel.runPendingTasks()
        assertEquals(revision, fixture.state.persistentSurfaceRevision())
        assertEquals((0 until 64).toSet(), entityPackets(drainOutbound(fixture.channel)).map { it.id() }.toSet())

        epoch.set(2)
        fixture.channel.pipeline().write(metadata(64, "B-64"))
        fixture.channel.pipeline().flush()
        fixture.channel.runPendingTasks()
        val replacementRevision = fixture.state.persistentSurfaceRevision()
        val afterReplacement = ArrayList<Any>()
        afterReplacement.addAll(drainOutbound(fixture.channel))

        advanceRefreshPage(fixture.channel)
        afterReplacement.addAll(drainOutbound(fixture.channel))
        advanceRefreshPage(fixture.channel)
        afterReplacement.addAll(drainOutbound(fixture.channel))

        val refreshed = entityPackets(afterReplacement)
        assertTrue(refreshed.filter { it.id() == 64 }.isNotEmpty())
        assertTrue(refreshed.filter { it.id() == 64 }.all { entityItemName(it) == "2:B-64" })
        assertTrue(refreshed.any { it.id() == 65 && entityItemName(it) == "2:A-65" })
        assertEquals(replacementRevision, fixture.state.persistentSurfaceRevision())
        assertEquals(0, fixture.connectionSendCount)
        fixture.channel.finishAndReleaseAll()
    }

    @Test
    fun `paged refresh coalesces a later-page removal without losing its untouched peer`() {
        val epoch = AtomicLong(1)
        val fixture = fixture(runtime = revisionRuntime(epoch))
        fixture.handler.bindViewer(VIEWER_ID)
        repeat(66) { entityId ->
            fixture.channel.pipeline().write(metadata(entityId, "A-$entityId"))
        }
        fixture.channel.pipeline().flush()
        fixture.channel.runPendingTasks()
        drainOutbound(fixture.channel)

        fixture.handler.startPersistentRefreshForTest(activeContainerId = 0)
        fixture.channel.runPendingTasks()
        drainOutbound(fixture.channel)

        epoch.set(2)
        fixture.channel.pipeline().write(ClientboundRemoveEntitiesPacket(64))
        fixture.channel.pipeline().flush()
        fixture.channel.runPendingTasks()
        val removalRevision = fixture.state.persistentSurfaceRevision()
        drainOutbound(fixture.channel)

        val afterRemoval = ArrayList<Any>()
        advanceRefreshPage(fixture.channel)
        afterRemoval.addAll(drainOutbound(fixture.channel))
        advanceRefreshPage(fixture.channel)
        afterRemoval.addAll(drainOutbound(fixture.channel))

        val refreshed = entityPackets(afterRemoval)
        assertTrue(refreshed.none { it.id() == 64 })
        assertTrue(refreshed.any { it.id() == 65 && entityItemName(it) == "2:A-65" })
        assertEquals(removalRevision, fixture.state.persistentSurfaceRevision())
        assertEquals(0, fixture.connectionSendCount)
        fixture.channel.finishAndReleaseAll()
    }

    @Test
    fun `continuous page churn coalesces to the latest source and eventually completes`() {
        val epoch = AtomicLong(1)
        val fixture = fixture(runtime = revisionRuntime(epoch))
        fixture.handler.bindViewer(VIEWER_ID)
        repeat(66) { entityId ->
            fixture.channel.pipeline().write(metadata(entityId, "A-$entityId"))
        }
        fixture.channel.pipeline().flush()
        fixture.channel.runPendingTasks()
        drainOutbound(fixture.channel)

        fixture.handler.startPersistentRefreshForTest(activeContainerId = 0)
        fixture.channel.runPendingTasks()
        drainOutbound(fixture.channel)

        epoch.set(2)
        fixture.channel.pipeline().write(metadata(64, "B-64"))
        fixture.channel.pipeline().flush()
        fixture.channel.runPendingTasks()
        drainOutbound(fixture.channel)

        epoch.set(3)
        fixture.channel.pipeline().write(metadata(64, "C-64"))
        fixture.channel.pipeline().flush()
        fixture.channel.runPendingTasks()
        val latestRevision = fixture.state.persistentSurfaceRevision()
        drainOutbound(fixture.channel)

        val afterLatestMutation = ArrayList<Any>()
        advanceRefreshPage(fixture.channel)
        afterLatestMutation.addAll(drainOutbound(fixture.channel))
        advanceRefreshPage(fixture.channel)
        afterLatestMutation.addAll(drainOutbound(fixture.channel))

        val refreshed = entityPackets(afterLatestMutation)
        assertTrue(refreshed.filter { it.id() == 64 }.isNotEmpty())
        assertTrue(refreshed.filter { it.id() == 64 }.all { entityItemName(it) == "3:C-64" })
        assertTrue(refreshed.any { it.id() == 65 && entityItemName(it) == "3:A-65" })
        assertEquals(latestRevision, fixture.state.persistentSurfaceRevision())
        assertEquals(0, fixture.connectionSendCount)
        fixture.channel.finishAndReleaseAll()
    }

    @Test
    fun `paged refresh coalesces a ghost replacement and never replays the old ghost`() {
        val epoch = AtomicLong(1)
        val fixture = fixture(runtime = revisionRuntime(epoch))
        fixture.handler.bindViewer(VIEWER_ID)
        repeat(64) { entityId ->
            fixture.channel.pipeline().write(metadata(entityId, "entity-$entityId"))
        }
        fixture.channel.pipeline().write(ghostRecipe(12, "A-ghost"))
        fixture.channel.pipeline().flush()
        fixture.channel.runPendingTasks()
        drainOutbound(fixture.channel)

        fixture.handler.startPersistentRefreshForTest(activeContainerId = 12)
        fixture.channel.runPendingTasks()
        drainOutbound(fixture.channel)

        epoch.set(2)
        fixture.channel.pipeline().write(ghostRecipe(12, "B-ghost"))
        fixture.channel.pipeline().flush()
        fixture.channel.runPendingTasks()
        val replacementRevision = fixture.state.persistentSurfaceRevision()
        val afterReplacement = ArrayList<Any>()
        afterReplacement.addAll(drainOutbound(fixture.channel))
        advanceRefreshPage(fixture.channel)
        afterReplacement.addAll(drainOutbound(fixture.channel))
        advanceRefreshPage(fixture.channel)
        afterReplacement.addAll(drainOutbound(fixture.channel))

        val ghosts = afterReplacement.filterIsInstance<ClientboundPlaceGhostRecipePacket>()
        assertTrue(ghosts.isNotEmpty())
        assertTrue(ghosts.all { ghostItemName(it) == "2:B-ghost" })
        assertEquals(replacementRevision, fixture.state.persistentSurfaceRevision())
        assertEquals(0, fixture.connectionSendCount)
        fixture.channel.finishAndReleaseAll()
    }

    @Test
    fun `newer persistent refresh generation cancels the older delayed page`() {
        val epoch = AtomicLong(1)
        val fixture = fixture(runtime = revisionRuntime(epoch))
        fixture.handler.bindViewer(VIEWER_ID)
        repeat(64) { entityId ->
            fixture.channel.pipeline().write(metadata(entityId, "entity-$entityId"))
        }
        fixture.channel.pipeline().write(ghostRecipe(12, "ghost"))
        fixture.channel.pipeline().flush()
        fixture.channel.runPendingTasks()
        drainOutbound(fixture.channel)

        val revision = fixture.state.persistentSurfaceRevision()
        fixture.handler.startPersistentRefreshForTest(activeContainerId = 12)
        fixture.channel.runPendingTasks()
        drainOutbound(fixture.channel)
        fixture.handler.startPersistentRefreshForTest(activeContainerId = 12)
        fixture.channel.runPendingTasks()
        drainOutbound(fixture.channel)
        assertEquals(revision, fixture.state.persistentSurfaceRevision())

        advanceRefreshPage(fixture.channel)
        val ghosts = drainOutbound(fixture.channel).filterIsInstance<ClientboundPlaceGhostRecipePacket>()
        assertEquals(1, ghosts.size)
        assertEquals("1:ghost", ghostItemName(ghosts.single()))
        assertEquals(revision, fixture.state.persistentSurfaceRevision())
        assertEquals(0, fixture.connectionSendCount)
        fixture.channel.finishAndReleaseAll()
    }

    @Test
    fun `renderer exception sends canonical fallback without dropping the packet`() {
        val fixture = fixture(
            runtime = runtime(
                ItemProjector { throw IllegalArgumentException("invalid rendered definition") },
            ),
        )
        fixture.handler.bindViewer(VIEWER_ID)
        val source = ClientboundContainerSetSlotPacket(2, 4, 1, canonicalStack())
        val promise = fixture.channel.newPromise()

        fixture.channel.pipeline().write(source, promise)
        fixture.channel.pipeline().flush()
        fixture.channel.runPendingTasks()

        assertTrue(promise.isSuccess)
        val fallback = fixture.channel.readOutbound<ClientboundContainerSetSlotPacket>()
        assertNotNull(fallback)
        assertFalse(fallback.item.get(DataComponents.CUSTOM_DATA)?.contains(NmsCanonicalItemCodec.ROOT_KEY) == true)
        assertTrue(source.item.get(DataComponents.CUSTOM_DATA)?.contains(NmsCanonicalItemCodec.ROOT_KEY) == true)
        assertNull(fixture.terminal.failure())
        fixture.channel.finishAndReleaseAll()
    }

    @Test
    fun `packet item budget exhaustion sanitizes every item and does not publish partial capabilities`() {
        val fixture = fixture()
        fixture.handler.bindViewer(VIEWER_ID)
        val canonicalItems = List(257) { canonicalStack() }
        val source = ClientboundContainerSetContentPacket(2, 4, canonicalItems, ItemStack.EMPTY)
        val promise = fixture.channel.newPromise()

        fixture.channel.pipeline().write(source, promise)
        fixture.channel.pipeline().flush()
        fixture.channel.runPendingTasks()

        assertTrue(promise.isSuccess)
        val fallback = fixture.channel.readOutbound<ClientboundContainerSetContentPacket>()
        assertEquals(257, fallback.items().size)
        fallback.items().forEach { item ->
            assertFalse(item.get(DataComponents.CUSTOM_DATA)?.contains(NmsCanonicalItemCodec.ROOT_KEY) == true)
            assertFalse(item.get(DataComponents.CUSTOM_DATA)?.contains(NmsViewTokenCodec.VIEW_KEY) == true)
        }
        canonicalItems.forEach { item ->
            assertTrue(item.get(DataComponents.CUSTOM_DATA)?.contains(NmsCanonicalItemCodec.ROOT_KEY) == true)
        }
        assertNull(fixture.terminal.failure())
        fixture.channel.finishAndReleaseAll()
    }

    @Test
    fun `canonical fallback hard limit fails closed without writing the raw carrier`() {
        val fixture = fixture()
        fixture.handler.bindViewer(VIEWER_ID)
        val source = ClientboundContainerSetContentPacket(
            2,
            4,
            List(8_193) { canonicalStack() },
            ItemStack.EMPTY,
        )
        val promise = fixture.channel.newPromise()

        fixture.channel.pipeline().write(source, promise)
        fixture.channel.pipeline().flush()
        fixture.channel.runPendingTasks()

        assertFalse(promise.isSuccess)
        assertTrue(promise.cause() is NmsProjectionInfrastructureException)
        assertNotNull(fixture.terminal.failure())
        assertNull(fixture.channel.readOutbound<Any>())
        assertHasCanonicalRoot(source.items().first())
        assertHasCanonicalRoot(source.items().last())
        fixture.channel.finishAndReleaseAll()
    }

    @Test
    fun `merchant limit fallback rebuilds the whole carrier without leaking canonical roots`() {
        val fixture = fixture()
        fixture.handler.bindViewer(VIEWER_ID)
        val offers = MerchantOffers().also { result ->
            repeat(129) {
                val cost = canonicalStack()
                val output = canonicalStack()
                result += MerchantOffer(
                    itemCost(cost),
                    java.util.Optional.empty(),
                    output,
                    0,
                    7,
                    1,
                    0.0F,
                    0,
                )
            }
        }
        val source = ClientboundMerchantOffersPacket(5, offers, 1, 0, false, false)
        val promise = fixture.channel.newPromise()

        fixture.channel.pipeline().write(source, promise)
        fixture.channel.pipeline().flush()
        fixture.channel.runPendingTasks()

        assertTrue(promise.isSuccess)
        val fallback = fixture.channel.readOutbound<ClientboundMerchantOffersPacket>()
        assertEquals(129, fallback.offers.size)
        fallback.offers.forEach { offer ->
            assertNoCanonicalRoot(offer.baseCostA.itemStack())
            assertNoCanonicalRoot(offer.result)
            assertFalse(offer.baseCostA.itemStack().get(DataComponents.CUSTOM_DATA)
                ?.contains(NmsViewTokenCodec.VIEW_KEY) == true)
            assertFalse(offer.result.get(DataComponents.CUSTOM_DATA)
                ?.contains(NmsViewTokenCodec.VIEW_KEY) == true)
        }
        assertHasCanonicalRoot(source.offers.first().baseCostA.itemStack())
        assertHasCanonicalRoot(source.offers.first().result)
        assertNull(fixture.terminal.failure())
        fixture.channel.finishAndReleaseAll()
    }

    @Test
    fun `deep entity component and dialog fallbacks remain exhaustive and keep the runtime active`() {
        val fixture = fixture()
        fixture.handler.bindViewer(VIEWER_ID)
        val entityComponent = deepHoverCarrier()
        val chatComponent = deepHoverCarrier()
        val dialogComponent = deepHoverCarrier()
        val packets = listOf(
            ClientboundSetEntityDataPacket(
                42,
                listOf(SynchedEntityData.DataValue(6, EntityDataSerializers.COMPONENT, entityComponent)),
            ),
            ClientboundSystemChatPacket(chatComponent, false),
            ClientboundShowDialogPacket(
                Holder.direct<Dialog>(
                    NoticeDialog(
                        CommonDialogData(
                            dialogComponent,
                            java.util.Optional.empty(),
                            true,
                            false,
                            DialogAction.CLOSE,
                            emptyList(),
                            emptyList(),
                        ),
                        ActionButton(
                            CommonButtonData(Component.literal("close"), java.util.Optional.empty(), 150),
                            java.util.Optional.empty(),
                        ),
                    ),
                ),
            ),
        )

        packets.forEach { source ->
            val promise = fixture.channel.newPromise()
            fixture.channel.pipeline().write(source, promise)
            fixture.channel.pipeline().flush()
            fixture.channel.runPendingTasks()
            assertTrue(promise.isSuccess)
        }

        val entity = fixture.channel.readOutbound<ClientboundSetEntityDataPacket>()
        val entityResult = entity.packedItems().single().value() as Component
        assertNoCanonicalRoot(requireShownItem(entityResult))
        val chat = fixture.channel.readOutbound<ClientboundSystemChatPacket>()
        assertNoCanonicalRoot(requireShownItem(chat.content()))
        val dialog = fixture.channel.readOutbound<ClientboundShowDialogPacket>()
        val notice = dialog.dialog().value() as NoticeDialog
        assertNoCanonicalRoot(requireShownItem(notice.common().title()))

        assertHasCanonicalRoot(requireShownItem(entityComponent))
        assertHasCanonicalRoot(requireShownItem(chatComponent))
        assertHasCanonicalRoot(requireShownItem(dialogComponent))
        assertNull(fixture.terminal.failure())
        fixture.channel.finishAndReleaseAll()
    }

    @Test
    fun `nbt and structured entry limits rebuild every encoded carrier through fallback`() {
        val fixture = fixture()
        fixture.handler.bindViewer(VIEWER_ID)
        val encodedForQuery = encodedCanonicalStack()
        val list = ListTag().apply {
            add(encodedForQuery)
            repeat(4_096) { add(IntTag.valueOf(it)) }
        }
        val querySource = ClientboundTagQueryPacket(
            73,
            CompoundTag().apply { put("values", list) },
        )
        val registryEntries = List(4_097) { index ->
            RegistrySynchronization.PackedRegistryEntry(
                Identifier.fromNamespaceAndPath("itemerness", "fallback_$index"),
                java.util.Optional.of(
                    CompoundTag().apply { put("item", encodedCanonicalStack()) },
                ),
            )
        }
        val registrySource = ClientboundRegistryDataPacket(Registries.DIALOG, registryEntries)

        listOf(querySource, registrySource).forEach { source ->
            val promise = fixture.channel.newPromise()
            fixture.channel.pipeline().write(source, promise)
            fixture.channel.pipeline().flush()
            fixture.channel.runPendingTasks()
            assertTrue(promise.isSuccess)
        }

        val query = fixture.channel.readOutbound<ClientboundTagQueryPacket>()
        val queryItem = ((query.tag!!.get("values") as ListTag)[0] as CompoundTag)
        assertNoCanonicalRoot(decodeStack(queryItem))
        val registry = fixture.channel.readOutbound<ClientboundRegistryDataPacket>()
        assertEquals(4_097, registry.entries().size)
        listOf(registry.entries().first(), registry.entries().last()).forEach { entry ->
            val item = (entry.data().orElseThrow() as CompoundTag).get("item") as CompoundTag
            assertNoCanonicalRoot(decodeStack(item))
        }

        assertHasCanonicalRoot(decodeStack(encodedForQuery))
        val sourceRegistryItem = (registryEntries.first().data().orElseThrow() as CompoundTag)
            .get("item") as CompoundTag
        assertHasCanonicalRoot(decodeStack(sourceRegistryItem))
        assertNull(fixture.terminal.failure())
        fixture.channel.finishAndReleaseAll()
    }

    @Test
    fun `recoverable capability commit failure falls back atomically and keeps later writes active`() {
        val fixture = fixture(customClickCapacity = 1)
        fixture.handler.bindViewer(VIEWER_ID)
        val seedId = Identifier.fromNamespaceAndPath("itemerness", "seed-capability")
        val seedWire = fixture.state.registerDirect(
            seedId,
            IntTag.valueOf(1),
            IntTag.valueOf(2),
            ProjectionGeneration(catalogRevision = 1, epoch = 1),
        )
        val overflowId = Identifier.fromNamespaceAndPath("itemerness", "overflow-capability")
        val payload = CompoundTag().apply { put("item", encodedCanonicalStack()) }
        val dialog = ClientboundShowDialogPacket(
            Holder.direct<Dialog>(
                NoticeDialog(
                    CommonDialogData(
                        Component.literal("overflow"),
                        java.util.Optional.empty(),
                        true,
                        false,
                        DialogAction.CLOSE,
                        emptyList(),
                        emptyList(),
                    ),
                    ActionButton(
                        CommonButtonData(Component.literal("submit"), java.util.Optional.empty(), 150),
                        java.util.Optional.of(
                            StaticAction(ClickEvent.Custom(overflowId, java.util.Optional.of(payload))),
                        ),
                    ),
                ),
            ),
        )
        val sourceItem = canonicalStack()
        val source = ClientboundBundlePacket(
            listOf<Packet<in ClientGamePacketListener>>(
                ClientboundContainerSetSlotPacket(2, 4, 1, sourceItem),
                dialog,
            ),
        )
        val promise = fixture.channel.newPromise()

        fixture.channel.pipeline().write(source, promise)
        fixture.channel.pipeline().flush()
        fixture.channel.runPendingTasks()

        assertTrue(promise.isSuccess)
        val fallback = fixture.channel.readOutbound<ClientboundBundlePacket>()
        val packets = fallback.subPackets().toList()
        val fallbackItem = (packets[0] as ClientboundContainerSetSlotPacket).item
        assertNoCanonicalRoot(fallbackItem)
        assertFalse(fallbackItem.get(DataComponents.CUSTOM_DATA)?.contains(NmsViewTokenCodec.VIEW_KEY) == true)
        val fallbackDialog = (packets[1] as ClientboundShowDialogPacket).dialog().value() as NoticeDialog
        val action = fallbackDialog.action().action().orElseThrow() as StaticAction
        val click = action.value() as ClickEvent.Custom
        val fallbackPayload = click.payload().orElseThrow() as CompoundTag
        assertTrue(fallbackPayload.contains(NmsCustomClickTokenCodec.ACTION_KEY))
        assertTrue(NmsCustomClickTokenCodec.read(fallbackPayload) is CustomClickTokenResult.Malformed)
        assertNull(fallbackPayload.get("item"), "Direct fallback must discard the canonical payload")
        assertHasCanonicalRoot(sourceItem)
        assertHasCanonicalRoot(decodeStack(payload.get("item") as CompoundTag))
        assertTrue(fixture.state.restoreCustomClick(seedId, java.util.Optional.of(seedWire)) is
            CustomClickRestoreResult.Restored)
        assertNull(fixture.terminal.failure())

        val inbound = NmsInboundPacketProjector(fixture.state, ProjectionResyncSink.REJECTING)
        val originalDecision = inbound.project(
            ServerboundCustomClickActionPacket(overflowId, java.util.Optional.of(fallbackPayload.copy())),
            VIEWER_ID,
        )
        assertTrue(originalDecision is InboundPacketDecision.RejectCustomClick)
        val tampered = fallbackPayload.copy().apply { putString("forged", "client-value") }
        val tamperedDecision = inbound.project(
            ServerboundCustomClickActionPacket(overflowId, java.util.Optional.of(tampered)),
            VIEWER_ID,
        )
        assertTrue(tamperedDecision is InboundPacketDecision.RejectCustomClick)
        val markerRemoved = fallbackPayload.copy().apply {
            remove(NmsCustomClickTokenCodec.ACTION_KEY)
            putString("forged", "client-value")
        }
        val removedDecision = inbound.project(
            ServerboundCustomClickActionPacket(overflowId, java.util.Optional.of(markerRemoved)),
            VIEWER_ID,
        )
        assertTrue(removedDecision is InboundPacketDecision.RejectCustomClick)

        val laterPromise = fixture.channel.newPromise()
        fixture.channel.pipeline().write(
            ClientboundContainerSetSlotPacket(2, 5, 1, canonicalStack()),
            laterPromise,
        )
        fixture.channel.pipeline().flush()
        fixture.channel.runPendingTasks()
        assertTrue(laterPromise.isSuccess)
        assertEquals(
            "Projected login item",
            fixture.channel.readOutbound<ClientboundContainerSetSlotPacket>().item.itemName.string,
        )
        fixture.channel.finishAndReleaseAll()
    }

    @Test
    fun `custom all capacity fallback sanitizes additions and rejects marker removal`() {
        val fixture = fixture(customClickCapacity = 1)
        fixture.handler.bindViewer(VIEWER_ID)
        fixture.state.registerDirect(
            Identifier.fromNamespaceAndPath("itemerness", "seed-additions-capability"),
            IntTag.valueOf(1),
            IntTag.valueOf(2),
            ProjectionGeneration(catalogRevision = 1, epoch = 1),
        )
        val overflowId = Identifier.fromNamespaceAndPath("itemerness", "overflow-additions-capability")
        val canonicalAdditions = CompoundTag().apply { put("item", encodedCanonicalStack()) }
        val source = ClientboundShowDialogPacket(
            Holder.direct<Dialog>(
                NoticeDialog(
                    CommonDialogData(
                        Component.literal("overflow additions"),
                        java.util.Optional.empty(),
                        true,
                        false,
                        DialogAction.CLOSE,
                        emptyList(),
                        emptyList(),
                    ),
                    ActionButton(
                        CommonButtonData(Component.literal("submit"), java.util.Optional.empty(), 150),
                        java.util.Optional.of(CustomAll(overflowId, java.util.Optional.of(canonicalAdditions))),
                    ),
                ),
            ),
        )
        val promise = fixture.channel.newPromise()

        fixture.channel.pipeline().write(source, promise)
        fixture.channel.pipeline().flush()
        fixture.channel.runPendingTasks()

        assertTrue(promise.isSuccess)
        val fallback = fixture.channel.readOutbound<ClientboundShowDialogPacket>()
        val notice = fallback.dialog().value() as NoticeDialog
        val action = notice.action().action().orElseThrow() as CustomAll
        val additions = action.additions().orElseThrow()
        assertTrue(NmsCustomClickTokenCodec.read(additions) is CustomClickTokenResult.Malformed)
        assertNoCanonicalRoot(decodeStack(additions.get("item") as CompoundTag))
        assertHasCanonicalRoot(decodeStack(canonicalAdditions.get("item") as CompoundTag))

        val inbound = NmsInboundPacketProjector(fixture.state, ProjectionResyncSink.REJECTING)
        val originalDecision = inbound.project(
            ServerboundCustomClickActionPacket(overflowId, java.util.Optional.of(additions.copy())),
            VIEWER_ID,
        )
        assertTrue(originalDecision is InboundPacketDecision.RejectCustomClick)
        val markerRemoved = additions.copy().apply {
            remove(NmsCustomClickTokenCodec.ACTION_KEY)
            putString("player_input", "forged")
        }
        val removedDecision = inbound.project(
            ServerboundCustomClickActionPacket(overflowId, java.util.Optional.of(markerRemoved)),
            VIEWER_ID,
        )
        assertTrue(removedDecision is InboundPacketDecision.RejectCustomClick)
        assertNull(fixture.terminal.failure())
        fixture.channel.finishAndReleaseAll()
    }

    @Test
    fun `hash infrastructure unknown runtime and linkage failures poison the runtime`() {
        val failures = listOf<Throwable>(
            NmsProjectionInfrastructureException("hash infrastructure"),
            IllegalStateException("unexpected hash runtime"),
            NoSuchMethodError("hash ABI drift"),
        )
        failures.forEach { failure ->
            val fixture = fixture(hasher = HashedPatchMap.HashGenerator { throw failure })
            fixture.handler.bindViewer(VIEWER_ID)
            val promise = fixture.channel.newPromise()

            fixture.channel.pipeline().write(
                ClientboundContainerSetSlotPacket(2, 4, 1, canonicalStack()),
                promise,
            )
            fixture.channel.pipeline().flush()
            fixture.channel.runPendingTasks()

            assertFalse(promise.isSuccess)
            val boundaryFailure = promise.cause()
            if (failure is IllegalStateException && failure !is NmsProjectionInfrastructureException) {
                assertTrue(boundaryFailure is NmsProjectionInfrastructureException)
                assertSame(failure, boundaryFailure.cause)
            } else {
                assertSame(failure, boundaryFailure)
            }
            assertSame(boundaryFailure, fixture.terminal.failure()?.cause)
            assertNull(fixture.channel.readOutbound<Any>())
            fixture.channel.finishAndReleaseAll()
        }
    }

    @Test
    fun `linkage error at the projection boundary poisons the whole runtime`() {
        val failure = NoSuchMethodError("simulated exact ABI drift")
        val fixture = fixture(
            runtime = runtime(
                ItemProjector { throw failure },
            ),
        )
        fixture.handler.bindViewer(VIEWER_ID)
        val promise = fixture.channel.newPromise()

        fixture.channel.pipeline().write(
            ClientboundContainerSetSlotPacket(2, 4, 1, canonicalStack()),
            promise,
        )
        fixture.channel.runPendingTasks()

        assertFalse(promise.isSuccess)
        assertSame(failure, promise.cause())
        assertSame(failure, fixture.terminal.failure()?.cause)
        assertEquals("project an outbound packet", fixture.terminal.failure()?.operation)
        assertNull(fixture.channel.readOutbound<Any>())
        fixture.channel.finishAndReleaseAll()
    }

    @Test
    fun `viewer unbind keeps the channel tracked and permits a later owning-context rebind`() {
        val fixture = fixture()
        fixture.handler.bindViewer(VIEWER_ID)

        fixture.handler.unbindViewer(VIEWER_ID)

        assertEquals(1, fixture.unboundCount)
        assertEquals(0, fixture.removedCount)
        assertNotNull(fixture.channel.pipeline().get(HANDLER_NAME))
        fixture.handler.bindViewer(VIEWER_ID)
        assertTrue(fixture.resolved)
        fixture.channel.finishAndReleaseAll()
        assertEquals(1, fixture.removedCount)
    }

    @Test
    fun `terminal poison drops carriers but allows unrelated protocol packets until removal`() {
        val fixture = fixture()
        fixture.handler.bindViewer(VIEWER_ID)
        fixture.terminal.poison("test poison", IllegalStateException("poisoned"))

        val carrierPromise = fixture.channel.newPromise()
        fixture.channel.pipeline().write(
            ClientboundContainerSetSlotPacket(2, 5, 1, canonicalStack()),
            carrierPromise,
        )
        val keepAlivePromise = fixture.channel.newPromise()
        fixture.channel.pipeline().write(ClientboundKeepAlivePacket(19L), keepAlivePromise)
        fixture.channel.pipeline().flush()
        fixture.channel.runPendingTasks()

        assertFalse(carrierPromise.isSuccess)
        assertTrue(keepAlivePromise.isSuccess)
        assertTrue(fixture.channel.readOutbound<Any>() is ClientboundKeepAlivePacket)
        assertNull(fixture.channel.readOutbound<Any>())
        fixture.channel.finishAndReleaseAll()
    }

    @Test
    fun `restart slot rejects active owner and replaces only a confirmed retired owner`() {
        val fixture = fixture()
        val replacementOwner = NmsProjectionHandlerOwner().also(NmsProjectionHandlerOwner::activate)

        assertThrows(IllegalStateException::class.java) {
            NmsProjectionHandlerSlot.prepare(fixture.channel.pipeline(), HANDLER_NAME, replacementOwner)
        }
        assertSame(fixture.handler, fixture.channel.pipeline().get(HANDLER_NAME))

        fixture.owner.beginRetirement()
        fixture.owner.completeRetirement()
        closeChannelsAndAwait(listOf(fixture.channel), timeoutSeconds = 1)
        assertFalse(NmsProjectionHandlerSlot.prepare(fixture.channel.pipeline(), HANDLER_NAME, replacementOwner))
        assertNull(fixture.channel.pipeline().get(HANDLER_NAME))
        assertEquals(1, fixture.removedCount)
        fixture.channel.finishAndReleaseAll()
    }

    @Test
    fun `restart slot rejects a failed retirement and close removal verifies the owning handler`() {
        val fixture = fixture()
        val replacementOwner = NmsProjectionHandlerOwner().also(NmsProjectionHandlerOwner::activate)
        fixture.owner.beginRetirement()
        fixture.owner.failRetirement()

        assertThrows(IllegalStateException::class.java) {
            NmsProjectionHandlerSlot.prepare(fixture.channel.pipeline(), HANDLER_NAME, replacementOwner)
        }
        assertSame(fixture.handler, fixture.channel.pipeline().get(HANDLER_NAME))

        NmsProjectionHandlerSlot.removeOwned(fixture.channel.pipeline(), HANDLER_NAME, replacementOwner)
        assertSame(fixture.handler, fixture.channel.pipeline().get(HANDLER_NAME))
        closeChannelsAndAwait(listOf(fixture.channel), timeoutSeconds = 1)
        NmsProjectionHandlerSlot.removeOwned(fixture.channel.pipeline(), HANDLER_NAME, fixture.owner)
        assertNull(fixture.channel.pipeline().get(HANDLER_NAME))
        fixture.channel.finishAndReleaseAll()
    }

    @Test
    fun `terminal publication is single shot even when the lifecycle sink rejects it`() {
        var offers = 0
        val terminal = NmsProjectionTerminal(ProjectionFailureSink { offers++; false })
        val first = terminal.poison("first", IllegalStateException("first"))
        val duplicate = terminal.poison("second", IllegalStateException("second"))

        assertNotNull(first)
        assertNull(duplicate)
        assertSame(first, terminal.failure())
        assertEquals(1, offers)
    }

    @Test
    fun `retirement closes an active channel before handler removal and cannot expose a carrier`() {
        val fixture = fixture()
        fixture.handler.bindViewer(VIEWER_ID)
        fixture.owner.beginRetirement()

        val guarded = fixture.channel.newPromise()
        fixture.channel.pipeline().write(
            ClientboundContainerSetSlotPacket(2, 5, 1, canonicalStack()),
            guarded,
        )
        fixture.channel.runPendingTasks()
        assertFalse(guarded.isSuccess)
        assertNull(fixture.channel.readOutbound<Any>())

        closeChannelsAndAwait(listOf(fixture.channel), timeoutSeconds = 1)
        assertFalse(fixture.channel.isActive)
        NmsProjectionHandlerSlot.removeOwned(fixture.channel.pipeline(), HANDLER_NAME, fixture.owner)
        fixture.owner.completeRetirement()
        assertNull(fixture.channel.pipeline().get(HANDLER_NAME))

        val afterRemoval = fixture.channel.newPromise()
        fixture.channel.pipeline().write(
            ClientboundContainerSetSlotPacket(2, 6, 1, canonicalStack()),
            afterRemoval,
        )
        fixture.channel.runPendingTasks()
        assertFalse(afterRemoval.isSuccess)
        assertNull(fixture.channel.readOutbound<Any>())
        fixture.channel.finishAndReleaseAll()
    }

    @Test
    fun `unexpected removal from an active channel poisons the projection runtime`() {
        val fixture = fixture()

        fixture.channel.pipeline().remove(fixture.handler)

        assertNotNull(fixture.terminal.failure())
        assertEquals("retain a channel handler", fixture.terminal.failure()?.operation)
        assertEquals(1, fixture.removedCount)
        assertFalse(fixture.channel.isActive, "An untracked active channel must be closed immediately")
        val promise = fixture.channel.newPromise()
        fixture.channel.pipeline().write(
            ClientboundContainerSetSlotPacket(2, 5, 1, canonicalStack()),
            promise,
        )
        fixture.channel.runPendingTasks()
        assertFalse(promise.isSuccess)
        assertNull(fixture.channel.readOutbound<Any>())
        fixture.channel.finishAndReleaseAll()
    }

    @Test
    fun `refresh boundary poisons on nonfatal ABI failure and rethrows fatal VM errors`() {
        val viewerId = UUID.randomUUID()
        val linkage = NoSuchMethodError("refresh ABI drift")
        var operation: String? = null
        var reported: Throwable? = null

        runProjectionRefreshBoundary(
            viewerId = viewerId,
            refresh = { throw linkage },
            failure = { name, cause ->
                operation = name
                reported = cause
            },
        )

        assertEquals("refresh viewer $viewerId", operation)
        assertSame(linkage, reported)

        val fatal = OutOfMemoryError("fatal refresh")
        val thrown = assertThrows(OutOfMemoryError::class.java) {
            runProjectionRefreshBoundary(
                viewerId = viewerId,
                refresh = { throw fatal },
                failure = { _, _ -> error("Fatal failures must not be reported asynchronously") },
            )
        }
        assertSame(fatal, thrown)
    }

    @Test
    fun `channel close cleans binding and publishes handler removal`() {
        val fixture = fixture()
        fixture.handler.bindViewer(VIEWER_ID)

        closeChannelsAndAwait(listOf(fixture.channel), timeoutSeconds = 1)

        assertEquals(1, fixture.unboundCount)
        assertEquals(1, fixture.removedCount)
        assertNull(fixture.channel.pipeline().get(HANDLER_NAME))
        fixture.channel.finishAndReleaseAll()
    }

    @Test
    fun `unbound login queue overflow closes the channel and fails every retained promise`() {
        val fixture = fixture()
        val promises = ArrayList<ChannelPromise>(513)
        repeat(513) { index ->
            val promise = fixture.channel.newPromise()
            promises += promise
            fixture.channel.pipeline().write(
                ClientboundContainerSetSlotPacket(2, index, 1, ItemStack(Items.STONE)),
                promise,
            )
        }
        fixture.channel.runPendingTasks()

        assertFalse(fixture.channel.isOpen)
        assertTrue(promises.all { it.isDone && !it.isSuccess })
        assertNull(fixture.channel.readOutbound<Any>())
        fixture.channel.finishAndReleaseAll()
    }

    private fun fixture(
        runtime: ProjectionRuntime = runtime(),
        customClickCapacity: Int = NmsConnectionProjectionState.DEFAULT_CUSTOM_CLICK_CAPACITY,
        hasher: HashedPatchMap.HashGenerator = HashedPatchMap.HashGenerator { component ->
            component.value().hashCode()
        },
        persistentEntityCapacity: Int = NmsConnectionProjectionState.DEFAULT_PERSISTENT_ENTITY_CAPACITY,
        terminal: NmsProjectionTerminal = NmsProjectionTerminal(),
    ): Fixture {
        val connection = TrackingConnection()
        connection.isPending = false
        val listenerField = Connection::class.java.getDeclaredField("packetListener").also { field ->
            check(field.trySetAccessible()) { "Cannot access Connection.packetListener" }
        }
        listenerField.set(connection, PlayPacketListener)
        val state = NmsConnectionProjectionState(
            connectionGeneration = 9,
            hasher = hasher,
            customClickCapacity = customClickCapacity,
            persistentEntityCapacity = persistentEntityCapacity,
            persistentWireSizer = NmsPersistentWireSizer.fixed(64),
            persistentPacketSnapshotter = NmsPersistentPacketSnapshotter { source ->
                NmsPersistentPacketSnapshot(source, 64)
            },
        )
        var resolved = false
        var unbound = 0
        var removed = 0
        val owner = NmsProjectionHandlerOwner().also(NmsProjectionHandlerOwner::activate)
        val handler = ProjectionChannelHandler(
            connection = connection,
            packetProjector = NmsOutboundPacketProjector(NmsItemStackProjector(runtime)),
            projectionState = state,
            resyncRequests = ProjectionResyncSink.REJECTING,
            owner = owner,
            terminal = terminal,
            viewerResolved = { _, _ -> resolved = true },
            viewerUnbound = { _, _ -> unbound++ },
            removed = { _, _ -> removed++ },
            terminalFailure = { operation, failure -> terminal.poison(operation, failure) },
            projectionEnabled = { true },
        )
        val channel = EmbeddedChannel()
        connection.channel = channel
        channel.pipeline().addLast(HANDLER_NAME, handler)
        return Fixture(
            channel,
            handler,
            owner,
            terminal,
            state,
            { resolved },
            { unbound },
            { removed },
            { connection.sendCalls },
        )
    }

    private fun runtime(
        projector: ItemProjector = ItemProjector {
            ProjectionResult.Rendered(
                RenderedDisplay(
                    displayName = RenderedText.plain("Projected login item"),
                    lore = emptyList(),
                ),
            )
        },
    ): ProjectionRuntime = ProjectionRuntime(
        projector = projector,
        contexts = ProjectionContextSource { viewerId ->
            if (viewerId != VIEWER_ID) null else ProjectionContext(
                ViewerProjectionSnapshot(
                    viewerId = viewerId,
                    revision = 1,
                    locale = LocaleId("en_us"),
                    theme = ItemKey.parse("itemerness:default"),
                    assetProfile = null,
                ),
                ProjectionGeneration(catalogRevision = 1, epoch = 1),
            )
        },
    )

    private fun revisionRuntime(epoch: AtomicLong): ProjectionRuntime = ProjectionRuntime(
        projector = ItemProjector { request ->
            ProjectionResult.Rendered(
                RenderedDisplay(
                    displayName = RenderedText.plain(
                        "${request.context.generation.epoch}:${request.canonical.pendingName}",
                    ),
                    lore = emptyList(),
                ),
            )
        },
        contexts = ProjectionContextSource { viewerId ->
            if (viewerId != VIEWER_ID) null else epoch.get().let { current ->
                ProjectionContext(
                    ViewerProjectionSnapshot(
                        viewerId = viewerId,
                        revision = current,
                        locale = LocaleId("en_us"),
                        theme = ItemKey.parse("itemerness:default"),
                        assetProfile = null,
                    ),
                    ProjectionGeneration(catalogRevision = current, epoch = current),
                )
            }
        },
    )

    private fun canonicalStack(pendingName: String = "[itemerness:login-item]"): ItemStack =
        ItemStack(Items.PAPER).also { stack ->
        stack.set(DataComponents.MAX_STACK_SIZE, 64)
        CustomData.set(
            DataComponents.CUSTOM_DATA,
            stack,
            CompoundTag().apply {
                put(
                    NmsCanonicalItemCodec.ROOT_KEY,
                    CompoundTag().apply {
                        putInt("format", 1)
                        putString("id", "itemerness:login-item")
                        putLong("created_against_revision", 1)
                        putLong("instance_revision", 0)
                        put("data_schemas", CompoundTag())
                        put("data", CompoundTag())
                    },
                )
            },
        )
            stack.set(DataComponents.ITEM_NAME, Component.literal(pendingName))
        }

    private fun metadata(entityId: Int, pendingName: String): ClientboundSetEntityDataPacket =
        ClientboundSetEntityDataPacket(
            entityId,
            listOf(
                SynchedEntityData.DataValue(
                    0,
                    EntityDataSerializers.ITEM_STACK,
                    canonicalStack(pendingName),
                ),
            ),
        )

    private fun ghostRecipe(containerId: Int, pendingName: String): ClientboundPlaceGhostRecipePacket {
        val empty = SlotDisplay.Empty.INSTANCE
        return ClientboundPlaceGhostRecipePacket(
            containerId,
            StonecutterRecipeDisplay(
                empty,
                SlotDisplay.ItemStackSlotDisplay(canonicalStack(pendingName)),
                empty,
            ),
        )
    }

    private fun drainOutbound(channel: EmbeddedChannel): List<Any> = buildList {
        while (true) add(channel.readOutbound<Any>() ?: break)
    }

    private fun entityPackets(source: List<Any>): List<ClientboundSetEntityDataPacket> =
        source.filterIsInstance<ClientboundSetEntityDataPacket>()

    private fun entityItemName(packet: ClientboundSetEntityDataPacket): String =
        (packet.packedItems().single().value() as ItemStack).itemName.string

    private fun ghostItemName(packet: ClientboundPlaceGhostRecipePacket): String =
        ((packet.recipeDisplay() as StonecutterRecipeDisplay).result() as SlotDisplay.ItemStackSlotDisplay)
            .stack()
            .itemName
            .string

    private fun advanceRefreshPage(channel: EmbeddedChannel) {
        channel.advanceTimeBy(50, TimeUnit.MILLISECONDS)
        channel.runScheduledPendingTasks()
        channel.runPendingTasks()
    }

    private fun itemCost(stack: ItemStack): ItemCost = ItemCost(
        stack.itemHolder,
        stack.count,
        DataComponentExactPredicate.allOf(stack.componentsPatch.split().added()),
    )

    private fun deepHoverCarrier(): Component {
        var component: Component = Component.literal("leaf").withStyle { style ->
            style.withHoverEvent(
                HoverEvent.ShowItem(canonicalStack()),
            )
        }
        repeat(33) {
            component = Component.empty().append(component)
        }
        return component
    }

    private fun requireShownItem(source: Component): ItemStack {
        val hover = source.style.hoverEvent
        if (hover is HoverEvent.ShowItem) return hover.item()
        source.siblings.forEach { child ->
            runCatching { return requireShownItem(child) }
        }
        error("Component does not contain a ShowItem carrier")
    }

    private fun encodedCanonicalStack(): CompoundTag {
        val ops = RegistryAccess.fromRegistryOfRegistries(BuiltInRegistries.REGISTRY)
            .createSerializationContext(NbtOps.INSTANCE)
        return ItemStack.CODEC.encodeStart(ops, canonicalStack()).result().orElseThrow() as CompoundTag
    }

    private fun decodeStack(source: CompoundTag): ItemStack {
        val ops = RegistryAccess.fromRegistryOfRegistries(BuiltInRegistries.REGISTRY)
            .createSerializationContext(NbtOps.INSTANCE)
        return ItemStack.CODEC.parse(ops, source).result().orElseThrow()
    }

    private fun assertHasCanonicalRoot(source: ItemStack) {
        assertTrue(source.get(DataComponents.CUSTOM_DATA)?.contains(NmsCanonicalItemCodec.ROOT_KEY) == true)
    }

    private fun assertNoCanonicalRoot(source: ItemStack) {
        assertFalse(source.get(DataComponents.CUSTOM_DATA)?.contains(NmsCanonicalItemCodec.ROOT_KEY) == true)
    }

    private data class Fixture(
        val channel: EmbeddedChannel,
        val handler: ProjectionChannelHandler,
        val owner: NmsProjectionHandlerOwner,
        val terminal: NmsProjectionTerminal,
        val state: NmsConnectionProjectionState,
        private val resolvedSource: () -> Boolean,
        private val unboundSource: () -> Int,
        private val removedSource: () -> Int,
        private val connectionSendSource: () -> Int,
    ) {
        val resolved: Boolean get() = resolvedSource()
        val unboundCount: Int get() = unboundSource()
        val removedCount: Int get() = removedSource()
        val connectionSendCount: Int get() = connectionSendSource()
    }

    private class TrackingConnection : Connection(PacketFlow.SERVERBOUND) {
        var sendCalls = 0
            private set

        override fun send(packet: Packet<*>) {
            sendCalls++
            super.send(packet)
        }
    }

    private class DeferredFailingOutboundHandler : ChannelOutboundHandlerAdapter() {
        private val promises = ArrayList<ChannelPromise>()
        val pendingWrites: Int get() = promises.size

        override fun write(context: ChannelHandlerContext, message: Any, promise: ChannelPromise) {
            promises += promise
        }

        fun failAll(failure: Throwable = ClosedChannelException()) {
            promises.forEach { promise -> promise.tryFailure(failure) }
        }
    }

    private class OutboundProbe(
        private val name: String,
        private val events: MutableList<String>,
    ) : ChannelOutboundHandlerAdapter() {
        var writeCount = 0
            private set
        var flushCount = 0
            private set

        override fun write(context: ChannelHandlerContext, message: Any, promise: ChannelPromise) {
            writeCount++
            events += "$name.write"
            context.write(message, promise)
        }

        override fun flush(context: ChannelHandlerContext) {
            flushCount++
            events += "$name.flush"
            context.flush()
        }

        fun reset() {
            writeCount = 0
            flushCount = 0
        }
    }

    private object PlayPacketListener : PacketListener {
        override fun flow(): PacketFlow = PacketFlow.SERVERBOUND

        override fun protocol(): ConnectionProtocol = ConnectionProtocol.PLAY

        override fun onDisconnect(details: DisconnectionDetails) = Unit

        override fun isAcceptingMessages(): Boolean = true
    }

    private companion object {
        val VIEWER_ID: UUID = UUID.fromString("de732f1a-a9bb-4c05-996a-c9a91b1143ec")
        const val HANDLER_NAME = "itemerness_projection"

        @JvmStatic
        @BeforeAll
        fun bootstrapMinecraft() {
            SharedConstants.tryDetectVersion()
            Bootstrap.bootStrap()
            val global = GlobalConfiguration().also { configuration ->
                configuration.misc = configuration.Misc()
                configuration.packetLimiter = configuration.PacketLimiter().also { limiter ->
                    limiter.allPackets = GlobalConfiguration.PacketLimiter.PacketLimit(
                        0.0,
                        0.0,
                        GlobalConfiguration.PacketLimiter.PacketLimit.ViolateAction.KICK,
                    )
                    limiter.overrides = emptyMap()
                }
            }
            GlobalConfiguration::class.java.getDeclaredField("instance").also { field ->
                check(field.trySetAccessible()) { "Cannot initialize Paper global configuration" }
                field.set(null, global)
            }
        }
    }
}
