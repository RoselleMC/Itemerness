package com.iroselle.itemerness.bukkit.editor

import com.iroselle.itemerness.core.presentation.*
import com.iroselle.itemerness.bukkit.editor.YamlEncoding.mapping as map
import com.iroselle.itemerness.bukkit.editor.YamlEncoding.enum as token

internal object PresentationYamlEncoding {
    fun format(format: FormatSource): Map<String, Any?> = when (format) {
        is FormatSource.IntegerFormat -> map("type" to "integer", "pattern" to format.pattern)
        is FormatSource.DecimalFormat -> map("type" to "decimal", "pattern" to format.pattern, "multiply" to format.multiply, "suffix-message" to format.suffixMessage)
        is FormatSource.BooleanFormat -> map("type" to "boolean", "true-message" to format.trueMessage, "false-message" to format.falseMessage)
        is FormatSource.NamespacedKeyFormat -> map("type" to "namespaced-key", "mode" to token(format.mode), "message-pattern" to format.messagePattern, "missing-value" to token(format.missingValue))
        is FormatSource.ListFormat -> map("type" to "list<namespaced-key>", "element-format" to format.elementFormat, "separator-message" to format.separatorMessage)
    }

    fun fact(fact: ViewerFactSource): Map<String, Any?> = map("type" to token(fact.type), "providers" to fact.providers,
        "nullable" to fact.nullable, "cache-key" to fact.cacheKey, "default" to fact.defaultValue?.let(YamlEncoding::typed))

    fun layout(layout: LayoutSource): Map<String, Any?> = when (layout) {
        is LayoutSource.Flow -> map("content-width" to map("minimum-pixels" to layout.minimumWidthPixels, "maximum-pixels" to layout.maximumWidthPixels, "strategy" to "clamp-content"),
            "flow" to listOf(map("source" to "blocks", "gap-after-pixels" to layout.blockGapAfterPixels)),
            "sections" to map("field" to map("left-padding-pixels" to layout.fieldLeftPaddingPixels, "icon-gap-pixels" to layout.fieldIconGapPixels, "value-alignment" to token(layout.fieldValueAlignment)),
                "description" to map("left-padding-pixels" to layout.descriptionLeftPaddingPixels, "right-padding-pixels" to layout.descriptionRightPaddingPixels, "gap-before-pixels" to layout.descriptionGapBeforePixels)),
            "wrapping" to layout.wrapping.mapValues { wrapping(it.value) })
        is LayoutSource.Canvas -> map("renderer" to "bitmap-canvas", "canvas" to map("width-pixels" to layout.widthPixels, "height-pixels" to layout.heightPixels,
            "maximum-width-pixels" to layout.maximumWidthPixels, "maximum-height-pixels" to layout.maximumHeightPixels, "reserve-tooltip-lines" to layout.reserveTooltipLines, "clip-policy" to "reject"),
            "anchors" to layout.anchors.mapValues { (_, anchor) -> map("x" to anchor.x, "y" to anchor.y, "width" to anchor.width, "height" to anchor.height, "overflow" to token(anchor.overflow)) },
            "wrapping" to layout.wrapping.mapValues { wrapping(it.value) })
    }

    private fun wrapping(wrap: WrappingSource): Map<String, Any?> = map("width" to (wrap.widthPixels ?: "content-minus-section-padding"),
        "line-height-pixels" to wrap.lineHeightPixels, "break-mode" to "word-then-codepoint", "preserve-explicit-lines" to wrap.preserveExplicitLines,
        "maximum-lines" to wrap.maximumLines, "overflow" to token(wrap.overflow), "continuation-indent-pixels" to wrap.continuationIndentPixels)

    fun theme(theme: ThemeSource): Map<String, Any?> {
        val common = map("renderer" to token(theme.renderer), "requires-resource-pack" to theme.requiresResourcePack,
            "requires-capabilities" to theme.requiredCapabilities, "vanilla-tooltip-lines" to token(theme.vanillaTooltipLines), "fallback" to theme.fallback,
            "fonts" to theme.fonts, "styles" to theme.styles.mapValues { (_, style) -> map("color" to style.color, "bold" to style.bold, "italic" to style.italic, "underlined" to style.underlined, "strikethrough" to style.strikethrough) })
        return common + when (theme.renderer) {
            ThemeRenderer.PLAIN -> map("icons" to map("unsupported-token" to "omit"))
            ThemeRenderer.NATIVE_TOOLTIP_STYLE -> map("tooltip-style" to theme.tooltipStyle, "content" to theme.content?.let { content -> map(
                "minimum-width-pixels" to content.minimumWidthPixels, "maximum-width-pixels" to content.maximumWidthPixels,
                "left-padding-pixels" to content.leftPaddingPixels, "right-padding-pixels" to content.rightPaddingPixels) })
            ThemeRenderer.VANILLA_CHARACTER_FRAME -> requireNotNull(theme.characterFrame).let { frame -> map(
                "frame" to map("preset" to token(frame.preset), "scope" to "managed-lore", "continuity" to "ornamental", "separators" to "section-boundaries",
                    "minimum-width-pixels" to frame.minimumWidthPixels, "maximum-width-pixels" to frame.maximumWidthPixels,
                    "left-padding-pixels" to frame.leftPaddingPixels, "right-padding-pixels" to frame.rightPaddingPixels, "alignment-tolerance-pixels" to frame.alignmentTolerancePixels),
                "wrapping" to map("enforce-frame-width" to true, "overflow" to "wrap", "maximum-lines" to frame.maximumLines),
                "safety" to map("bidirectional-layout" to "fallback", "unknown-glyph" to "fallback", "personal-font-overrides" to "approximate")) }
            ThemeRenderer.SEGMENTED_FRAME -> requireNotNull(theme.segmentedFrame).let { frame -> map(
                "tooltip-style" to theme.tooltipStyle,
                "frame" to map("width" to "layout", "minimum-width-pixels" to frame.minimumWidthPixels, "maximum-width-pixels" to frame.maximumWidthPixels,
                    "left-padding-pixels" to frame.leftPaddingPixels, "right-padding-pixels" to frame.rightPaddingPixels, "fill-mode" to "exact-pixel", "height-mode" to "repeat-for-rendered-lines",
                    "top" to row(frame.top), "body" to row(frame.body), "connector" to frame.connector?.let(::row), "bottom" to row(frame.bottom), "include-name" to frame.includeName),
                "wrapping" to map("enforce-frame-width" to true, "overflow" to "wrap")) }
            ThemeRenderer.BITMAP_CANVAS -> requireNotNull(theme.canvas).let { canvas -> map("experimental" to true, "tooltip-style" to theme.tooltipStyle,
                "canvas" to map("composition" to "bitmap-overlay", "width-pixels" to canvas.widthPixels, "height-pixels" to canvas.heightPixels,
                    "maximum-width-pixels" to canvas.maximumWidthPixels, "maximum-height-pixels" to canvas.maximumHeightPixels,
                    "normalize-visual-origin" to canvas.normalizeVisualOrigin, "emit-width-anchor" to true, "reserve-tooltip-lines" to canvas.reserveTooltipLines,
                    "measured-advance-pixels" to canvas.measuredAdvancePixels, "final-tooltip-width-pixels" to canvas.finalTooltipWidthPixels,
                    "layers" to canvas.layers.map { layer -> map("asset" to layer.asset, "anchor" to token(layer.anchor), "x-pixels" to layer.xPixels,
                        "baseline-line" to layer.baselineLine, "baseline-variant" to layer.baselineVariant, "draw-order" to layer.drawOrder) }),
                "safety" to map("force-decoration-bold" to false, "require-exact-font-metrics" to theme.requireExactFontMetrics,
                    "reject-negative-final-advance" to canvas.rejectNegativeFinalAdvance, "reject-out-of-bounds-layer" to canvas.rejectOutOfBoundsLayer,
                    "maximum-emitted-components" to canvas.maximumEmittedComponents)) }
        }
    }

    private fun row(row: FrameRowSource): Map<String, Any?> = map("left" to row.left, "fill" to row.fill, "right" to row.right, "center" to row.center, "kern" to row.kern)
}
