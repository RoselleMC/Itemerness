package com.iroselle.itemerness.bukkit.editor

import com.iroselle.itemerness.api.ItemKey
import com.iroselle.itemerness.bukkit.catalog.CatalogSourceLoader
import com.iroselle.itemerness.bukkit.catalog.DataKeyIntegration
import com.iroselle.itemerness.bukkit.catalog.MaterialProperties
import com.iroselle.itemerness.bukkit.catalog.RuntimeCatalogValidator
import com.iroselle.itemerness.bukkit.config.ItemernessSettings
import com.iroselle.itemerness.bukkit.presentation.BuiltinFontMetricsLoader
import com.iroselle.itemerness.editor.agent.CompilerBridge
import com.iroselle.itemerness.editor.agent.EditorDraftStore
import com.iroselle.itemerness.editor.protocol.Json
import com.iroselle.itemerness.editor.protocol.JsonObject
import com.iroselle.itemerness.editor.protocol.JsonValue
import com.iroselle.itemerness.editor.protocol.ProjectDocumentCodec
import java.nio.file.Files
import java.nio.file.Path
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir

class DocumentRuntimeIntegrationTest {
    @TempDir
    lateinit var directory: Path

    private val metrics = BundledBuiltinFontMetrics(BuiltinFontMetricsLoader.bundled("26.1.2"))
    private val legacy = Json.parse(Files.readString(
        Path.of(requireNotNull(System.getProperty("itemerness.editorFixtures")), "baseline.json"),
    )) as JsonValue.Obj
    private val settings = ItemernessSettings(
        "itemerness", "[{item-id}]", "dark_gray", "en_us",
        ItemKey.parse("itemerness:plain"), ItemKey.parse("itemerness:default"), null,
    )
    private val validator = RuntimeCatalogValidator {
        mapOf(
            ItemKey.parse("minecraft:paper") to MaterialProperties(64, null),
            ItemKey.parse("minecraft:netherite_sword") to MaterialProperties(1, 2031),
            ItemKey.parse("minecraft:book") to MaterialProperties(64, null),
            ItemKey.parse("minecraft:bundle") to MaterialProperties(1, null),
            ItemKey.parse("minecraft:echo_shard") to MaterialProperties(64, null),
        )
    }

    @Test
    fun `the actual YAML integration policies round trip through the document runtime bridge`() {
        val policies = yamlPolicies()
        val document = upgraded(policies)
        val decoded = ProjectDocumentCodec.decode(Json.canonicalize(document), metrics)
        assertEquals(policies, decoded.runtimeIntegrations())
        val result = preview(document)
        assertEquals(JsonValue.Null, result.raw("failure"))
        assertEquals("schema-2", result.requiredObject("digests").requiredString("documentSchema"))
        assertEquals("schema-1", preview(legacy).requiredObject("digests").requiredString("documentSchema"))
    }

    @Test
    fun `owner-only integration cannot claim a verified preview without a resolver`() {
        val document = updatePolicy(upgraded(yamlPolicies()), "example:metadata") { policy ->
            policy.with("access", (policy.entries.getValue("access") as JsonValue.Obj).with("read", text("OWNER_ONLY")))
        }
        assertRejected(document, "CATALOG.INVALID_VALUE", "access.read")
    }

    @Test
    fun `missing and incompatible PlaceholderAPI formatters are rejected by the same runtime validator`() {
        for ((formatter, code) in listOf("example:missing" to "CATALOG.MISSING_REFERENCE", "itemerness:integer" to "CATALOG.INVALID_VALUE")) {
            val document = updatePolicy(upgraded(yamlPolicies()), "example:quality") { policy ->
                policy.with("placeholderApi", (policy.entries.getValue("placeholderApi") as JsonValue.Obj).with("formatter", text(formatter)))
            }
            assertRejected(document, code, "placeholder-api.formatter")
        }
    }

    @Test
    fun `conflicting physical PDC types and total fallback budget are rejected`() {
        val document = updatePolicy(upgraded(yamlPolicies()), "example:attack-damage") { policy ->
            policy.with("readSources", arr(primary(), pdc("legacyitems:quality")))
        }
        assertRejected(document, "CATALOG.INVALID_VALUE", "read-sources")
        val overBudget = updatePolicy(upgraded(yamlPolicies()), "example:attack-damage") { policy ->
            policy.with("readSources", JsonValue.Arr(listOf(primary()) + (0..255).map { pdc("legacy:extra_$it") }))
        }
        assertRejected(overBudget, "CATALOG.BUDGET_EXCEEDED", "data-keys")
    }

    private fun yamlPolicies(): Map<ItemKey, DataKeyIntegration> {
        Files.createDirectories(directory.resolve("data-keys"))
        Files.createDirectories(directory.resolve("items"))
        javaClass.classLoader.getResourceAsStream("data-keys/common.yml")!!.use {
            Files.copy(it, directory.resolve("data-keys/common.yml"), java.nio.file.StandardCopyOption.REPLACE_EXISTING)
        }
        return CatalogSourceLoader().load(directory).dataKeyIntegrations
    }

    private fun upgraded(policies: Map<ItemKey, DataKeyIntegration>): JsonValue.Obj {
        val schemas = (legacy.entries.getValue("dataSchemas") as JsonValue.Arr).values.map { raw ->
            val schema = raw as JsonValue.Obj
            schema.with("keys", JsonValue.Arr((schema.entries.getValue("keys") as JsonValue.Arr).values.map { value ->
                val key = value as JsonValue.Obj
                val node = JsonObject.of(key, "key")
                val integration = policies.getValue(ItemKey.parse(node.requiredString("id")))
                val primaryKind = if (node.requiredString("scope") == "DEFINITION") "catalogDefinition" else "canonicalNbt"
                key.with("integration", obj(
                    "readSources" to JsonValue.Arr(listOf(primary(primaryKind)) + integration.pdcFallbacks.map { pdc(it.key.toString()) }),
                    "access" to obj("read" to text(integration.readAccess.name), "write" to JsonValue.Arr(integration.writePrincipals.map(::text))),
                    "placeholderApi" to obj(
                        "exposed" to JsonValue.Bool(integration.placeholderExposed),
                        "formatter" to (integration.placeholderFormatter?.toString()?.let(::text) ?: JsonValue.Null),
                    ),
                ))
            }))
        }
        return legacy.with("schemaVersion", JsonValue.Num(2.0))
            .with("measurement", obj("boldExtraAdvancePixels" to JsonValue.Num(1.0)))
            .with("dataSchemas", JsonValue.Arr(schemas))
    }

    private fun updatePolicy(document: JsonValue.Obj, keyId: String, update: (JsonValue.Obj) -> JsonValue.Obj): JsonValue.Obj =
        document.with("dataSchemas", JsonValue.Arr((document.entries.getValue("dataSchemas") as JsonValue.Arr).values.map { raw ->
            val schema = raw as JsonValue.Obj
            schema.with("keys", JsonValue.Arr((schema.entries.getValue("keys") as JsonValue.Arr).values.map { value ->
                val key = value as JsonValue.Obj
                if (key.entries["id"] == text(keyId)) key.with("integration", update(key.entries.getValue("integration") as JsonValue.Obj)) else key
            }))
        })).also { check(it != document) { "Fixture policy $keyId was not changed" } }

    private fun preview(document: JsonValue): JsonObject {
        val json = Json.canonicalize(document)
        val bridge = CompilerBridge(metrics, "test") { decoded, domain, presentation ->
            validator.validateRuntimeContent(settings, decoded.catalog, domain, presentation, decoded.runtimeIntegrations())
        }
        val result = bridge.compilePreview(json, CompilerBridge.PreviewContext(
            "itemerness:travel-token", "en_us", null, null, emptyList(), null,
            false, false, EditorDraftStore.digest(json),
        ))
        return JsonObject.parse(when (result) {
            is CompilerBridge.Outcome.Rendered -> result.json
            is CompilerBridge.Outcome.Rejected -> result.json
        }, "artifact")
    }

    private fun assertRejected(document: JsonValue, code: String, path: String) {
        val result = preview(document)
        assertEquals(JsonValue.Null, result.raw("display"))
        assertEquals("DOCUMENT_INVALID", result.requiredObject("failure").requiredString("code"))
        assertTrue(result.requiredObjects("diagnostics").any {
            it.requiredString("code") == code && it.requiredObject("params").requiredString("path").contains(path)
        }, Json.canonicalize(result.raw("diagnostics")!!))
    }

    private fun JsonValue.Obj.with(key: String, value: JsonValue) = JsonValue.Obj(entries + (key to value))
    private fun primary(kind: String = "canonicalNbt") = obj("kind" to text(kind))
    private fun pdc(key: String) = obj("kind" to text("pdc"), "key" to text(key), "mode" to text("FALLBACK_READ_ONLY"))
    private fun obj(vararg entries: Pair<String, JsonValue>) = JsonValue.Obj(linkedMapOf(*entries))
    private fun arr(vararg values: JsonValue) = JsonValue.Arr(values.toList())
    private fun text(value: String) = JsonValue.Text(value)
}
