package com.iroselle.itemerness.bukkit.editor

import com.iroselle.itemerness.api.ItemKey
import com.iroselle.itemerness.bukkit.catalog.MaterialProperties
import com.iroselle.itemerness.bukkit.catalog.RuntimeCatalogValidator
import com.iroselle.itemerness.bukkit.config.StrictYaml
import com.iroselle.itemerness.bukkit.presentation.BuiltinFontMetricsLoader
import com.iroselle.itemerness.editor.agent.CompilerBridge
import com.iroselle.itemerness.editor.protocol.BuiltinFontMetrics
import com.iroselle.itemerness.editor.protocol.Json
import com.iroselle.itemerness.editor.protocol.JsonObject
import com.iroselle.itemerness.editor.protocol.JsonValue
import com.iroselle.itemerness.editor.protocol.ProjectDocumentCodec
import java.io.StringReader
import java.nio.file.Files
import java.nio.file.Path
import java.util.UUID
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir

class EditorMeasurementVersionGoldenTest {
    @TempDir lateinit var directory: Path
    private val validator = RuntimeCatalogValidator { mapOf(
        ItemKey.parse("minecraft:paper") to MaterialProperties(64, null),
        ItemKey.parse("minecraft:netherite_sword") to MaterialProperties(1, 2031),
        ItemKey.parse("minecraft:book") to MaterialProperties(64, null),
        ItemKey.parse("minecraft:bundle") to MaterialProperties(1, null),
        ItemKey.parse("minecraft:echo_shard") to MaterialProperties(64, null),
    ) }

    @Test
    fun `every supported measurement target imports and exports through its real YAML loader`() {
        fixture()
        val actual = JsonValue.Obj(listOf("server", "1.21.11", "26.1.1", "26.1.2", "26.2").associateWith { target ->
            val version = if (target == "server") "26.1.2" else target
            val metrics = BuiltinFontMetricsLoader.bundled(version)
            val provider = BundledBuiltinFontMetrics(metrics)
            assertEquals(version, provider.clientVersion)
            val path = directory.resolve("assets/fonts.yml")
            val root = StrictYaml.load(path).toMutableMap()
            @Suppress("UNCHECKED_CAST")
            val measurement = (root.getValue("measurement") as Map<String, Any?>).toMutableMap()
            measurement["client-version"] = target
            root["measurement"] = measurement
            Files.writeString(path, YamlEncoding.dump(root))
            val document = requireNotNull(JsonObject.of(EditorCatalogReader(directory, metrics, "test", validator).read(), "response").raw("document"))
            assertEquals(target, ProjectDocumentCodec.decode(Json.canonicalize(document), provider).measurementClientVersion)
            val exported = JsonObject.of(EditorCatalogExporter(metrics, CompilerBridge(provider, "test")).export(document), "export")
            val assetFiles = exported.requiredObjects("files").filter { it.requiredString("path").startsWith("assets/") }
            assertTrue(assetFiles.any { file ->
                val source = StrictYaml.load(StringReader(file.requiredString("content")), file.requiredString("path"))
                (source["measurement"] as? Map<*, *>)?.get("client-version") == target
            })
            stable(document, "")
        })
        val golden = fixtures().resolve("measurement-version-golden.json")
        if (System.getenv("ITEMERNESS_UPDATE_MEASUREMENT_VERSION_GOLDEN") == "1") Files.writeString(golden, Json.canonicalize(actual) + "\n")
        assertEquals(Json.parse(Files.readString(golden)), actual)
        assertFalse(Files.exists(directory.resolve("editor")))
    }

    @Test
    fun `legacy defaults and unversioned functional providers retain compatibility`() {
        assertNull(BuiltinFontMetrics.NONE.clientVersion)
        val provider = BundledBuiltinFontMetrics(BuiltinFontMetricsLoader.bundled("26.1.2"))
        val raw = Files.readString(fixtures().resolve("baseline.json"))
        assertNull(ProjectDocumentCodec.decode(raw, provider).measurementClientVersion)
    }

    private fun fixtures(): Path = Path.of(requireNotNull(System.getProperty("itemerness.editorFixtures")))

    private fun stable(node: JsonValue, path: String): JsonValue = when (node) {
        is JsonValue.Obj -> JsonValue.Obj(node.entries.mapValues { (key, value) ->
            if ((key == "uuid" || key == "documentId") && value is JsonValue.Text) JsonValue.Text(UUID.nameUUIDFromBytes("$path/$key".toByteArray(Charsets.UTF_8)).toString())
            else stable(value, "$path/$key")
        })
        is JsonValue.Arr -> JsonValue.Arr(node.values.mapIndexed { index, value -> stable(value, "$path/$index") })
        else -> node
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
