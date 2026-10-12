package com.iroselle.itemerness.bukkit.editor

import com.iroselle.itemerness.bukkit.presentation.BuiltinFontMetricsLoader
import com.iroselle.itemerness.editor.agent.CompilerBridge
import com.iroselle.itemerness.editor.protocol.Json
import com.iroselle.itemerness.editor.protocol.JsonObject
import com.iroselle.itemerness.editor.protocol.JsonValue
import java.nio.file.Files
import java.nio.file.Path
import java.security.MessageDigest
import java.util.HexFormat
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/**
 * Server-generated group, marker, divider and separator outputs. The browser's local draft paints
 * the same cases and must match them run for run, so a cold edit never shows different pixels.
 */
class GroupLayoutGoldenTest {
    @Test
    fun `group layout golden outputs come from the production compiler`() {
        val directory = Path.of(requireNotNull(System.getProperty("itemerness.editorFixtures")))
        val baseline = Json.parse(Files.readString(directory.resolve("baseline.json")))
        val cases = Json.parse(Files.readString(directory.resolve("group-layout-cases.json"))) as JsonValue.Arr
        val bridge = CompilerBridge(BundledBuiltinFontMetrics(BuiltinFontMetricsLoader.bundled("26.1.2")), "test")
        val actual = JsonValue.Obj(cases.values.associate { case ->
            val source = JsonObject.of(case, "case")
            val document = source.requiredObjects("changes").fold(baseline) { current, change ->
                replace(current, (change.raw("path") as JsonValue.Arr).values, requireNotNull(change.raw("value")))
            }
            val json = Json.canonicalize(document)
            val outcome = bridge.compilePreview(json, CompilerBridge.PreviewContext(
                itemId = "itemerness:nested-satchel", locale = "en_us", requestedTheme = source.requiredString("theme"),
                assetProfile = "itemerness:example-pack-v1",
                capabilities = listOf("itemerness:native-tooltip-style-v1", "itemerness:segmented-frame-v1", "itemerness:signed-advance-v1", "itemerness:bitmap-canvas-v1"),
                metricsRevision = "itemerness:example-pack-v1", resourcePackLoaded = true, managesVanillaTooltipLines = true,
                snapshotHash = "sha256:" + HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(json.toByteArray(Charsets.UTF_8))),
            ))
            val artifact = JsonObject.parse(when (outcome) {
                is CompilerBridge.Outcome.Rendered -> outcome.json
                is CompilerBridge.Outcome.Rejected -> outcome.json
            }, "artifact")
            assertEquals(JsonValue.Null, artifact.raw("failure"), "${source.requiredString("name")}: ${artifact.raw("diagnostics")}")
            val display = artifact.raw("display") as JsonValue.Obj
            source.requiredString("name") to JsonValue.Obj(display.entries.filterKeys {
                it in setOf("displayName", "lore", "renderer", "selectedTheme", "tooltipStyle", "fallbackReasons")
            })
        })
        // Every requested theme must actually render its case; a silent fallback would hide a bug.
        cases.values.forEach { case ->
            val source = JsonObject.of(case, "case")
            val display = JsonObject.of(requireNotNull(actual.entries[source.requiredString("name")]), "display")
            assertEquals(source.requiredString("theme"), display.requiredString("selectedTheme"), source.requiredString("name") + ": " + display.raw("fallbackReasons"))
        }
        val text = Json.canonicalize(actual)
        listOf("├─ ", "└─ ", "│  ", "• ").forEach { assertTrue(text.contains(it), it) }
        val golden = directory.resolve("group-layout-golden.json")
        if (System.getenv("ITEMERNESS_UPDATE_GROUP_GOLDEN") == "1") Files.writeString(golden, text + "\n")
        assertEquals(Json.parse(Files.readString(golden)), actual)
    }

    private fun replace(node: JsonValue, path: List<JsonValue>, value: JsonValue): JsonValue {
        if (path.isEmpty()) return value
        return when (val segment = path.first()) {
            is JsonValue.Text -> {
                node as JsonValue.Obj
                JsonValue.Obj(node.entries + (segment.value to replace(node.entries[segment.value] ?: JsonValue.Null, path.drop(1), value)))
            }
            is JsonValue.Num -> {
                node as JsonValue.Arr
                JsonValue.Arr(node.values.mapIndexed { index, child ->
                    if (index == segment.value.toInt()) replace(child, path.drop(1), value) else child
                })
            }
            else -> error("Invalid fixture path")
        }
    }
}
