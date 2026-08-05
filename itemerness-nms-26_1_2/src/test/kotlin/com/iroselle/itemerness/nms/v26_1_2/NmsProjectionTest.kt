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
import java.util.ServiceLoader
import java.util.UUID
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import net.minecraft.SharedConstants
import net.minecraft.core.component.DataComponentMap
import net.minecraft.core.component.DataComponents
import net.minecraft.nbt.CompoundTag
import net.minecraft.nbt.StringTag
import net.minecraft.network.chat.Component
import net.minecraft.network.protocol.game.ClientboundContainerSetSlotPacket
import net.minecraft.resources.Identifier
import net.minecraft.server.Bootstrap
import net.minecraft.world.item.ItemStack
import net.minecraft.world.item.Items
import net.minecraft.world.item.component.CustomData
import net.minecraft.world.item.component.ItemLore
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNotSame
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertSame
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
        assertEquals("[itemerness:travel-token]", projected.get(DataComponents.ITEM_NAME)?.string)
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
        assertEquals("[itemerness:travel-token]", projected.get(DataComponents.ITEM_NAME)?.string)
        assertNull(projected.get(DataComponents.LORE))
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
    fun `unmanaged stacks pass through by identity`() {
        val source = ItemStack(Items.STONE)

        val projected = NmsItemStackProjector(runtime()).project(source, VIEWER_ID)

        assertSame(source, projected)
    }

    @Test
    fun `container slot packet is rebuilt around the projected stack`() {
        val packet = ClientboundContainerSetSlotPacket(4, 19, 7, canonicalStack())
        val projector = NmsContainerSlotProjector(NmsItemStackProjector(runtime()))

        val projected = projector.project(packet, VIEWER_ID)

        assertNotSame(packet, projected)
        assertEquals(packet.containerId, projected.containerId)
        assertEquals(packet.stateId, projected.stateId)
        assertEquals(packet.slot, projected.slot)
        assertTrue(itemernessRootPresent(packet.item))
        assertFalse(itemernessRootPresent(projected.item))
        assertEquals("Harbor Travel Token", projected.item.get(DataComponents.ITEM_NAME)?.string)
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

    private fun renderedDisplay(): RenderedDisplay = RenderedDisplay(
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
    )

    private fun decode(stack: ItemStack): com.iroselle.itemerness.projection.CanonicalItemSnapshot =
        (NmsCanonicalItemCodec().decode(stack) as CanonicalDecodeResult.Decoded).snapshot

    private fun canonicalStack(count: Int = 1): ItemStack {
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
        return ItemStack(Items.PAPER, count).also { stack ->
            CustomData.set(DataComponents.CUSTOM_DATA, stack, custom)
            stack.set(DataComponents.ITEM_NAME, Component.literal("[itemerness:travel-token]"))
            stack.set(DataComponents.CUSTOM_NAME, Component.literal("stale custom name"))
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
        }
    }
}
