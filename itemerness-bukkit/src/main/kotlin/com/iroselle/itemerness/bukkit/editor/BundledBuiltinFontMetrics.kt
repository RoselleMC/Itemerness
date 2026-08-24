package com.iroselle.itemerness.bukkit.editor

import com.iroselle.itemerness.bukkit.presentation.BuiltinFontMetricsArtifact
import com.iroselle.itemerness.editor.protocol.BuiltinFontMetrics
import com.iroselle.itemerness.editor.protocol.BuiltinFontTable

/**
 * Exposes the generated vanilla metric tables to the editor agent.
 *
 * The artifact ships inside this module's resources because the local YAML path needs it too, so
 * this adapter is the only place that knows both. Keeping it here means the agent and the protocol
 * codec stay free of any dependency on the plugin distribution, which is what allows the whole
 * compile path to run outside a Bukkit runtime in tests.
 */
internal class BundledBuiltinFontMetrics(
    private val artifact: BuiltinFontMetricsArtifact,
) : BuiltinFontMetrics {
    override fun table(metricsRevision: String): BuiltinFontTable? {
        val table = artifact.tablesByRevision["builtin:$metricsRevision"] ?: return null
        return BuiltinFontTable(
            fontId = table.fontId,
            metricsRevision = table.metricsRevision,
            fallback = table.fallback,
            fallbackGlyph = table.fallbackGlyph,
            glyphs = table.glyphs,
        )
    }
}
