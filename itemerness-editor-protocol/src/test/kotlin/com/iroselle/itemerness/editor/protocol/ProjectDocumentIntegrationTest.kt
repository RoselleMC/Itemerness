package com.iroselle.itemerness.editor.protocol

import com.iroselle.itemerness.api.ItemKey
import com.iroselle.itemerness.core.presentation.GlyphMetricSource
import com.iroselle.itemerness.core.presentation.VisualBoundsSource
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class ProjectDocumentIntegrationTest {
    @Test
    fun `schema one remains readable without synthesizing integration policies`() {
        val document = document().with("schemaVersion", num(1)).without("measurement", "dataSchemas")
        val before = Json.canonicalize(document)
        val decoded = decode(document)
        assertEquals(1, decoded.schemaVersion)
        assertTrue(decoded.dataKeyIntegrations.isEmpty())
        assertEquals(before, Json.canonicalize(document))
    }

    @Test
    fun `schema two requires measurement and each key integration`() {
        assertFails(document().without("measurement"), "measurement")
        assertFails(document(key().without("integration")), "integration")
        assertFails(document().with("schemaVersion", num(1)), "requires document schema 2")
        assertFails(document().with("schemaVersion", num(1)).without("measurement"), "requires document schema 2")
    }

    @Test
    fun `decodes ordered PDC fallback and exact principals and placeholder references`() {
        val policy = integration(
            sources = arr(primary(), pdc("legacy:first"), pdc("legacy:second")),
            read = "PUBLIC",
            writers = listOf("internal", "plugin:Another_Plugin"),
            exposed = true,
            formatter = text("example:integer"),
        )
        val decoded = decode(document(key(policy)))
        val actual = decoded.dataKeyIntegrations.getValue(ItemKey.parse("example:key"))
        assertEquals(DocumentDataKeyIntegration.ReadAccess.PUBLIC, actual.readAccess)
        assertEquals(listOf("legacy:first", "legacy:second"), actual.pdcFallbackKeys.map { it.toString() })
        assertEquals(setOf("internal", "plugin:Another_Plugin"), actual.writePrincipals)
        assertTrue(actual.placeholderExposed)
        assertEquals(ItemKey.parse("example:integer"), actual.placeholderFormatter)
        assertThrows(UnsupportedOperationException::class.java) {
            @Suppress("UNCHECKED_CAST")
            (actual.pdcFallbackKeys as MutableList<ItemKey>).clear()
        }
    }

    @Test
    fun `definition policies follow their own source and writer semantics`() {
        val decoded = decode(document(key(
            integration(sources = arr(primary("catalogDefinition")), writers = listOf("definition")),
            scope = "DEFINITION",
        )))
        assertEquals(setOf("definition"), decoded.dataKeyIntegrations.values.single().writePrincipals)
        for (writer in listOf("internal", "plugin:Another")) {
            assertFails(document(key(
                integration(sources = arr(primary("catalogDefinition")), writers = listOf(writer)),
                scope = "DEFINITION",
            )), "access.write")
        }
    }

    @Test
    fun `read sources cannot be empty reordered duplicated or write-enabled`() {
        for (sources in listOf(
            arr(), arr(primary("catalogDefinition")), arr(pdc("legacy:key")),
            arr(primary(), primary()), arr(primary(), pdc("legacy:key"), pdc("legacy:key")),
            arr(primary(), pdc("legacy:key").with("mode", text("READ_WRITE"))),
            arr(primary(), obj("kind" to text("future"))),
        )) {
            assertFails(document(key(integration(sources = sources))), "readSources")
        }
    }

    @Test
    fun `PDC fallback is limited to instance scalar values`() {
        assertFails(document(key(
            integration(sources = arr(primary("catalogDefinition"), pdc("legacy:key")), writers = listOf("definition")),
            scope = "DEFINITION",
        )), "readSources")
        for (type in listOf(
            obj("kind" to text("list"), "element" to obj("kind" to text("integer"))),
            obj("kind" to text("compound"), "fields" to JsonValue.Null),
        )) {
            assertFails(document(key(integration(sources = arr(primary(), pdc("legacy:key"))), type = type)), "readSources")
        }
    }

    @Test
    fun `writers reject unknown malformed empty and case-insensitive duplicates`() {
        for (writers in listOf(
            emptyList(), listOf("definition"), listOf("unknown"), listOf("plugin:"),
            listOf("plugin:A/B"), listOf("plugin:${"a".repeat(65)}"),
            listOf("plugin:Other", "plugin:other"), listOf("internal", "internal"),
        )) {
            assertFails(document(key(integration(writers = writers))), "access.write")
        }
        assertFails(document(key(integration(read = "EVERYONE"))), "access.read")
    }

    @Test
    fun `PlaceholderAPI exposure requires public scalar reads`() {
        assertFails(document(key(integration(exposed = true))), "placeholderApi.exposed")
        assertFails(document(key(
            integration(read = "PUBLIC", exposed = true),
            type = obj("kind" to text("list"), "element" to obj("kind" to text("integer"))),
        )), "placeholderApi.exposed")
        val owner = decode(document(key(integration(read = "OWNER_ONLY"))))
        assertEquals(DocumentDataKeyIntegration.ReadAccess.OWNER_ONLY, owner.dataKeyIntegrations.values.single().readAccess)
    }

    @Test
    fun `duplicate ids across schema versions cannot overwrite an integration policy`() {
        val first = schema(key())
        assertFails(document().with("dataSchemas", arr(first, first.with("version", num(2)))), "more than one integration policy")
    }

    @Test
    fun `unknown integration and measurement fields fail closed`() {
        assertFails(document(key(integration().with("future", JsonValue.Bool(true)))), "future")
        assertFails(document(key(integration(sources = arr(primary().with("future", JsonValue.Bool(true)))))), "future")
        assertFails(document().with("measurement", obj("boldExtraAdvancePixels" to num(1), "future" to num(1))), "future")
    }

    @Test
    fun `global bold advance reaches both explicit and builtin fonts without replacing exact glyph metrics`() {
        val metric = GlyphMetricSource(6.0, VisualBoundsSource(0.0, 5.0, -8.0, 0.0), boldExtraAdvancePixels = 0.75)
        val metrics = BuiltinFontMetrics {
            BuiltinFontTable("minecraft:default", "builtin:test", null, metric, mapOf(65 to metric))
        }
        val document = document().with("fonts", arr(
            obj("id" to text("example:explicit"), "metrics" to text("explicit")),
            obj("id" to text("minecraft:default"), "metrics" to text("builtin:test")),
        )).with("measurement", obj("boldExtraAdvancePixels" to JsonValue.Num(2.5)))
        val fonts = ProjectDocumentCodec.decode(Json.canonicalize(document), metrics).presentation.fonts
        assertEquals(listOf(2.5, 2.5), fonts.map { it.boldExtraAdvancePixels })
        assertEquals(0.75, fonts[1].glyphs.getValue(65).boldExtraAdvancePixels)
        assertEquals(0.75, fonts[1].fallbackGlyph!!.boldExtraAdvancePixels)
        val legacy = document.with("schemaVersion", num(1)).without("measurement", "dataSchemas")
        assertEquals(listOf(1.0, 1.0), ProjectDocumentCodec.decode(Json.canonicalize(legacy), metrics).presentation.fonts.map { it.boldExtraAdvancePixels })
    }

    @Test
    fun `invalid global measurements are field-scoped errors even without fonts`() {
        for (pixels in listOf(-1.0, 4097.0)) {
            assertFails(document().with("measurement", obj("boldExtraAdvancePixels" to JsonValue.Num(pixels))), "measurement.boldExtraAdvancePixels")
        }
    }

    private fun decode(document: JsonValue) = ProjectDocumentCodec.decode(Json.canonicalize(document))
    private fun assertFails(document: JsonValue, message: String) {
        val error = assertThrows(JsonException::class.java) { decode(document) }
        assertTrue(error.message!!.contains(message), error.message)
    }
    private fun document(key: JsonValue = key()): JsonValue.Obj = obj(
        "schemaVersion" to num(2), "documentId" to text("00000000-0000-4000-8000-000000000001"),
        "namespace" to text("example"), "defaultLocale" to text("en_us"),
        "measurement" to obj("boldExtraAdvancePixels" to num(1)), "dataSchemas" to arr(schema(key)),
    )
    private fun schema(key: JsonValue) = obj("id" to text("example:schema"), "version" to num(1), "keys" to arr(key))
    private fun key(
        integration: JsonValue = integration(),
        scope: String = "INSTANCE",
        type: JsonValue = obj("kind" to text("integer")),
    ) = obj("id" to text("example:key"), "scope" to text(scope), "type" to type, "integration" to integration)
    private fun integration(
        sources: JsonValue = arr(primary()), read: String = "INTERNAL", writers: List<String> = listOf("internal"),
        exposed: Boolean = false, formatter: JsonValue = JsonValue.Null,
    ) = obj(
        "readSources" to sources,
        "access" to obj("read" to text(read), "write" to JsonValue.Arr(writers.map(::text))),
        "placeholderApi" to obj("exposed" to JsonValue.Bool(exposed), "formatter" to formatter),
    )
    private fun primary(kind: String = "canonicalNbt") = obj("kind" to text(kind))
    private fun pdc(key: String) = obj("kind" to text("pdc"), "key" to text(key), "mode" to text("FALLBACK_READ_ONLY"))
    private fun JsonValue.Obj.with(key: String, value: JsonValue) = JsonValue.Obj(entries + (key to value))
    private fun JsonValue.Obj.without(vararg keys: String) = JsonValue.Obj(entries - keys.toSet())
    private fun obj(vararg entries: Pair<String, JsonValue>) = JsonValue.Obj(linkedMapOf(*entries))
    private fun arr(vararg values: JsonValue) = JsonValue.Arr(values.toList())
    private fun text(value: String) = JsonValue.Text(value)
    private fun num(value: Int) = JsonValue.Num(value.toDouble())
}
