package com.iroselle.itemerness.editor.protocol

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test

class ProjectDocumentDefaultsTest {
    @Test
    fun `omitted and null item bindings inherit defaults without normalizing authoring bytes`() {
        val document = document()
        val before = Json.canonicalize(document)
        val decoded = ProjectDocumentCodec.decode(before)
        assertEquals("example:plain", decoded.defaultLayout)
        assertEquals("example:default", decoded.defaultTheme)
        assertEquals(listOf("example:default", "other:theme"), decoded.presentation.items.map { it.theme })
        assertEquals(listOf("example:plain", "other:layout"), decoded.presentation.items.map { it.layout })
        assertEquals(before, Json.canonicalize(document))
    }

    @Test
    fun `changing roots does not rewrite explicit bindings`() {
        val updated = document().with("defaultTheme", text("other:theme"))
            .with("defaultLayout", text("other:layout"))
        val decoded = ProjectDocumentCodec.decode(Json.canonicalize(updated))
        assertEquals(listOf("other:theme", "other:theme"), decoded.presentation.items.map { it.theme })
        assertEquals(listOf("other:layout", "other:layout"), decoded.presentation.items.map { it.layout })
    }

    @Test
    fun `legacy and older schema two documents do not acquire defaults`() {
        val explicit = document().without("defaultTheme", "defaultLayout").with("items", arr(item("explicit", explicit = true)))
        assertNull(ProjectDocumentCodec.decode(Json.canonicalize(explicit)).defaultTheme)
        val legacy = explicit.with("schemaVersion", JsonValue.Num(1.0)).without("measurement")
        assertNull(ProjectDocumentCodec.decode(Json.canonicalize(legacy)).defaultLayout)
        assertThrows(JsonException::class.java) { ProjectDocumentCodec.decode(Json.canonicalize(legacy.with("defaultTheme", JsonValue.Null))) }
        assertThrows(JsonException::class.java) { ProjectDocumentCodec.decode(Json.canonicalize(legacy.with("items", arr(item("inherited"))))) }
    }

    @Test
    fun `inheritance without a default and dangling defaults fail closed`() {
        for (invalid in listOf(document().without("defaultTheme"), document().with("defaultLayout", JsonValue.Null), document().with("defaultTheme", text("missing:theme")))) {
            assertThrows(JsonException::class.java) { ProjectDocumentCodec.decode(Json.canonicalize(invalid)) }
        }
    }

    private fun document() = obj(
        "schemaVersion" to JsonValue.Num(2.0), "documentId" to text("00000000-0000-4000-8000-000000000001"),
        "namespace" to text("example"), "defaultLocale" to text("en_us"),
        "measurement" to obj("boldExtraAdvancePixels" to JsonValue.Num(1.0)),
        "defaultLayout" to text("example:plain"), "defaultTheme" to text("example:default"),
        "layouts" to arr(layout("example:plain"), layout("other:layout")),
        "themes" to arr(theme("example:default"), theme("other:theme")),
        "items" to arr(item("inherited"), item("explicit", explicit = true)),
    )
    private fun item(id: String, explicit: Boolean = false): JsonValue.Obj {
        val presentation = linkedMapOf<String, JsonValue>("nameMessage" to text("item.name"), "blocks" to arr())
        presentation["theme"] = if (explicit) text("other:theme") else JsonValue.Null
        if (explicit) presentation["layout"] = text("other:layout")
        return obj("id" to text(id), "enabled" to JsonValue.Bool(true),
            "presentation" to JsonValue.Obj(presentation),
            "definition" to obj("material" to text("minecraft:paper"), "instance" to obj("mode" to text("FUNGIBLE"), "schemas" to arr())))
    }
    private fun layout(id: String) = obj("id" to text(id), "kind" to text("flow"), "minimumWidthPixels" to JsonValue.Num(1.0), "maximumWidthPixels" to JsonValue.Num(220.0), "wrapping" to obj())
    private fun theme(id: String) = obj("id" to text(id), "renderer" to text("PLAIN"), "requiresResourcePack" to JsonValue.Bool(false), "vanillaTooltipLines" to text("PRESERVE"), "fonts" to obj())
    private fun JsonValue.Obj.with(field: String, value: JsonValue) = JsonValue.Obj(entries + (field to value))
    private fun JsonValue.Obj.without(vararg fields: String) = JsonValue.Obj(entries - fields.toSet())
    private fun obj(vararg fields: Pair<String, JsonValue>) = JsonValue.Obj(linkedMapOf(*fields))
    private fun arr(vararg values: JsonValue) = JsonValue.Arr(values.toList())
    private fun text(value: String) = JsonValue.Text(value)
}
