package com.iroselle.itemerness.core.presentation

import com.iroselle.itemerness.api.CompoundDataValue
import com.iroselle.itemerness.api.DecimalDataValue
import com.iroselle.itemerness.api.IntegerDataValue
import com.iroselle.itemerness.api.ItemKey
import com.iroselle.itemerness.api.ListDataValue
import com.iroselle.itemerness.api.NamespacedKeyDataValue
import com.iroselle.itemerness.api.StringDataValue
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertInstanceOf
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class PresentationEngineTest {
    private val catalog = PresentationFixtures.compile()
    private val engine = PresentationEngine(catalog)

    @Test
    fun `same canonical values render independently in Chinese and English`() {
        val chinese = render(
            "itemerness:travel-token",
            PresentationFixtures.travelData(),
            PresentationViewer("zh_cn"),
        )
        val english = render(
            "itemerness:travel-token",
            PresentationFixtures.travelData(),
            PresentationViewer("en_us"),
        )

        assertEquals("港口旅行凭证", chinese.displayName.plainText)
        assertEquals("Harbor Travel Token", english.displayName.plainText)
        assertTrue(chinese.lore.joinToString { it.plainText }.contains("港口"))
        assertTrue(english.lore.joinToString { it.plainText }.contains("Harbor"))
        assertEquals(ThemeRenderer.VANILLA_CHARACTER_FRAME, chinese.renderer)
        assertTrue(chinese.lore.first().plainText.startsWith("┌"))
        assertTrue(chinese.lore.last().plainText.endsWith("┘"))
    }

    @Test
    fun `null viewer theme preserves the item theme and an explicit override wins`() {
        val configured = render(
            "itemerness:travel-token",
            PresentationFixtures.travelData(),
            PresentationViewer("en_us", requestedTheme = null),
        )
        val overridden = render(
            "itemerness:travel-token",
            PresentationFixtures.travelData(),
            PresentationViewer("en_us", requestedTheme = ItemKey.parse("itemerness:default")),
        )

        assertEquals(ItemKey.parse("itemerness:vanilla-frame"), configured.selectedTheme)
        assertEquals(ItemKey.parse("itemerness:default"), overridden.selectedTheme)
    }

    @Test
    fun `conditional facts and repeats are resolved before packet-time layout`() {
        val data = mapOf(
            PresentationFixtures.attack to DecimalDataValue(38.4),
            PresentationFixtures.quality to NamespacedKeyDataValue(ItemKey.parse("example:rare")),
            PresentationFixtures.requiredLevel to IntegerDataValue(12),
            PresentationFixtures.sockets to ListDataValue(
                listOf(
                    CompoundDataValue(emptyMap()),
                    CompoundDataValue(mapOf("inserted" to NamespacedKeyDataValue(ItemKey.parse("example:fire-gem")))),
                ),
            ),
        )
        val display = render(
            "itemerness:ember-blade",
            data,
            PresentationViewer(
                locale = "en_us",
                requestedTheme = ItemKey.parse("itemerness:default"),
                facts = mapOf(ItemKey.parse("example:level") to IntegerDataValue(7)),
            ),
        )

        val requirement = display.lore.first { "Required Level" in it.plainText }
        assertEquals(0xFF5555, requirement.runs.first().style.color)
        assertEquals(2, display.lore.count { "Socket" in it.plainText })
        assertTrue(display.lore.any { "Empty" in it.plainText })
        assertTrue(display.lore.any { "example:fire-gem" in it.plainText })
    }

    @Test
    fun `native tooltip style is selected only with its declared capability`() {
        val display = render(
            "itemerness:ember-blade",
            emberData(),
            packViewer(setOf("itemerness:native-tooltip-style-v1")),
        )

        assertEquals(ThemeRenderer.NATIVE_TOOLTIP_STYLE, display.renderer)
        assertEquals(ItemKey.parse("itemerness:ember"), display.tooltipStyle)
        assertTrue(display.fallbackReasons.isEmpty())
    }

    @Test
    fun `segmented frame emits measured rows without author supplied padding`() {
        val display = render(
            "itemerness:framed-relic",
            mapOf(
                PresentationFixtures.quality to NamespacedKeyDataValue(ItemKey.parse("example:epic")),
                PresentationFixtures.region to NamespacedKeyDataValue(ItemKey.parse("example:ancient-vault")),
            ),
            packViewer(setOf("itemerness:segmented-frame-v1"), managesLines = true),
        )

        assertEquals(ThemeRenderer.SEGMENTED_FRAME, display.renderer)
        assertTrue(display.lore.size >= 5)
        assertTrue(display.lore.all { it.logicalWidthPixels <= 220 })
        assertTrue(display.lore.first().runs.all { it.kind == PresentationRunKind.FRAME })
        assertTrue(display.lore.any { line -> line.runs.any { it.kind == PresentationRunKind.WIDTH_ANCHOR } })
    }

    @Test
    fun `managed-only theme falls back before layout when vanilla lines are unsafe`() {
        val display = render(
            "itemerness:framed-relic",
            mapOf(
                PresentationFixtures.quality to NamespacedKeyDataValue(ItemKey.parse("example:epic")),
                PresentationFixtures.region to NamespacedKeyDataValue(ItemKey.parse("example:ancient-vault")),
            ),
            packViewer(setOf("itemerness:segmented-frame-v1"), managesLines = false),
        )

        assertEquals(ItemKey.parse("itemerness:vanilla-frame"), display.selectedTheme)
        assertEquals(ThemeRenderer.VANILLA_CHARACTER_FRAME, display.renderer)
        assertTrue(display.fallbackReasons.any { it.code == ThemeFallbackCode.UNMANAGED_TOOLTIP_LINES })
    }

    @Test
    fun `bitmap canvas anchors width and height only for an exact asset revision`() {
        val display = render(
            "itemerness:survey-codex",
            mapOf(
                PresentationFixtures.customLabel to StringDataValue("Expedition 7"),
                PresentationFixtures.region to NamespacedKeyDataValue(ItemKey.parse("example:aurora-expanse")),
            ),
            packViewer(
                setOf(
                    "itemerness:native-tooltip-style-v1",
                    "itemerness:bitmap-canvas-v1",
                    "itemerness:signed-advance-v1",
                ),
                managesLines = true,
                exactMetrics = true,
            ),
        )

        assertEquals(ThemeRenderer.BITMAP_CANVAS, display.renderer)
        assertEquals(ItemKey.parse("itemerness:transparent-canvas"), display.tooltipStyle)
        assertEquals(10, display.lore.size)
        assertTrue(display.lore.all { it.logicalWidthPixels == 176 })
        assertTrue(display.lore.any { line -> line.runs.any { it.kind == PresentationRunKind.BITMAP } })
        assertTrue(display.lore.any { "Expedition 7" in it.plainText })
    }

    @Test
    fun `bitmap mismatch falls back atomically to native instead of mixing assets`() {
        val display = render(
            "itemerness:survey-codex",
            mapOf(
                PresentationFixtures.customLabel to StringDataValue("Expedition 7"),
                PresentationFixtures.region to NamespacedKeyDataValue(ItemKey.parse("example:aurora-expanse")),
            ),
            packViewer(
                setOf(
                    "itemerness:native-tooltip-style-v1",
                    "itemerness:bitmap-canvas-v1",
                    "itemerness:signed-advance-v1",
                ),
                managesLines = true,
                exactMetrics = false,
            ),
        )

        assertEquals(ThemeRenderer.NATIVE_TOOLTIP_STYLE, display.renderer)
        assertEquals(ItemKey.parse("itemerness:ember"), display.selectedTheme)
        assertTrue(display.fallbackReasons.any { it.code == ThemeFallbackCode.METRICS_MISMATCH })
        assertFalse(display.lore.any { line -> line.runs.any { it.kind == PresentationRunKind.BITMAP } })
    }

    @Test
    fun `canvas component budget falls back atomically`() {
        val themes = PresentationFixtures.themes().map { theme ->
            if (theme.id != "itemerness:aurora-canvas") return@map theme
            val canvas = requireNotNull(theme.canvas)
            ThemeSource(
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
                canvas = CanvasThemeSource(
                    widthPixels = canvas.widthPixels,
                    heightPixels = canvas.heightPixels,
                    maximumWidthPixels = canvas.maximumWidthPixels,
                    maximumHeightPixels = canvas.maximumHeightPixels,
                    reserveTooltipLines = canvas.reserveTooltipLines,
                    layers = canvas.layers,
                    measuredAdvancePixels = canvas.measuredAdvancePixels,
                    finalTooltipWidthPixels = canvas.finalTooltipWidthPixels,
                    rejectNegativeFinalAdvance = canvas.rejectNegativeFinalAdvance,
                    rejectOutOfBoundsLayer = canvas.rejectOutOfBoundsLayer,
                    maximumEmittedComponents = 1,
                ),
                requireExactFontMetrics = theme.requireExactFontMetrics,
            )
        }
        val boundedEngine = PresentationEngine(
            PresentationFixtures.compile(PresentationFixtures.source(themeSources = themes)),
        )
        val result = boundedEngine.render(
            PresentationRenderRequest(
                ItemKey.parse("itemerness:survey-codex"),
                mapOf(
                    PresentationFixtures.customLabel to StringDataValue("Expedition 7"),
                    PresentationFixtures.region to NamespacedKeyDataValue(ItemKey.parse("example:aurora-expanse")),
                ),
                packViewer(
                    setOf(
                        "itemerness:native-tooltip-style-v1",
                        "itemerness:bitmap-canvas-v1",
                        "itemerness:signed-advance-v1",
                    ),
                    managesLines = true,
                    exactMetrics = true,
                ),
            ),
        )

        val display = assertInstanceOf(PresentationRenderResult.Rendered::class.java, result).display
        assertEquals(ItemKey.parse("itemerness:ember"), display.selectedTheme)
        assertTrue(display.fallbackReasons.any { it.code == ThemeFallbackCode.OUTPUT_BUDGET_EXCEEDED })
        assertFalse(display.lore.any { line -> line.runs.any { it.kind == PresentationRunKind.BITMAP } })
    }

    @Test
    fun `nested item block renders immutable supplied summaries without recursive callbacks`() {
        val display = render(
            "itemerness:nested-satchel",
            emptyMap(),
            PresentationViewer("en_us"),
            listOf(NestedItemPresentation(ItemKey.parse("itemerness:travel-token"), "Harbor Travel Token", 2)),
        )

        assertTrue(display.lore.any { "Harbor Travel Token ×2" in it.plainText })
        assertEquals(ThemeRenderer.PLAIN, display.renderer)
    }

    @Test
    fun `missing runtime data is rejected without partially rendered output`() {
        val result = engine.render(
            PresentationRenderRequest(
                ItemKey.parse("itemerness:travel-token"),
                emptyMap(),
                PresentationViewer("en_us"),
            ),
        )

        val rejected = assertInstanceOf(PresentationRenderResult.Rejected::class.java, result)
        assertEquals(PresentationRenderFailureCode.MISSING_DATA, rejected.failure.code)
    }

    @Test
    fun `omit policy skips missing text field and repeat blocks without rejecting the item`() {
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
                    missingPolicy = MissingDataPolicy.OMIT,
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
                PresentationBlockSource.Description("item.nested-satchel.description"),
            ),
        )
        val omittingEngine = PresentationEngine(
            PresentationFixtures.compile(PresentationFixtures.source(itemSources = listOf(item))),
        )

        val result = omittingEngine.render(
            PresentationRenderRequest(
                ItemKey.parse("itemerness:nested-satchel"),
                emptyMap(),
                PresentationViewer("en_us"),
            ),
        )

        val display = assertInstanceOf(PresentationRenderResult.Rendered::class.java, result).display
        val lore = display.lore.joinToString(" ") { it.plainText }
        assertTrue(lore.contains("projected recursively"))
        assertFalse(lore.contains("Region"))
        assertFalse(lore.contains("Socket"))
    }

    @Test
    fun `repeat defaults to an error when its source data is absent`() {
        val item = ItemPresentationSource(
            id = "itemerness:nested-satchel",
            layout = "itemerness:plain",
            theme = "itemerness:default",
            nameMessage = "item.nested-satchel.name",
            blocks = listOf(
                PresentationBlockSource.Repeat(
                    data = "example:sockets",
                    maximumElements = 8,
                    template = CompoundFieldTemplateSource(
                        "data.socket.label",
                        "inserted",
                        "data.socket.empty",
                    ),
                ),
            ),
        )
        val strictEngine = PresentationEngine(
            PresentationFixtures.compile(PresentationFixtures.source(itemSources = listOf(item))),
        )

        val result = strictEngine.render(
            PresentationRenderRequest(
                ItemKey.parse("itemerness:nested-satchel"),
                emptyMap(),
                PresentationViewer("en_us"),
            ),
        )

        val rejected = assertInstanceOf(PresentationRenderResult.Rejected::class.java, result)
        assertEquals(PresentationRenderFailureCode.MISSING_DATA, rejected.failure.code)
    }

    private fun emberData() = mapOf(
        PresentationFixtures.attack to DecimalDataValue(38.4),
        PresentationFixtures.quality to NamespacedKeyDataValue(ItemKey.parse("example:rare")),
        PresentationFixtures.requiredLevel to IntegerDataValue(12),
        PresentationFixtures.sockets to ListDataValue(emptyList()),
    )

    private fun packViewer(
        capabilities: Set<String>,
        managesLines: Boolean = false,
        exactMetrics: Boolean = false,
    ): PresentationViewer = PresentationViewer(
        locale = "en_us",
        assetProfile = ItemKey.parse("itemerness:example-pack-v1"),
        capabilities = capabilities.map(ItemKey::parse),
        metricsRevision = if (exactMetrics) ItemKey.parse("itemerness:example-pack-v1") else ItemKey.parse("itemerness:wrong"),
        resourcePackLoaded = true,
        managesVanillaTooltipLines = managesLines,
    )

    private fun render(
        key: String,
        data: Map<com.iroselle.itemerness.api.DataKey, com.iroselle.itemerness.api.ItemDataValue>,
        viewer: PresentationViewer,
        nested: List<NestedItemPresentation> = emptyList(),
    ): PresentationDisplay {
        val result = engine.render(PresentationRenderRequest(ItemKey.parse(key), data, viewer, nested))
        return assertInstanceOf(PresentationRenderResult.Rendered::class.java, result).display
    }
}
