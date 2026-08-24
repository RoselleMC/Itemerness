package com.iroselle.itemerness.nms.v26_2

import com.iroselle.itemerness.api.ItemKey
import com.iroselle.itemerness.projection.BoundedProjectionResyncQueue
import com.iroselle.itemerness.projection.ItemProjector
import com.iroselle.itemerness.projection.LocaleId
import com.iroselle.itemerness.projection.ProjectionContext
import com.iroselle.itemerness.projection.ProjectionContextSource
import com.iroselle.itemerness.projection.ProjectionGeneration
import com.iroselle.itemerness.projection.ProjectionResult
import com.iroselle.itemerness.projection.ProjectionRuntime
import com.iroselle.itemerness.projection.RenderedDisplay
import com.iroselle.itemerness.projection.RenderedText
import com.iroselle.itemerness.projection.ViewerProjectionSnapshot
import com.mojang.datafixers.util.Pair
import it.unimi.dsi.fastutil.ints.Int2ObjectOpenHashMap
import java.io.ByteArrayOutputStream
import java.io.DataOutputStream
import java.util.UUID
import net.minecraft.SharedConstants
import net.minecraft.core.RegistryAccess
import net.minecraft.core.component.DataComponentMap
import net.minecraft.core.component.DataComponents
import net.minecraft.core.registries.BuiltInRegistries
import net.minecraft.nbt.CompoundTag
import net.minecraft.network.HashedPatchMap
import net.minecraft.network.HashedStack
import net.minecraft.network.chat.Component
import net.minecraft.network.protocol.game.ClientboundContainerSetSlotPacket
import net.minecraft.network.protocol.game.ClientboundSetEquipmentPacket
import net.minecraft.network.protocol.game.ServerboundContainerClickPacket
import net.minecraft.network.protocol.game.ServerboundSetCreativeModeSlotPacket
import net.minecraft.server.Bootstrap
import net.minecraft.world.inventory.ContainerInput
import net.minecraft.world.entity.EquipmentSlot
import net.minecraft.world.item.ItemStack
import net.minecraft.world.item.ItemStackTemplate
import net.minecraft.world.item.Items
import net.minecraft.world.item.component.CustomData
import net.minecraft.world.item.component.UseRemainder
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotSame
import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Test

class NmsInboundProjectionTest {
    @Test
    fun `canonical tag fingerprint ignores compound insertion order`() {
        val first = CompoundTag().apply {
            putString("z-last", "value")
            put("nested", CompoundTag().apply {
                putInt("beta", 2)
                putInt("alpha", 1)
            })
        }
        val second = CompoundTag().apply {
            put("nested", CompoundTag().apply {
                putInt("alpha", 1)
                putInt("beta", 2)
            })
            putString("z-last", "value")
        }

        assertEquals(canonicalBytes(first).toList(), canonicalBytes(second).toList())
    }

    @Test
    fun `container interaction variants restore only uniquely registered projected hashes`() {
        val state = state()
        val source = canonicalStack()
        val outgoing = NmsOutboundPacketProjector(NmsItemStackProjector(runtime())).project(
            ClientboundContainerSetSlotPacket(7, 91, 12, source),
            VIEWER_ID,
            state,
        ) as ClientboundContainerSetSlotPacket
        assertTrue(NmsViewTokenCodec.read(outgoing.item) is ViewTokenResult.Present)

        val variants = listOf(
            ContainerInput.PICKUP to 0,
            ContainerInput.QUICK_MOVE to 0,
            ContainerInput.SWAP to 40,
            ContainerInput.CLONE to 2,
            ContainerInput.THROW to 1,
            ContainerInput.QUICK_CRAFT to 5,
            ContainerInput.PICKUP_ALL to 0,
        )
        variants.forEach { (input, button) ->
            val projectedHash = HashedStack.create(outgoing.item.copyWithCount(3), HASHER)
            val directRewrite = state.rewrite(projectedHash)
            assertTrue(directRewrite is HashedRewriteResult.Hit, directRewrite.toString())
            val slots = Int2ObjectOpenHashMap<HashedStack>().also { it.put(12, projectedHash) }
            val packet = ServerboundContainerClickPacket(
                7,
                91,
                12,
                button.toByte(),
                input,
                slots,
                projectedHash,
            )

            val decision = inbound(state).project(packet, VIEWER_ID) as InboundPacketDecision.Forward
            val rewritten = decision.packet as ServerboundContainerClickPacket

            assertNotSame(packet, rewritten)
            assertEquals(packet.containerId(), rewritten.containerId())
            assertEquals(packet.stateId(), rewritten.stateId())
            assertEquals(packet.slotNum(), rewritten.slotNum())
            assertEquals(packet.buttonNum(), rewritten.buttonNum())
            assertEquals(input, rewritten.containerInput())
            assertCanonicalHash(rewritten.changedSlots().get(12), source, expectedCount = 3)
            assertCanonicalHash(rewritten.carriedItem(), source, expectedCount = 3)
            assertTrue((packet.changedSlots().get(12) as HashedStack.ActualItem).components().matches(outgoing.item.componentsPatch, HASHER))
        }
    }

    @Test
    fun `outbound registration and inbound rewrite agree under vanilla registry crc32c`() {
        val productionHasher = NmsComponentHashGenerator.create(
            RegistryAccess.fromRegistryOfRegistries(BuiltInRegistries.REGISTRY),
        )
        val state = NmsConnectionProjectionState(
            connectionGeneration = CONNECTION_GENERATION,
            hasher = productionHasher,
        )
        val canonical = canonicalStack()
        val outgoing = NmsOutboundPacketProjector(NmsItemStackProjector(runtime())).project(
            ClientboundContainerSetSlotPacket(1, 2, 3, canonical),
            VIEWER_ID,
            state,
        ) as ClientboundContainerSetSlotPacket
        val clientHash = HashedStack.create(outgoing.item.copyWithCount(5), productionHasher)

        val result = state.rewrite(clientHash) as HashedRewriteResult.Hit

        val restored = result.stack as HashedStack.ActualItem
        assertEquals(5, restored.count())
        assertTrue(restored.components().matches(canonical.componentsPatch, productionHasher))
    }

    @Test
    fun `unknown hashes pass through unchanged for vanilla correction`() {
        val state = state()
        val unknown = HashedStack.create(ItemStack(Items.STONE), HASHER)
        val slots = Int2ObjectOpenHashMap<HashedStack>().also { it.put(4, unknown) }
        val packet = ServerboundContainerClickPacket(2, 4, 4, 0, ContainerInput.PICKUP, slots, unknown)

        val decision = inbound(state).project(packet, VIEWER_ID) as InboundPacketDecision.Forward

        assertSame(packet, decision.packet)
    }

    @Test
    fun `hash mappings are connection isolated and lifecycle clear invalidates both ledgers`() {
        val first = state()
        val second = state(connectionGeneration = 18)
        val canonical = canonicalStack()
        val projected = first.register(canonical, projectedStack(canonical), GENERATION)
        val hashed = HashedStack.create(projected, HASHER)

        assertTrue(first.rewrite(hashed) is HashedRewriteResult.Hit)
        assertTrue(second.rewrite(hashed) is HashedRewriteResult.PassThrough)
        first.clear()
        val afterClear = first.rewrite(hashed) as HashedRewriteResult.PassThrough
        assertEquals(LedgerMissReason.MISS, afterClear.reason)
        assertSame(hashed, afterClear.stack)
        assertEquals(
            CreativeRejectReason.UNKNOWN_TOKEN,
            (first.restoreCreative(projected) as CreativeRestoreResult.Rejected).reason,
        )
    }

    @Test
    fun `crc collision is ambiguous instead of last write wins`() {
        val ledger = HashedPatchLedger(capacity = 4)
        val generation = ProjectionGeneration(1, 1)
        val projected = HashedPatchMap(mapOf(DataComponents.CUSTOM_DATA to 10), emptySet())
        val firstCanonical = HashedPatchMap(mapOf(DataComponents.CUSTOM_DATA to 20), emptySet())
        val secondCanonical = HashedPatchMap(mapOf(DataComponents.CUSTOM_DATA to 21), emptySet())
        ledger.record(Items.PAPER.builtInRegistryHolder(), projected, firstCanonical, generation)
        ledger.record(Items.PAPER.builtInRegistryHolder(), projected, secondCanonical, generation)
        val window = ProjectionGenerationWindow().also { it.observe(generation) }
        val incoming = HashedStack.ActualItem(Items.PAPER.builtInRegistryHolder(), 9, projected)

        val result = ledger.rewrite(incoming, window)

        assertTrue(result is HashedRewriteResult.PassThrough)
        assertEquals(LedgerMissReason.AMBIGUOUS, (result as HashedRewriteResult.PassThrough).reason)
        assertSame(incoming, result.stack)
    }

    @Test
    fun `removed component set and item holder participate in the hash signature`() {
        val ledger = HashedPatchLedger(capacity = 4)
        val generation = ProjectionGeneration(1, 1)
        val projected = HashedPatchMap(
            mapOf(DataComponents.CUSTOM_DATA to 10),
            setOf(DataComponents.LORE),
        )
        val canonical = HashedPatchMap(
            mapOf(DataComponents.CUSTOM_DATA to 20),
            setOf(DataComponents.CUSTOM_NAME),
        )
        ledger.record(Items.PAPER.builtInRegistryHolder(), projected, canonical, generation)
        val window = ProjectionGenerationWindow().also { it.observe(generation) }

        val hit = ledger.rewrite(actual(projected), window) as HashedRewriteResult.Hit
        assertEquals(canonical, (hit.stack as HashedStack.ActualItem).components())
        val changedRemovedSet = actual(
            HashedPatchMap(projected.addedComponents(), emptySet()),
        )
        assertTrue(ledger.rewrite(changedRemovedSet, window) is HashedRewriteResult.PassThrough)
        val changedHolder = HashedStack.ActualItem(Items.STONE.builtInRegistryHolder(), 1, projected)
        assertTrue(ledger.rewrite(changedHolder, window) is HashedRewriteResult.PassThrough)
    }

    @Test
    fun `hash ledger has hard lru capacity and two generation fences`() {
        val ledger = HashedPatchLedger(capacity = 1)
        val first = ProjectionGeneration(1, 1)
        val second = ProjectionGeneration(2, 2)
        val third = ProjectionGeneration(3, 3)
        val firstProjected = HashedPatchMap(mapOf(DataComponents.CUSTOM_DATA to 1), emptySet())
        val secondProjected = HashedPatchMap(mapOf(DataComponents.CUSTOM_DATA to 2), emptySet())
        val canonical = HashedPatchMap(mapOf(DataComponents.CUSTOM_DATA to 8), emptySet())
        val window = ProjectionGenerationWindow().also { it.observe(first) }
        ledger.record(Items.PAPER.builtInRegistryHolder(), firstProjected, canonical, first)
        ledger.record(Items.PAPER.builtInRegistryHolder(), secondProjected, canonical, first)
        assertEquals(
            LedgerMissReason.MISS,
            (ledger.rewrite(actual(firstProjected), window) as HashedRewriteResult.PassThrough).reason,
        )

        window.observe(second)
        ledger.retainGenerations(window)
        window.observe(third)
        ledger.retainGenerations(window)
        assertTrue(ledger.rewrite(actual(secondProjected), window) is HashedRewriteResult.PassThrough)

        ledger.record(Items.PAPER.builtInRegistryHolder(), secondProjected, canonical, third)
        assertTrue(ledger.rewrite(actual(secondProjected), window) is HashedRewriteResult.Hit)
    }

    @Test
    fun `creative exact projection permits valid count change and same-connection replay`() {
        val state = state()
        val canonical = canonicalStack().also { it.set(DataComponents.MAX_STACK_SIZE, 16) }
        val projected = projectedStack(canonical)
        val tokenized = state.register(canonical, projected, GENERATION)
        val packet = ServerboundSetCreativeModeSlotPacket(9, tokenized.copyWithCount(12))

        val decision = inbound(state).project(packet, VIEWER_ID) as InboundPacketDecision.Forward
        val restored = (decision.packet as ServerboundSetCreativeModeSlotPacket).itemStack()

        assertEquals(12, restored.count)
        assertTrue(hasCanonicalRoot(restored))
        assertFalse(hasViewToken(restored))
        assertEquals(canonical.componentsPatch, restored.componentsPatch)
        assertTrue(hasCanonicalRoot(canonical))
        assertFalse(hasCanonicalRoot(tokenized))

        // A view token binds a projected fingerprint to this connection and generation; it is not
        // an authentication credential. Repeating the exact projected patch is a legal clone.
        val replay = inbound(state).project(packet, VIEWER_ID) as InboundPacketDecision.Forward
        val replayed = (replay.packet as ServerboundSetCreativeModeSlotPacket).itemStack()
        assertEquals(12, replayed.count)
        assertEquals(restored.componentsPatch, replayed.componentsPatch)
        assertTrue(hasCanonicalRoot(replayed))
    }

    @Test
    fun `creative component tampering is rejected and coalesced for owning context resync`() {
        val queue = BoundedProjectionResyncQueue(maxConnections = 1, maxSlotsPerConnection = 4)
        val state = state()
        val tokenized = state.register(canonicalStack(), projectedStack(canonicalStack()), GENERATION)
        val tampered = tokenized.copy().also { it.set(DataComponents.ITEM_NAME, Component.literal("forged")) }
        val packet = ServerboundSetCreativeModeSlotPacket(11, tampered)

        val decision = NmsInboundPacketProjector(state, queue).project(packet, VIEWER_ID)

        assertTrue(decision is InboundPacketDecision.RejectCreative)
        assertEquals(
            CreativeRejectReason.COMPONENTS_CHANGED,
            (decision as InboundPacketDecision.RejectCreative).reason,
        )
        val batch = queue.drain(VIEWER_ID, CONNECTION_GENERATION)!!
        assertFalse(batch.fullInventory)
        assertEquals(setOf(11), batch.slots)
    }

    @Test
    fun `canonical nbt forgery and malformed or cross connection tokens are rejected`() {
        val firstState = state()
        val secondState = state(connectionGeneration = 18)
        val projected = firstState.register(canonicalStack(), projectedStack(canonicalStack()), GENERATION)

        val crossConnection = secondState.restoreCreative(projected)
        val canonicalForgery = firstState.restoreCreative(canonicalStack())
        val malformed = projected.copy().also { stack ->
            val custom = stack.get(DataComponents.CUSTOM_DATA)!!.copyTag()
            custom.putString(NmsViewTokenCodec.VIEW_KEY, "forged")
            CustomData.set(DataComponents.CUSTOM_DATA, stack, custom)
        }
        val changedMaterial = ItemStack(
            Items.STONE.builtInRegistryHolder(),
            projected.count,
            projected.componentsPatch,
        )

        assertEquals(
            CreativeRejectReason.UNKNOWN_TOKEN,
            (crossConnection as CreativeRestoreResult.Rejected).reason,
        )
        assertEquals(
            CreativeRejectReason.MANAGED_WITHOUT_TOKEN,
            (canonicalForgery as CreativeRestoreResult.Rejected).reason,
        )
        assertEquals(
            CreativeRejectReason.MALFORMED_TOKEN,
            (firstState.restoreCreative(malformed) as CreativeRestoreResult.Rejected).reason,
        )
        assertEquals(
            CreativeRejectReason.MATERIAL_CHANGED,
            (firstState.restoreCreative(changedMaterial) as CreativeRestoreResult.Rejected).reason,
        )
    }

    @Test
    fun `creative registration is idempotent and capacity evicts least recent distinct identity`() {
        val stableState = NmsConnectionProjectionState(
            connectionGeneration = CONNECTION_GENERATION,
            hasher = HASHER,
        )
        val firstIdentity = stableState.register(canonicalStack(), projectedStack(canonicalStack()), GENERATION)
        val repeatedIdentity = stableState.register(canonicalStack(), projectedStack(canonicalStack()), GENERATION)
        assertEquals(NmsViewTokenCodec.read(firstIdentity), NmsViewTokenCodec.read(repeatedIdentity))
        assertTrue(stableState.restoreCreative(firstIdentity) is CreativeRestoreResult.Restored)

        val bounded = NmsConnectionProjectionState(
            connectionGeneration = CONNECTION_GENERATION,
            hasher = HASHER,
            creativeCapacity = 1,
        )
        val firstCanonical = canonicalStack(charges = 3)
        val secondCanonical = canonicalStack(charges = 4)
        val first = bounded.register(firstCanonical, projectedStack(firstCanonical), GENERATION)
        val second = bounded.register(secondCanonical, projectedStack(secondCanonical), GENERATION)
        assertEquals(
            CreativeRejectReason.UNKNOWN_TOKEN,
            (bounded.restoreCreative(first) as CreativeRestoreResult.Rejected).reason,
        )
        assertTrue(bounded.restoreCreative(second) is CreativeRestoreResult.Restored)
    }

    @Test
    fun `creative token remains valid for its connection while epoch rollover and count limits fail closed`() {
        val state = state()
        val first = state.register(canonicalStack(), projectedStack(canonicalStack()), ProjectionGeneration(1, 1))
        val second = state.register(canonicalStack(), projectedStack(canonicalStack()), ProjectionGeneration(2, 2))
        state.register(canonicalStack(), projectedStack(canonicalStack()), ProjectionGeneration(3, 3))

        assertTrue(state.restoreCreative(first) is CreativeRestoreResult.Rejected)
        val excessive = second.copyWithCount(2)
        assertEquals(
            CreativeRejectReason.INVALID_COUNT,
            (state.restoreCreative(excessive) as CreativeRestoreResult.Rejected).reason,
        )
        val current = state.register(canonicalStack(), projectedStack(canonicalStack()), ProjectionGeneration(3, 3))
        repeat(10_000) {
            assertTrue(state.restoreCreative(current) is CreativeRestoreResult.Restored)
        }
    }

    @Test
    fun `ordinary creative items remain vanilla while managed nested items require their outer token`() {
        val state = state()
        val ordinary = ServerboundSetCreativeModeSlotPacket(4, ItemStack(Items.STONE))
        val ordinaryDecision = inbound(state).project(ordinary, VIEWER_ID) as InboundPacketDecision.Forward
        assertSame(ordinary, ordinaryDecision.packet)

        val nestedCanonical = canonicalStack()
        val outer = ItemStack(Items.STONE).also { stack ->
            stack.set(
                DataComponents.USE_REMAINDER,
                UseRemainder(ItemStackTemplate.fromNonEmptyStack(nestedCanonical)),
            )
        }
        val outgoing = NmsOutboundPacketProjector(NmsItemStackProjector(runtime())).project(
            ClientboundContainerSetSlotPacket(1, 2, 3, outer),
            VIEWER_ID,
            state,
        ) as ClientboundContainerSetSlotPacket
        assertTrue(hasViewToken(outgoing.item))
        val restored = state.restoreCreative(outgoing.item) as CreativeRestoreResult.Restored
        assertTrue(hasCanonicalRoot(restored.stack.get(DataComponents.USE_REMAINDER)!!.convertInto().create()))

        val strippedOuterToken = outgoing.item.copy().also { stack ->
            val custom = stack.get(DataComponents.CUSTOM_DATA)!!.copyTag()
            custom.remove(NmsViewTokenCodec.VIEW_KEY)
            CustomData.set(DataComponents.CUSTOM_DATA, stack, custom)
        }
        assertEquals(
            CreativeRejectReason.MANAGED_WITHOUT_TOKEN,
            (state.restoreCreative(strippedOuterToken) as CreativeRestoreResult.Rejected).reason,
        )
    }

    @Test
    fun `display only surfaces do not mint creative restoration capabilities`() {
        val state = state()
        val packet = ClientboundSetEquipmentPacket(
            42,
            listOf(Pair.of(EquipmentSlot.MAINHAND, canonicalStack())),
        )

        val projected = NmsOutboundPacketProjector(NmsItemStackProjector(runtime())).project(
            packet,
            VIEWER_ID,
            state,
        ) as ClientboundSetEquipmentPacket
        val displayStack = projected.slots.single().second

        assertFalse(hasCanonicalRoot(displayStack))
        assertFalse(hasViewToken(displayStack))
        assertTrue(state.restoreCreative(displayStack) is CreativeRestoreResult.Unmanaged)
    }

    @Test
    fun `component hashing uses the exact registry aware crc32c algorithm`() {
        val hasher = NmsComponentHashGenerator.create(
            RegistryAccess.fromRegistryOfRegistries(BuiltInRegistries.REGISTRY),
        )
        val stack = ItemStack(Items.PAPER).also { item ->
            item.set(DataComponents.ITEM_NAME, Component.literal("Itemerness CRC32C vector"))
        }
        val hash = HashedPatchMap.create(stack.componentsPatch, hasher)
            .addedComponents()[DataComponents.ITEM_NAME]

        // A fixed vector catches accidental replacement with Object.hashCode or a non-registry codec.
        assertEquals(EXPECTED_ITEM_NAME_CRC32C, hash)
    }

    private fun inbound(
        state: NmsConnectionProjectionState,
        queue: BoundedProjectionResyncQueue = BoundedProjectionResyncQueue(),
    ) = NmsInboundPacketProjector(state, queue)

    private fun state(
        connectionGeneration: Long = CONNECTION_GENERATION,
    ) = NmsConnectionProjectionState(
        connectionGeneration = connectionGeneration,
        hasher = HASHER,
    )

    private fun runtime(): ProjectionRuntime = ProjectionRuntime(
        projector = ItemProjector {
            ProjectionResult.Rendered(
                RenderedDisplay(
                    displayName = RenderedText.plain("Projected token"),
                    lore = listOf(RenderedText.plain("Projected lore")),
                ),
            )
        },
        contexts = ProjectionContextSource { viewer ->
            if (viewer == VIEWER_ID) {
                ProjectionContext(
                    viewer = ViewerProjectionSnapshot(
                        viewerId = viewer,
                        revision = 1,
                        locale = LocaleId("en_us"),
                        theme = ItemKey.parse("itemerness:default"),
                        assetProfile = null,
                    ),
                    generation = GENERATION,
                )
            } else {
                null
            }
        },
    )

    private fun canonicalStack(charges: Int = 3): ItemStack {
        val root = CompoundTag().apply {
            putInt("format", 1)
            putString("id", "itemerness:travel-token")
            putLong("created_against_revision", 1)
            putLong("instance_revision", 0)
            put("data_schemas", CompoundTag().apply { putInt("itemerness:common", 1) })
            put("data", CompoundTag().apply { putInt("example:charges", charges) })
        }
        val custom = CompoundTag().apply {
            put(NmsCanonicalItemCodec.ROOT_KEY, root)
            putString("foreign", "kept")
        }
        return ItemStack(Items.PAPER).also { stack ->
            CustomData.set(DataComponents.CUSTOM_DATA, stack, custom)
            stack.set(DataComponents.ITEM_NAME, Component.literal("[itemerness:travel-token]"))
            stack.set(DataComponents.MAX_STACK_SIZE, 1)
        }
    }

    private fun projectedStack(canonical: ItemStack): ItemStack = canonical.copy().also { stack ->
        val custom = stack.get(DataComponents.CUSTOM_DATA)!!.copyTag()
        custom.remove(NmsCanonicalItemCodec.ROOT_KEY)
        CustomData.set(DataComponents.CUSTOM_DATA, stack, custom)
        stack.set(DataComponents.ITEM_NAME, Component.literal("Projected token"))
    }

    private fun actual(patch: HashedPatchMap): HashedStack.ActualItem =
        HashedStack.ActualItem(Items.PAPER.builtInRegistryHolder(), 1, patch)

    private fun canonicalBytes(source: CompoundTag): ByteArray = ByteArrayOutputStream().use { bytes ->
        DataOutputStream(bytes).use { output -> NmsCanonicalTagWriter.write(source, output) }
        bytes.toByteArray()
    }

    private fun assertCanonicalHash(hashed: HashedStack, canonical: ItemStack, expectedCount: Int) {
        val actual = hashed as HashedStack.ActualItem
        assertEquals(canonical.typeHolder(), actual.item())
        assertEquals(expectedCount, actual.count())
        assertTrue(actual.components().matches(canonical.componentsPatch, HASHER))
    }

    private fun hasCanonicalRoot(stack: ItemStack): Boolean =
        stack.get(DataComponents.CUSTOM_DATA)?.contains(NmsCanonicalItemCodec.ROOT_KEY) == true

    private fun hasViewToken(stack: ItemStack): Boolean =
        NmsViewTokenCodec.read(stack) is ViewTokenResult.Present

    private companion object {
        val VIEWER_ID: UUID = UUID.fromString("34d355ab-0914-45f6-98d1-674358f3452e")
        val GENERATION = ProjectionGeneration(catalogRevision = 9, epoch = 12)
        const val CONNECTION_GENERATION = 17L
        const val EXPECTED_ITEM_NAME_CRC32C = 2_100_488_706
        val HASHER = HashedPatchMap.HashGenerator { component -> component.value().hashCode() }

        @JvmStatic
        @BeforeAll
        @Suppress("DEPRECATION")
        fun bootstrapMinecraft() {
            SharedConstants.tryDetectVersion()
            Bootstrap.bootStrap()
            Items.PAPER.builtInRegistryHolder().bindComponents(DataComponentMap.EMPTY)
            Items.STONE.builtInRegistryHolder().bindComponents(DataComponentMap.EMPTY)
        }
    }
}
