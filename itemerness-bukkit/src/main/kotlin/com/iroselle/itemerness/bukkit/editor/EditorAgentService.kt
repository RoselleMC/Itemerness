package com.iroselle.itemerness.bukkit.editor

import com.iroselle.itemerness.bukkit.config.EditorEndpoint
import com.iroselle.itemerness.editor.agent.AgentScheduler
import com.iroselle.itemerness.editor.agent.CompilerBridge
import com.iroselle.itemerness.editor.agent.EditorAgentClient
import com.iroselle.itemerness.editor.agent.JdkWebSocketTransport
import com.iroselle.itemerness.editor.protocol.Json
import com.iroselle.itemerness.editor.protocol.JsonObject
import com.iroselle.itemerness.editor.protocol.JsonValue
import java.net.URI
import java.util.concurrent.Executor
import java.util.logging.Level
import java.util.logging.Logger

/**
 * Owns the editor connection for the lifetime of the plugin.
 *
 * Connecting, decoding, and compiling are pure computation over immutable inputs. They run through
 * Folia's async scheduler and never enter an entity, region, or global tick context. Preview does
 * not persist or publish an artifact.
 *
 * Disable only tears down. No reconnect is scheduled once `stop` has been called.
 */
internal class EditorAgentService(
    override val endpoint: EditorEndpoint,
    private val serverId: String,
    private val agentVersion: String,
    private val minecraftVersion: String,
    private val platform: String,
    private val logger: Logger,
    scheduler: AgentScheduler,
    worker: Executor,
    transportExecutor: Executor,
) : EditorAgentHandle {
    private val bridge = CompilerBridge(BundledBuiltinFontMetrics, agentVersion)

    private val client =
        EditorAgentClient(
            serverId = serverId,
            transports = JdkWebSocketTransport.factory(agentEndpoint(), endpoint.token, transportExecutor),
            handler = ::handle,
            helloPayload = ::capabilities,
            scheduler = scheduler,
            worker = worker,
            log = { level, message, failure ->
                logger.log(
                    when (level) {
                        EditorAgentClient.Level.INFO -> Level.INFO
                        EditorAgentClient.Level.WARN -> Level.WARNING
                        EditorAgentClient.Level.ERROR -> Level.SEVERE
                    },
                    message,
                    failure,
                )
            },
        )

    val state: EditorAgentClient.State get() = client.currentState

    override fun start() {
        logger.info("Connecting to the editor control plane at ${endpoint.url}")
        client.start()
    }

    override fun stop() {
        client.stop("plugin disable")
    }

    /**
     * Derives the agent socket from the single configured URL.
     *
     * The operator supplies one HTTPS base and nothing else; making them also configure a path and
     * a scheme would be three chances to get a deployment wrong for no benefit.
     */
    private fun agentEndpoint(): URI {
        val base = endpoint.url.trimEnd('/')
        val socket = when {
            base.startsWith("https://") -> "wss://" + base.removePrefix("https://")
            base.startsWith("http://") -> "ws://" + base.removePrefix("http://")
            else -> base
        }
        return URI.create("$socket/api/v1/agent")
    }

    private fun capabilities(): JsonValue =
        JsonValue.Obj(
            linkedMapOf(
                "schemaVersion" to JsonValue.Num(1.0),
                "agentVersion" to JsonValue.Text(agentVersion),
                "pluginVersion" to JsonValue.Text(agentVersion),
                "minecraftVersion" to JsonValue.Text(minecraftVersion),
                "javaVersion" to JsonValue.Text(Runtime.version().toString()),
                "platform" to JsonValue.Text(platform),
                "compilerDigest" to JsonValue.Text(bridge.compilerDigest()),
                "supportedMethods" to JsonValue.Arr(
                    com.iroselle.itemerness.editor.protocol.AgentEnvelope.SUPPORTED_METHODS
                        .sorted()
                        .map(JsonValue::Text),
                ),
                // Preview and validation never create a deployable artifact. A future publish
                // transaction will own persistence and expose its digest here.
                "activeArtifactDigest" to JsonValue.Null,
            ),
        )

    private fun handle(method: String, payload: JsonValue): JsonValue? =
        when (method) {
            "preview.compile" -> compile(payload)
            else -> null
        }

    private fun compile(payload: JsonValue): JsonValue {
        val request = JsonObject.of(payload, "preview")
        val documentJson = Json.canonicalize(request.raw("document") ?: JsonValue.Obj(emptyMap()))
        val viewer = request.optionalObject("viewer")

        val outcome =
            bridge.compilePreview(
                documentJson,
                CompilerBridge.PreviewContext(
                    itemId = request.requiredString("itemId"),
                    locale = viewer?.optionalString("locale") ?: "en_us",
                    requestedTheme = viewer?.optionalString("requestedTheme"),
                    assetProfile = viewer?.optionalString("assetProfile"),
                    capabilities = viewer?.optionalStrings("capabilities").orEmpty(),
                    metricsRevision = viewer?.optionalString("metricsRevision"),
                    resourcePackLoaded = viewer?.optionalBoolean("resourcePackLoaded", false) ?: false,
                    managesVanillaTooltipLines = viewer?.optionalBoolean("managesVanillaTooltipLines", false) ?: false,
                    snapshotHash = request.optionalString("snapshotHash") ?: "",
                ),
            )

        val json = when (outcome) {
            is CompilerBridge.Outcome.Rendered -> outcome.json
            is CompilerBridge.Outcome.Rejected -> outcome.json
        }
        return Json.parse(json)
    }

}
