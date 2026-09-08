package com.iroselle.itemerness.bukkit.editor

import com.iroselle.itemerness.api.ItemKey
import com.iroselle.itemerness.bukkit.catalog.MaterialProperties
import com.iroselle.itemerness.bukkit.catalog.RuntimeCatalogValidator
import com.iroselle.itemerness.bukkit.config.StrictYaml
import com.iroselle.itemerness.bukkit.presentation.BuiltinFontMetricsLoader
import com.iroselle.itemerness.editor.agent.CatalogTransferException
import com.iroselle.itemerness.editor.agent.CompilerBridge
import com.iroselle.itemerness.editor.protocol.Json
import com.iroselle.itemerness.editor.protocol.JsonObject
import com.iroselle.itemerness.editor.protocol.JsonValue
import java.nio.file.Files
import java.nio.file.Path
import java.util.UUID
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir

class EditorCatalogBoundaryGoldenTest {
    @TempDir lateinit var directory: Path
    private val metrics = BuiltinFontMetricsLoader.bundled("26.1.2")
    private val validator = RuntimeCatalogValidator { mapOf(
        ItemKey.parse("minecraft:paper") to MaterialProperties(64, null),
        ItemKey.parse("minecraft:netherite_sword") to MaterialProperties(1, 2031),
        ItemKey.parse("minecraft:book") to MaterialProperties(64, null),
        ItemKey.parse("minecraft:bundle") to MaterialProperties(1, null),
        ItemKey.parse("minecraft:echo_shard") to MaterialProperties(64, null),
    ) }

    @Test
    fun `valid production YAML beyond former browser limits imports and exports unchanged`() {
        fixture()
        updateMapping("assets/fonts.yml", "fonts") { fonts ->
            repeat(129 - fonts.size) { index -> fonts["boundary:font-$index"] = mapOf("metrics" to "explicit", "fallback-advance-pixels" to 6) }
        }
        val longGlyph = "boundary." + "g".repeat(300)
        updateMapping("assets/glyphs.yml", "glyphs") { glyphs ->
            glyphs[longGlyph] = mapOf("font" to "itemerness:icons", "codepoint" to "U+EFFF", "advance-pixels" to 6,
                "visual-bounds" to mapOf("left" to 0, "right" to 5, "top" to -8, "bottom" to 0))
        }
        val uppercaseSha1 = "ABCDEF0123456789ABCDEF0123456789ABCDEF01"
        updateMapping("assets/bitmaps.yml", "resource-pack-bindings") { bindings ->
            bindings["boundary:enabled"] = mapOf("enabled" to true, "pack-id" to "12345678-1234-4321-8123-123456789abc",
                "sha1" to uppercaseSha1, "asset-profile" to "itemerness:example-pack-v1")
            bindings["boundary:disabled"] = mapOf("enabled" to false, "sha1" to "replace with a real hash", "asset-profile" to "itemerness:example-pack-v1")
        }
        updateMapping("assets/bitmaps.yml", "asset-profiles") { profiles ->
            profiles["boundary:many-capabilities"] = mapOf("capabilities" to (0..64).map { "boundary:capability-$it" })
        }
        updateMapping("assets/bitmaps.yml", "bitmaps") { bitmaps ->
            bitmaps["boundary.empty-baseline"] = mapOf("baseline-variant" to "", "texture" to "boundary:font/tiny.png",
                "source-width-pixels" to 1, "source-height-pixels" to 1, "render-width-pixels" to 1, "render-height-pixels" to 1, "ascent-pixels" to 1)
        }
        updateMapping("locales/en_us.yml", "messages") { messages ->
            messages["boundary.ascii"] = "a".repeat(8193)
            messages["boundary.supplementary"] = "\uD83D\uDE00".repeat(16384)
            messages["boundary." + "m".repeat(300)] = "Long message key"
        }
        Files.writeString(directory.resolve("locales/boundary.yml"), YamlEncoding.document(
            "locale" to "en_us_${"x".repeat(40)}", "messages" to mapOf("boundary.locale" to "Long locale variant"),
        ).let(YamlEncoding::dump))
        updateMapping("formats/default.yml", "formats") { formats ->
            formats["boundary:empty-number"] = mapOf("type" to "integer", "pattern" to "")
            formats["boundary:long-number"] = mapOf("type" to "decimal", "pattern" to "0".repeat(65))
            formats["boundary:empty-message"] = mapOf("type" to "namespaced-key", "mode" to "message", "message-pattern" to "", "missing-value" to "path")
            formats["boundary:long-message"] = mapOf("type" to "namespaced-key", "mode" to "message", "message-pattern" to "m".repeat(300), "missing-value" to "full-key")
        }
        Files.writeString(directory.resolve("data-keys/boundary.yml"), YamlEncoding.document(
            "id" to "boundary:many-keys", "keys" to (0..512).associate { index ->
                val type = if (index == 0) mapOf("kind" to "compound", "fields" to ((0..255).associate {
                    "field-$it" to mapOf("type" to "string")
                } + ("\uFEFF" to mapOf("type" to "string")))) else "string"
                "boundary:key-$index" to mapOf("type" to type, "scope" to "definition", "read-sources" to listOf("catalog-definition"),
                    "access" to mapOf("read" to "public", "write" to listOf("definition")), "placeholder-api" to mapOf("exposed" to false))
            },
        ).let(YamlEncoding::dump))
        updateMapping("items/examples.yml", "items") { items ->
            @Suppress("UNCHECKED_CAST")
            val item = (items.getValue("travel-token") as Map<String, Any?>).toMutableMap()
            @Suppress("UNCHECKED_CAST")
            val presentation = (item.getValue("presentation") as Map<String, Any?>).toMutableMap()
            val blocks = presentation.getValue("blocks") as List<*>
            val nested = (0 until 17).fold<_, Any>(true) { value, _ -> listOf(value) }
            presentation["blocks"] = blocks + listOf("s".repeat(65537), List(4097) { true }, nested).mapIndexed { index, literal ->
                mapOf("type" to "conditional", "id" to "boundary-$index", "condition" to mapOf("operator" to "exists",
                    "left" to mapOf("literal" to literal)), "then" to emptyList<Any>(), "otherwise" to emptyList<Any>())
            }
            item["presentation"] = presentation
            items["travel-token"] = item
        }

        val before = EditorCatalogFiles.capture(directory).digest
        val response = transfer { EditorCatalogReader(directory, metrics, "test", validator).read() }
        val document = requireNotNull(response.raw("document"))
        val nodes = JsonObject.of(document, "document")
        assertEquals(129, nodes.requiredObjects("fonts").size)
        assertTrue(nodes.requiredObjects("glyphs").any { it.requiredString("id") == longGlyph })
        assertEquals(513, nodes.requiredObjects("dataSchemas").single { it.requiredString("id") == "boundary:many-keys" }.requiredObjects("keys").size)
        val bindings = nodes.requiredObjects("resourcePackBindings").associateBy { it.requiredString("id") }
        assertEquals(uppercaseSha1, bindings.getValue("boundary:enabled").requiredString("sha1"))
        assertEquals("replace with a real hash", bindings.getValue("boundary:disabled").requiredString("sha1"))
        transfer { EditorCatalogExporter(metrics, CompilerBridge(BundledBuiltinFontMetrics(metrics), "test")).export(document) }
        assertEquals(before, EditorCatalogFiles.capture(directory).digest)
        assertFalse(Files.exists(directory.resolve("editor")))

        val actual = stable(document, "")
        val golden = Path.of(requireNotNull(System.getProperty("itemerness.editorFixtures"))).resolve("catalog-boundary-golden.json")
        if (System.getenv("ITEMERNESS_UPDATE_CATALOG_BOUNDARY_GOLDEN") == "1") Files.writeString(golden, Json.canonicalize(actual) + "\n")
        assertEquals(Json.parse(Files.readString(golden)), actual)
    }

    private fun transfer(action: () -> JsonValue): JsonObject = try { JsonObject.of(action(), "response") }
    catch (failure: CatalogTransferException) { throw AssertionError(failure.code + ": " + Json.canonicalize(JsonValue.Arr(failure.diagnostics))) }

    private fun stable(node: JsonValue, path: String): JsonValue = when (node) {
        is JsonValue.Obj -> JsonValue.Obj(node.entries.mapValues { (key, value) ->
            if ((key == "uuid" || key == "documentId") && value is JsonValue.Text) JsonValue.Text(UUID.nameUUIDFromBytes("$path/$key".toByteArray(Charsets.UTF_8)).toString())
            else stable(value, "$path/$key")
        })
        is JsonValue.Arr -> JsonValue.Arr(node.values.mapIndexed { index, value -> stable(value, "$path/$index") })
        else -> node
    }

    private fun updateMapping(file: String, field: String, update: (MutableMap<String, Any?>) -> Unit) {
        val path = directory.resolve(file)
        val root = StrictYaml.load(path).toMutableMap()
        @Suppress("UNCHECKED_CAST")
        val values = (root.getValue(field) as Map<String, Any?>).toMutableMap()
        update(values)
        root[field] = values
        Files.writeString(path, YamlEncoding.dump(root))
    }

    private fun fixture() {
        val resources = Path.of("src/main/resources")
        (EditorCatalogFiles.DOMAINS + "config.yml").forEach { name ->
            val source = resources.resolve(name)
            if (Files.isDirectory(source)) Files.walk(source).use { paths -> paths.forEach { path ->
                val target = directory.resolve(resources.relativize(path))
                if (Files.isDirectory(path)) Files.createDirectories(target) else Files.copy(path, target)
            } } else Files.copy(source, directory.resolve(name))
        }
    }
}
