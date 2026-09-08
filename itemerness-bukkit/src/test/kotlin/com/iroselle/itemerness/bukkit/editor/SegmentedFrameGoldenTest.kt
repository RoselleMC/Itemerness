package com.iroselle.itemerness.bukkit.editor

import com.iroselle.itemerness.bukkit.presentation.BuiltinFontMetricsLoader
import com.iroselle.itemerness.editor.agent.CompilerBridge
import com.iroselle.itemerness.editor.protocol.Json
import com.iroselle.itemerness.editor.protocol.JsonObject
import com.iroselle.itemerness.editor.protocol.JsonValue
import com.iroselle.itemerness.editor.protocol.ProjectDocumentCodec
import java.nio.file.Files
import java.nio.file.Path
import java.security.MessageDigest
import java.util.HexFormat
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

/** Synthetic geometry shared with the browser; contains no third-party resource-pack artwork. */
class SegmentedFrameGoldenTest {
    private val directory = Path.of(requireNotNull(System.getProperty("itemerness.editorFixtures")))
    private val fixture = JsonObject.parse(Files.readString(directory.resolve("segmented-frame-fixture.json")), "fixture")
    private val metrics = BundledBuiltinFontMetrics(BuiltinFontMetricsLoader.bundled("26.1.2"))
    private val bridge = CompilerBridge(metrics, "test")

    @Test
    fun `decorated frame golden outputs come from the production compiler`() {
        val actual = JsonValue.Obj(fixture.requiredObjects("cases").associate { case ->
            val document = document(case.requiredObject("frame"))
            val artifact = render(document)
            assertEquals(JsonValue.Null, artifact.raw("failure"), "${case.requiredString("name")}: ${artifact.raw("diagnostics")}")
            val display = artifact.raw("display") as JsonValue.Obj
            assertEquals(JsonValue.Text("SEGMENTED_FRAME"), display.entries["renderer"], Json.canonicalize(display))
            assertEquals(JsonValue.Text("itemerness:transparent-canvas"), display.entries["tooltipStyle"])
            case.requiredString("name") to JsonValue.Obj(display.entries.filterKeys {
                it in setOf("displayName", "lore", "renderer", "selectedTheme", "tooltipStyle")
            })
        })
        assertNotEquals(actual.entries.getValue("name-inside"), actual.entries.getValue("name-outside"))
        val golden = directory.resolve("segmented-frame-golden.json")
        if (System.getenv("ITEMERNESS_UPDATE_SEGMENTED_FRAME_GOLDEN") == "1") Files.writeString(golden, Json.canonicalize(actual) + "\n")
        assertEquals(Json.parse(Files.readString(golden)), actual)
    }

    @Test
    fun `optional decorations and tooltip style round trip through the actual YAML loader`() {
        val decoded = ProjectDocumentCodec.decode(Json.canonicalize(document()), metrics)
        assertFalse(decoded.presentation.fonts.single { it.id == "itemerness:frame" }.glyphs.getValue(59656).hasInk)
        val source = decoded.presentation.themes.single { it.id == "itemerness:segmented" }
        val yaml = PresentationYamlEncoding.theme(source)
        assertEquals("itemerness:transparent-canvas", yaml["tooltip-style"])
        assertEquals(true, (yaml["frame"] as Map<*, *>)["include-name"])
        val files = EditorCatalogFiles.from(mapOf(
            "themes/editor.yml" to YamlEncoding.dump(YamlEncoding.document("themes" to mapOf(source.id to yaml))),
            "assets/editor.yml" to YamlEncoding.dump(YamlEncoding.document("measurement" to mapOf("client-version" to "server", "missing-glyph" to "error", "bold-extra-advance-pixels" to 1))),
        ))
        files.withDirectory { root ->
            val restored = com.iroselle.itemerness.bukkit.presentation.PresentationSourceLoader(BuiltinFontMetricsLoader.bundled("26.1.2"))
                .loadAndCompile(root, com.iroselle.itemerness.bukkit.catalog.CatalogSourceLoader().load(root), "en_us").source.themes.single()
            assertEquals(source.segmentedFrame, restored.segmentedFrame)
            assertEquals(source.tooltipStyle, restored.tooltipStyle)
        }
    }

    @Test
    fun `an impossible layout minimum produces a layout diagnostic instead of an arithmetic failure`() {
        val source = document(JsonObject.of(EditorAssetMetadata.obj("minimumWidthPixels" to 70, "maximumWidthPixels" to 90), "changes"))
        val display = render(source).requiredObject("display")
        assertNotEquals("SEGMENTED_FRAME", display.requiredString("renderer"))
        assertEquals("LAYOUT_OVERFLOW", display.requiredObjects("fallbackReasons").first().requiredString("code"))
    }

    @Test
    fun `decoration references and kern constraints cannot bypass document validation`() {
        for (failure in listOf("missing-center", "missing-kern", "wrong-font-kern", "visible-kern", "zero-net-fill")) {
            var source = document()
            source = when (failure) {
                "missing-center", "missing-kern" -> mapArray(source, "themes") { theme ->
                    if (theme.entries["id"] != JsonValue.Text("itemerness:segmented")) theme else {
                        val frame = theme.entries.getValue("segmentedFrame") as JsonValue.Obj
                        val top = frame.entries.getValue("top") as JsonValue.Obj
                        JsonValue.Obj(theme.entries + ("segmentedFrame" to JsonValue.Obj(frame.entries + ("top" to JsonValue.Obj(top.entries +
                            ((if (failure == "missing-center") "center" else "kern") to JsonValue.Text("missing.glyph")))))))
                    }
                }
                else -> mapArray(source, "glyphs") { glyph ->
                    when {
                        failure == "wrong-font-kern" && glyph.entries["id"] == JsonValue.Text("test.frame.kern") -> JsonValue.Obj(glyph.entries + ("font" to JsonValue.Text("itemerness:icons")))
                        failure == "visible-kern" && glyph.entries["id"] == JsonValue.Text("test.frame.kern") -> JsonValue.Obj(glyph.entries + ("visualBounds" to EditorAssetMetadata.obj("left" to 0, "right" to 1, "top" to -1, "bottom" to 0)))
                        failure == "zero-net-fill" && glyph.entries["id"] == JsonValue.Text("test.frame.top-fill") -> JsonValue.Obj(glyph.entries + ("advancePixels" to JsonValue.Num(1.0)))
                        else -> glyph
                    }
                }
            }
            assertTrue(bridge.validateDocument(source).isNotEmpty(), failure)
        }
    }

    private fun document(changes: JsonObject? = null): JsonValue.Obj {
        var source = Json.parse(Files.readString(directory.resolve("baseline.json"))) as JsonValue.Obj
        val glyphs = source.entries.getValue("glyphs") as JsonValue.Arr
        source = JsonValue.Obj(source.entries + ("glyphs" to JsonValue.Arr(glyphs.values + (fixture.raw("glyphs") as JsonValue.Arr).values)))
        val baseFrame = fixture.raw("frame") as JsonValue.Obj
        val frame = JsonValue.Obj(baseFrame.entries + (changes?.keys?.associateWith { requireNotNull(changes.raw(it)) } ?: emptyMap()))
        source = mapArray(source, "themes") { theme ->
            if (theme.entries["renderer"] != JsonValue.Text("SEGMENTED_FRAME")) theme else {
                val styles = theme.entries.getValue("styles") as JsonValue.Obj
                JsonValue.Obj(theme.entries + mapOf("segmentedFrame" to frame, "tooltipStyle" to JsonValue.Text("itemerness:transparent-canvas"),
                    "styles" to JsonValue.Obj(styles.entries + ("frame" to EditorAssetMetadata.obj("color" to "white", "bold" to false, "italic" to false, "underlined" to false, "strikethrough" to false)))))
            }
        }
        val items = source.entries.getValue("items") as JsonValue.Arr
        val first = items.values.first() as JsonValue.Obj
        val presentation = first.entries.getValue("presentation") as JsonValue.Obj
        source = JsonValue.Obj(source.entries + ("items" to JsonValue.Arr(listOf(JsonValue.Obj(first.entries + ("presentation" to JsonValue.Obj(presentation.entries + ("theme" to JsonValue.Text("itemerness:segmented")))))) + items.values.drop(1))))
        return mapArray(source, "locales") { locale ->
            val messages = locale.entries.getValue("messages") as JsonValue.Obj
            val name = (presentation.entries.getValue("nameMessage") as JsonValue.Text).value
            JsonValue.Obj(locale.entries + ("messages" to JsonValue.Obj(messages.entries + mapOf(name to JsonValue.Text("Name"), "item.travel-token.description" to JsonValue.Text("Body")))))
        }
    }

    private fun mapArray(source: JsonValue.Obj, key: String, map: (JsonValue.Obj) -> JsonValue.Obj): JsonValue.Obj =
        JsonValue.Obj(source.entries + (key to JsonValue.Arr((source.entries.getValue(key) as JsonValue.Arr).values.map { map(it as JsonValue.Obj) })))

    private fun render(document: JsonValue): JsonObject {
        val json = Json.canonicalize(document)
        val outcome = bridge.compilePreview(json, CompilerBridge.PreviewContext(
            itemId = "itemerness:travel-token", locale = "en_us", requestedTheme = "itemerness:segmented",
            assetProfile = "itemerness:example-pack-v1", capabilities = listOf("itemerness:segmented-frame-v1", "itemerness:signed-advance-v1"),
            metricsRevision = "itemerness:example-pack-v1", resourcePackLoaded = true, managesVanillaTooltipLines = true,
            snapshotHash = "sha256:" + HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(json.toByteArray(Charsets.UTF_8))),
        ))
        return JsonObject.parse(when (outcome) {
            is CompilerBridge.Outcome.Rendered -> outcome.json
            is CompilerBridge.Outcome.Rejected -> outcome.json
        }, "artifact")
    }
}
