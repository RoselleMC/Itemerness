package com.iroselle.itemerness.bukkit.editor

import com.iroselle.itemerness.core.presentation.*
import com.iroselle.itemerness.editor.protocol.JsonObject
import com.iroselle.itemerness.bukkit.editor.YamlEncoding.mapping as map

internal object AssetYamlEncoding {
    fun encode(document: JsonObject, source: PresentationSource): Map<String, Any?> = YamlEncoding.document(
        "measurement" to document.optionalObject("measurement").let { map("client-version" to (it?.optionalString("clientVersion") ?: "server"),
            "missing-glyph" to "error", "bold-extra-advance-pixels" to (it?.optionalDouble("boldExtraAdvancePixels") ?: 1.0)) },
        "fonts" to document.requiredObjects("fonts").associate { font -> font.requiredString("id") to map("metrics" to font.requiredString("metrics"),
            "fallback" to font.optionalString("fallback"), "fallback-advance-pixels" to font.optionalDouble("fallbackAdvancePixels"),
            "advances" to font.optionalObject("advances")?.let { map("minimum" to it.requiredInt("minimum"), "maximum" to it.requiredInt("maximum"), "step" to 1) }) },
        "glyphs" to source.glyphs.associate { glyph -> glyph.id to map("font" to glyph.font, "codepoint" to codePoint(glyph.codePoint),
            "bitmap" to glyph.bitmap, "advance-pixels" to glyph.advancePixels, "visual-bounds" to bounds(glyph.visualBounds)) },
        "bitmaps" to document.requiredObjects("bitmaps").associate { bitmap ->
            val id = bitmap.requiredString("id")
            val metadata = source.bitmaps.single { it.id == id }
            id to map("baseline-variant" to metadata.baselineVariant, "texture" to bitmap.requiredString("texture"),
                "source-width-pixels" to bitmap.requiredInt("sourceWidthPixels"), "source-height-pixels" to bitmap.requiredInt("sourceHeightPixels"),
                "render-width-pixels" to metadata.renderWidthPixels, "render-height-pixels" to metadata.renderHeightPixels,
                "ascent-pixels" to metadata.ascentPixels, "visual-bounds" to bounds(metadata.visualBounds))
        },
        "tooltip-styles" to document.requiredObjects("tooltipStyles").associate { style -> style.requiredString("id") to map(
            "component-value" to style.requiredString("id"), "expected-background-sprite" to style.requiredString("expectedBackgroundSprite"),
            "expected-frame-sprite" to style.requiredString("expectedFrameSprite"), "scaling" to style.requiredString("scaling")) },
        "asset-profiles" to source.assetProfiles.associate { profile -> profile.id to map("capabilities" to profile.capabilities,
            "metrics-revision" to profile.metricsRevision, "fallback" to profile.fallback) },
        "resource-pack-bindings" to source.resourcePackBindings.associate { binding -> binding.id to map("enabled" to binding.enabled,
            "pack-id" to binding.packId?.toString(), "sha1" to binding.sha1, "asset-profile" to binding.assetProfile) },
        "spacing" to source.spacing?.let { map("negative" to range(it.font, it.negative), "positive" to range(it.font, it.positive)) },
    )

    private fun range(font: String, range: SpacingRangeSource): Map<String, Any?> = map("font" to font,
        "codepoint-range" to map("first" to codePoint(range.firstCodePoint), "last" to codePoint(range.lastCodePoint)),
        "minimum-advance-pixels" to range.minimumAdvancePixels, "maximum-advance-pixels" to range.maximumAdvancePixels)
    private fun bounds(bounds: VisualBoundsSource): Map<String, Any?> = map("left" to bounds.left, "right" to bounds.right, "top" to bounds.top, "bottom" to bounds.bottom)
    private fun codePoint(point: Int): String = "U+" + point.toString(16).uppercase().padStart(4, '0')
}
