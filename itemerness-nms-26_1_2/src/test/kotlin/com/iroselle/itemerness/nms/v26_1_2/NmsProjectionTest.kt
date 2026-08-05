package com.iroselle.itemerness.nms.v26_1_2

import com.iroselle.itemerness.api.ItemKey
import com.iroselle.itemerness.projection.IntegerProjectionValue
import com.iroselle.itemerness.projection.ItemProjector
import com.iroselle.itemerness.projection.LocaleId
import com.iroselle.itemerness.projection.ProjectionAdapterFactory
import com.iroselle.itemerness.projection.ProjectionContext
import com.iroselle.itemerness.projection.ProjectionContextSource
import com.iroselle.itemerness.projection.ProjectionGeneration
import com.iroselle.itemerness.projection.ProjectionResult
import com.iroselle.itemerness.projection.ProjectionRuntime
import com.iroselle.itemerness.projection.RenderedDisplay
import com.iroselle.itemerness.projection.RenderedText
import com.iroselle.itemerness.projection.RenderedTextRun
import com.iroselle.itemerness.projection.RgbColor
import com.iroselle.itemerness.projection.TextDecorations
import com.iroselle.itemerness.projection.ViewerProjectionSnapshot
import com.mojang.datafixers.util.Pair
import java.util.ServiceLoader
import java.util.UUID
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import net.minecraft.SharedConstants
import net.minecraft.core.component.DataComponentMap
import net.minecraft.core.component.DataComponents
import net.minecraft.core.RegistryAccess
import net.minecraft.core.registries.BuiltInRegistries
import net.minecraft.nbt.CompoundTag
import net.minecraft.nbt.StringTag
import net.minecraft.network.chat.Component
import net.minecraft.network.protocol.Packet
import net.minecraft.network.protocol.game.ClientGamePacketListener
import net.minecraft.network.protocol.game.ClientboundBundlePacket
import net.minecraft.network.protocol.game.ClientboundContainerSetContentPacket
import net.minecraft.network.protocol.game.ClientboundContainerSetSlotPacket
import net.minecraft.network.protocol.game.ClientboundSetCursorItemPacket
import net.minecraft.network.protocol.game.ClientboundSetEquipmentPacket
import net.minecraft.network.protocol.game.ClientboundSetPlayerInventoryPacket
import net.minecraft.resources.Identifier
import net.minecraft.server.Bootstrap
import net.minecraft.world.entity.EquipmentSlot
import net.minecraft.world.item.Item
import net.minecraft.world.item.ItemStack
import net.minecraft.world.item.Items
import net.minecraft.world.item.component.CustomData
import net.minecraft.world.item.component.ItemAttributeModifiers
import net.minecraft.world.item.component.ItemLore
import net.minecraft.world.item.enchantment.ItemEnchantments
import net.minecraft.util.Unit
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNotSame
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class NmsProjectionTest {
    @Test
    fun `direct custom data is projected on a copy without mutating canonical state`() {
        val captured = AtomicReference<com.iroselle.itemerness.projection.CanonicalItemSnapshot>()
        val source = canonicalStack()
        val projector = NmsItemStackProjector(runtime(captured))

        val projected = projector.project(source, VIEWER_ID)

        assertNotSame(source, projected)
        assertTrue(itemernessRootPresent(source))
        assertFalse(itemernessRootPresent(projected))
        assertEquals("kept", customTag(projected).getString("foreign").orElseThrow())
        assertEquals("[itemerness:travel-token]", source.get(DataComponents.ITEM_NAME)?.string)
        assertEquals("Harbor Travel Token", projected.get(DataComponents.ITEM_NAME)?.string)
        assertNotNull(source.get(DataComponents.CUSTOM_NAME))
        assertNull(projected.get(DataComponents.CUSTOM_NAME))
        assertEquals(listOf("stale canonical lore"), source.get(DataComponents.LORE)?.lines()?.map { it.string })
        assertEquals(listOf("Region: Harbor", "Charges: 3"), projected.get(DataComponents.LORE)?.lines()?.map { it.string })
        assertEquals("itemerness:default", projected.get(DataComponents.TOOLTIP_STYLE)?.toString())
        assertEquals("itemerness:travel_token", projected.get(DataComponents.ITEM_MODEL)?.toString())

        val canonical = captured.get()
        assertEquals(ItemKey.parse("itemerness:travel-token"), canonical.itemKey)
        assertEquals(ItemKey.parse("minecraft:paper"), canonical.materialKey)
        assertEquals(1, canonical.count)
        assertEquals("[itemerness:travel-token]", canonical.pendingName)
        assertEquals(1L, canonical.createdAgainstRevision)
        assertEquals(0L, canonical.instanceRevision)
        assertEquals(1, canonical.dataSchemas[ItemKey.parse("itemerness:common")])
        assertNull(canonical.instanceId)
        assertEquals(IntegerProjectionValue(3), canonical.data["example:charges"])
        assertEquals(32, canonical.fingerprint.size)

        val firstNameRun = projected.get(DataComponents.ITEM_NAME)?.siblings?.single()
        assertEquals(0xE86A33, firstNameRun?.style?.color?.value)
        assertTrue(firstNameRun?.style?.isBold == true)
        assertFalse(firstNameRun?.style?.isItalic == true)
    }

    @Test
    fun `malformed managed root is sanitized without invoking the projector`() {
        val invocations = AtomicInteger()
        val source = ItemStack(Items.PAPER)
        val custom = CompoundTag().apply {
            put(NmsCanonicalItemCodec.ROOT_KEY, StringTag.valueOf("invalid"))
            putString("foreign", "kept")
        }
        CustomData.set(DataComponents.CUSTOM_DATA, source, custom)
        source.set(DataComponents.LORE, ItemLore(listOf(Component.literal("untrusted lore"))))
        source.set(DataComponents.TOOLTIP_STYLE, Identifier.parse("example:untrusted"))
        source.set(DataComponents.ITEM_MODEL, Identifier.parse("example:untrusted"))
        val runtime = ProjectionRuntime(
            projector = ItemProjector {
                invocations.incrementAndGet()
                ProjectionResult.Rendered(renderedDisplay())
            },
            contexts = ProjectionContextSource { projectionContext() },
        )

        val projected = NmsItemStackProjector(runtime).project(source, VIEWER_ID)

        assertNotSame(source, projected)
        assertEquals(0, invocations.get())
        assertFalse(itemernessRootPresent(projected))
        assertEquals("kept", customTag(projected).getString("foreign").orElseThrow())
        assertNull(projected.get(DataComponents.LORE))
        assertNull(projected.get(DataComponents.TOOLTIP_STYLE))
        assertNull(projected.get(DataComponents.ITEM_MODEL))
        assertTrue(itemernessRootPresent(source))
    }

    @Test
    fun `missing viewer snapshot produces a sanitized pending item`() {
        val invocations = AtomicInteger()
        val source = canonicalStack()
        val runtime = ProjectionRuntime(
            projector = ItemProjector {
                invocations.incrementAndGet()
                ProjectionResult.Rendered(renderedDisplay())
            },
            contexts = ProjectionContextSource { null },
        )

        val projected = NmsItemStackProjector(runtime).project(source, VIEWER_ID)

        assertEquals(0, invocations.get())
        assertFalse(itemernessRootPresent(projected))
        assertNull(projected.get(DataComponents.ITEM_NAME))
        assertNull(projected.get(DataComponents.CUSTOM_NAME))
        assertNull(projected.get(DataComponents.LORE))
        assertNull(projected.get(DataComponents.TOOLTIP_STYLE))
        assertNull(projected.get(DataComponents.ITEM_MODEL))
    }

    @Test
    fun `projector failure produces a sanitized pending item`() {
        val source = canonicalStack()
        val runtime = ProjectionRuntime(
            projector = ItemProjector { error("render failed") },
            contexts = ProjectionContextSource { projectionContext() },
        )

        val projected = NmsItemStackProjector(runtime).project(source, VIEWER_ID)

        assertFalse(itemernessRootPresent(projected))
        assertNull(projected.get(DataComponents.ITEM_NAME))
        assertNull(projected.get(DataComponents.LORE))
    }

    @Test
    fun `clean base items can grant managed tooltip ownership`() {
        listOf(Items.ECHO_SHARD, Items.BOOK).forEach { item ->
            val source = canonicalStack(item = item, includeCustomName = false)
            val decoded = decode(source)

            assertEquals(Item::class.java, item.javaClass)
            assertTrue(decoded.canManageVanillaTooltipLines)
        }
    }

    @Test
    fun `tooltip-producing components and forged names deny managed ownership`() {
        val unsafeStacks = listOf(
            canonicalStack(item = Items.ECHO_SHARD, includeCustomName = false).also { stack ->
                stack.set(DataComponents.UNBREAKABLE, Unit.INSTANCE)
            },
            canonicalStack(item = Items.ECHO_SHARD, includeCustomName = false).also { stack ->
                stack.set(DataComponents.ENCHANTMENTS, ItemEnchantments.EMPTY)
            },
            canonicalStack(item = Items.ECHO_SHARD, includeCustomName = false).also { stack ->
                stack.set(DataComponents.ATTRIBUTE_MODIFIERS, ItemAttributeModifiers.EMPTY)
            },
            canonicalStack(item = Items.ECHO_SHARD, includeCustomName = false).also { stack ->
                stack.set(DataComponents.DAMAGE, 1)
            },
            canonicalStack(item = Items.ECHO_SHARD, includeCustomName = true),
        )

        unsafeStacks.forEach { stack ->
            assertFalse(decode(stack).canManageVanillaTooltipLines)
        }
    }

    @Test
    fun `managed canvas view is installed only for a proven safe physical stack`() {
        val source = canonicalStack(item = Items.ECHO_SHARD, includeCustomName = false)
        val runtime = ProjectionRuntime(
            projector = ItemProjector {
                ProjectionResult.Rendered(renderedDisplay(managesVanillaTooltipLines = true))
            },
            contexts = ProjectionContextSource { projectionContext() },
        )

        val projected = NmsItemStackProjector(runtime).project(source, VIEWER_ID)
        val tooltip = requireNotNull(projected.get(DataComponents.TOOLTIP_DISPLAY))

        assertTrue(tooltip.shows(DataComponents.LORE))
        assertEquals(listOf("Region: Harbor", "Charges: 3"), projected.get(DataComponents.LORE)?.lines()?.map { it.string })
        assertNull(source.get(DataComponents.TOOLTIP_DISPLAY))
    }

    @Test
    fun `unsafe physical stack cannot be hidden even if a projector overclaims ownership`() {
        val source = canonicalStack(item = Items.ECHO_SHARD, includeCustomName = false).also { stack ->
            stack.set(DataComponents.UNBREAKABLE, Unit.INSTANCE)
        }
        val runtime = ProjectionRuntime(
            projector = ItemProjector {
                ProjectionResult.Rendered(renderedDisplay(managesVanillaTooltipLines = true))
            },
            contexts = ProjectionContextSource { projectionContext() },
        )

        val projected = NmsItemStackProjector(runtime).project(source, VIEWER_ID)

        assertNotNull(projected.get(DataComponents.UNBREAKABLE))
        assertNull(projected.get(DataComponents.TOOLTIP_DISPLAY))
        assertEquals(listOf("Region: Harbor", "Charges: 3"), projected.get(DataComponents.LORE)?.lines()?.map { it.string })
    }

    @Test
    fun `forged custom name is sanitized and cannot enable managed tooltip ownership`() {
        val source = canonicalStack(item = Items.ECHO_SHARD, includeCustomName = true)
        val captured = AtomicReference<com.iroselle.itemerness.projection.CanonicalItemSnapshot>()
        val runtime = ProjectionRuntime(
            projector = ItemProjector { request ->
                captured.set(request.canonical)
                ProjectionResult.Rendered(renderedDisplay(managesVanillaTooltipLines = true))
            },
            contexts = ProjectionContextSource { projectionContext() },
        )

        val projected = NmsItemStackProjector(runtime).project(source, VIEWER_ID)

        assertFalse(captured.get().canManageVanillaTooltipLines)
        assertNull(projected.get(DataComponents.CUSTOM_NAME))
        assertNull(projected.get(DataComponents.TOOLTIP_DISPLAY))
    }

    @Test
    fun `canonical decoder rejects unbounded aggregate text`() {
        val source = canonicalStack()
        val custom = customTag(source)
        val root = custom.getCompound(NmsCanonicalItemCodec.ROOT_KEY).orElseThrow()
        val data = CompoundTag().apply {
            repeat(33) { index -> putString("example:value-$index", "x".repeat(8_192)) }
        }
        root.put("data", data)
        CustomData.set(DataComponents.CUSTOM_DATA, source, custom)

        val decoded = NmsCanonicalItemCodec().decode(source)

        assertTrue(decoded is CanonicalDecodeResult.Invalid)
    }

    @Test
    fun `canonical decoder exposes pending name for catalog validation`() {
        val source = canonicalStack()
        source.set(DataComponents.ITEM_NAME, Component.literal("[example:mismatch]"))

        val decoded = decode(source)

        assertEquals("[example:mismatch]", decoded.pendingName)
        assertEquals(ItemKey.parse("itemerness:travel-token"), decoded.itemKey)
    }

    @Test
    fun `fingerprint changes when canonical stack count changes`() {
        val first = decode(canonicalStack(count = 1))
        val second = decode(canonicalStack(count = 2))

        assertFalse(first.fingerprint.copyBytes().contentEquals(second.fingerprint.copyBytes()))
    }

    @Test
    fun `fingerprint separates safe and unsafe tooltip ownership`() {
        val safe = decode(canonicalStack(item = Items.ECHO_SHARD, includeCustomName = false))
        val unsafe = decode(
            canonicalStack(item = Items.ECHO_SHARD, includeCustomName = false).also { stack ->
                stack.set(DataComponents.UNBREAKABLE, Unit.INSTANCE)
            },
        )

        assertTrue(safe.canManageVanillaTooltipLines)
        assertFalse(unsafe.canManageVanillaTooltipLines)
        assertFalse(safe.fingerprint.copyBytes().contentEquals(unsafe.fingerprint.copyBytes()))
    }

    @Test
    fun `unmanaged stacks pass through by identity`() {
        val source = ItemStack(Items.STONE)

        val projected = NmsItemStackProjector(runtime()).project(source, VIEWER_ID)

        assertSame(source, projected)
    }

    @Test
    fun `container slot packet is rebuilt around the projected stack`() {
        val packet = ClientboundContainerSetSlotPacket(4, 19, 7, canonicalStack())
        val projector = packetProjector()

        val projected = projector.project(packet, VIEWER_ID) as ClientboundContainerSetSlotPacket

        assertNotSame(packet, projected)
        assertEquals(packet.containerId, projected.containerId)
        assertEquals(packet.stateId, projected.stateId)
        assertEquals(packet.slot, projected.slot)
        assertTrue(itemernessRootPresent(packet.item))
        assertFalse(itemernessRootPresent(projected.item))
        assertEquals("Harbor Travel Token", projected.item.get(DataComponents.ITEM_NAME)?.string)
    }

    @Test
    fun `container content packet rebuilds items and cursor with an immutable list`() {
        val managedSlot = canonicalStack()
        val unmanagedSlot = ItemStack(Items.STONE)
        val carried = canonicalStack(count = 2)
        val mutableItems = mutableListOf(managedSlot, unmanagedSlot)
        val packet = ClientboundContainerSetContentPacket(6, 23, mutableItems, carried)

        val projected = packetProjector().project(packet, VIEWER_ID) as ClientboundContainerSetContentPacket

        assertNotSame(packet, projected)
        assertEquals(packet.containerId(), projected.containerId())
        assertEquals(packet.stateId(), projected.stateId())
        assertTrue(itemernessRootPresent(managedSlot))
        assertTrue(itemernessRootPresent(carried))
        assertFalse(itemernessRootPresent(projected.items()[0]))
        assertSame(unmanagedSlot, projected.items()[1])
        assertFalse(itemernessRootPresent(projected.carriedItem()))
        mutableItems.clear()
        assertEquals(2, projected.items().size)
        assertThrows(UnsupportedOperationException::class.java) {
            projected.items().add(ItemStack(Items.STONE))
        }
    }

    @Test
    fun `equal canonical stacks receive one stable connection-private view identity`() {
        val state = connectionState()
        val packet = ClientboundContainerSetContentPacket(
            6,
            23,
            listOf(canonicalStack(), canonicalStack(count = 2)),
            ItemStack.EMPTY,
        )

        val projected = packetProjector().project(packet, VIEWER_ID, state) as ClientboundContainerSetContentPacket

        assertTrue(ItemStack.isSameItemSameComponents(projected.items()[0], projected.items()[1]))
        assertEquals(NmsViewTokenCodec.read(projected.items()[0]), NmsViewTokenCodec.read(projected.items()[1]))
    }

    @Test
    fun `same generation re-projection keeps the same view identity`() {
        val state = connectionState()
        val packet = ClientboundContainerSetSlotPacket(4, 19, 7, canonicalStack())

        val first = packetProjector().project(packet, VIEWER_ID, state) as ClientboundContainerSetSlotPacket
        val second = packetProjector().project(packet, VIEWER_ID, state) as ClientboundContainerSetSlotPacket

        assertEquals(NmsViewTokenCodec.read(first.item), NmsViewTokenCodec.read(second.item))
        assertTrue(ItemStack.isSameItemSameComponents(first.item, second.item))
    }

    @Test
    fun `different unique canonical instances receive different view identities`() {
        val state = connectionState()
        fun unique(id: String): ItemStack = canonicalStack().also { stack ->
            val custom = customTag(stack)
            val root = custom.getCompound(NmsCanonicalItemCodec.ROOT_KEY).orElseThrow()
            root.getCompound("data").orElseThrow().putString("itemerness:instance", id)
            CustomData.set(DataComponents.CUSTOM_DATA, stack, custom)
        }

        val first = packetProjector().project(
            ClientboundContainerSetSlotPacket(4, 19, 7, unique("first")),
            VIEWER_ID,
            state,
        ) as ClientboundContainerSetSlotPacket
        val second = packetProjector().project(
            ClientboundContainerSetSlotPacket(4, 20, 8, unique("second")),
            VIEWER_ID,
            state,
        ) as ClientboundContainerSetSlotPacket

        assertFalse(ItemStack.isSameItemSameComponents(first.item, second.item))
        assertFalse(NmsViewTokenCodec.read(first.item) == NmsViewTokenCodec.read(second.item))
    }

    @Test
    fun `cursor packet is rebuilt without changing its source stack`() {
        val sourceStack = canonicalStack()
        val packet = ClientboundSetCursorItemPacket(sourceStack)

        val projected = packetProjector().project(packet, VIEWER_ID) as ClientboundSetCursorItemPacket

        assertNotSame(packet, projected)
        assertTrue(itemernessRootPresent(packet.contents()))
        assertFalse(itemernessRootPresent(projected.contents()))
        assertEquals("Harbor Travel Token", projected.contents().get(DataComponents.ITEM_NAME)?.string)
    }

    @Test
    fun `player inventory packet retains its slot while rebuilding the item`() {
        val packet = ClientboundSetPlayerInventoryPacket(31, canonicalStack())

        val projected = packetProjector().project(packet, VIEWER_ID) as ClientboundSetPlayerInventoryPacket

        assertNotSame(packet, projected)
        assertEquals(31, projected.slot())
        assertTrue(itemernessRootPresent(packet.contents()))
        assertFalse(itemernessRootPresent(projected.contents()))
    }

    @Test
    fun `equipment packet preserves private sanitize state and immutable slot entries`() {
        listOf(false, true).forEach { sanitize ->
            val sourceStack = canonicalStack()
            val sourceEntries = mutableListOf(Pair.of(EquipmentSlot.MAINHAND, sourceStack))
            val packet = ClientboundSetEquipmentPacket(47, sourceEntries, sanitize)

            val projected = packetProjector().project(packet, VIEWER_ID) as ClientboundSetEquipmentPacket

            assertNotSame(packet, projected)
            assertEquals(packet.entity, projected.entity)
            assertEquals(sanitize, NmsEquipmentPacketAccess.sanitize(packet))
            assertEquals(sanitize, NmsEquipmentPacketAccess.sanitize(projected))
            assertTrue(itemernessRootPresent(sourceStack))
            assertFalse(itemernessRootPresent(projected.slots.single().second))
            sourceEntries.clear()
            assertEquals(1, projected.slots.size)
            assertThrows(UnsupportedOperationException::class.java) {
                projected.slots.add(Pair.of(EquipmentSlot.OFFHAND, ItemStack(Items.STONE)))
            }
        }
    }

    @Test
    fun `clientbound bundles are rebuilt recursively without mutating nested packets`() {
        val nestedSlot = ClientboundContainerSetSlotPacket(2, 9, 4, canonicalStack())
        val nestedBundle = bundle(nestedSlot)
        val cursor = ClientboundSetCursorItemPacket(canonicalStack(count = 2))
        val packet = bundle(nestedBundle, cursor)

        val projected = packetProjector().project(packet, VIEWER_ID) as ClientboundBundlePacket
        val projectedPackets = projected.subPackets().toList()
        val projectedNested = projectedPackets[0] as ClientboundBundlePacket
        val projectedSlot = projectedNested.subPackets().single() as ClientboundContainerSetSlotPacket
        val projectedCursor = projectedPackets[1] as ClientboundSetCursorItemPacket

        assertNotSame(packet, projected)
        assertNotSame(nestedBundle, projectedNested)
        assertTrue(itemernessRootPresent(nestedSlot.item))
        assertFalse(itemernessRootPresent(projectedSlot.item))
        assertTrue(itemernessRootPresent(cursor.contents()))
        assertFalse(itemernessRootPresent(projectedCursor.contents()))
    }

    @Test
    fun `bundle projection failure fails the whole top-level packet`() {
        val brokenPackets = Iterable<Packet<in ClientGamePacketListener>> {
            throw IllegalStateException("broken bundle iterator")
        }
        val packet = ClientboundBundlePacket(brokenPackets)

        assertThrows(IllegalStateException::class.java) {
            packetProjector().project(packet, VIEWER_ID)
        }
    }

    @Test
    fun `bundle recursion beyond the fixed limit fails atomically`() {
        var nested: Packet<in ClientGamePacketListener> =
            ClientboundContainerSetSlotPacket(2, 9, 4, canonicalStack())
        repeat(17) {
            nested = bundle(nested)
        }
        val packet = nested as ClientboundBundlePacket

        assertThrows(IllegalStateException::class.java) {
            packetProjector().project(packet, VIEWER_ID)
        }
        var cursor: Packet<in ClientGamePacketListener> = packet
        repeat(17) {
            cursor = (cursor as ClientboundBundlePacket).subPackets().single()
        }
        assertTrue(itemernessRootPresent((cursor as ClientboundContainerSetSlotPacket).item))
    }

    @Test
    fun `bundle shares one item budget across every nested packet`() {
        fun content(id: Int) = ClientboundContainerSetContentPacket(
            id,
            1,
            List(130) { ItemStack(Items.STONE) },
            ItemStack.EMPTY,
        )
        val first = content(1)
        val second = content(2)

        // Each child stays below the item bound on its own.
        assertSame(first, packetProjector().project(first, VIEWER_ID))
        assertSame(second, packetProjector().project(second, VIEWER_ID))

        assertThrows(IllegalStateException::class.java) {
            packetProjector().project(bundle(first, second), VIEWER_ID)
        }
    }

    @Test
    fun `unmanaged direct carriers and bundles pass through by identity`() {
        val slot = ClientboundContainerSetSlotPacket(2, 9, 4, ItemStack(Items.STONE))
        val packet = bundle(slot)

        val projected = packetProjector().project(packet, VIEWER_ID)

        assertSame(packet, projected)
        assertSame(slot, packet.subPackets().single())
    }

    @Test
    fun `exact adapter factory is service loaded with the pinned version`() {
        val factories = ServiceLoader.load(ProjectionAdapterFactory::class.java).toList()

        assertEquals(1, factories.size)
        assertEquals("itemerness:nms-26_1_2", factories.single().descriptor.id.toString())
        assertEquals("26.1.2", factories.single().descriptor.minecraftVersion.value)
    }

    @Test
    fun `abi probe matches the exact development bundle`() {
        NmsAbiProbe.verify()
    }

    private fun runtime(
        captured: AtomicReference<com.iroselle.itemerness.projection.CanonicalItemSnapshot>? = null,
    ): ProjectionRuntime = ProjectionRuntime(
        projector = ItemProjector { request ->
            captured?.set(request.canonical)
            ProjectionResult.Rendered(renderedDisplay())
        },
        contexts = ProjectionContextSource { viewerId ->
            if (viewerId == VIEWER_ID) projectionContext() else null
        },
    )

    private fun packetProjector(): NmsOutboundPacketProjector =
        NmsOutboundPacketProjector(NmsItemStackProjector(runtime()))

    private fun connectionState(): NmsConnectionProjectionState = NmsConnectionProjectionState(
        connectionGeneration = 41,
        hasher = { component -> component.value().hashCode() },
        registryAccess = RegistryAccess.fromRegistryOfRegistries(BuiltInRegistries.REGISTRY),
    )

    private fun bundle(vararg packets: Packet<in ClientGamePacketListener>): ClientboundBundlePacket =
        ClientboundBundlePacket(packets.asList())

    private fun projectionContext(): ProjectionContext = ProjectionContext(
        viewer = ViewerProjectionSnapshot(
            viewerId = VIEWER_ID,
            revision = 2,
            locale = LocaleId("en_us"),
            theme = ItemKey.parse("itemerness:default"),
            assetProfile = null,
        ),
        generation = ProjectionGeneration(catalogRevision = 5, epoch = 8),
    )

    private fun renderedDisplay(managesVanillaTooltipLines: Boolean = false): RenderedDisplay = RenderedDisplay(
        displayName = RenderedText(
            listOf(
                RenderedTextRun(
                    text = "Harbor Travel Token",
                    color = RgbColor(0xE86A33),
                    font = ItemKey.parse("minecraft:default"),
                    decorations = TextDecorations(bold = true),
                ),
            ),
        ),
        lore = listOf(
            RenderedText.plain("Region: Harbor"),
            RenderedText.plain("Charges: 3"),
        ),
        tooltipStyle = ItemKey.parse("itemerness:default"),
        itemModel = ItemKey.parse("itemerness:travel_token"),
        managesVanillaTooltipLines = managesVanillaTooltipLines,
    )

    private fun decode(stack: ItemStack): com.iroselle.itemerness.projection.CanonicalItemSnapshot =
        (NmsCanonicalItemCodec().decode(stack) as CanonicalDecodeResult.Decoded).snapshot

    private fun canonicalStack(
        count: Int = 1,
        item: Item = Items.PAPER,
        includeCustomName: Boolean = true,
    ): ItemStack {
        val data = CompoundTag().apply {
            putString("example:region", "example:harbor")
            putInt("example:charges", 3)
            put(
                "example:metadata",
                CompoundTag().apply {
                    putString("type", "travel")
                    putBoolean("enabled", true)
                },
            )
        }
        val root = CompoundTag().apply {
            putInt("format", 1)
            putString("id", "itemerness:travel-token")
            putLong("created_against_revision", 1)
            putLong("instance_revision", 0)
            put(
                "data_schemas",
                CompoundTag().apply {
                    putInt("itemerness:common", 1)
                },
            )
            put("data", data)
        }
        val custom = CompoundTag().apply {
            put(NmsCanonicalItemCodec.ROOT_KEY, root)
            putString("foreign", "kept")
        }
        return ItemStack(item, count).also { stack ->
            stack.set(DataComponents.MAX_STACK_SIZE, 64)
            CustomData.set(DataComponents.CUSTOM_DATA, stack, custom)
            stack.set(DataComponents.ITEM_NAME, Component.literal("[itemerness:travel-token]"))
            if (includeCustomName) {
                stack.set(DataComponents.CUSTOM_NAME, Component.literal("stale custom name"))
            }
            stack.set(DataComponents.LORE, ItemLore(listOf(Component.literal("stale canonical lore"))))
        }
    }

    private fun itemernessRootPresent(stack: ItemStack): Boolean =
        stack.get(DataComponents.CUSTOM_DATA)?.contains(NmsCanonicalItemCodec.ROOT_KEY) == true

    private fun customTag(stack: ItemStack): CompoundTag =
        stack.get(DataComponents.CUSTOM_DATA)?.copyTag() ?: CompoundTag()

    private companion object {
        val VIEWER_ID: UUID = UUID.fromString("b3efd69a-ef71-4c1e-9e09-927f3d440311")

        @JvmStatic
        @BeforeAll
        @Suppress("DEPRECATION")
        fun bootstrapMinecraft() {
            SharedConstants.tryDetectVersion()
            Bootstrap.bootStrap()
            // Standalone NMS tests do not run the server registry component binding phase.
            Items.PAPER.builtInRegistryHolder().bindComponents(DataComponentMap.EMPTY)
            Items.STONE.builtInRegistryHolder().bindComponents(DataComponentMap.EMPTY)
            Items.ECHO_SHARD.builtInRegistryHolder().bindComponents(DataComponentMap.EMPTY)
            Items.BOOK.builtInRegistryHolder().bindComponents(DataComponentMap.EMPTY)
        }
    }
}
