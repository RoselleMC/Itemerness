package com.iroselle.itemerness.editor.protocol

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class ProjectDocumentAssetAuthoringTest {
    @Test
    fun `spacing keeps signed Int bounds independent of individual glyph advances`() {
        fun range(codePoint: Int, advance: Int) = obj(
            "firstCodePoint" to num(codePoint), "lastCodePoint" to num(codePoint),
            "minimumAdvancePixels" to num(advance), "maximumAdvancePixels" to num(advance),
        )
        val source = document().with("spacing", obj(
            "font" to text("example:font"),
            "negative" to range(0xE000, Int.MIN_VALUE), "positive" to range(0xE001, Int.MAX_VALUE),
        ))
        val spacing = decode(source).presentation.spacing!!
        assertEquals(Int.MIN_VALUE, spacing.negative.minimumAdvancePixels)
        assertEquals(Int.MAX_VALUE, spacing.positive.maximumAdvancePixels)
    }

    @Test
    fun `measurement policies preserve source metadata without changing old document JSON`() {
        val legacy = document()
        val before = Json.canonicalize(legacy)
        decode(legacy)
        assertEquals(before, Json.canonicalize(legacy))
        for (version in listOf("server", "26.1.2")) {
            val source = document(obj(
                "boldExtraAdvancePixels" to num(2), "clientVersion" to text(version), "missingGlyph" to text("error"),
            ))
            assertEquals(2.0, decode(source).presentation.fonts.single().boldExtraAdvancePixels)
        }
        assertFails(document(obj("boldExtraAdvancePixels" to num(1), "clientVersion" to text("1.21"))), "clientVersion")
        assertFails(document(obj("boldExtraAdvancePixels" to num(1), "missingGlyph" to text("guess"))), "missingGlyph")
    }

    @Test
    fun `font metric revisions accept namespaced paths and preserve their identity`() {
        for (revision in listOf("example:metrics/v2", "manifest:pack/font-table")) {
            val source = document(font = font(revision))
            assertEquals(revision, decode(source).presentation.fonts.single().metricsRevision)
        }
    }

    @Test
    fun `source advance metadata is ordered but need not cross zero`() {
        val source = font("explicit").with("advances", obj("minimum" to num(12), "maximum" to num(40)))
        decode(document(font = source))
        assertFails(document(font = source.with("advances", obj("minimum" to num(4), "maximum" to num(4)))), "advances")
    }

    private fun document(
        measurement: JsonValue = obj("boldExtraAdvancePixels" to num(1)),
        font: JsonValue = font("explicit"),
    ) = obj(
        "schemaVersion" to num(2), "documentId" to text("00000000-0000-4000-8000-000000000001"),
        "namespace" to text("example"), "defaultLocale" to text("en_us"), "measurement" to measurement,
        "fonts" to JsonValue.Arr(listOf(font)),
    )
    private fun font(metrics: String) = obj("id" to text("example:font"), "metrics" to text(metrics))
    private fun decode(document: JsonValue) = ProjectDocumentCodec.decode(Json.canonicalize(document))
    private fun assertFails(document: JsonValue, path: String) {
        val failure = assertThrows(JsonException::class.java) { decode(document) }
        assertTrue(failure.message!!.contains(path), failure.message)
    }
    private fun JsonValue.Obj.with(key: String, value: JsonValue) = JsonValue.Obj(entries + (key to value))
    private fun obj(vararg values: Pair<String, JsonValue>) = JsonValue.Obj(linkedMapOf(*values))
    private fun text(value: String) = JsonValue.Text(value)
    private fun num(value: Int) = JsonValue.Num(value.toDouble())
}
