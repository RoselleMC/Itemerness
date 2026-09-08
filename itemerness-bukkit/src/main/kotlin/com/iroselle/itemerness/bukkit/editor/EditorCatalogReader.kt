package com.iroselle.itemerness.bukkit.editor

import com.iroselle.itemerness.api.ItemKey
import com.iroselle.itemerness.bukkit.catalog.CatalogSourceLoader
import com.iroselle.itemerness.bukkit.catalog.LoadedCatalogSource
import com.iroselle.itemerness.bukkit.catalog.RuntimeCatalogValidator
import com.iroselle.itemerness.bukkit.config.ItemernessSettings
import com.iroselle.itemerness.bukkit.config.StrictYamlException
import com.iroselle.itemerness.bukkit.config.YamlObject
import com.iroselle.itemerness.bukkit.presentation.BuiltinFontMetricsArtifact
import com.iroselle.itemerness.bukkit.presentation.PresentationSourceLoader
import com.iroselle.itemerness.core.catalog.DataScope
import com.iroselle.itemerness.core.catalog.CatalogCompiler
import com.iroselle.itemerness.core.catalog.CatalogDiagnostic
import com.iroselle.itemerness.editor.agent.CatalogTransferException
import com.iroselle.itemerness.editor.agent.CompilerBridge
import com.iroselle.itemerness.editor.agent.EditorDraftStore
import com.iroselle.itemerness.editor.protocol.Json
import com.iroselle.itemerness.editor.protocol.JsonValue
import com.iroselle.itemerness.editor.protocol.ProjectDocumentEncoder
import com.iroselle.itemerness.bukkit.editor.EditorAssetMetadata.obj
import java.nio.file.Path
import java.util.UUID

/** Reads authoring configuration without seeding drafts, publishing catalogs, or retaining Bukkit state. */
internal class EditorCatalogReader(
    private val root: Path,
    private val metrics: BuiltinFontMetricsArtifact,
    private val agentVersion: String,
    private val validator: RuntimeCatalogValidator,
) {
    fun read(): JsonValue {
        val settings = try {
            ItemernessSettings.load(root.resolve("config.yml"))
        } catch (_: Exception) {
            // Strict YAML parser errors may include the line containing an API token.
            throw CatalogTransferException("CATALOG_SETTINGS_INVALID")
        }
        return try {
            read(settings)
        } catch (failure: StrictYamlException) {
            throw CatalogTransferException("CATALOG_INVALID", listOf(obj("code" to "CATALOG.SOURCE_INVALID", "severity" to "ERROR", "origin" to "agent",
                "messageKey" to "diagnostics.catalog.source_invalid", "params" to obj("detail" to (failure.message ?: "Invalid source").take(2048)))))
        }
    }

    private fun read(settings: ItemernessSettings): JsonValue {
        val files = EditorCatalogFiles.capture(root)
        val document = files.withDirectory { directory -> encode(directory, settings) }
        if (Json.canonicalize(document).toByteArray(Charsets.UTF_8).size > EditorDraftStore.MAX_BYTES) {
            throw CatalogTransferException("CATALOG_DOCUMENT_TOO_LARGE")
        }
        val compiler = CompilerBridge(BundledBuiltinFontMetrics(metrics), agentVersion) { decoded, domain, presentation ->
            validator.validateRuntimeContent(settings, decoded.catalog, domain, presentation, decoded.runtimeIntegrations())
        }
        val diagnostics = compiler.validateDocument(document)
        if (diagnostics.isNotEmpty()) throw CatalogTransferException("CATALOG_INVALID", diagnostics)
        val sourceHash = EditorDraftStore.digest(Json.canonicalize(obj("files" to files.digest,
            "namespace" to settings.defaultNamespace, "defaultLocale" to settings.defaultLocale,
            "defaultLayout" to settings.defaultLayout.toString(), "defaultTheme" to settings.defaultTheme.toString(),
            "pendingNameTemplate" to settings.pendingNameTemplate, "pendingNameColor" to settings.pendingNameColor)))
        return obj("document" to document, "sourceHash" to sourceHash, "diagnostics" to emptyList<JsonValue>())
    }

    private fun encode(directory: Path, settings: ItemernessSettings): JsonValue {
        val catalog = CatalogSourceLoader().load(directory)
        val compilation = CatalogCompiler().compile(catalog.source)
        val candidate = compilation.candidate
        if (candidate == null || compilation.diagnostics.isNotEmpty()) rejectCatalog(compilation.diagnostics)
        val presentation = PresentationSourceLoader(metrics).loadAndCompile(directory, catalog,
            settings.defaultLocale, settings.defaultLayout, settings.defaultTheme)
        if (presentation.compilation.diagnostics.isNotEmpty()) {
            throw CatalogTransferException("CATALOG_INVALID", presentation.compilation.diagnostics.map { diagnostic -> obj(
                "severity" to "ERROR", "origin" to "agent", "code" to "PRESENTATION.${diagnostic.code.name}",
                "messageKey" to "diagnostics.presentation.${diagnostic.code.name.lowercase()}",
                "params" to obj("path" to diagnostic.path, "detail" to diagnostic.message),
            ) })
        }
        val presentationCatalog = presentation.compilation.catalog ?: throw CatalogTransferException("CATALOG_INVALID")
        val diagnostics = validator.validate(settings, catalog.source, candidate.materializeValidationView(), presentationCatalog, catalog.dataKeyIntegrations)
        if (diagnostics.isNotEmpty()) rejectCatalog(diagnostics)
        return ProjectDocumentEncoder(UUID.randomUUID()).encode(settings.defaultNamespace, settings.defaultLocale,
            catalog.source, presentation.source, EditorAssetMetadata.read(directory, presentation.source), integrations(catalog),
            ProjectDocumentEncoder.Defaults(settings.defaultLayout.toString(), settings.defaultTheme.toString()),
            catalog.itemDocuments.mapKeys { it.key.toString() }.mapValues { (id, value) ->
                val authoring = YamlObject.root(value, "items.$id").requiredObject("presentation")
                ProjectDocumentEncoder.ItemBindings(authoring.optionalString("layout"), authoring.optionalString("theme"))
            },
        )
    }

    private fun rejectCatalog(diagnostics: List<CatalogDiagnostic>): Nothing = throw CatalogTransferException("CATALOG_INVALID", diagnostics.map { diagnostic -> obj(
        "severity" to "ERROR", "origin" to "agent", "code" to "CATALOG.${diagnostic.code.name}",
        "messageKey" to "diagnostics.catalog.${diagnostic.code.name.lowercase()}", "params" to obj("path" to diagnostic.path, "detail" to diagnostic.message),
    ) })

    private fun integrations(catalog: LoadedCatalogSource): Map<String, JsonValue> = catalog.source.schemas.flatMap { schema ->
        schema.keys.map { key ->
            val integration = requireNotNull(catalog.dataKeyIntegrations[ItemKey.parse(key.id)])
            val primary = if (key.scope == DataScope.DEFINITION) "catalogDefinition" else "canonicalNbt"
            key.id to obj(
                "readSources" to (listOf(obj("kind" to primary)) + integration.pdcFallbacks.map { obj("kind" to "pdc", "key" to it.key.toString(), "mode" to "FALLBACK_READ_ONLY") }),
                "access" to obj("read" to integration.readAccess.name, "write" to integration.writePrincipals),
                "placeholderApi" to obj("exposed" to integration.placeholderExposed, "formatter" to integration.placeholderFormatter?.toString()),
            )
        }
    }.toMap()
}
