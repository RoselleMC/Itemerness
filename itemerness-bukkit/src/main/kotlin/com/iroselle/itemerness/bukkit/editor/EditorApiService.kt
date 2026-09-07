package com.iroselle.itemerness.bukkit.editor

import com.iroselle.itemerness.bukkit.config.EditorEndpoint
import com.iroselle.itemerness.bukkit.presentation.BuiltinFontMetricsArtifact
import com.iroselle.itemerness.editor.agent.AgentScheduler
import com.iroselle.itemerness.editor.agent.CompilerBridge
import com.iroselle.itemerness.editor.agent.EditorApiServer
import com.iroselle.itemerness.editor.agent.EditorDraftStore
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
    serverId: String,
    agentVersion: String,
    minecraftVersion: String,
    platform: String,
    builtinFontMetrics: BuiltinFontMetricsArtifact,
    private val logger: Logger,
    private val scheduler: AgentScheduler,
    worker: Executor,
    draftPath: Path,
) : EditorApiHandle {
    private val metrics = BundledBuiltinFontMetrics(builtinFontMetrics)
    private val bridge = CompilerBridge(metrics, agentVersion)
    private val api = EditorApiServer(
        address = InetSocketAddress.createUnresolved(endpoint.bindHost, endpoint.port),
        token = endpoint.token,
        allowedOrigins = endpoint.allowedOrigins,
        metadata = EditorApiServer.Metadata(serverId, agentVersion, minecraftVersion, platform, bridge.compilerDigest()),
        drafts = EditorDraftStore(draftPath) { ProjectDocumentCodec.decode(it, metrics) },
        compile = ::compile,
        worker = worker,
        scheduler = scheduler,
        onFailure = { logger.log(Level.WARNING, "Editor API request failed (${it.javaClass.simpleName})") },
    )
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
        api.close()
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
        ))
        return Json.parse(when (outcome) {
            is CompilerBridge.Outcome.Rendered -> outcome.json
            is CompilerBridge.Outcome.Rejected -> outcome.json
        })
    }
}
