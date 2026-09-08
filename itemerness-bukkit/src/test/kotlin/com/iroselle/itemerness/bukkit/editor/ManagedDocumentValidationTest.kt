package com.iroselle.itemerness.bukkit.editor

import com.iroselle.itemerness.api.ItemKey
import com.iroselle.itemerness.bukkit.catalog.MaterialProperties
import com.iroselle.itemerness.bukkit.catalog.RuntimeCatalogValidator
import com.iroselle.itemerness.bukkit.config.ItemernessSettings
import com.iroselle.itemerness.bukkit.presentation.BuiltinFontMetricsLoader
import com.iroselle.itemerness.editor.agent.CompilerBridge
import com.iroselle.itemerness.editor.protocol.BuiltinFontMetrics
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

class ManagedDocumentValidationTest {
    private val metrics = BundledBuiltinFontMetrics(BuiltinFontMetricsLoader.bundled("26.1.2"))
    private val fixture = Json.parse(Files.readString(
        Path.of(requireNotNull(System.getProperty("itemerness.editorFixtures")), "baseline.json"),
    ))
    private val bridge = CompilerBridge(metrics, "test")

    @Test
    fun `measurement versions are validated even when every catalog item is disabled`() {
        val document = Json.parse(Files.readString(
            Path.of(requireNotNull(System.getProperty("itemerness.editorFixtures")), "catalog-import-golden.json"),
        )) as JsonValue.Obj
        val measurement = document.entries.getValue("measurement") as JsonValue.Obj
        fun requested(version: String?): JsonValue = document.withPath("measurement", value = JsonValue.Obj(
            (measurement.entries - "clientVersion") + if (version == null) emptyMap() else mapOf("clientVersion" to JsonValue.Text(version)),
        ))
        for (version in listOf(null, "server", "26.1.2")) {
            assertTrue(bridge.validateDocument(requested(version)).isEmpty(), "Matching measurement version $version")
        }
        for (version in listOf("1.21.11", "26.1.1", "26.2")) {
            val candidate = requested(version)
            val diagnostics = bridge.validateDocument(candidate).map { JsonObject.of(it, "diagnostic") }
            assertTrue(diagnostics.any {
                it.requiredString("code") == "CATALOG.INVALID_VALUE" &&
                    it.requiredObject("params").optionalString("path") == "measurement.clientVersion"
            }, "Mismatched measurement version $version must fail without requiring a preview item")
            assertRejected(candidate, "CATALOG.INVALID_VALUE", "measurement.clientVersion")
        }
        val unknownMetrics = CompilerBridge(BuiltinFontMetrics { metrics.table(it) }, "test")
        assertTrue(unknownMetrics.validateDocument(requested(null)).isEmpty())
        assertTrue(unknownMetrics.validateDocument(requested("server")).isEmpty())
        assertRejected(requested("26.1.2"), "CATALOG.INVALID_VALUE", "measurement.clientVersion", unknownMetrics)
    }

    private fun preview(document: JsonValue, compiler: CompilerBridge = bridge): JsonObject {
        val json = Json.canonicalize(document)
        val result = compiler.compilePreview(json, CompilerBridge.PreviewContext(
            itemId = "itemerness:travel-token",
            locale = "en_us",
            requestedTheme = null,
            assetProfile = null,
            capabilities = emptyList(),
            metricsRevision = null,
            resourcePackLoaded = false,
            managesVanillaTooltipLines = false,
            snapshotHash = "sha256:" + HexFormat.of().formatHex(
                MessageDigest.getInstance("SHA-256").digest(json.toByteArray(Charsets.UTF_8)),
            ),
        ))
        return JsonObject.parse(when (result) {
            is CompilerBridge.Outcome.Rendered -> result.json
            is CompilerBridge.Outcome.Rejected -> result.json
        }, "artifact")
    }

    private fun assertRejected(
        document: JsonValue,
        code: String,
        path: String,
        compiler: CompilerBridge = bridge,
    ) {
        val artifact = preview(document, compiler)
        assertEquals("DOCUMENT_INVALID", artifact.requiredObject("failure").requiredString("code"))
        assertEquals(JsonValue.Null, artifact.raw("display"))
        assertTrue(artifact.requiredObjects("diagnostics").any {
            it.requiredString("code") == code && it.requiredObject("params").requiredString("path").contains(path)
        }, artifact.requiredObjects("diagnostics").joinToString { diagnostic ->
            "${diagnostic.requiredString("code")}: ${diagnostic.requiredObject("params").optionalString("path")}"
        })
    }

    @Test
    fun `inactive renderer geometry is retained in drafts but excluded like the YAML loader`() {
        val themes = ((fixture as JsonValue.Obj).entries.getValue("themes") as JsonValue.Arr).values
        val modified = fixture
            .withPath("themes", 0, "characterFrame", value = (themes[1] as JsonValue.Obj).entries.getValue("characterFrame"))
            .withPath("themes", 0, "characterFrame", "maximumWidthPixels", value = JsonValue.Num(1.0))
            .withPath("themes", 0, "segmentedFrame", value = (themes[3] as JsonValue.Obj).entries.getValue("segmentedFrame"))
            .withPath("themes", 0, "canvas", value = (themes[4] as JsonValue.Obj).entries.getValue("canvas"))
        val before = preview(fixture)
        val after = preview(modified)
        assertEquals(JsonValue.Null, after.raw("failure"))
        assertEquals(before.raw("display"), after.raw("display"))
    }

    @Test
    fun `private data cannot receive a verified preview even if its value renders`() {
        assertRejected(
            fixture.withPath("dataSchemas", 0, "keys", 6, "presentationReadable", value = JsonValue.Bool(false)),
            "CATALOG.INVALID_SCOPE",
            "travel-token.blocks[1].data",
        )
    }

    @Test
    fun `formatter types are checked in items other than the requested preview`() {
        assertRejected(
            fixture.withPath("items", 1, "presentation", "blocks", 0, "format", value = JsonValue.Text("itemerness:key-message")),
            "CATALOG.INVALID_VALUE",
            "ember-blade.blocks[0].format",
        )
    }

    @Test
    fun `hidden conditional branches are validated`() {
        assertRejected(
            fixture.withPath(
                "items", 1, "presentation", "blocks", 2, "otherwiseBlocks", 0, "data",
                value = JsonValue.Text("example:undeclared"),
            ),
            "CATALOG.MISSING_REFERENCE",
            "otherwise[0].data",
        )
    }

    @Test
    fun `condition operand types must match`() {
        assertRejected(
            fixture.withPath(
                "items", 1, "presentation", "blocks", 2, "condition", "right", "key",
                value = JsonValue.Text("example:quality"),
            ),
            "CATALOG.INVALID_VALUE",
            "ember-blade.blocks[2].condition",
        )
    }

    @Test
    fun `repeat paths must exist in the compound schema`() {
        assertRejected(
            fixture.withPath(
                "items", 1, "presentation", "blocks", 3, "template", "valuePath",
                value = JsonValue.Text("missing.child"),
            ),
            "CATALOG.MISSING_REFERENCE",
            "template.value-path",
        )
    }

    @Test
    fun `repeat sources must be lists of compounds`() {
        assertRejected(
            fixture.withPath("items", 1, "presentation", "blocks", 3, "data", value = JsonValue.Text("example:tags")),
            "CATALOG.INVALID_VALUE",
            "ember-blade.blocks[3].data",
        )
    }

    @Test
    fun `nested lists cannot validate without configured contents`() {
        assertRejected(
            fixture.withPath("items", 3, "definition", "contents", value = JsonValue.Arr(emptyList()))
                .withPath("items", 3, "definition", "contentComponent", value = JsonValue.Null),
            "CATALOG.INVALID_CONTENT",
            "nested-satchel.blocks[0]",
        )
    }

    @Test
    fun `rendering limits cannot override the fixed YAML runtime budgets`() {
        for (width in listOf(100, 500)) {
            val artifact = preview(fixture.withPath("budgets", "maximumWidthPixels", value = JsonValue.Num(width.toDouble())))
            assertEquals(JsonValue.Null, artifact.raw("display"))
            assertEquals(
                "diagnostics.document.runtime_budgets_mismatch",
                artifact.requiredObject("failure").requiredString("messageKey"),
            )
        }
    }

    @Test
    fun `partial presentation compilation cannot return a verified display`() {
        val artifact = preview(fixture.withPath("themes", 1, "fallback", value = JsonValue.Text("itemerness:missing")))
        assertEquals(JsonValue.Null, artifact.raw("display"))
        assertTrue(artifact.requiredObjects("diagnostics").isNotEmpty())
    }

    @Test
    fun `platform validator rejects nonexistent materials and incompatible stack properties`() {
        val validator = RuntimeCatalogValidator {
            mapOf(
                ItemKey.parse("minecraft:paper") to MaterialProperties(64, null),
                ItemKey.parse("minecraft:netherite_sword") to MaterialProperties(1, 2031),
                ItemKey.parse("minecraft:book") to MaterialProperties(64, null),
                ItemKey.parse("minecraft:bundle") to MaterialProperties(1, null),
                ItemKey.parse("minecraft:echo_shard") to MaterialProperties(64, null),
            )
        }
        val settings = ItemernessSettings(
            "itemerness", "[{item-id}]", "dark_gray", "en_us",
            ItemKey.parse("itemerness:plain"), ItemKey.parse("itemerness:default"), null,
        )
        val platformBridge = CompilerBridge(metrics, "test") { decoded, domain, presentation ->
            validator.validateRuntimeContent(settings, decoded.catalog, domain, presentation, emptyMap())
        }
        assertEquals(JsonValue.Null, preview(fixture, platformBridge).raw("failure"))
        assertRejected(
            fixture.withPath("items", 0, "definition", "material", value = JsonValue.Text("minecraft:not_an_item")),
            "CATALOG.INVALID_VALUE",
            "items[0].material",
            platformBridge,
        )
        assertRejected(
            fixture.withPath("items", 0, "definition", "material", value = JsonValue.Text("minecraft:netherite_sword")),
            "CATALOG.INVALID_COMPONENT",
            "items[0].base.components",
            platformBridge,
        )
        assertRejected(
            fixture.withPath("items", 3, "definition", "material", value = JsonValue.Text("minecraft:paper"))
                .withPath("items", 3, "definition", "instance", "mode", value = JsonValue.Text("FUNGIBLE"))
                .withPath("items", 3, "definition", "instance", "idGenerator", value = JsonValue.Null),
            "CATALOG.INVALID_CONTENT",
            "items[3].contents",
            platformBridge,
        )
    }

    @Test
    fun `enchantment registry validation uses one immutable snapshot and checks disabled items`() {
        val keys = mutableSetOf(ItemKey.parse("custom:skill/one"))
        var captures = 0
        val validator = RuntimeCatalogValidator(enchantmentProvider = { captures++; keys })
        keys.clear()
        val settings = ItemernessSettings(
            "itemerness", "[{item-id}]", "dark_gray", "en_us",
            ItemKey.parse("itemerness:plain"), ItemKey.parse("itemerness:default"), null,
        )
        val platformBridge = CompilerBridge(metrics, "test") { decoded, domain, presentation ->
            validator.validateRuntimeContent(settings, decoded.catalog, domain, presentation, emptyMap())
        }
        fun component(id: String, key: String?) = EditorAssetMetadata.obj(
            "id" to id,
            "value" to EditorAssetMetadata.obj(
                "kind" to "compound",
                "entries" to JsonValue.Obj(if (key == null) emptyMap() else mapOf(key to EditorAssetMetadata.obj("kind" to "integer", "value" to "255"))),
            ),
        )
        for (id in listOf("minecraft:enchantments", "minecraft:stored_enchantments")) {
            for (key in listOf(null, "custom:skill/one")) {
                val valid = fixture.withPath("items", 1, "definition", "baseComponents", value = JsonValue.Arr(listOf(component(id, key))))
                assertEquals(JsonValue.Null, preview(valid, platformBridge).raw("failure"))
            }
            val invalid = fixture.withPath("items", 1, "enabled", value = JsonValue.Bool(false))
                .withPath("items", 1, "definition", "baseComponents", value = JsonValue.Arr(listOf(component(id, "custom:not_registered"))))
            assertRejected(invalid, "CATALOG.MISSING_REFERENCE", "items[1].base.components[0].value.custom:not_registered", platformBridge)
        }
        assertEquals(1, captures)
    }

    private fun JsonValue.withPath(vararg path: Any, value: JsonValue): JsonValue {
        fun replace(node: JsonValue, depth: Int): JsonValue {
            if (depth == path.size) return value
            return when (val segment = path[depth]) {
                is String -> {
                    val objectNode = node as JsonValue.Obj
                    JsonValue.Obj(objectNode.entries + (segment to replace(objectNode.entries.getValue(segment), depth + 1)))
                }
                is Int -> {
                    val arrayNode = node as JsonValue.Arr
                    require(segment in arrayNode.values.indices)
                    JsonValue.Arr(arrayNode.values.mapIndexed { index, child ->
                        if (index == segment) replace(child, depth + 1) else child
                    })
                }
                else -> error("Invalid fixture path segment: $segment")
            }
        }
        return replace(this, 0)
    }
}
