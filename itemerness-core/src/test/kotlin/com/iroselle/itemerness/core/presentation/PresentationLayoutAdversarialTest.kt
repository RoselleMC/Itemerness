package com.iroselle.itemerness.core.presentation

import com.iroselle.itemerness.api.ItemKey
import com.iroselle.itemerness.api.NamespacedKeyDataValue
import com.iroselle.itemerness.api.StringDataValue
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertInstanceOf
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class PresentationLayoutAdversarialTest {
    @Test
    fun `flow applies theme and section padding aligns field values and emits exact vertical gaps`() {
        val base = PresentationFixtures.source()
        val layout = LayoutSource.Flow(
            id = "itemerness:layout-probe",
            minimumWidthPixels = 160,
            maximumWidthPixels = 160,
            blockGapAfterPixels = 20,
            fieldLeftPaddingPixels = 11,
            fieldValueAlignment = FieldValueAlignment.RIGHT,
            descriptionLeftPaddingPixels = 13,
            descriptionRightPaddingPixels = 17,
            descriptionGapBeforePixels = 10,
            wrapping = mapOf("body" to WrappingSource(widthPixels = 160, maximumLines = 16)),
        )
        val theme = nativeProbeTheme(
            id = "itemerness:layout-probe",
            content = ContentAreaSource(
                minimumWidthPixels = 160,
                maximumWidthPixels = 160,
                leftPaddingPixels = 7,
                rightPaddingPixels = 9,
            ),
        )
        val item = ItemPresentationSource(
            id = "itemerness:layout-probe",
            layout = layout.id,
            theme = theme.id,
            nameMessage = "item.travel-token.name",
            blocks = listOf(
                PresentationBlockSource.Field(
                    labelMessage = "data.region.label",
                    data = "example:region",
                    format = "itemerness:key-message",
                ),
                PresentationBlockSource.Description("item.travel-token.description"),
            ),
        )
        val catalog = compile(
            copySource(
                base,
                layouts = base.layouts + layout,
                themes = base.themes + theme,
                items = base.items + item,
            ),
        )
        val display = render(
            catalog,
            item.id,
            mapOf(PresentationFixtures.region to NamespacedKeyDataValue(ItemKey.parse("example:harbor"))),
            packViewer(),
        )
        val measurer = PixelMeasurer(catalog)

        assertEquals(ThemeRenderer.NATIVE_TOOLTIP_STYLE, display.renderer)
        val field = display.lore.first()
        assertEquals(160, field.logicalWidthPixels)
        assertEquals(18, leadingAdvance(field, measurer))
        assertEquals(9, trailingAdvance(field, measurer))

        val valueIndex = field.runs.indexOfFirst { it.text == "Harbor" }
        assertTrue(valueIndex > 0)
        val valueWidth = measurer.measure(listOf(field.runs[valueIndex])).logicalWidthPixels
        val valueEnd = measurer.measure(field.runs.take(valueIndex + 1)).logicalWidthPixels
        assertEquals(160 - 9, valueEnd)
        assertEquals(valueWidth, 160 - 9 - measurer.measure(field.runs.take(valueIndex)).logicalWidthPixels)

        assertEquals(3, display.lore.drop(1).takeWhile { it.runs.isEmpty() }.size)
        val description = display.lore.first { "Consumed when" in it.plainText }
        assertEquals(20, leadingAdvance(description, measurer))
        assertEquals(26, trailingAdvance(description, measurer))
    }

    @Test
    fun `explicit line preservation is independent from continuation indentation`() {
        val preserved = renderTextProbe(
            value = "aa\nbb",
            preserveExplicitLines = true,
            continuationIndentPixels = 8,
        )
        val joined = renderTextProbe(
            value = "aa\nbb",
            preserveExplicitLines = false,
            continuationIndentPixels = 8,
        )
        val wrapped = renderTextProbe(
            value = "aaaa bbbb",
            preserveExplicitLines = true,
            continuationIndentPixels = 8,
        )

        assertEquals(listOf("aa", "bb"), preserved.lore.map(::contentText))
        assertEquals(listOf("aa bb"), joined.lore.map(::contentText))
        assertEquals(listOf("aaaa", "  bbbb"), wrapped.lore.map(::contentText))
        assertEquals(24, contentWidth(wrapped.lore[0]))
        assertEquals(32, contentWidth(wrapped.lore[1]))

        listOf(preserved, joined, wrapped).forEach { display ->
            val lines = listOf(display.displayName) + display.lore
            assertEquals(40, lines.maxOf(PresentationLine::logicalWidthPixels))
            val anchor = lines.flatMap(PresentationLine::runs).single { it.kind == PresentationRunKind.WIDTH_ANCHOR }
            assertTrue(anchor.style.bold)
            assertTrue(anchor.text.codePoints().allMatch { it == 0x200C })
        }
    }

    @Test
    fun `segmented body paints its fill plane and preserves the exact border width`() {
        val catalog = PresentationFixtures.compile()
        val display = render(
            catalog,
            "itemerness:framed-relic",
            mapOf(
                PresentationFixtures.quality to NamespacedKeyDataValue(ItemKey.parse("example:epic")),
                PresentationFixtures.region to NamespacedKeyDataValue(ItemKey.parse("example:ancient-vault")),
            ),
            packViewer(
                capabilities = setOf("itemerness:segmented-frame-v1"),
                managesLines = true,
            ),
        )
        val fill = requireNotNull(catalog.glyphs["frame.segment.body-fill"])
        val fillText = String(Character.toChars(fill.codePoint))
        val bodyLines = display.lore.filter { line -> line.runs.any { fillText in it.text } }
        val targetWidth = display.lore.first().logicalWidthPixels

        assertTrue(bodyLines.isNotEmpty())
        bodyLines.forEach { line ->
            assertEquals(targetWidth, line.logicalWidthPixels)
            val fillRun = line.runs.single { fillText in it.text }
            assertEquals(PresentationRunKind.FRAME, fillRun.kind)
            assertEquals(targetWidth - 8, fillRun.text.codePointCount(0, fillRun.text.length))
        }
        assertEquals(targetWidth, display.lore.last().logicalWidthPixels)
    }

    @Test
    fun `canvas rejects absolute vertical layer overflow and falls back without leaking bitmap runs`() {
        val base = PresentationFixtures.source()
        val glyphs = base.glyphs.map { glyph ->
            if (glyph.id == "canvas.aurora.background") {
                glyph.copy(visualBounds = glyph.visualBounds.copy(top = -200.0, bottom = 2.0))
            } else {
                glyph
            }
        }
        val catalog = compile(copySource(base, glyphs = glyphs))

        val display = renderCanvasProbe(catalog)

        assertEquals(ItemKey.parse("itemerness:ember"), display.selectedTheme)
        assertTrue(display.fallbackReasons.any {
            it.theme == ItemKey.parse("itemerness:aurora-canvas") && it.code == ThemeFallbackCode.LAYOUT_OVERFLOW
        })
        assertFalse(display.lore.flatMap(PresentationLine::runs).any { it.kind == PresentationRunKind.BITMAP })
    }

    @Test
    fun `canvas anchor that cannot contain its ink falls back atomically`() {
        val base = PresentationFixtures.source()
        val layouts = base.layouts.map { layout ->
            if (layout !is LayoutSource.Canvas || layout.id != "itemerness:bitmap-canvas") return@map layout
            LayoutSource.Canvas(
                id = layout.id,
                widthPixels = layout.widthPixels,
                heightPixels = layout.heightPixels,
                maximumWidthPixels = layout.maximumWidthPixels,
                maximumHeightPixels = layout.maximumHeightPixels,
                reserveTooltipLines = layout.reserveTooltipLines,
                anchors = layout.anchors + ("subtitle" to CanvasAnchorSource(18, 16, 140, 1, OverflowPolicy.ERROR)),
                wrapping = layout.wrapping,
            )
        }
        val catalog = compile(copySource(base, layouts = layouts))

        val display = renderCanvasProbe(catalog)

        assertEquals(ItemKey.parse("itemerness:ember"), display.selectedTheme)
        assertTrue(display.fallbackReasons.any {
            it.theme == ItemKey.parse("itemerness:aurora-canvas") && it.code == ThemeFallbackCode.LAYOUT_OVERFLOW
        })
        assertFalse(display.lore.flatMap(PresentationLine::runs).any { it.kind == PresentationRunKind.BITMAP })
    }

    private fun renderTextProbe(
        value: String,
        preserveExplicitLines: Boolean,
        continuationIndentPixels: Int,
    ): PresentationDisplay {
        val base = PresentationFixtures.source()
        val layout = LayoutSource.Flow(
            id = "itemerness:text-probe",
            minimumWidthPixels = 40,
            maximumWidthPixels = 40,
            wrapping = mapOf(
                "body" to WrappingSource(
                    widthPixels = 40,
                    maximumLines = 8,
                    overflow = OverflowPolicy.ERROR,
                    preserveExplicitLines = preserveExplicitLines,
                    continuationIndentPixels = continuationIndentPixels,
                ),
            ),
        )
        val item = ItemPresentationSource(
            id = "itemerness:text-probe",
            layout = layout.id,
            theme = "itemerness:default",
            nameMessage = "item.travel-token.name",
            blocks = listOf(PresentationBlockSource.Text("example:custom-label", wrapping = "body")),
        )
        val catalog = compile(
            copySource(
                base,
                layouts = base.layouts + layout,
                items = base.items + item,
            ),
        )
        return render(
            catalog,
            item.id,
            mapOf(PresentationFixtures.customLabel to StringDataValue(value)),
            PresentationViewer("en_us"),
        )
    }

    private fun renderCanvasProbe(catalog: PresentationCatalogSnapshot): PresentationDisplay = render(
        catalog,
        "itemerness:survey-codex",
        mapOf(
            PresentationFixtures.customLabel to StringDataValue("Expedition 7"),
            PresentationFixtures.region to NamespacedKeyDataValue(ItemKey.parse("example:aurora-expanse")),
        ),
        packViewer(
            capabilities = setOf(
                "itemerness:native-tooltip-style-v1",
                "itemerness:bitmap-canvas-v1",
                "itemerness:signed-advance-v1",
            ),
            managesLines = true,
            exactMetrics = true,
        ),
    )

    private fun nativeProbeTheme(
        id: String,
        font: String = "itemerness:body",
        content: ContentAreaSource? = null,
    ): ThemeSource = ThemeSource(
        id = id,
        renderer = ThemeRenderer.NATIVE_TOOLTIP_STYLE,
        requiresResourcePack = true,
        requiredCapabilities = listOf("itemerness:native-tooltip-style-v1"),
        vanillaTooltipLines = VanillaTooltipLinePolicy.PRESERVE,
        fallback = "itemerness:default",
        fonts = mapOf("text" to font),
        tooltipStyle = "itemerness:ember",
        content = content,
    )

    private fun packViewer(
        capabilities: Set<String> = setOf("itemerness:native-tooltip-style-v1"),
        managesLines: Boolean = false,
        exactMetrics: Boolean = false,
    ): PresentationViewer = PresentationViewer(
        locale = "en_us",
        assetProfile = ItemKey.parse("itemerness:example-pack-v1"),
        capabilities = capabilities.map(ItemKey::parse),
        metricsRevision = if (exactMetrics) ItemKey.parse("itemerness:example-pack-v1") else null,
        resourcePackLoaded = true,
        managesVanillaTooltipLines = managesLines,
    )

    private fun leadingAdvance(line: PresentationLine, measurer: PixelMeasurer): Int =
        measurer.measure(line.runs.takeWhile { it.kind == PresentationRunKind.SPACING }).logicalWidthPixels

    private fun trailingAdvance(line: PresentationLine, measurer: PixelMeasurer): Int =
        measurer.measure(line.runs.takeLastWhile { it.kind == PresentationRunKind.SPACING }).logicalWidthPixels

    private fun contentText(line: PresentationLine): String = buildString {
        line.runs.filterNot { it.kind == PresentationRunKind.WIDTH_ANCHOR }.forEach { append(it.text) }
    }

    private fun contentWidth(line: PresentationLine): Int = line.logicalWidthPixels - line.runs
        .filter { it.kind == PresentationRunKind.WIDTH_ANCHOR }
        .sumOf { it.text.codePointCount(0, it.text.length) }

    private fun compile(source: PresentationSource): PresentationCatalogSnapshot {
        val compilation = PresentationCompiler().compile(source, revision = 91)
        assertTrue(compilation.successful, compilation.diagnostics.joinToString())
        return requireNotNull(compilation.catalog)
    }

    private fun render(
        catalog: PresentationCatalogSnapshot,
        item: String,
        data: Map<com.iroselle.itemerness.api.DataKey, com.iroselle.itemerness.api.ItemDataValue>,
        viewer: PresentationViewer,
    ): PresentationDisplay {
        val result = PresentationEngine(catalog).render(
            PresentationRenderRequest(ItemKey.parse(item), data, viewer),
        )
        return assertInstanceOf(PresentationRenderResult.Rendered::class.java, result, result.toString()).display
    }

    private fun copySource(
        source: PresentationSource,
        fonts: Collection<FontSource> = source.fonts,
        glyphs: Collection<GlyphSource> = source.glyphs,
        layouts: Collection<LayoutSource> = source.layouts,
        themes: Collection<ThemeSource> = source.themes,
        items: Collection<ItemPresentationSource> = source.items,
    ): PresentationSource = PresentationSource(
        formats = source.formats,
        locales = source.locales,
        fonts = fonts,
        glyphs = glyphs,
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
