package com.iroselle.itemerness.bukkit.editor

import com.iroselle.itemerness.api.ItemKey
import com.iroselle.itemerness.bukkit.catalog.CatalogSourceLoader
import com.iroselle.itemerness.bukkit.config.StrictYamlException
import com.iroselle.itemerness.bukkit.presentation.BuiltinFontMetricsArtifact
import com.iroselle.itemerness.bukkit.presentation.PresentationSourceLoader
import com.iroselle.itemerness.editor.agent.CatalogTransferException
import com.iroselle.itemerness.editor.agent.CompilerBridge
import com.iroselle.itemerness.editor.protocol.*
import com.iroselle.itemerness.bukkit.editor.EditorAssetMetadata.obj
import com.iroselle.itemerness.bukkit.editor.YamlEncoding.mapping as map
import java.util.UUID

/** Produces configuration files only. The runtime directory and draft store are never mutated. */
internal class EditorCatalogExporter(
    private val metrics: BuiltinFontMetricsArtifact,
    private val compiler: CompilerBridge,
    /** Hash of the catalog currently on disk, comparable with an imported document's baseline. */
    private val currentSourceHash: () -> String = { error("No source hash is available") },
) {
    fun export(document: JsonValue): JsonValue {
        val root = JsonObject.of(document, "document")
        if (root.requiredInt("schemaVersion") != 2) throw CatalogTransferException("CATALOG_UPGRADE_REQUIRED")
        val diagnostics = compiler.validateDocument(document)
        if (diagnostics.isNotEmpty()) throw CatalogTransferException("CATALOG_INVALID", diagnostics)
        val decoded = ProjectDocumentCodec.decode(Json.canonicalize(document), BundledBuiltinFontMetrics(metrics))
        if (decoded.defaultLayout == null || decoded.defaultTheme == null) throw CatalogTransferException("CATALOG_DEFAULTS_REQUIRED")
        root.requiredObjects("bitmaps").forEach { bitmap ->
            if (bitmap.optionalString("texture") == null || bitmap.optionalInt("sourceWidthPixels") == null || bitmap.optionalInt("sourceHeightPixels") == null) {
                throw CatalogTransferException("CATALOG_ASSET_METADATA_MISSING", listOf(obj("code" to "ASSETS.METADATA_MISSING", "severity" to "ERROR", "origin" to "agent",
                    "messageKey" to "diagnostics.assets.metadata_missing", "params" to obj("asset" to bitmap.requiredString("id")))))
            }
        }
        val layout = EditorSourceLayout.resolve(root, decoded.namespace, decoded.schemaVersion)
        val files = LinkedHashMap<String, String>()
        fun file(path: String, value: Map<String, Any?>) {
            // Paths are case-folded because the client and common file systems treat them as one file.
            if (files.keys.any { it.equals(path, ignoreCase = true) }) {
                throw CatalogTransferException("CATALOG_EXPORT_INVALID", listOf(obj("code" to "CATALOG.SOURCE_PATH_CONFLICT", "severity" to "ERROR",
                    "origin" to "agent", "messageKey" to "diagnostics.catalog.source_path_conflict", "params" to obj("path" to path))))
            }
            files[path] = YamlEncoding.dump(value)
        }
        fun grouped(collection: String, section: String, default: String, entries: Map<String, Any?>, vararg header: Pair<String, Any?>) {
            if (entries.isEmpty()) return file(default, YamlEncoding.document(*header, section to entries))
            entries.entries.groupBy { (id, _) -> layout.path(collection, id, default) }.forEach { (path, group) ->
                file(path, YamlEncoding.document(*header, section to group.associate { it.key to it.value }))
            }
        }
        fun groupedThemes(themes: Map<String, Any?>, selectors: Map<String, Any?>) {
            // A theme file may hold themes, selectors, or both; an empty selector section is omitted.
            val byPath = LinkedHashMap<String, Pair<MutableMap<String, Any?>, MutableMap<String, Any?>>>()
            fun target(path: String) = byPath.getOrPut(path) { linkedMapOf<String, Any?>() to linkedMapOf() }
            if (themes.isEmpty() && selectors.isEmpty()) target("themes/editor.yml")
            themes.forEach { (id, value) -> target(layout.path("themes", id, "themes/editor.yml")).first[id] = value }
            selectors.forEach { (id, value) -> target(layout.path("themeSelectors", id, "themes/editor.yml")).second[id] = value }
            byPath.forEach { (path, sections) ->
                file(path, YamlEncoding.document("themes" to sections.first, "theme-selectors" to sections.second.takeIf { it.isNotEmpty() }))
            }
        }
        decoded.catalog.schemas.forEachIndexed { index, schema ->
            file(layout.path("dataSchemas", "${schema.id}@${schema.version}", "data-keys/schema-${index.toString().padStart(4, '0')}.yml"),
                CatalogYamlEncoding.schema(schema, decoded.dataKeyIntegrations))
        }
        val authoring = root.requiredObjects("items").associateBy { it.itemKey(decoded.namespace, decoded.schemaVersion).toString() }
        val items = decoded.catalog.items.associate { item ->
            val bindings = authoring.getValue(item.id).requiredObject("presentation")
            item.id to CatalogYamlEncoding.item(item, decoded.presentation.items.single { it.id == item.id }, bindings.optionalString("layout"), bindings.optionalString("theme"))
        }
        grouped("items", "items", "items/editor.yml", items, "namespace" to decoded.namespace)
        grouped("formats", "formats", "formats/editor.yml", decoded.presentation.formats.associate { it.id to PresentationYamlEncoding.format(it) })
        decoded.presentation.locales.forEachIndexed { index, locale ->
            file(layout.path("locales", locale.locale, "locales/${index.toString().padStart(4, '0')}-${locale.locale}.yml"),
                YamlEncoding.document("locale" to locale.locale, "fallback" to locale.fallback, "messages" to locale.messages))
        }
        grouped("layouts", "layouts", "layouts/editor.yml", decoded.presentation.layouts.associate { it.id to PresentationYamlEncoding.layout(it) })
        groupedThemes(
            decoded.presentation.themes.associate { it.id to PresentationYamlEncoding.theme(it) },
            decoded.presentation.themeSelectors.associate { it.id to PresentationYamlEncoding.themeSelector(it) },
        )
        grouped("viewerFacts", "facts", "viewer-facts/editor.yml", decoded.presentation.viewerFacts.associate { it.id to PresentationYamlEncoding.fact(it) })
        splitAssets(AssetYamlEncoding.encode(root, decoded.presentation), layout).forEach { (path, content) -> file(path, content) }
        try {
            verify(root, decoded, files)
        } catch (failure: StrictYamlException) {
            throw CatalogTransferException("CATALOG_EXPORT_INVALID", listOf(obj("code" to "CATALOG.EXPORT_INVALID", "severity" to "ERROR", "origin" to "agent",
                "messageKey" to "diagnostics.catalog.export_invalid", "params" to obj("detail" to (failure.message ?: "Invalid source").take(2048)))))
        }
        val settingsPatch = map("catalog" to map("default-namespace" to decoded.namespace), "locale" to map("default" to decoded.defaultLocale),
            "presentation" to map("default-layout" to decoded.defaultLayout, "default-theme" to decoded.defaultTheme))
        // Export never writes the runtime catalog, so a changed baseline is a review warning, not a conflict.
        val imported = EditorSourceLayout.importedSourceHash(root)
        val current = imported?.let { runCatching(currentSourceHash).getOrNull() }
        val warnings = if (imported != null && current != null && current != imported) {
            listOf(obj("code" to "CATALOG.SOURCE_CHANGED_SINCE_IMPORT", "severity" to "WARNING", "origin" to "agent",
                "messageKey" to "diagnostics.catalog.source_changed_since_import", "params" to obj()))
        } else {
            emptyList()
        }
        return obj("files" to files.map { (path, content) -> obj("path" to path, "content" to content) },
            "settingsPatch" to YamlEncoding.dump(settingsPatch), "diagnostics" to warnings)
    }

    /** Splits the asset document by recorded file; singleton policies follow their own recorded file. */
    private fun splitAssets(assets: Map<String, Any?>, layout: EditorSourceLayout.Resolved): Map<String, Map<String, Any?>> {
        val default = "assets/editor.yml"
        val result = LinkedHashMap<String, MutableMap<String, Any?>>()
        fun target(path: String) = result.getOrPut(path) { linkedMapOf("schema-version" to assets["schema-version"]) }
        assets.forEach { (section, value) ->
            val collection = EditorSourceLayout.ASSET_SECTIONS[section]
            when {
                section == "schema-version" -> Unit
                collection != null -> {
                    @Suppress("UNCHECKED_CAST")
                    val entries = value as Map<String, Any?>
                    if (entries.isEmpty()) target(default)[section] = entries
                    entries.forEach { (id, entry) ->
                        @Suppress("UNCHECKED_CAST")
                        val group = target(layout.path(collection, id, default)).getOrPut(section) { LinkedHashMap<String, Any?>() } as MutableMap<String, Any?>
                        group[id] = entry
                    }
                }
                else -> target(layout.singleton(section, default))[section] = value
            }
        }
        return result
    }

    private fun verify(root: JsonObject, decoded: ProjectDocumentCodec.Decoded, files: Map<String, String>) {
        val id = UUID.fromString(root.requiredString("documentId"))
        val policies = root.requiredObjects("dataSchemas").flatMap { it.requiredObjects("keys") }
            .associate { it.requiredString("id") to requireNotNull(it.raw("integration")) }
        val encoder = ProjectDocumentEncoder(id)
        val defaults = ProjectDocumentEncoder.Defaults(decoded.defaultLayout, decoded.defaultTheme)
        val bindings = root.requiredObjects("items").associate { item ->
            val presentation = item.requiredObject("presentation")
            item.itemKey(decoded.namespace, decoded.schemaVersion).toString() to ProjectDocumentEncoder.ItemBindings(presentation.optionalString("layout"), presentation.optionalString("theme"))
        }
        val expected = encoder.encode(decoded.namespace, decoded.defaultLocale, decoded.catalog, decoded.presentation, root, policies, defaults, bindings)
        val actual = EditorCatalogFiles.from(files).withDirectory { directory ->
            val catalog = CatalogSourceLoader().load(directory)
            if (catalog.dataKeyIntegrations != decoded.runtimeIntegrations()) throw CatalogTransferException("CATALOG_EXPORT_LOSSY")
            val presentation = PresentationSourceLoader(metrics).loadAndCompile(directory, catalog, decoded.defaultLocale,
                decoded.defaultLayout?.let(ItemKey::parse), decoded.defaultTheme?.let(ItemKey::parse))
            if (presentation.compilation.diagnostics.isNotEmpty()) throw CatalogTransferException("CATALOG_EXPORT_INVALID")
            val restoredBindings = catalog.itemDocuments.mapKeys { it.key.toString() }.mapValues { (id, value) ->
                val binding = com.iroselle.itemerness.bukkit.config.YamlObject.root(value, "items.$id").requiredObject("presentation")
                ProjectDocumentEncoder.ItemBindings(binding.optionalString("layout"), binding.optionalString("theme"))
            }
            encoder.encode(decoded.namespace, decoded.defaultLocale, catalog.source, presentation.source, EditorAssetMetadata.read(directory, presentation.source), policies, defaults, restoredBindings)
        }
        // UUIDs are regenerated deterministically from the same document and business identities.
        // Only runtime inputs participate; previews and inactive authoring extensions are excluded.
        val differences = differences(normalizeMetadata(expected), normalizeMetadata(actual))
        if (differences.isNotEmpty()) throw CatalogTransferException("CATALOG_EXPORT_LOSSY", differences)
    }

    private fun normalizeMetadata(document: JsonValue.Obj): JsonValue.Obj {
        val measurement = JsonObject.of(document.entries.getValue("measurement"), "measurement")
        return JsonValue.Obj(document.entries + ("measurement" to obj("boldExtraAdvancePixels" to (measurement.optionalDouble("boldExtraAdvancePixels") ?: 1.0))))
    }

    private fun differences(expected: JsonValue, actual: JsonValue): List<JsonValue> {
        val diagnostics = ArrayList<JsonValue>()
        fun visit(before: JsonValue?, after: JsonValue?, path: String, decimal: Boolean = false) {
            if (diagnostics.size >= 16 || before == after) return
            if (decimal && before is JsonValue.Text && after is JsonValue.Text && before.value.toBigDecimal().compareTo(after.value.toBigDecimal()) == 0) return
            when {
                before is JsonValue.Obj && after is JsonValue.Obj -> (before.entries.keys + after.entries.keys).forEach { key ->
                    val numeric = (key == "value" && before.entries["kind"] == JsonValue.Text("decimal")) ||
                        (key in setOf("minimum", "maximum") && (path.endsWith("/constraints") || before.entries["kind"] == JsonValue.Text("randomDecimal")))
                    visit(before.entries[key], after.entries[key], "$path/${key.replace("~", "~0").replace("/", "~1")}", numeric)
                }
                before is JsonValue.Arr && after is JsonValue.Arr -> (0 until maxOf(before.values.size, after.values.size)).forEach { index ->
                    visit(before.values.getOrNull(index), after.values.getOrNull(index), "$path/$index")
                }
                else -> diagnostics += obj("code" to "CATALOG.EXPORT_LOSSY", "severity" to "ERROR", "origin" to "agent",
                    "messageKey" to "diagnostics.catalog.export_lossy", "params" to obj("path" to path), "pointer" to path)
            }
        }
        visit(expected, actual, "")
        return diagnostics
    }

    private fun JsonObject.itemKey(namespace: String, version: Int): ItemKey {
        val id = requiredString("id")
        return ItemKey.parse(if (version >= 2 && ':' in id) id else "$namespace:$id")
    }
}
