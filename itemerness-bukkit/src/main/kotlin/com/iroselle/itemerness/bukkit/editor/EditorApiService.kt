package com.iroselle.itemerness.bukkit.editor

import com.iroselle.itemerness.api.ItemKey
import com.iroselle.itemerness.bukkit.config.EditorEndpoint
import com.iroselle.itemerness.bukkit.config.ItemernessSettings
import com.iroselle.itemerness.bukkit.catalog.RuntimeCatalogValidator
import com.iroselle.itemerness.bukkit.catalog.DataKeyIntegration
import com.iroselle.itemerness.bukkit.catalog.DataReadAccess
import com.iroselle.itemerness.bukkit.catalog.PdcFallbackSource
import com.iroselle.itemerness.bukkit.presentation.BuiltinFontMetricsArtifact
import com.iroselle.itemerness.bukkit.projection.ShownComponentNotice
import com.iroselle.itemerness.editor.agent.AgentScheduler
import com.iroselle.itemerness.editor.agent.CompilerBridge
import com.iroselle.itemerness.editor.agent.EditorApiServer
import com.iroselle.itemerness.editor.agent.EditorDraftStore
import com.iroselle.itemerness.editor.agent.EditorTransferLimits
import com.iroselle.itemerness.editor.agent.ScenarioSelection
import com.iroselle.itemerness.editor.agent.ServerIdentity
import com.iroselle.itemerness.editor.agent.ServerMetadataStore
import com.iroselle.itemerness.editor.protocol.Json
import com.iroselle.itemerness.editor.protocol.JsonObject
import com.iroselle.itemerness.editor.protocol.JsonValue
import com.iroselle.itemerness.editor.protocol.ProjectDocumentCodec
import java.net.InetSocketAddress
import java.nio.file.Path
import java.util.concurrent.Executor
import java.util.logging.Level
import java.util.logging.Logger

/** Owns an inbound API, never an outbound connection. No handler retains Bukkit state. */
internal class EditorApiService(
    override val endpoint: EditorEndpoint,
    serverName: String,
    agentVersion: String,
    minecraftVersion: String,
    platform: String,
    builtinFontMetrics: BuiltinFontMetricsArtifact,
    settings: () -> ItemernessSettings,
    private val logger: Logger,
    private val scheduler: AgentScheduler,
    worker: Executor,
    draftPath: Path,
    catalogPath: Path,
    /** Absent in tests and on platforms without the plugin API; previews then offer no scenarios. */
    previewData: PreviewDataBroker? = null,
) : EditorApiHandle {
    private val metrics = BundledBuiltinFontMetrics(builtinFontMetrics)
    private val validator = RuntimeCatalogValidator()
    private val previewBroker = previewData
    private val bridge = CompilerBridge(metrics, agentVersion, { settings().budgets }, previewData = previewData) { decoded, domain, presentation ->
        validator.validateRuntimeContent(settings(), decoded.catalog, domain, presentation, decoded.runtimeIntegrations())
    }
    private val catalogReader = EditorCatalogReader(catalogPath, builtinFontMetrics, agentVersion, validator)
    private val catalogExporter = EditorCatalogExporter(builtinFontMetrics, bridge, catalogReader::currentSourceHash, directoryBytes = { settings().catalogDirectoryBytes })
    /** Editor documents may be as large as one catalog directory is allowed to be. */
    private val transferLimits = { EditorTransferLimits(settings().catalogDirectoryBytes.toInt()) }
    private val serverMetadata by lazy {
        ServerMetadataStore(draftPath.resolveSibling("server-metadata.json"), ServerIdentity.loadOrCreate(draftPath.resolveSibling("server-id")))
    }
    private val apiDelegate = lazy { EditorApiServer(
        address = InetSocketAddress.createUnresolved(endpoint.bindHost, endpoint.port),
        token = endpoint.token,
        allowedOrigins = endpoint.allowedOrigins,
        metadata = EditorApiServer.Metadata(
            serverMetadata.serverId,
            agentVersion, minecraftVersion, platform, bridge.compilerDigest(), serverName,
            persistentIdentity = true,
            dataComponentTypes = ShownComponentNotice.serverComponents().orEmpty().map(ItemKey::toString),
        ),
        drafts = EditorDraftStore(draftPath, transferLimits) { ProjectDocumentCodec.decode(it, metrics) },
        compile = ::compile,
        worker = worker,
        scheduler = scheduler,
        onFailure = { logger.log(Level.WARNING, "Editor API request failed (${it.javaClass.simpleName})") },
        readCatalog = catalogReader::read,
        exportCatalog = catalogExporter::export,
        catalogStatus = catalogReader::status,
        serverMetadata = serverMetadata,
        budgets = { settings().budgets },
        limits = transferLimits,
        previewScenarios = previewData?.let { { request -> scenarios(request) } },
    ) }
    private val api by apiDelegate
    private var stopped = false

    override fun start() {
        check(scheduler.execute {
            synchronized(this) {
                if (stopped) return@execute
                try {
                    api.start()
                    if (endpoint.token.isEmpty()) {
                        logger.warning("Editor API token authentication is disabled. Anyone who can reach the listener can read and edit drafts; restrict network access.")
                    }
                    logger.info("Editor API listening on ${endpoint.bindHost}:${endpoint.port} (protocol ${EditorApiServer.PROTOCOL})")
                } catch (failure: Exception) {
                    logger.log(Level.SEVERE, "Could not start editor API", failure)
                }
            }
        }) { "Editor API startup was rejected by the async scheduler" }
    }

    @Synchronized
    override fun stop() {
        stopped = true
        if (apiDelegate.isInitialized()) api.close()
        previewBroker?.close()
    }

    private fun scenarios(payload: JsonValue): JsonValue {
        val request = JsonObject.of(payload, "scenarios")
        return bridge.previewScenarios(
            Json.canonicalize(requireNotNull(request.raw("document"))),
            request.requiredString("snapshotHash"),
            request.requiredString("itemId"),
            request.optionalString("locale") ?: "en_us",
        )
    }

    private fun compile(payload: JsonValue): JsonValue {
        val request = JsonObject.of(payload, "preview")
        val documentJson = Json.canonicalize(requireNotNull(request.raw("document")))
        val viewer = request.optionalObject("viewer")
        val outcome = bridge.compilePreview(documentJson, CompilerBridge.PreviewContext(
            itemId = request.requiredString("itemId"),
            locale = viewer?.optionalString("locale") ?: "en_us",
            requestedTheme = viewer?.optionalString("requestedTheme"),
            assetProfile = viewer?.optionalString("assetProfile"),
            capabilities = viewer?.optionalStrings("capabilities").orEmpty(),
            metricsRevision = viewer?.optionalString("metricsRevision"),
            resourcePackLoaded = viewer?.optionalBoolean("resourcePackLoaded", false) ?: false,
            managesVanillaTooltipLines = viewer?.optionalBoolean("managesVanillaTooltipLines", false) ?: false,
            snapshotHash = request.requiredString("snapshotHash"),
            scenario = request.optionalObject("scenario")?.let { scenario ->
                ScenarioSelection(
                    plugin = scenario.requiredString("plugin"),
                    scenario = scenario.requiredString("id"),
                    parameters = (scenario.raw("parameters") as? JsonValue.Obj) ?: JsonValue.Obj(emptyMap()),
                )
            },
        ))
        return Json.parse(when (outcome) {
            is CompilerBridge.Outcome.Rendered -> outcome.json
            is CompilerBridge.Outcome.Rejected -> outcome.json
        })
    }
}

internal fun ProjectDocumentCodec.Decoded.runtimeIntegrations(): Map<ItemKey, DataKeyIntegration> =
    java.util.Collections.unmodifiableMap(dataKeyIntegrations.mapValues { (_, integration) ->
        DataKeyIntegration(
            readAccess = DataReadAccess.valueOf(integration.readAccess.name),
            writePrincipals = integration.writePrincipals,
            pdcFallbacks = java.util.List.copyOf(integration.pdcFallbackKeys.map(::PdcFallbackSource)),
            placeholderExposed = integration.placeholderExposed,
            placeholderFormatter = integration.placeholderFormatter,
        )
    })
