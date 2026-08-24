package com.iroselle.itemerness.editor.protocol

import com.iroselle.itemerness.core.presentation.GlyphMetricSource
import com.iroselle.itemerness.core.presentation.ThemeRenderer
import com.iroselle.itemerness.core.presentation.VisualBoundsSource
import java.nio.file.Files
import java.nio.file.Path
import java.security.MessageDigest
import java.util.HexFormat
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/**
 * The cross-language contract.
 *
 * The same golden document is validated by the browser's zod schema and decoded here into the
 * platform-neutral compiler inputs. Both sides must canonicalize it to the same bytes, because
 * that hash is what fences a stale preview response against a newer draft. A drift here would not
 * show up as a crash; it would show up as an editor occasionally seeing the wrong tooltip, which
 * is why it is asserted rather than assumed.
 */
class GoldenDocumentTest {
    private val fixtures: Path =
        Path.of(
            requireNotNull(System.getProperty("itemerness.editorFixtures")) {
                "itemerness.editorFixtures is not set; see itemerness-editor-protocol/build.gradle.kts"
            },
        )

    private val documentJson: String by lazy { Files.readString(fixtures.resolve("baseline.json")) }

    /**
     * A stub for the generated vanilla tables. The real artifact is read by `itemerness-bukkit`,
     * which owns the resource; this module only needs to prove it wires a table through correctly.
     */
    private val builtinMetrics = BuiltinFontMetrics { revision ->
        when (revision) {
            "minecraft-default-26.1.2" ->
                BuiltinFontTable(
                    fontId = "minecraft:default",
                    metricsRevision = "builtin:minecraft-default-26.1.2",
                    fallback = "minecraft:uniform",
                    fallbackGlyph = missingGlyph,
                    glyphs = mapOf('A'.code to GlyphMetricSource(6.0, VisualBoundsSource(0.0, 5.0, -7.0, 1.0))),
                )

            "minecraft-uniform-26.1.2" ->
                BuiltinFontTable(
                    fontId = "minecraft:uniform",
                    metricsRevision = "builtin:minecraft-uniform-26.1.2",
                    fallback = null,
                    fallbackGlyph = missingGlyph,
                    glyphs = mapOf(0x4F59 to GlyphMetricSource(9.0, VisualBoundsSource(0.0, 8.0, -7.0, 1.0))),
                )

            else -> null
        }
    }

    @Test
    fun `canonicalizes to the hash the browser produced`() {
        val expected = Files.readString(fixtures.resolve("baseline.sha256")).trim()
        val canonical = Json.canonicalize(Json.parse(documentJson))
        val digest = MessageDigest.getInstance("SHA-256").digest(canonical.toByteArray(Charsets.UTF_8))
        assertEquals(expected, "sha256:${HexFormat.of().formatHex(digest)}")
    }

    @Test
    fun `canonical form is stable across a parse round trip`() {
        val once = Json.canonicalize(Json.parse(documentJson))
        assertEquals(once, Json.canonicalize(Json.parse(once)))
    }

    @Test
    fun `decodes into the same compiler inputs the YAML loader produces`() {
        val decoded = ProjectDocumentCodec.decode(documentJson, builtinMetrics)

        assertEquals("itemerness", decoded.namespace)
        assertEquals("en_us", decoded.defaultLocale)
        assertEquals(
            listOf(
                "itemerness:travel-token",
                "itemerness:ember-blade",
                "itemerness:survey-codex",
                "itemerness:nested-satchel",
                "itemerness:framed-relic",
            ),
            decoded.catalog.items.map { it.id },
        )
        assertEquals(decoded.catalog.items.map { it.id }, decoded.presentation.items.map { it.id })

        // Every renderer must survive the round trip, including the two that only exist to be
        // fallen back from.
        assertEquals(
            ThemeRenderer.entries.toSet(),
            decoded.presentation.themes.map { it.renderer }.toSet(),
        )
    }

    @Test
    fun `resolves a builtin font selector to the generated table`() {
        val decoded = ProjectDocumentCodec.decode(documentJson, builtinMetrics)
        val default = decoded.presentation.fonts.first { it.id == "minecraft:default" }
        assertEquals("builtin:minecraft-default-26.1.2", default.metricsRevision)
        // The fallback pointer comes from the artifact, not the document. Without it CJK text has
        // no metrics at all, which is the exact bug the browser engine hit.
        assertEquals("minecraft:uniform", default.fallback)
        assertNotNull(default.fallbackGlyph)
        assertEquals(6.0, default.glyphs.getValue('A'.code).advancePixels)
    }

    @Test
    fun `attaches explicit glyph metrics to the font that declares them`() {
        val decoded = ProjectDocumentCodec.decode(documentJson, builtinMetrics)
        val icons = decoded.presentation.fonts.first { it.id == "itemerness:icons" }
        assertEquals("itemerness:explicit/itemerness/icons", icons.metricsRevision)
        assertEquals(9.0, icons.glyphs.getValue(0xE001).advancePixels)
        assertEquals("minecraft:default", icons.fallback)
    }

    @Test
    fun `carries editor-only preview values without publishing them`() {
        val decoded = ProjectDocumentCodec.decode(documentJson, builtinMetrics)
        val blade = decoded.previewData.getValue("itemerness:ember-blade")
        assertTrue(blade.any { it.key == "example:attack-damage" })
        // Preview data is not instance defaults; the published definition keeps its own list.
        val definition = decoded.catalog.items.first { it.id == "itemerness:ember-blade" }
        assertTrue(definition.instance.defaults.none { it.key == "example:attack-damage" })
        assertEquals(8, (decoded.previewFacts.getValue("example:level") as? com.iroselle.itemerness.api.IntegerDataValue)?.value)
    }

    @Test
    fun `decodes canvas layers and the spacing ranges the width anchor depends on`() {
        val decoded = ProjectDocumentCodec.decode(documentJson, builtinMetrics)
        val canvas = decoded.presentation.themes.first { it.id == "itemerness:aurora-canvas" }.canvas
        assertNotNull(canvas)
        assertEquals(3, canvas!!.layers.size)
        assertEquals(176, canvas.finalTooltipWidthPixels)

        val spacing = decoded.presentation.spacing
        assertNotNull(spacing)
        assertEquals(-256, spacing!!.negative.minimumAdvancePixels)
        assertEquals(256, spacing.positive.maximumAdvancePixels)
    }

    @Test
    fun `rejects an unknown key rather than dropping it`() {
        val tampered = documentJson.replaceFirst("\"namespace\"", "\"namespaces\"")
        assertThrows(JsonException::class.java) { ProjectDocumentCodec.decode(tampered, builtinMetrics) }
    }

    @Test
    fun `rejects an unknown enum constant`() {
        val tampered = documentJson.replaceFirst("\"BITMAP_CANVAS\"", "\"HOLOGRAM\"")
        assertThrows(JsonException::class.java) { ProjectDocumentCodec.decode(tampered, builtinMetrics) }
    }

    @Test
    fun `rejects an unknown builtin metrics revision`() {
        assertThrows(JsonException::class.java) {
            ProjectDocumentCodec.decode(documentJson, BuiltinFontMetrics.NONE)
        }
    }

    @Test
    fun `rejects a future document schema version`() {
        val tampered = documentJson.replaceFirst("\"schemaVersion\": 1", "\"schemaVersion\": 2")
        assertThrows(JsonException::class.java) { ProjectDocumentCodec.decode(tampered, builtinMetrics) }
    }

    private companion object {
        val missingGlyph = GlyphMetricSource(6.0, VisualBoundsSource(0.0, 5.0, -7.0, 1.0))
    }
}
