package com.iroselle.itemerness.bukkit.editor

import com.iroselle.itemerness.bukkit.config.StrictYaml
import com.iroselle.itemerness.bukkit.config.YamlObject
import com.iroselle.itemerness.core.presentation.PresentationSource
import com.iroselle.itemerness.editor.protocol.JsonObject
import com.iroselle.itemerness.editor.protocol.JsonValue
import java.nio.file.Files
import java.nio.file.Path
import kotlin.io.path.extension

/** Retains authoring selectors which the runtime intentionally replaces with compiled metrics. */
internal object EditorAssetMetadata {
    fun read(root: Path, presentation: PresentationSource): JsonObject {
        val fonts = ArrayList<JsonValue>()
        val bitmaps = ArrayList<JsonValue>()
        val styles = ArrayList<JsonValue>()
        var measurement: JsonValue? = null
        val paths = Files.walk(root.resolve("assets")).use { entries ->
            entries.filter { Files.isRegularFile(it) && it.extension.lowercase() in setOf("yml", "yaml") }.sorted().toList()
        }
        paths.forEach { path ->
            val document = YamlObject.root(StrictYaml.load(path), root.relativize(path).toString())
            document.optionalObject("measurement")?.let { value ->
                check(measurement == null) { "Duplicate measurement policy" }
                measurement = obj("clientVersion" to value.requiredString("client-version"), "missingGlyph" to value.requiredString("missing-glyph"),
                    "boldExtraAdvancePixels" to (value.optionalDouble("bold-extra-advance-pixels") ?: 1.0))
            }
            document.optionalObject("fonts")?.let { entries -> entries.keys.forEach { id ->
                val value = entries.child(id, entries.raw(id))
                fonts += obj("id" to id, "metrics" to value.requiredString("metrics"), "fallback" to value.optionalString("fallback"),
                    "fallbackAdvancePixels" to value.optionalDouble("fallback-advance-pixels"),
                    "advances" to value.optionalObject("advances")?.let { obj("minimum" to it.requiredInt("minimum"), "maximum" to it.requiredInt("maximum")) })
            } }
            document.optionalObject("tooltip-styles")?.let { entries -> entries.keys.forEach { id ->
                val value = entries.child(id, entries.raw(id))
                styles += obj("id" to id,
                    "expectedBackgroundSprite" to value.requiredString("expected-background-sprite"), "expectedFrameSprite" to value.requiredString("expected-frame-sprite"),
                    "scaling" to value.requiredString("scaling"))
            } }
            document.optionalObject("bitmaps")?.let { entries -> entries.keys.forEach { id ->
                val value = entries.child(id, entries.raw(id))
                val bitmap = presentation.bitmaps.single { it.id == id }
                bitmaps += obj("id" to id, "baselineVariant" to bitmap.baselineVariant, "texture" to value.requiredString("texture"),
                    "sourceWidthPixels" to value.requiredInt("source-width-pixels"), "sourceHeightPixels" to value.requiredInt("source-height-pixels"),
                    "renderWidthPixels" to bitmap.renderWidthPixels, "renderHeightPixels" to bitmap.renderHeightPixels, "ascentPixels" to bitmap.ascentPixels,
                    "visualBounds" to obj("left" to bitmap.visualBounds.left, "right" to bitmap.visualBounds.right, "top" to bitmap.visualBounds.top, "bottom" to bitmap.visualBounds.bottom))
            } }
        }
        return JsonObject.of(obj("measurement" to requireNotNull(measurement), "fonts" to fonts, "bitmaps" to bitmaps, "tooltipStyles" to styles), "assets")
    }

    internal fun obj(vararg fields: Pair<String, Any?>): JsonValue.Obj = JsonValue.Obj(fields.associate { it.first to json(it.second) })
    private fun YamlObject.optionalDouble(key: String): Double? = (raw(key) as? Number)?.toDouble()
    private fun json(value: Any?): JsonValue = when (value) {
        null -> JsonValue.Null
        is JsonValue -> value
        is String -> JsonValue.Text(value)
        is Boolean -> JsonValue.Bool(value)
        is Int -> JsonValue.Num(value.toDouble())
        is Double -> JsonValue.Num(value)
        is Collection<*> -> JsonValue.Arr(value.map(::json))
        else -> error("Unsupported metadata value")
    }
}
