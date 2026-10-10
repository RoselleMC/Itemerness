package com.iroselle.itemerness.core.presentation

import com.iroselle.itemerness.api.ItemKey
import com.iroselle.itemerness.api.StringDataValue
import java.util.UUID
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class PresentationCompilerTest {
    @Test
    fun `compiles the five bundled presentation shapes into one immutable snapshot`() {
        val compilation = PresentationCompiler().compile(PresentationFixtures.source(), revision = 19)

        assertTrue(compilation.successful, compilation.diagnostics.joinToString())
        val catalog = requireNotNull(compilation.catalog)
        assertEquals(19, catalog.revision)
        assertEquals(5, catalog.items.size)
        assertEquals(5, catalog.themes.size)
        assertEquals(3, catalog.layouts.size)
        assertEquals(2, catalog.locales.size)
        assertEquals(6, catalog.viewerFacts.size)
        assertEquals(1, catalog.resourcePackBindings.size)
        assertThrows(UnsupportedOperationException::class.java) {
            @Suppress("UNCHECKED_CAST")
            (catalog.items as MutableMap<ItemKey, CompiledItemPresentation>).clear()
        }
        assertEquals(20, catalog.glyphs.size)
    }

    @Test
    fun `compiles explicit missing policies and defaults unspecified blocks to error`() {
        val item = ItemPresentationSource(
            id = "itemerness:nested-satchel",
            layout = "itemerness:plain",
            theme = "itemerness:default",
            nameMessage = "item.nested-satchel.name",
            blocks = listOf(
                PresentationBlockSource.Text(
                    data = "example:custom-label",
                    missingPolicy = MissingDataPolicy.OMIT,
                ),
                PresentationBlockSource.Field(
                    labelMessage = "data.region.label",
                    data = "example:region",
                ),
                PresentationBlockSource.Repeat(
                    data = "example:sockets",
                    maximumElements = 8,
                    template = CompoundFieldTemplateSource(
                        "data.socket.label",
                        "inserted",
                        "data.socket.empty",
                    ),
                    missingPolicy = MissingDataPolicy.OMIT,
                ),
            ),
        )

        val compilation = PresentationCompiler().compile(PresentationFixtures.source(itemSources = listOf(item)))

        assertTrue(compilation.successful, compilation.diagnostics.joinToString())
        val blocks = requireNotNull(compilation.catalog)
            .items
            .getValue(ItemKey.parse("itemerness:nested-satchel"))
            .blocks
        assertEquals(MissingDataPolicy.OMIT, (blocks[0] as CompiledPresentationBlock.Text).missingPolicy)
        assertEquals(MissingDataPolicy.ERROR, (blocks[1] as CompiledPresentationBlock.Field).missingPolicy)
        assertEquals(MissingDataPolicy.OMIT, (blocks[2] as CompiledPresentationBlock.Repeat).missingPolicy)
    }

    @Test
    fun `rejects fallback cycles instead of publishing a partially usable graph`() {
        val themes = PresentationFixtures.themes().filterNot { it.id == "itemerness:default" } + ThemeSource(
            id = "itemerness:default",
            renderer = ThemeRenderer.PLAIN,
            requiresResourcePack = false,
            vanillaTooltipLines = VanillaTooltipLinePolicy.PRESERVE,
            fallback = "itemerness:vanilla-frame",
            fonts = mapOf("text" to "minecraft:default"),
        )

        val compilation = PresentationCompiler().compile(PresentationFixtures.source(themeSources = themes))

        assertFalse(compilation.successful)
        assertTrue(compilation.diagnostics.any { it.code == PresentationDiagnosticCode.REFERENCE_CYCLE })
        assertTrue(compilation.diagnostics.any { "Plain themes must be terminal" in it.message })
    }

    @Test
    fun `requires every referenced message in the default fallback chain`() {
        val locales = PresentationFixtures.locales().map { locale ->
            if (locale.locale != "en_us") locale else LocaleSource(
                "en_us",
                messages = locale.messages - "item.travel-token.name",
            )
        }

        val compilation = PresentationCompiler().compile(PresentationFixtures.source(localeSources = locales))

        assertFalse(compilation.successful)
        assertTrue(compilation.diagnostics.any {
            it.code == PresentationDiagnosticCode.MISSING_MESSAGE && "item.travel-token.name" in it.message
        })
    }

    @Test
    fun `rejects unknown anchors and repeat limits above the global budget`() {
        val invalidItems = PresentationFixtures.items().map { item ->
            when (item.id) {
                "itemerness:survey-codex" -> ItemPresentationSource(
                    item.id,
                    item.layout,
                    item.theme,
                    item.nameMessage,
                    listOf(PresentationBlockSource.Text("example:custom-label", anchor = "nowhere")),
                )
                "itemerness:ember-blade" -> ItemPresentationSource(
                    item.id,
                    item.layout,
                    item.theme,
                    item.nameMessage,
                    listOf(
                        PresentationBlockSource.Repeat(
                            "example:sockets",
                            65,
                            CompoundFieldTemplateSource("data.socket.label", "inserted", "data.socket.empty"),
                        ),
                    ),
                )
                else -> item
            }
        }

        val compilation = PresentationCompiler().compile(PresentationFixtures.source(itemSources = invalidItems))

        assertFalse(compilation.successful)
        assertTrue(compilation.diagnostics.any { it.code == PresentationDiagnosticCode.MISSING_REFERENCE && it.path.endsWith("anchor") })
        assertTrue(compilation.diagnostics.any { it.code == PresentationDiagnosticCode.BUDGET_EXCEEDED && "maximum-elements" in it.path })
    }

    @Test
    fun `source collections are defensively copied before compilation`() {
        val messages = linkedMapOf("only.message" to "stable")
        val locale = LocaleSource("en_us", messages = messages)
        messages.clear()

        assertEquals("stable", locale.messages["only.message"])
        assertThrows(UnsupportedOperationException::class.java) {
            @Suppress("UNCHECKED_CAST")
            (locale.messages as MutableMap<String, String>)["later"] = "mutation"
        }
    }

    @Test
    fun `rejects recursive formatter references`() {
        val base = PresentationFixtures.source()
        val source = PresentationSource(
            formats = base.formats + listOf(
                FormatSource.ListFormat("example:list-a", "example:list-b", "format.list-separator"),
                FormatSource.ListFormat("example:list-b", "example:list-a", "format.list-separator"),
            ),
            locales = base.locales,
            fonts = base.fonts,
            glyphs = base.glyphs,
            bitmaps = base.bitmaps,
            assetProfiles = base.assetProfiles,
            viewerFacts = base.viewerFacts,
            resourcePackBindings = base.resourcePackBindings,
            layouts = base.layouts,
            themes = base.themes,
            items = base.items,
            spacing = base.spacing,
            tooltipStyles = base.tooltipStyles,
        )

        val compilation = PresentationCompiler().compile(source)

        assertFalse(compilation.successful)
        assertTrue(compilation.diagnostics.any { it.code == PresentationDiagnosticCode.REFERENCE_CYCLE && it.path.startsWith("formats") })
    }

    @Test
    fun `conditional facts must exist be typed and participate in cache identity`() {
        val facts = PresentationFixtures.viewerFacts().map { fact ->
            if (fact.id == "example:level") {
                ViewerFactSource("example:level", ViewerFactType.INTEGER, listOf("api"), StringDataValue("wrong"), cacheKey = false)
            } else {
                fact
            }
        }

        val compilation = PresentationCompiler().compile(copySource(PresentationFixtures.source(), viewerFacts = facts))

        assertFalse(compilation.successful)
        assertTrue(compilation.diagnostics.any { it.path.contains("viewer-facts") && "does not match" in it.message })
        assertTrue(compilation.diagnostics.any { "must participate in the cache key" in it.message })
    }

    @Test
    fun `disabled pack placeholders are accepted but enabled bindings are strict`() {
        val invalid = ResourcePackBindingSource(
            "itemerness:example-pack-v1",
            true,
            UUID(0, 0),
            "0000000000000000000000000000000000000000",
            "itemerness:example-pack-v1",
        )

        val compilation = PresentationCompiler().compile(
            copySource(PresentationFixtures.source(), bindings = listOf(invalid)),
        )

        assertFalse(compilation.successful)
        assertTrue(compilation.diagnostics.count { it.code == PresentationDiagnosticCode.INVALID_VALUE && it.path.startsWith("resource-pack-bindings") } >= 2)
    }

    @Test
    fun `assumed delivery needs no pack identity`() {
        val assumed = ResourcePackBindingSource(
            id = "itemerness:example-pack-v1",
            enabled = true,
            assetProfile = "itemerness:example-pack-v1",
            delivery = ResourcePackDelivery.ASSUMED,
        )

        val compilation = PresentationCompiler().compile(
            copySource(PresentationFixtures.source(), bindings = listOf(assumed)),
        )

        assertTrue(compilation.successful, compilation.diagnostics.joinToString())
        val binding = requireNotNull(compilation.catalog).resourcePackBindings.values.single()
        assertEquals(ResourcePackDelivery.ASSUMED, binding.delivery)
        assertEquals(null, binding.packId)
        assertEquals(null, binding.sha1)
    }

    @Test
    fun `assumed delivery still rejects placeholder or malformed pack identity`() {
        val assumed = ResourcePackBindingSource(
            id = "itemerness:example-pack-v1",
            enabled = true,
            packId = UUID(0, 0),
            sha1 = "not-a-sha1",
            assetProfile = "itemerness:example-pack-v1",
            delivery = ResourcePackDelivery.ASSUMED,
        )

        val compilation = PresentationCompiler().compile(
            copySource(PresentationFixtures.source(), bindings = listOf(assumed)),
        )

        assertFalse(compilation.successful)
        assertTrue(compilation.diagnostics.any { it.code == PresentationDiagnosticCode.INVALID_VALUE && it.path.endsWith(".pack-id") })
        assertTrue(compilation.diagnostics.any { it.code == PresentationDiagnosticCode.INVALID_VALUE && it.path.endsWith(".sha1") })
    }

    @Test
    fun `at most one enabled binding may use assumed delivery`() {
        fun assumed(id: String, enabled: Boolean = true) = ResourcePackBindingSource(
            id = id,
            enabled = enabled,
            assetProfile = "itemerness:example-pack-v1",
            delivery = ResourcePackDelivery.ASSUMED,
        )

        val rejected = PresentationCompiler().compile(
            copySource(PresentationFixtures.source(), bindings = listOf(assumed("example:first"), assumed("example:second"))),
        )
        val accepted = PresentationCompiler().compile(
            copySource(
                PresentationFixtures.source(),
                bindings = listOf(assumed("example:first"), assumed("example:second", enabled = false)),
            ),
        )

        assertFalse(rejected.successful)
        assertTrue(rejected.diagnostics.any { it.path == "resource-pack-bindings[1].delivery" })
        assertTrue(accepted.successful, accepted.diagnostics.joinToString())
    }

    @Test
    fun `assumed delivery keeps the duplicate enabled pack id rule`() {
        val packId = UUID.fromString("7b3f1c2a-0000-4000-8000-000000000001")
        val verified = ResourcePackBindingSource(
            "example:verified",
            true,
            packId,
            "1".repeat(40),
            "itemerness:example-pack-v1",
        )
        val assumed = ResourcePackBindingSource(
            id = "example:assumed",
            enabled = true,
            packId = packId,
            assetProfile = "itemerness:example-pack-v1",
            delivery = ResourcePackDelivery.ASSUMED,
        )

        val compilation = PresentationCompiler().compile(
            copySource(PresentationFixtures.source(), bindings = listOf(verified, assumed)),
        )

        assertFalse(compilation.successful)
        assertTrue(compilation.diagnostics.any { it.code == PresentationDiagnosticCode.DUPLICATE_ID && it.path.endsWith(".pack-id") })
    }

    @Test
    fun `disabled item presentations are validated but omitted from the published snapshot`() {
        val items = PresentationFixtures.items().map { item ->
            if (item.id == "itemerness:travel-token") {
                ItemPresentationSource(item.id, item.layout, item.theme, item.nameMessage, item.blocks, enabled = false)
            } else {
                item
            }
        }

        val compilation = PresentationCompiler().compile(copySource(PresentationFixtures.source(), items = items))

        assertTrue(compilation.successful, compilation.diagnostics.joinToString())
        val catalog = requireNotNull(compilation.catalog)
        assertFalse(ItemKey.parse("itemerness:travel-token") in catalog.items)
        assertTrue(ItemKey.parse("itemerness:travel-token") in catalog.validationItems)
    }

    @Test
    fun `canvas measured advance must equal its emitted tooltip width`() {
        val themes = PresentationFixtures.themes().map { theme ->
            if (theme.id != "itemerness:aurora-canvas") return@map theme
            val canvas = requireNotNull(theme.canvas)
            copyTheme(
                theme,
                CanvasThemeSource(
                    widthPixels = canvas.widthPixels,
                    heightPixels = canvas.heightPixels,
                    maximumWidthPixels = canvas.maximumWidthPixels,
                    maximumHeightPixels = canvas.maximumHeightPixels,
                    reserveTooltipLines = canvas.reserveTooltipLines,
                    layers = canvas.layers,
                    measuredAdvancePixels = canvas.finalTooltipWidthPixels - 1,
                    finalTooltipWidthPixels = canvas.finalTooltipWidthPixels,
                    rejectNegativeFinalAdvance = canvas.rejectNegativeFinalAdvance,
                    rejectOutOfBoundsLayer = canvas.rejectOutOfBoundsLayer,
                    maximumEmittedComponents = canvas.maximumEmittedComponents,
                ),
            )
        }

        val compilation = PresentationCompiler().compile(
            PresentationFixtures.source(themeSources = themes),
        )

        assertFalse(compilation.successful)
        assertTrue(compilation.diagnostics.any {
            it.path.endsWith("canvas.measured-advance") && "must match" in it.message
        })
    }

    private fun copySource(
        base: PresentationSource,
        viewerFacts: List<ViewerFactSource> = base.viewerFacts,
        bindings: List<ResourcePackBindingSource> = base.resourcePackBindings,
        items: List<ItemPresentationSource> = base.items,
    ): PresentationSource = PresentationSource(
        formats = base.formats,
        locales = base.locales,
        fonts = base.fonts,
        glyphs = base.glyphs,
        bitmaps = base.bitmaps,
        assetProfiles = base.assetProfiles,
        viewerFacts = viewerFacts,
        resourcePackBindings = bindings,
        layouts = base.layouts,
        themes = base.themes,
        items = items,
        spacing = base.spacing,
        tooltipStyles = base.tooltipStyles,
    )

    private fun copyTheme(theme: ThemeSource, canvas: CanvasThemeSource): ThemeSource = ThemeSource(
        id = theme.id,
        renderer = theme.renderer,
        requiresResourcePack = theme.requiresResourcePack,
        requiredCapabilities = theme.requiredCapabilities,
        vanillaTooltipLines = theme.vanillaTooltipLines,
        fallback = theme.fallback,
        fonts = theme.fonts,
        styles = theme.styles,
        tooltipStyle = theme.tooltipStyle,
        content = theme.content,
        characterFrame = theme.characterFrame,
        segmentedFrame = theme.segmentedFrame,
        canvas = canvas,
        requireExactFontMetrics = theme.requireExactFontMetrics,
    )
}
