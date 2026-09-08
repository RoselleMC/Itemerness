package com.iroselle.itemerness.bukkit.editor

import com.iroselle.itemerness.api.DecimalDataValue
import com.iroselle.itemerness.api.ItemKey
import com.iroselle.itemerness.api.LongDataValue
import com.iroselle.itemerness.bukkit.presentation.BuiltinFontMetricsLoader
import com.iroselle.itemerness.core.presentation.FormatSource
import com.iroselle.itemerness.core.presentation.LocaleSource
import com.iroselle.itemerness.core.presentation.PresentationCompiler
import com.iroselle.itemerness.core.presentation.PresentationEngine
import com.iroselle.itemerness.core.presentation.PresentationSource
import com.iroselle.itemerness.editor.protocol.Json
import com.iroselle.itemerness.editor.protocol.JsonObject
import com.iroselle.itemerness.editor.protocol.JsonValue
import com.iroselle.itemerness.editor.protocol.ProjectDocumentCodec
import java.nio.file.Files
import java.nio.file.Path
import java.text.DecimalFormat
import java.text.DecimalFormatSymbols
import java.util.Locale
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class JavaDecimalFormatGoldenTest {
    @Test
    fun `numeric golden values use the production value formatter`() {
        val directory = Path.of(requireNotNull(System.getProperty("itemerness.editorFixtures")))
        val base = ProjectDocumentCodec.decode(Files.readString(directory.resolve("baseline.json")), BundledBuiltinFontMetrics(BuiltinFontMetricsLoader.bundled("26.1.2"))).presentation
        val cases = Json.parse(Files.readString(directory.resolve("decimal-format-cases.json"))) as JsonValue.Arr
        val edgeValues = (1..32).map { java.lang.Double.longBitsToDouble(it.toLong()) } +
            listOf(-300, -10, -1, 0, 1, 10, 20, 23, 100, 300).flatMap { exponent ->
                val value = Math.pow(10.0, exponent.toDouble())
                listOf(Math.nextDown(value), value, Math.nextUp(value))
            } + listOf(-1070, -1022, -10, -1, 0, 1, 10, 20, 53, 62, 63, 64, 100, 500, 1023).flatMap { exponent ->
                val value = Math.scalb(1.0, exponent)
                listOf(Math.nextDown(value), value, Math.nextUp(value))
            } + java.util.Random(20260908L).let { random ->
                generateSequence { java.lang.Double.longBitsToDouble(random.nextLong() and Long.MAX_VALUE) }
                    .filter { it.isFinite() && it > 0 }.take(256).toList()
            }
        val generated = JsonValue.Arr(edgeValues.mapIndexed { index, value -> JsonValue.Obj(mapOf(
            "name" to JsonValue.Text("double-edge-$index"), "kind" to JsonValue.Text("decimal"), "value" to JsonValue.Text(value.toString()),
            "pattern" to JsonValue.Text("0.#################E0"), "locale" to JsonValue.Text("en_us"),
        )) })
        val actual = JsonValue.Obj((cases.values + generated.values).associate { value ->
            val case = JsonObject.of(value, "case")
            val pattern = case.requiredString("pattern")
            val locale = case.requiredString("locale")
            val integer = case.requiredString("kind") == "integer"
            val format = if (integer) FormatSource.IntegerFormat("test:value", pattern)
                else FormatSource.DecimalFormat("test:value", pattern, case.optionalDouble("multiply") ?: 1.0)
            val source = PresentationSource(
                formats = listOf(format), locales = base.locales.filterNot { it.locale == locale } + LocaleSource(locale, messages = emptyMap()),
                fonts = base.fonts, glyphs = base.glyphs, bitmaps = base.bitmaps, assetProfiles = base.assetProfiles,
                layouts = base.layouts, themes = base.themes, items = emptyList(), spacing = base.spacing, tooltipStyles = base.tooltipStyles,
            )
            val compiled = PresentationCompiler().compile(source)
            val catalog = requireNotNull(compiled.catalog) { compiled.diagnostics.joinToString() }
            val data = if (integer) LongDataValue(case.requiredString("value").toLong()) else DecimalDataValue(case.requiredString("value").toDouble())
            val engine = PresentationEngine(catalog)
            val result = engine.formatValue(data, ItemKey.parse("test:value"), locale)
            val default = requireNotNull(engine.formatValue(data, format = null, locale = locale).getOrNull())
            case.requiredString("name") to result.fold(
                onSuccess = { JsonValue.Obj(mapOf("text" to JsonValue.Text(it), "default" to JsonValue.Text(default))) },
                onFailure = { JsonValue.Obj(mapOf("error" to JsonValue.Text(requireNotNull(it.message)), "default" to JsonValue.Text(default))) },
            )
        })
        val golden = directory.resolve("decimal-format-golden.json")
        if (System.getenv("ITEMERNESS_UPDATE_FORMAT_GOLDEN") == "1") {
            Files.writeString(golden, Json.canonicalize(actual) + "\n")
            Files.writeString(directory.resolve("decimal-format-generated-cases.json"), Json.canonicalize(generated) + "\n")
            if (System.getenv("ITEMERNESS_UPDATE_DECIMAL_SYMBOLS") == "1") {
                writeSymbols(directory.resolve("../../mc-render/src/data/java-decimal-symbols-25.json"))
            }
        }
        assertEquals(Json.parse(Files.readString(golden)), actual)
    }

    private fun writeSymbols(path: Path) {
        val languages = listOf("") + Locale.getISOLanguages().filter { it.length == 2 }.sorted()
        val regions = listOf("") + Locale.getISOCountries().sorted()
        val symbols = ArrayList<JsonValue>()
        val indexes = HashMap<String, Int>()
        val numberSymbols = ArrayList<JsonValue>()
        val numberIndexes = HashMap<String, Int>()
        val currencySymbols = ArrayList<JsonValue>()
        val currencyIndexes = HashMap<String, Int>()
        fun currencyIndex(value: String): JsonValue.Num = JsonValue.Num(currencyIndexes.getOrPut(value) {
            currencySymbols.add(JsonValue.Text(value)); currencySymbols.lastIndex
        }.toDouble())
        fun symbolsIndex(locale: Locale): JsonValue.Num {
            val data = DecimalFormatSymbols.getInstance(locale)
            fun affix(pattern: String): String = DecimalFormat(pattern, data).format(0).filterNot { it == data.zeroDigit }
            val values = linkedMapOf(
                "zero" to data.zeroDigit.toString(), "decimal" to data.decimalSeparator.toString(), "group" to data.groupingSeparator.toString(),
                "monetaryDecimal" to data.monetaryDecimalSeparator.toString(), "monetaryGroup" to data.monetaryGroupingSeparator.toString(),
                "minus" to affix("-0"), "percent" to affix("0%"), "permille" to affix("0\u2030"),
                "exponent" to data.exponentSeparator, "infinity" to data.infinity,
            ).mapValues { JsonValue.Text(it.value) }
            val numeric = JsonValue.Obj(values)
            val numericIndex = numberIndexes.getOrPut(Json.canonicalize(numeric)) { numberSymbols.add(numeric); numberSymbols.lastIndex }
            val json = JsonValue.Arr(listOf(JsonValue.Num(numericIndex.toDouble()), currencyIndex(data.currencySymbol), currencyIndex(data.internationalCurrencySymbol)))
            val index = indexes.getOrPut(Json.canonicalize(json)) { symbols.add(json); symbols.lastIndex }
            return JsonValue.Num(index.toDouble())
        }
        val rows = languages.map { language -> JsonValue.Arr(regions.map { region ->
            symbolsIndex(Locale.Builder().setLanguage(language).setRegion(region).build())
        }) }
        val variants = DecimalFormatSymbols.getAvailableLocales().filter { it.variant.isNotEmpty() && it.language.length == 2 && it.country.length == 2 }
            .associate { it.toLanguageTag().lowercase(Locale.ROOT) to symbolsIndex(it) }
        val artifact = JsonValue.Obj(mapOf(
            "schemaVersion" to JsonValue.Num(1.0), "id" to JsonValue.Text("java-decimal-symbols-25-v1"),
            "generator" to JsonValue.Text("OpenJDK ${System.getProperty("java.version")} DecimalFormatSymbols; CLDR locale data"),
            "languages" to JsonValue.Arr(languages.map(JsonValue::Text)), "regions" to JsonValue.Arr(regions.map(JsonValue::Text)),
            "symbols" to JsonValue.Arr(numberSymbols), "currencies" to JsonValue.Arr(currencySymbols), "combinations" to JsonValue.Arr(symbols),
            "rows" to JsonValue.Arr(rows), "variants" to JsonValue.Obj(variants),
        ))
        Files.createDirectories(path.parent)
        Files.writeString(path, Json.canonicalize(artifact) + "\n")
    }
}
