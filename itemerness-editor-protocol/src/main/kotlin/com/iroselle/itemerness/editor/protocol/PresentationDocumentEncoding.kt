package com.iroselle.itemerness.editor.protocol

import com.iroselle.itemerness.core.presentation.FieldSeparatorSource
import com.iroselle.itemerness.core.presentation.FrameRowSource
import com.iroselle.itemerness.core.presentation.MarkerPieceSource
import com.iroselle.itemerness.core.presentation.MarkerThemeSource
import com.iroselle.itemerness.core.presentation.OverflowStrategy
import com.iroselle.itemerness.core.presentation.RuleThemeSource
import com.iroselle.itemerness.core.presentation.LayoutSource
import com.iroselle.itemerness.core.presentation.SpacingRangeSource
import com.iroselle.itemerness.core.presentation.SpacingSource
import com.iroselle.itemerness.core.presentation.ThemeSource
import com.iroselle.itemerness.core.presentation.VisualBoundsSource
import com.iroselle.itemerness.core.presentation.WrappingSource
import com.iroselle.itemerness.editor.protocol.DocumentEncoding.obj

internal object PresentationDocumentEncoding {
    fun bounds(bounds: VisualBoundsSource): JsonValue = obj("left" to bounds.left, "right" to bounds.right, "top" to bounds.top, "bottom" to bounds.bottom)

    fun layout(layout: LayoutSource): JsonValue.Obj = when (layout) {
        is LayoutSource.Flow -> obj(
            "id" to layout.id, "kind" to "flow", "minimumWidthPixels" to layout.minimumWidthPixels, "maximumWidthPixels" to layout.maximumWidthPixels,
            "blockGapAfterPixels" to layout.blockGapAfterPixels, "fieldLeftPaddingPixels" to layout.fieldLeftPaddingPixels,
            "fieldIconGapPixels" to layout.fieldIconGapPixels, "fieldValueAlignment" to layout.fieldValueAlignment,
            "descriptionLeftPaddingPixels" to layout.descriptionLeftPaddingPixels, "descriptionRightPaddingPixels" to layout.descriptionRightPaddingPixels,
            "descriptionGapBeforePixels" to layout.descriptionGapBeforePixels, "wrapping" to layout.wrapping.mapValues { wrapping(it.value) },
        ).let { encoded ->
            // Inherited and default settings stay absent so existing documents keep their hashes.
            JsonValue.Obj(encoded.entries + buildMap {
                layout.fieldSeparator?.let { put("fieldSeparator", separator(it)) }
                layout.fieldIconSlotPixels?.let { put("fieldIconSlotPixels", JsonValue.Num(it.toDouble())) }
                if (layout.overflow != OverflowStrategy.FALLBACK) put("overflow", JsonValue.Text(layout.overflow.name))
            })
        }
        is LayoutSource.Canvas -> obj(
            "id" to layout.id, "kind" to "canvas", "widthPixels" to layout.widthPixels, "heightPixels" to layout.heightPixels,
            "maximumWidthPixels" to layout.maximumWidthPixels, "maximumHeightPixels" to layout.maximumHeightPixels,
            "reserveTooltipLines" to layout.reserveTooltipLines, "wrapping" to layout.wrapping.mapValues { wrapping(it.value) },
            "anchors" to layout.anchors.mapValues { (_, anchor) -> obj("x" to anchor.x, "y" to anchor.y, "width" to anchor.width, "height" to anchor.height, "overflow" to anchor.overflow) },
        )
    }

    private fun wrapping(wrapping: WrappingSource): JsonValue = obj(
        "widthPixels" to wrapping.widthPixels, "maximumLines" to wrapping.maximumLines, "overflow" to wrapping.overflow,
        "preserveExplicitLines" to wrapping.preserveExplicitLines, "continuationIndentPixels" to wrapping.continuationIndentPixels, "lineHeightPixels" to wrapping.lineHeightPixels,
    )

    fun separator(separator: FieldSeparatorSource): JsonValue = when (separator) {
        FieldSeparatorSource.None -> obj("kind" to "none")
        is FieldSeparatorSource.Message -> obj("kind" to "message", "message" to separator.message)
    }

    private fun markers(markers: MarkerThemeSource): JsonValue = JsonValue.Obj(buildMap {
        markers.style?.let { put("style", JsonValue.Text(it)) }
        markers.bullet?.let { put("bullet", markerPiece(it)) }
        markers.tree?.let { tree ->
            put("tree", JsonValue.Obj(buildMap {
                tree.branch?.let { put("branch", markerPiece(it)) }
                tree.last?.let { put("last", markerPiece(it)) }
                tree.vertical?.let { put("vertical", markerPiece(it)) }
            }))
        }
        if (markers.gapPixels != 0) put("gapPixels", JsonValue.Num(markers.gapPixels.toDouble()))
    })

    private fun rules(rules: RuleThemeSource): JsonValue = JsonValue.Obj(buildMap {
        rules.style?.let { put("style", JsonValue.Text(it)) }
        rules.fill?.let { put("fill", markerPiece(it)) }
        rules.left?.let { put("left", markerPiece(it)) }
        rules.right?.let { put("right", markerPiece(it)) }
        if (rules.titleGapPixels != 4) put("titleGapPixels", JsonValue.Num(rules.titleGapPixels.toDouble()))
    })

    private fun markerPiece(piece: MarkerPieceSource): JsonValue = when (piece) {
        is MarkerPieceSource.Text -> obj("kind" to "text", "text" to piece.text)
        is MarkerPieceSource.Glyph -> obj("kind" to "glyph", "glyph" to piece.glyph)
    }

    fun theme(theme: ThemeSource): JsonValue.Obj = withMarkers(theme, obj(
        "id" to theme.id, "renderer" to theme.renderer, "requiresResourcePack" to theme.requiresResourcePack,
        "requiredCapabilities" to theme.requiredCapabilities, "vanillaTooltipLines" to theme.vanillaTooltipLines,
        "fallback" to theme.fallback, "fonts" to theme.fonts, "tooltipStyle" to theme.tooltipStyle, "requireExactFontMetrics" to theme.requireExactFontMetrics,
        "styles" to theme.styles.mapValues { (_, style) -> obj("color" to style.color, "bold" to style.bold, "italic" to style.italic, "underlined" to style.underlined, "strikethrough" to style.strikethrough) },
        "content" to theme.content?.let { obj(
            "minimumWidthPixels" to it.minimumWidthPixels, "maximumWidthPixels" to it.maximumWidthPixels,
            "leftPaddingPixels" to it.leftPaddingPixels, "rightPaddingPixels" to it.rightPaddingPixels,
        ) },
        "characterFrame" to theme.characterFrame?.let { obj(
            "preset" to it.preset, "minimumWidthPixels" to it.minimumWidthPixels, "maximumWidthPixels" to it.maximumWidthPixels,
            "leftPaddingPixels" to it.leftPaddingPixels, "rightPaddingPixels" to it.rightPaddingPixels,
            "alignmentTolerancePixels" to it.alignmentTolerancePixels, "maximumLines" to it.maximumLines, "fallbackBidirectionalText" to it.fallbackBidirectionalText,
        ) },
        "segmentedFrame" to theme.segmentedFrame?.let { frame -> obj(
            "minimumWidthPixels" to frame.minimumWidthPixels, "maximumWidthPixels" to frame.maximumWidthPixels,
            "leftPaddingPixels" to frame.leftPaddingPixels, "rightPaddingPixels" to frame.rightPaddingPixels,
            "top" to row(frame.top), "body" to row(frame.body), "connector" to frame.connector?.let(::row), "bottom" to row(frame.bottom),
        ).let { encoded -> if (frame.includeName) JsonValue.Obj(encoded.entries + ("includeName" to JsonValue.Bool(true))) else encoded } },
        "canvas" to theme.canvas?.let { obj(
            "widthPixels" to it.widthPixels, "heightPixels" to it.heightPixels, "maximumWidthPixels" to it.maximumWidthPixels, "maximumHeightPixels" to it.maximumHeightPixels,
            "reserveTooltipLines" to it.reserveTooltipLines, "measuredAdvancePixels" to it.measuredAdvancePixels, "finalTooltipWidthPixels" to it.finalTooltipWidthPixels,
            "rejectNegativeFinalAdvance" to it.rejectNegativeFinalAdvance, "rejectOutOfBoundsLayer" to it.rejectOutOfBoundsLayer,
            "maximumEmittedComponents" to it.maximumEmittedComponents, "normalizeVisualOrigin" to it.normalizeVisualOrigin,
            "layers" to it.layers.map { layer -> obj("asset" to layer.asset, "anchor" to layer.anchor, "xPixels" to layer.xPixels,
                "baselineLine" to layer.baselineLine, "baselineVariant" to layer.baselineVariant, "drawOrder" to layer.drawOrder) },
        ) },
    ))

    /** Absent marker and rule art and a zero name inset stay absent so existing theme documents keep their hashes. */
    private fun withMarkers(theme: ThemeSource, encoded: JsonValue.Obj): JsonValue.Obj = JsonValue.Obj(encoded.entries + buildMap {
        theme.markers?.let { put("markers", markers(it)) }
        theme.rules?.let { put("rules", rules(it)) }
        if (theme.nameInsetPixels != 0) put("nameInsetPixels", JsonValue.Num(theme.nameInsetPixels.toDouble()))
    })

    private fun row(row: FrameRowSource): JsonValue = JsonValue.Obj(buildMap {
        putAll(obj("left" to row.left, "fill" to row.fill, "right" to row.right).entries)
        row.center?.let { put("center", JsonValue.Text(it)) }
        row.kern?.let { put("kern", JsonValue.Text(it)) }
    })

    fun spacing(spacing: SpacingSource): JsonValue = obj("font" to spacing.font, "negative" to range(spacing.negative), "positive" to range(spacing.positive))

    private fun range(range: SpacingRangeSource): JsonValue = obj(
        "firstCodePoint" to range.firstCodePoint, "lastCodePoint" to range.lastCodePoint,
        "minimumAdvancePixels" to range.minimumAdvancePixels, "maximumAdvancePixels" to range.maximumAdvancePixels,
    )
}
