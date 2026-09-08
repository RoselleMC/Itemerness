package com.iroselle.itemerness.bukkit.editor

import com.iroselle.itemerness.api.BooleanDataValue
import com.iroselle.itemerness.api.CompoundDataValue
import com.iroselle.itemerness.api.DecimalDataValue
import com.iroselle.itemerness.api.ItemDataValue
import com.iroselle.itemerness.api.ItemKey
import com.iroselle.itemerness.api.ListDataValue
import com.iroselle.itemerness.api.LongDataValue
import com.iroselle.itemerness.api.NamespacedKeyDataValue
import com.iroselle.itemerness.api.StringDataValue
import com.iroselle.itemerness.api.UuidDataValue
import com.iroselle.itemerness.bukkit.presentation.BuiltinFontMetricsLoader
import com.iroselle.itemerness.core.presentation.PresentationCompiler
import com.iroselle.itemerness.core.presentation.PresentationEngine
import com.iroselle.itemerness.editor.protocol.Json
import com.iroselle.itemerness.editor.protocol.JsonObject
import com.iroselle.itemerness.editor.protocol.JsonValue
import com.iroselle.itemerness.editor.protocol.ProjectDocumentCodec
import java.nio.file.Files
import java.nio.file.Path
import java.util.UUID
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class ValueFormattingGoldenTest {
    @Test
    fun `shared format variants use the production compiler and value formatter`() {
        val directory = Path.of(requireNotNull(System.getProperty("itemerness.editorFixtures")))
        val base = Json.parse(Files.readString(directory.resolve("baseline.json"))) as JsonValue.Obj
        val fixtures = JsonObject.parse(Files.readString(directory.resolve("value-format-cases.json")), "fixtures")
        val formats = fixtures.requiredArray("formats").mapIndexed { index, value ->
            JsonValue.Obj((value as JsonValue.Obj).entries + ("uuid" to JsonValue.Text(UUID(0, index.toLong() + 1).toString())))
        }
        val locale = JsonValue.Obj(mapOf(
            "uuid" to JsonValue.Text(UUID(0, 100).toString()), "locale" to JsonValue.Text("en_us"),
            "fallback" to JsonValue.Null, "messages" to requireNotNull(fixtures.raw("messages")),
        ))
        val document = JsonValue.Obj(base.entries + mapOf(
            "formats" to JsonValue.Arr(formats), "locales" to JsonValue.Arr(listOf(locale)), "items" to JsonValue.Arr(emptyList()),
        ))
        val decoded = ProjectDocumentCodec.decode(Json.canonicalize(document), BundledBuiltinFontMetrics(BuiltinFontMetricsLoader.bundled("26.1.2")))
        val compiled = PresentationCompiler().compile(decoded.presentation)
        val engine = PresentationEngine(requireNotNull(compiled.catalog) { compiled.diagnostics.joinToString() })
        val actual = JsonValue.Obj(fixtures.requiredObjects("cases").associate { case ->
            val value = data(case.requiredObject("value"), case.optionalObject("type"))
            val result = engine.formatValue(value, case.optionalString("format")?.let(ItemKey::parse), "en_us")
            case.requiredString("name") to result.fold(
                onSuccess = { JsonValue.Obj(mapOf("text" to JsonValue.Text(it))) },
                onFailure = { JsonValue.Obj(mapOf("error" to JsonValue.Text(requireNotNull(it.message)))) },
            )
        })
        val golden = directory.resolve("value-format-golden.json")
        if (System.getenv("ITEMERNESS_UPDATE_FORMAT_GOLDEN") == "1") Files.writeString(golden, Json.canonicalize(actual) + "\n")
        assertEquals(Json.parse(Files.readString(golden)), actual)
    }

    private fun data(value: JsonObject, type: JsonObject?): ItemDataValue = when (type?.requiredString("kind") ?: value.requiredString("kind")) {
        "boolean" -> BooleanDataValue(value.requiredBoolean("value"))
        "integer", "long" -> LongDataValue(value.requiredString("value").toLong())
        "decimal" -> DecimalDataValue(value.requiredString("value").toDouble())
        "string" -> StringDataValue(value.requiredString("value"))
        "uuid" -> UuidDataValue(UUID.fromString(value.requiredString("value")))
        "namespacedKey" -> NamespacedKeyDataValue(ItemKey.parse(value.requiredString("value")))
        "list" -> ListDataValue(value.requiredObjects("values").map { data(it, type?.optionalObject("element")) })
        "compound" -> value.requiredObject("entries").let { entries -> CompoundDataValue(entries.keys.associateWith { key -> data(entries.requiredObject(key), null) }) }
        else -> error("Unsupported fixture value")
    }
}
