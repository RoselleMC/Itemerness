package com.iroselle.itemerness.bukkit.editor

import com.iroselle.itemerness.bukkit.presentation.BuiltinFontMetricsArtifact
import com.iroselle.itemerness.bukkit.presentation.BuiltinFontMetricsTable
import com.iroselle.itemerness.core.presentation.GlyphMetricSource
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test

class BundledBuiltinFontMetricsTest {
    @Test
    fun `unversioned aliases select the current client metrics without guessing adjacent versions`() {
        for (version in listOf("1.21.11", "26.1.1", "26.1.2", "26.2")) {
            val metrics = BundledBuiltinFontMetrics(BuiltinFontMetricsArtifact(
                clientVersion = version,
                clientSha1 = "",
                assetIndexSha1 = "",
                sourceSha1 = "",
                tables = listOf("default", "uniform").map { name ->
                    BuiltinFontMetricsTable(
                        fontId = "minecraft:$name",
                        metricsRevision = "builtin:minecraft-$name-$version",
                        fallback = null,
                        fallbackGlyph = GlyphMetricSource(6.0),
                        glyphs = emptyMap(),
                    )
                },
            ))
            for (name in listOf("default", "uniform")) {
                assertEquals("builtin:minecraft-$name-$version", metrics.table("minecraft-$name")?.metricsRevision)
                assertEquals("builtin:minecraft-$name-$version", metrics.table("minecraft-$name-$version")?.metricsRevision)
                assertNull(metrics.table("minecraft-$name-26.3"))
            }
            assertNull(metrics.table("unknown"))
        }
    }
}
