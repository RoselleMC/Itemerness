package com.iroselle.itemerness.bukkit.editor

import com.iroselle.itemerness.bukkit.config.StrictYaml
import com.iroselle.itemerness.bukkit.config.YamlObject
import com.iroselle.itemerness.editor.agent.CatalogTransferException
import com.iroselle.itemerness.editor.protocol.JsonObject
import com.iroselle.itemerness.editor.protocol.JsonValue
import com.iroselle.itemerness.bukkit.editor.EditorAssetMetadata.obj
import java.nio.file.Files
import java.nio.file.Path
import kotlin.io.path.extension
import kotlin.io.path.invariantSeparatorsPathString

/**
 * Remembers which catalog file each imported object came from, so an export can write objects
 * back to the operator's own file layout instead of one editor-shaped file per domain.
 *
 * The layout is authoring metadata only. It never changes runtime meaning: export still verifies
 * that the written files load back to exactly the same document, and objects without a recorded
 * file go to the domain's default `editor.yml`.
 */
internal object EditorSourceLayout {
    /** Document collections whose nodes map to files, with the catalog directory they belong to. */
    private val COLLECTIONS = linkedMapOf(
        "dataSchemas" to "data-keys",
        "items" to "items",
        "formats" to "formats",
        "locales" to "locales",
        "layouts" to "layouts",
        "themes" to "themes",
        "viewerFacts" to "viewer-facts",
        "fonts" to "assets",
        "glyphs" to "assets",
        "bitmaps" to "assets",
        "tooltipStyles" to "assets",
        "assetProfiles" to "assets",
        "resourcePackBindings" to "assets",
    )

    /** Asset YAML sections and the document collection each one holds. */
    val ASSET_SECTIONS = linkedMapOf(
        "fonts" to "fonts",
        "glyphs" to "glyphs",
        "bitmaps" to "bitmaps",
        "tooltip-styles" to "tooltipStyles",
        "asset-profiles" to "assetProfiles",
        "resource-pack-bindings" to "resourcePackBindings",
    )
    private val SINGLETONS = linkedMapOf("measurement" to "measurement", "spacing" to "spacing")
    private const val MAX_PATH_LENGTH = 256
    private const val MAX_SEGMENTS = 8
    private val SEGMENT = Regex("[A-Za-z0-9_.-]+")

    /** Object identity inside one catalog: the document collection plus its natural id. */
    data class ObjectKey(val collection: String, val id: String)

    /** Scans a captured catalog directory. Paths are relative to the plugin data folder. */
    fun scan(root: Path): Map<ObjectKey, String> {
        val result = LinkedHashMap<ObjectKey, String>()
        EditorCatalogFiles.DOMAINS.forEach { domain ->
            val directory = root.resolve(domain)
            if (!Files.isDirectory(directory)) return@forEach
            Files.walk(directory).use { paths ->
                paths.filter { Files.isRegularFile(it) && it.extension.lowercase() in setOf("yml", "yaml") }.sorted().toList()
            }.forEach { file ->
                val relative = root.relativize(file).invariantSeparatorsPathString
                val document = YamlObject.root(StrictYaml.load(file), relative)
                identities(domain, document).forEach { key -> result.putIfAbsent(key, relative) }
            }
        }
        return result
    }

    private fun identities(domain: String, document: YamlObject): List<ObjectKey> = when (domain) {
        "data-keys" -> listOf(ObjectKey("dataSchemas", "${document.requiredString("id")}@${document.requiredInt("schema-version")}"))
        "items" -> {
            val namespace = document.requiredString("namespace")
            document.requiredObject("items").keys.map { id -> ObjectKey("items", if (':' in id) id else "$namespace:$id") }
        }
        "locales" -> listOf(ObjectKey("locales", document.requiredString("locale")))
        "formats" -> keys(document, "formats", "formats")
        "layouts" -> keys(document, "layouts", "layouts")
        "themes" -> keys(document, "themes", "themes")
        "viewer-facts" -> keys(document, "facts", "viewerFacts")
        "assets" -> ASSET_SECTIONS.flatMap { (section, collection) -> keys(document, section, collection) } +
            SINGLETONS.keys.filter(document::contains).map { section -> ObjectKey(section, "") }
        else -> emptyList()
    }

    private fun keys(document: YamlObject, section: String, collection: String): List<ObjectKey> =
        document.optionalObject(section)?.keys?.map { id -> ObjectKey(collection, id) }.orEmpty()

    /** Encodes a scan against the imported document's node identities. */
    fun encode(document: JsonValue, scanned: Map<ObjectKey, String>, sourceHash: String): JsonValue.Obj {
        val root = JsonObject.of(document, "document")
        val namespace = root.requiredString("namespace")
        val schemaVersion = root.requiredInt("schemaVersion")
        val files = sortedMapOf<String, JsonValue>()
        COLLECTIONS.keys.forEach { collection ->
            root.optionalObjects(collection).forEach { node ->
                scanned[ObjectKey(collection, naturalId(collection, node, namespace, schemaVersion))]?.let { path ->
                    files[node.requiredString("uuid")] = JsonValue.Text(path)
                }
            }
        }
        val singletons = SINGLETONS.mapNotNull { (section, field) ->
            scanned[ObjectKey(section, "")]?.let { path -> field to path }
        }
        return obj("sourceHash" to sourceHash, "files" to JsonValue.Obj(files), *singletons.toTypedArray())
    }

    /** Resolves the export file for every node, falling back to the domain default. */
    class Resolved(private val nodes: Map<ObjectKey, String>, private val singletons: Map<String, String>) {
        fun path(collection: String, id: String, default: String): String = nodes[ObjectKey(collection, id)] ?: default
        fun singleton(section: String, default: String): String = singletons[section] ?: default
    }

    fun resolve(root: JsonObject, namespace: String, schemaVersion: Int): Resolved {
        val layout = root.optionalObject("sourceLayout") ?: return Resolved(emptyMap(), emptyMap())
        val files = layout.optionalObject("files")
        val nodes = LinkedHashMap<ObjectKey, String>()
        COLLECTIONS.forEach { (collection, domain) ->
            root.optionalObjects(collection).forEach { node ->
                val path = files?.optionalString(node.requiredString("uuid")) ?: return@forEach
                nodes[ObjectKey(collection, naturalId(collection, node, namespace, schemaVersion))] = validated(path, domain)
            }
        }
        val singletons = SINGLETONS.mapNotNull { (section, field) ->
            layout.optionalString(field)?.let { path -> section to validated(path, "assets") }
        }.toMap()
        return Resolved(nodes, singletons)
    }

    /** The import baseline, when the document still carries one. */
    fun importedSourceHash(root: JsonObject): String? = root.optionalObject("sourceLayout")?.optionalString("sourceHash")

    private fun naturalId(collection: String, node: JsonObject, namespace: String, schemaVersion: Int): String = when (collection) {
        "dataSchemas" -> "${node.requiredString("id")}@${node.requiredInt("version")}"
        "items" -> node.requiredString("id").let { id -> if (schemaVersion >= 2 && ':' in id) id else "$namespace:$id" }
        "locales" -> node.requiredString("locale")
        else -> node.requiredString("id")
    }

    /** Rejects anything but a plain relative YAML path inside the object's own catalog directory. */
    fun validated(path: String, domain: String): String {
        val segments = path.split('/')
        val valid = path.length <= MAX_PATH_LENGTH && segments.size in 2..MAX_SEGMENTS && segments.first() == domain &&
            segments.all { segment -> segment != "." && segment != ".." && SEGMENT.matches(segment) } &&
            segments.last().substringAfterLast('.', "").lowercase() in setOf("yml", "yaml")
        if (!valid) {
            throw CatalogTransferException("CATALOG_EXPORT_INVALID", listOf(obj("code" to "CATALOG.SOURCE_PATH_INVALID", "severity" to "ERROR",
                "origin" to "agent", "messageKey" to "diagnostics.catalog.source_path_invalid", "params" to obj("path" to path.take(MAX_PATH_LENGTH), "domain" to domain))))
        }
        return path
    }
}
