package com.iroselle.itemerness.editor.protocol

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test

class ProjectDocumentItemIdentityTest {
    @Test
    fun `qualified items retain one identity in catalog presentation and preview data`() {
        val document = document(2, "token", "equipment:token")
        val before = Json.canonicalize(document)
        val decoded = ProjectDocumentCodec.decode(before)
        val expected = listOf("example:token", "equipment:token")
        assertEquals(expected, decoded.catalog.items.map { it.id })
        assertEquals(expected, decoded.presentation.items.map { it.id })
        assertEquals(expected, decoded.previewData.keys.toList())
        assertEquals("equipment:token", decoded.catalog.items.first().contents.single().item)
        assertEquals(before, Json.canonicalize(document))
    }

    @Test
    fun `legacy documents keep paths and reject qualified ids`() {
        val document = document(1, "token")
        assertEquals("example:token", ProjectDocumentCodec.decode(Json.canonicalize(document)).catalog.items.single().id)
        assertThrows(JsonException::class.java) { ProjectDocumentCodec.decode(Json.canonicalize(document(1, "equipment:token"))) }
        assertThrows(JsonException::class.java) { ProjectDocumentCodec.decode(Json.canonicalize(document(1, "a".repeat(201)))) }
    }

    @Test
    fun `logical aliases and overlong namespace or resolved keys are rejected`() {
        for (ids in listOf(arrayOf("token", "example:token"), arrayOf("${"n".repeat(65)}:token"), arrayOf("a".repeat(249)))) {
            assertThrows(JsonException::class.java) { ProjectDocumentCodec.decode(Json.canonicalize(document(2, *ids))) }
        }
        assertEquals("x:${"p".repeat(254)}", ProjectDocumentCodec.decode(Json.canonicalize(document(2, "x:${"p".repeat(254)}"))).catalog.items.single().id)
    }

    private fun document(version: Int, vararg ids: String): JsonValue.Obj {
        val fields = linkedMapOf<String, JsonValue>(
            "schemaVersion" to JsonValue.Num(version.toDouble()),
            "documentId" to text("00000000-0000-4000-8000-000000000001"),
            "namespace" to text("example"), "defaultLocale" to text("en_us"),
            "items" to JsonValue.Arr(ids.map(::item)),
        )
        if (version == 2) fields["measurement"] = obj("boldExtraAdvancePixels" to JsonValue.Num(1.0))
        return JsonValue.Obj(fields)
    }

    private fun item(id: String) = obj(
        "id" to text(id), "enabled" to JsonValue.Bool(true),
        "definition" to obj(
            "material" to text("minecraft:bundle"),
            "instance" to obj("mode" to text("FUNGIBLE"), "schemas" to JsonValue.Arr(emptyList())),
            "contents" to JsonValue.Arr(listOf(obj("item" to text("equipment:token"), "amount" to JsonValue.Num(1.0)))),
        ),
        "presentation" to obj(
            "layout" to text("example:plain"), "theme" to text("example:default"),
            "nameMessage" to text("item.name"), "blocks" to JsonValue.Arr(emptyList()),
        ),
    )
    private fun obj(vararg fields: Pair<String, JsonValue>) = JsonValue.Obj(linkedMapOf(*fields))
    private fun text(value: String) = JsonValue.Text(value)
}
