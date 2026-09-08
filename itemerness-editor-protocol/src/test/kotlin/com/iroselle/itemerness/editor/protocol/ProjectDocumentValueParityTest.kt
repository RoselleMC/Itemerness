package com.iroselle.itemerness.editor.protocol

import com.iroselle.itemerness.api.BooleanDataValue
import com.iroselle.itemerness.api.CompoundDataValue
import com.iroselle.itemerness.api.DecimalDataValue
import com.iroselle.itemerness.api.IntegerDataValue
import com.iroselle.itemerness.api.ItemDataValue
import com.iroselle.itemerness.api.ItemKey
import com.iroselle.itemerness.api.ListDataValue
import com.iroselle.itemerness.api.LongDataValue
import com.iroselle.itemerness.api.NamespacedKeyDataValue
import com.iroselle.itemerness.api.StringDataValue
import com.iroselle.itemerness.api.UuidDataValue
import com.iroselle.itemerness.core.presentation.GlyphMetricSource
import com.iroselle.itemerness.core.presentation.PresentationBlockSource
import com.iroselle.itemerness.core.presentation.ValueReferenceSource
import java.util.UUID
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class ProjectDocumentValueParityTest {
    @Test
    fun `unsupported access policies cannot be accepted as effective permissions`() {
        decode("accessPolicies" to arr())
        val error = assertThrows(JsonException::class.java) {
            decode("accessPolicies" to arr(obj(
                "id" to text("example:policy"),
                "subject" to obj("kind" to text("item"), "item" to text("example")),
                "presentationReadable" to JsonValue.Bool(true),
                "apiReadable" to JsonValue.Bool(true),
                "apiWritable" to JsonValue.Bool(false),
            )))
        }
        assertTrue(error.message!!.contains("document.accessPolicies"), error.message)
    }

    @Test
    fun `viewer fact defaults and preview values retain their declared scalar types`() {
        val uuid = UUID.fromString("dd678de7-9d8f-411a-a036-df12f3a9ad67")
        val cases = listOf(
            Triple("LOCALE", value("string", "en_us"), StringDataValue("en_us")),
            Triple("STRING", value("string", "example:literal"), StringDataValue("example:literal")),
            Triple("BOOLEAN", obj("kind" to text("boolean"), "value" to JsonValue.Bool(true)), BooleanDataValue(true)),
            Triple("INTEGER", value("integer", "1"), IntegerDataValue(1)),
            Triple("INTEGER", value("integer", Int.MIN_VALUE.toString()), IntegerDataValue(Int.MIN_VALUE)),
            Triple("INTEGER", value("integer", Int.MAX_VALUE.toString()), IntegerDataValue(Int.MAX_VALUE)),
            Triple("LONG", value("integer", "1"), LongDataValue(1)),
            Triple("LONG", value("integer", Long.MIN_VALUE.toString()), LongDataValue(Long.MIN_VALUE)),
            Triple("LONG", value("integer", Long.MAX_VALUE.toString()), LongDataValue(Long.MAX_VALUE)),
            Triple("DECIMAL", value("decimal", "1.25"), DecimalDataValue(1.25)),
            Triple("DECIMAL", value("integer", "1"), DecimalDataValue(1.0)),
            Triple("UUID", value("string", uuid.toString()), UuidDataValue(uuid)),
            Triple("NAMESPACED_KEY", value("string", "example:value"), NamespacedKeyDataValue(ItemKey.parse("example:value"))),
        )
        for ((type, raw, expected) in cases) {
            val decoded = decode("viewerFacts" to arr(fact(type, raw)))
            assertEquals(expected, decoded.presentation.viewerFacts.single().defaultValue, type)
            assertEquals(expected, decoded.previewFacts.getValue("example:fact"), type)

            val previewOnly = decode("viewerFacts" to arr(fact(type, nullValue, raw)))
            assertNull(previewOnly.presentation.viewerFacts.single().defaultValue, type)
            assertEquals(expected, previewOnly.previewFacts.getValue("example:fact"), type)
        }
    }

    @Test
    fun `viewer fact overrides replace defaults without changing their type`() {
        val decoded = decode("viewerFacts" to arr(fact("LONG", value("integer", "1"), value("integer", "2"))))
        assertEquals(LongDataValue(1), decoded.presentation.viewerFacts.single().defaultValue)
        assertEquals(LongDataValue(2), decoded.previewFacts.getValue("example:fact"))
    }

    @Test
    fun `invalid viewer fact scalar values are decode errors with a field context`() {
        val cases = listOf(
            "INTEGER" to value("integer", "2147483648"),
            "INTEGER" to value("decimal", "1.0"),
            "LONG" to value("string", "1"),
            "DECIMAL" to value("decimal", "1e309"),
            "STRING" to value("integer", "1"),
            "BOOLEAN" to value("string", "true"),
            "UUID" to value("string", "not-a-uuid"),
            "NAMESPACED_KEY" to value("string", "not-a-key"),
            "LOCALE" to value("integer", "1"),
        )
        for ((type, raw) in cases) {
            val defaultError = assertThrows(JsonException::class.java) {
                decode("viewerFacts" to arr(fact(type, raw)))
            }
            assertTrue(defaultError.message!!.contains("example:fact.defaultValue"), defaultError.message)
            val previewError = assertThrows(JsonException::class.java) {
                decode("viewerFacts" to arr(fact(type, nullValue, raw)))
            }
            assertTrue(previewError.message!!.contains("example:fact.previewValue"), previewError.message)
        }
    }

    @Test
    fun `nullable facts may omit a value without synthesizing one`() {
        val decoded = decode("viewerFacts" to arr(fact("LONG", nullValue)))
        assertNull(decoded.presentation.viewerFacts.single().defaultValue)
        assertTrue(decoded.previewFacts.isEmpty())
    }

    @Test
    fun `condition literals follow the YAML generic scalar rules`() {
        assertEquals(StringDataValue("example:value"), literal(value("string", "example:value")))
        assertEquals(IntegerDataValue(1), literal(value("integer", "1")))
        assertEquals(LongDataValue(Long.MAX_VALUE), literal(value("integer", Long.MAX_VALUE.toString())))
        assertEquals(DecimalDataValue(1.25), literal(value("decimal", "1.25")))
        val nested = obj(
            "kind" to text("compound"),
            "entries" to obj("values" to obj(
                "kind" to text("list"),
                "values" to arr(value("string", "example:value"), value("integer", "1")),
            )),
        )
        assertEquals(
            CompoundDataValue(mapOf("values" to ListDataValue(listOf(StringDataValue("example:value"), IntegerDataValue(1))))),
            literal(nested),
        )
    }

    @Test
    fun `null literals are rejected at every container depth rather than removed`() {
        val cases = listOf(
            nullValue,
            obj("kind" to text("list"), "values" to arr(value("integer", "1"), nullValue)),
            obj("kind" to text("compound"), "entries" to obj("missing" to nullValue)),
            obj("kind" to text("list"), "values" to arr(
                obj("kind" to text("compound"), "entries" to obj("missing" to nullValue)),
            )),
        )
        for (raw in cases) {
            val error = assertThrows(JsonException::class.java) { literal(raw) }
            assertTrue(error.message!!.contains("null"), error.message)
        }
    }

    @Test
    fun `tagged values reject unrecognized fields`() {
        assertThrows(JsonException::class.java) {
            literal(obj("kind" to text("string"), "value" to text("text"), "unexpected" to text("data")))
        }
    }

    @Test
    fun `nonfinite literal decimals remain structured decode failures`() {
        val error = assertThrows(JsonException::class.java) { literal(value("decimal", "1e309")) }
        assertTrue(error.message!!.contains("condition.literal"), error.message)
    }

    @Test
    fun `builtin font selectors reject both kinds of fallback override`() {
        for (override in listOf("fallback" to text("example:font"), "fallbackAdvancePixels" to JsonValue.Num(0.0))) {
            val error = assertThrows(JsonException::class.java) {
                decode("fonts" to arr(obj(
                    "id" to text("minecraft:default"),
                    "metrics" to text("builtin:minecraft-default"),
                    override,
                )), metrics = builtin)
            }
            assertTrue(error.message!!.contains("own exact fallback policy"), error.message)
        }
    }

    @Test
    fun `builtin aliases are resolved by the active platform provider`() {
        val decoded = decode("fonts" to arr(obj(
            "id" to text("minecraft:default"),
            "metrics" to text("builtin:minecraft-default"),
        )), metrics = builtin)
        assertEquals("builtin:minecraft-default-26.1.2", decoded.presentation.fonts.single().metricsRevision)
    }

    @Test
    fun `invalid constructor arguments remain structured decode failures`() {
        val budgets = assertThrows(JsonException::class.java) {
            decode("budgets" to obj("maximumWidthPixels" to JsonValue.Num(0.0)))
        }
        assertTrue(budgets.message!!.contains("document.budgets"), budgets.message)
        assertThrows(JsonException::class.java) {
            decode("resourcePackBindings" to arr(obj(
                "id" to text("example:pack"),
                "enabled" to JsonValue.Bool(true),
                "packId" to text("not-a-uuid"),
                "assetProfile" to text("example:profile"),
            )))
        }
    }

    @Test
    fun `duplicate glyph assignments cannot silently overwrite font metrics`() {
        val glyph = obj(
            "id" to text("icon.first"),
            "font" to text("example:font"),
            "codePoint" to JsonValue.Num(65.0),
            "advancePixels" to JsonValue.Num(6.0),
            "visualBounds" to obj(
                "left" to JsonValue.Num(0.0), "right" to JsonValue.Num(5.0),
                "top" to JsonValue.Num(-7.0), "bottom" to JsonValue.Num(1.0),
            ),
        )
        val second = JsonValue.Obj(glyph.entries + ("id" to text("icon.second")))
        val error = assertThrows(JsonException::class.java) { decode("glyphs" to arr(glyph, second)) }
        assertTrue(error.message!!.contains("assigns U+41 more than once"), error.message)
    }

    private fun literal(raw: JsonValue): ItemDataValue {
        val item = obj(
            "id" to text("example"),
            "enabled" to JsonValue.Bool(true),
            "definition" to obj(
                "material" to text("minecraft:paper"),
                "instance" to obj("mode" to text("FUNGIBLE"), "schemas" to arr()),
            ),
            "presentation" to obj(
                "layout" to text("example:layout"),
                "theme" to text("example:theme"),
                "nameMessage" to text("item.name"),
                "blocks" to arr(obj(
                    "type" to text("conditional"),
                    "condition" to obj(
                        "operator" to text("EQUALS"),
                        "left" to obj("kind" to text("fact"), "key" to text("example:fact")),
                        "right" to obj("kind" to text("literal"), "value" to raw),
                    ),
                    "thenBlocks" to arr(),
                )),
            ),
        )
        val block = decode("items" to arr(item)).presentation.items.single().blocks.single() as PresentationBlockSource.Conditional
        return (block.condition.right as ValueReferenceSource.Literal).value
    }

    private fun fact(type: String, default: JsonValue, preview: JsonValue = JsonValue.Null): JsonValue = obj(
        "id" to text("example:fact"),
        "type" to text(type),
        "providers" to arr(text("provider")),
        "nullable" to JsonValue.Bool(true),
        "defaultValue" to default,
        "previewValue" to preview,
    )

    private fun decode(
        vararg fields: Pair<String, JsonValue>,
        metrics: BuiltinFontMetrics = BuiltinFontMetrics.NONE,
    ): ProjectDocumentCodec.Decoded = ProjectDocumentCodec.decode(JsonObject.of(obj(
        "schemaVersion" to JsonValue.Num(1.0),
        "documentId" to text("dd678de7-9d8f-411a-a036-df12f3a9ad67"),
        "namespace" to text("example"),
        "defaultLocale" to text("en_us"),
        *fields,
    )), metrics)

    private companion object {
        fun text(value: String): JsonValue.Text = JsonValue.Text(value)
        fun obj(vararg fields: Pair<String, JsonValue>): JsonValue.Obj = JsonValue.Obj(linkedMapOf(*fields))
        fun arr(vararg values: JsonValue): JsonValue.Arr = JsonValue.Arr(values.toList())
        fun value(kind: String, value: String): JsonValue = obj("kind" to text(kind), "value" to text(value))
        val nullValue = obj("kind" to text("null"))
        val builtin = BuiltinFontMetrics { revision ->
            if (revision == "minecraft-default") {
                BuiltinFontTable(
                    "minecraft:default", "builtin:minecraft-default-26.1.2", null,
                    GlyphMetricSource(6.0), emptyMap(),
                )
            } else null
        }
    }
}
