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
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Test

/** Shared server-generated canvas outputs also exercised by the cold browser composer. */
class CanvasLayoutGoldenTest {
    @Test
    fun `canvas layout golden outputs come from the production compiler`() {
        val directory = Path.of(requireNotNull(System.getProperty("itemerness.editorFixtures")))
        val baseline = Json.parse(Files.readString(directory.resolve("baseline.json")))
        val cases = Json.parse(Files.readString(directory.resolve("canvas-layout-cases.json"))) as JsonValue.Arr
        val bridge = CompilerBridge(BundledBuiltinFontMetrics(BuiltinFontMetricsLoader.bundled("26.1.2")), "test")
        val actual = JsonValue.Obj(cases.values.associate { case ->
            val source = JsonObject.of(case, "case")
            val document = source.requiredObjects("changes").fold(baseline) { current, change ->
                replace(current, (change.raw("path") as JsonValue.Arr).values, requireNotNull(change.raw("value")))
            }
            val json = Json.canonicalize(document)
            val outcome = bridge.compilePreview(json, CompilerBridge.PreviewContext(
                itemId = "itemerness:survey-codex", locale = "en_us", requestedTheme = null,
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
                it in setOf("displayName", "lore", "renderer", "selectedTheme", "tooltipStyle")
            })
        })
        assertNotEquals(actual.entries.getValue("baseline"), actual.entries.getValue("body-x"))
        val golden = directory.resolve("canvas-layout-golden.json")
        if (System.getenv("ITEMERNESS_UPDATE_CANVAS_GOLDEN") == "1") Files.writeString(golden, Json.canonicalize(actual) + "\n")
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
