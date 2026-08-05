package com.iroselle.itemerness.core.presentation

import com.iroselle.itemerness.api.ItemKey
import com.iroselle.itemerness.api.StringDataValue
import org.junit.jupiter.api.Assertions.assertDoesNotThrow
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertInstanceOf
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class PresentationMetricAndBudgetTest {
    @Test
    fun `measurer honors per-glyph bold ink flags fallback glyphs and italic geometry`() {
        val base = PresentationFixtures.source()
        val font = FontSource(
            id = "itemerness:metric-probe",
            metricsRevision = "itemerness:metric-probe-v1",
            glyphs = mapOf(
                'A'.code to GlyphMetricSource(
                    advancePixels = 5.0,
                    visualBounds = VisualBoundsSource(-1.0, 4.0, -7.0, 1.0),
                    boldExtraAdvancePixels = 2.0,
                ),
                '~'.code to GlyphMetricSource(
                    advancePixels = 4.0,
                    visualBounds = VisualBoundsSource(-50.0, 50.0, -80.0, 80.0),
                    boldExtraAdvancePixels = 0.0,
                    hasInk = false,
                ),
            ),
            fallbackGlyph = GlyphMetricSource(
                advancePixels = 7.0,
                visualBounds = VisualBoundsSource(-2.0, 6.0, -9.0, 2.0),
                boldExtraAdvancePixels = 3.0,
            ),
        )
        val catalog = compile(copySource(base, fonts = base.fonts + font))
        val measurer = PixelMeasurer(catalog)
        val normalStyle = PresentationTextStyle(font = ItemKey.parse(font.id))

        val normal = measurer.measure(listOf(PresentationTextRun("A", normalStyle)))
        val bold = measurer.measure(listOf(PresentationTextRun("A", normalStyle.copy(bold = true))))
        val italic = measurer.measure(listOf(PresentationTextRun("A", normalStyle.copy(italic = true))))
        val noInk = measurer.measure(listOf(PresentationTextRun("~", normalStyle)))
        val fallback = measurer.measure(listOf(PresentationTextRun("\u03a9", normalStyle)))
        val boldFallback = measurer.measure(listOf(PresentationTextRun("\u03a9", normalStyle.copy(bold = true))))

        assertEquals(5, normal.logicalWidthPixels)
        assertEquals(7, bold.logicalWidthPixels)
        assertEquals(5, italic.logicalWidthPixels)
        assertNotEquals(normal.visualBounds, italic.visualBounds)
        assertTrue(italic.visualBounds.right > normal.visualBounds.right)
        assertTrue(
            bold.visualBounds.right - bold.visualBounds.left >=
                normal.visualBounds.right - normal.visualBounds.left,
        )

        assertEquals(4, noInk.logicalWidthPixels)
        assertEquals(PresentationVisualBounds(0.0, 4.0, 0.0, 0.0), noInk.visualBounds)
        assertEquals(7, fallback.logicalWidthPixels)
        assertEquals(PresentationVisualBounds(-2.0, 6.0, -9.0, 2.0), fallback.visualBounds)
        assertEquals(10, boldFallback.logicalWidthPixels)
    }

    @Test
    fun `visual ink overhang causes a safe whole-theme fallback`() {
        val display = renderMetricProbe(
            GlyphMetricSource(
                advancePixels = 5.0,
                visualBounds = VisualBoundsSource(-100.0, 100.0, -8.0, 1.0),
            ),
            value = "XXXXXX",
        )

        assertEquals(ItemKey.parse("itemerness:default"), display.selectedTheme)
        assertTrue(display.fallbackReasons.any {
            it.theme == ItemKey.parse("itemerness:metric-budget-probe") &&
                it.code == ThemeFallbackCode.OUTPUT_BUDGET_EXCEEDED
        })
    }

    @Test
    fun `visual height exceeding the hard budget causes a safe whole-theme fallback`() {
        val display = renderMetricProbe(
            GlyphMetricSource(
                advancePixels = 5.0,
                visualBounds = VisualBoundsSource(0.0, 4.0, -90.0, 90.0),
            ),
            value = "X\nX",
        )

        assertEquals(ItemKey.parse("itemerness:default"), display.selectedTheme)
        assertTrue(display.fallbackReasons.any {
            it.theme == ItemKey.parse("itemerness:metric-budget-probe") &&
                it.code == ThemeFallbackCode.OUTPUT_BUDGET_EXCEEDED
        })
    }

    @Test
    fun `run serialization boundary is measured in UTF-16 code units`() {
        val style = PresentationTextStyle(font = ItemKey.parse("minecraft:default"))
        val nonBmp = String(Character.toChars(0x1F680))

        assertDoesNotThrow { PresentationTextRun(nonBmp.repeat(4_096), style) }
        assertThrows(IllegalArgumentException::class.java) {
            PresentationTextRun(nonBmp.repeat(4_096) + "x", style)
        }
    }

    @Test
    fun `total UTF-16 budget cannot be bypassed with individually valid runs`() {
        val base = PresentationFixtures.source()
        val defaultFont = base.fonts.single { it.id == "minecraft:default" }
        val rocketCodePoint = 0x1F680
        val font = FontSource(
            id = "itemerness:utf16-probe",
            metricsRevision = "itemerness:utf16-probe-v1",
            glyphs = defaultFont.glyphs + (
                rocketCodePoint to GlyphMetricSource(
                    advancePixels = 0.0,
                    visualBounds = VisualBoundsSource(0.0, 0.0, 0.0, 0.0),
                    boldExtraAdvancePixels = 0.0,
                    hasInk = false,
                )
                ),
            fallbackAdvancePixels = 6.0,
        )
        val layout = LayoutSource.Flow(
            id = "itemerness:utf16-probe",
            minimumWidthPixels = 1,
            maximumWidthPixels = 220,
            wrapping = mapOf(
                "body" to WrappingSource(
                    widthPixels = 220,
                    maximumLines = 64,
                    overflow = OverflowPolicy.ELLIPSIS,
                    preserveExplicitLines = true,
                ),
            ),
        )
        val theme = nativeProbeTheme("itemerness:utf16-probe", font.id)
        val item = ItemPresentationSource(
            id = "itemerness:utf16-probe",
            layout = layout.id,
            theme = theme.id,
            nameMessage = "item.travel-token.name",
            blocks = listOf(
                PresentationBlockSource.Text(
                    data = "example:custom-label",
                    wrapping = "body",
                    unbreakable = true,
                ),
            ),
        )
        val catalog = compile(
            copySource(
                base,
                fonts = base.fonts + font,
                layouts = base.layouts + layout,
                themes = base.themes + theme,
                items = base.items + item,
            ),
            PresentationBudgets(maximumTextCodePoints = 131_072),
        )
        val rocket = String(Character.toChars(rocketCodePoint))
        val value = List(17) { rocket.repeat(4_096) }.joinToString("\n")

        val display = render(
            catalog,
            item.id,
            value,
        )

        assertEquals(ItemKey.parse("itemerness:default"), display.selectedTheme)
        assertTrue(display.fallbackReasons.any {
            it.theme == ItemKey.parse(theme.id) && it.code == ThemeFallbackCode.OUTPUT_BUDGET_EXCEEDED
        })
        assertTrue(display.lore.all { line -> line.runs.sumOf { it.text.length } <= 8_192 })
    }

    private fun renderMetricProbe(
        metric: GlyphMetricSource,
        value: String,
    ): PresentationDisplay {
        val base = PresentationFixtures.source()
        val font = FontSource(
            id = "itemerness:metric-budget-probe",
            metricsRevision = "itemerness:metric-budget-probe-v1",
            glyphs = mapOf('X'.code to metric),
            fallback = "minecraft:default",
        )
        val layout = LayoutSource.Flow(
            id = "itemerness:metric-budget-probe",
            minimumWidthPixels = 1,
            maximumWidthPixels = 220,
            wrapping = mapOf("body" to WrappingSource(maximumLines = 4, overflow = OverflowPolicy.ERROR)),
        )
        val theme = nativeProbeTheme("itemerness:metric-budget-probe", font.id)
        val item = ItemPresentationSource(
            id = "itemerness:metric-budget-probe",
            layout = layout.id,
            theme = theme.id,
            nameMessage = "item.travel-token.name",
            blocks = listOf(PresentationBlockSource.Text("example:custom-label")),
        )
        val catalog = compile(
            copySource(
                base,
                fonts = base.fonts + font,
                layouts = base.layouts + layout,
                themes = base.themes + theme,
                items = base.items + item,
            ),
        )
        return render(catalog, item.id, value)
    }

    private fun render(
        catalog: PresentationCatalogSnapshot,
        itemId: String,
        value: String,
    ): PresentationDisplay {
        val result = PresentationEngine(catalog).render(
            PresentationRenderRequest(
                itemKey = ItemKey.parse(itemId),
                data = mapOf(PresentationFixtures.customLabel to StringDataValue(value)),
                viewer = PresentationViewer(
                    locale = "en_us",
                    assetProfile = ItemKey.parse("itemerness:example-pack-v1"),
                    capabilities = setOf(ItemKey.parse("itemerness:native-tooltip-style-v1")),
                    resourcePackLoaded = true,
                ),
            ),
        )
        return assertInstanceOf(PresentationRenderResult.Rendered::class.java, result).display
    }

    private fun nativeProbeTheme(id: String, font: String): ThemeSource = ThemeSource(
        id = id,
        renderer = ThemeRenderer.NATIVE_TOOLTIP_STYLE,
        requiresResourcePack = true,
        requiredCapabilities = listOf("itemerness:native-tooltip-style-v1"),
        vanillaTooltipLines = VanillaTooltipLinePolicy.PRESERVE,
        fallback = "itemerness:default",
        fonts = mapOf("text" to font),
        tooltipStyle = "itemerness:ember",
    )

    private fun compile(
        source: PresentationSource,
        budgets: PresentationBudgets = PresentationBudgets(),
    ): PresentationCatalogSnapshot {
        val compilation = PresentationCompiler(budgets = budgets).compile(source, revision = 92)
        assertTrue(compilation.successful, compilation.diagnostics.joinToString())
        return requireNotNull(compilation.catalog)
    }

    private fun copySource(
        source: PresentationSource,
        fonts: Collection<FontSource> = source.fonts,
        layouts: Collection<LayoutSource> = source.layouts,
        themes: Collection<ThemeSource> = source.themes,
        items: Collection<ItemPresentationSource> = source.items,
    ): PresentationSource = PresentationSource(
        formats = source.formats,
        locales = source.locales,
        fonts = fonts,
        glyphs = source.glyphs,
        bitmaps = source.bitmaps,
        assetProfiles = source.assetProfiles,
        viewerFacts = source.viewerFacts,
        resourcePackBindings = source.resourcePackBindings,
        layouts = layouts,
        themes = themes,
        items = items,
        spacing = source.spacing,
        tooltipStyles = source.tooltipStyles,
    )
}
