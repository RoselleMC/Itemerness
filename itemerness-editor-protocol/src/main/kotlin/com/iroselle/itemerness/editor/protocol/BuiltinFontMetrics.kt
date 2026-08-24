package com.iroselle.itemerness.editor.protocol

import com.iroselle.itemerness.core.presentation.GlyphMetricSource

/**
 * Supplies the generated vanilla metric tables a `builtin:` font selector resolves to.
 *
 * The tables are a build artifact of roughly a hundred thousand glyphs, so an authoring document
 * names a revision rather than carrying them. Reading the artifact belongs to whoever ships it —
 * currently `itemerness-bukkit` — and this interface keeps the codec from having to depend on the
 * plugin module to decode a document.
 */
fun interface BuiltinFontMetrics {
    /** Returns the table for a `builtin:<revision>` selector, or null when the revision is unknown. */
    fun table(metricsRevision: String): BuiltinFontTable?

    companion object {
        /** Rejects every `builtin:` selector. Useful in tests that declare metrics explicitly. */
        val NONE: BuiltinFontMetrics = BuiltinFontMetrics { null }
    }
}

class BuiltinFontTable(
    val fontId: String,
    val metricsRevision: String,
    val fallback: String?,
    val fallbackGlyph: GlyphMetricSource,
    glyphs: Map<Int, GlyphMetricSource>,
) {
    val glyphs: Map<Int, GlyphMetricSource> = java.util.Collections.unmodifiableMap(LinkedHashMap(glyphs))
}
