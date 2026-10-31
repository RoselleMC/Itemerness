package com.iroselle.itemerness.editor.agent

import com.iroselle.itemerness.core.presentation.PresentationBudgets
import com.iroselle.itemerness.editor.protocol.Json
import com.iroselle.itemerness.editor.protocol.JsonException
import com.iroselle.itemerness.editor.protocol.JsonObject
import com.iroselle.itemerness.editor.protocol.JsonValue
import com.iroselle.itemerness.editor.protocol.ProjectDocumentCodec
import com.iroselle.itemerness.editor.protocol.ProjectDocumentEncoder
import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import java.net.InetSocketAddress
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.security.MessageDigest
import java.util.concurrent.Executor
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.Semaphore
import java.util.concurrent.TimeUnit

/** Inbound, preview-only plugin API. All handlers run on the supplied async executor. */
class EditorApiServer(
    private val address: InetSocketAddress,
    token: String,
    allowedOrigins: Collection<String>,
    private val metadata: Metadata,
    private val drafts: EditorDraftStore,
    private val compile: (JsonValue) -> JsonValue,
    private val worker: Executor,
    private val scheduler: AgentScheduler,
    private val onFailure: (Throwable) -> Unit,
    /** Reads local YAML as an import candidate; `true` also records each object's source file. */
    private val readCatalog: ((Boolean) -> JsonValue)? = null,
    private val exportCatalog: ((JsonValue) -> JsonValue)? = null,
    /** Fingerprints local YAML without reading it into a document, so drafts can detect a changed baseline. */
    private val catalogStatus: (() -> String)? = null,
    private val serverMetadata: ServerMetadataStore? = null,
    /** The server's current output limits; a stored draft is realigned to them when read. */
    private val budgets: () -> PresentationBudgets = { PresentationBudgets() },
    /** Transfer limits follow the server's catalog directory budget, which a reload may change. */
    private val limits: () -> EditorTransferLimits = { EditorTransferLimits() },
    /** Lists provider scenarios for one item of a draft; null when the platform offers no providers. */
    private val previewScenarios: ((JsonValue) -> JsonValue)? = null,
) : AutoCloseable {
    data class Metadata(
        val serverId: String,
        val pluginVersion: String,
        val minecraftVersion: String,
        val platform: String,
        val compilerDigest: String,
        val serverName: String = serverId,
        val persistentIdentity: Boolean = false,
        /** Data component ids registered on this server, offered to the editor as suggestions only. */
        val dataComponentTypes: List<String> = emptyList(),
    )

    private val authorization = token.takeIf(String::isNotEmpty)?.let { "Bearer $it".toByteArray(Charsets.UTF_8) }
    private val origins = allowedOrigins.toSet()
    private val slots = Semaphore(8)
    private val transferSlot = Semaphore(1)
    private val largeSlots = Semaphore(EditorTransferLimits.LARGE_MESSAGE_SLOTS)
    private var server: HttpServer? = null
    val port: Int get() = checkNotNull(server).address.port

    @Synchronized
    fun start() {
        check(server == null) { "Editor API already started" }
        val candidate = HttpServer.create(InetSocketAddress(address.hostString, address.port), 16)
        try {
            candidate.executor = Executor { task ->
                if (!slots.tryAcquire()) throw RejectedExecutionException("Editor API is busy")
                try {
                    worker.execute {
                        try { task.run() } finally { slots.release() }
                    }
                } catch (failure: RuntimeException) {
                    slots.release()
                    throw failure
                }
            }
            candidate.createContext("/", ::handle)
            candidate.start()
            server = candidate
        } catch (failure: Throwable) {
            candidate.stop(0)
            throw failure
        }
    }

    @Synchronized
    override fun close() {
        server?.stop(0)
        server = null
    }

    private fun handle(exchange: HttpExchange) {
        val deadline = scheduler.schedule(15_000, exchange::close)
        if (deadline == null) {
            exchange.close()
            return
        }
        // One snapshot per request, so a reload cannot change the limits halfway through a body.
        val transfer = limits()
        try {
            exchange.responseHeaders.set("Cache-Control", "no-store")
            exchange.responseHeaders.set("X-Content-Type-Options", "nosniff")
            val origin = exchange.requestHeaders.getFirst("Origin")
            if (origin != null) {
                if (origin !in origins) return error(exchange, 403, "ORIGIN_FORBIDDEN")
                exchange.responseHeaders.set("Access-Control-Allow-Origin", origin)
                exchange.responseHeaders.set("Vary", "Origin")
            }
            if (exchange.requestMethod == "OPTIONS") {
                if (origin == null) return error(exchange, 403, "ORIGIN_FORBIDDEN")
                exchange.responseHeaders.set("Access-Control-Allow-Methods", "GET, PUT, POST")
                exchange.responseHeaders.set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Itemerness-Protocol, $LAYOUT_HEADER")
                exchange.sendResponseHeaders(204, -1)
                return
            }
            val supplied = exchange.requestHeaders["Authorization"]
            if (authorization != null &&
                (supplied?.size != 1 || !MessageDigest.isEqual(authorization, supplied[0].toByteArray(Charsets.UTF_8)))
            ) {
                exchange.responseHeaders.set("WWW-Authenticate", "Bearer")
                return error(exchange, 401, "UNAUTHORIZED")
            }
            if (exchange.requestURI.rawQuery != null) return error(exchange, 400, "INVALID_REQUEST")
            val path = exchange.requestURI.rawPath
            if (path == "/api/handshake" && exchange.requestMethod == "GET") {
                return respond(exchange, 200, handshake(transfer))
            }
            if (exchange.requestHeaders["X-Itemerness-Protocol"] != listOf(PROTOCOL)) {
                return error(exchange, 426, "PROTOCOL_INCOMPATIBLE")
            }
            when (path) {
                "/api/v2/server" -> {
                    if (exchange.requestMethod != "PUT") return error(exchange, 405, "METHOD_NOT_ALLOWED")
                    val store = serverMetadata ?: return error(exchange, 404, "NOT_FOUND")
                    val request = JsonObject.of(body(exchange, transfer), "server").rejectUnknown("alias", "expectedAlias", "targetServerId")
                    if (request.requiredString("targetServerId") != metadata.serverId) return error(exchange, 409, "TARGET_MISMATCH")
                    val alias = request.requiredString("alias")
                    try { ServerMetadataStore.validate(alias) } catch (_: IllegalArgumentException) {
                        return error(exchange, 400, "SERVER_ALIAS_INVALID")
                    }
                    val saved = store.update(alias, request.requiredString("expectedAlias"))
                    respond(exchange, 200, obj("serverId" to text(metadata.serverId), "serverAlias" to text(saved)))
                }
                "/api/v2/catalog" -> {
                    if (exchange.requestMethod != "GET") return error(exchange, 405, "METHOD_NOT_ALLOWED")
                    val read = readCatalog ?: return error(exchange, 404, "NOT_FOUND")
                    // Only clients that ask for it receive the additive sourceLayout field.
                    val layout = exchange.requestHeaders[LAYOUT_HEADER] == listOf("1")
                    respondTransfer(exchange, transfer) { read(layout) }
                }
                "/api/v2/catalog/status" -> {
                    if (exchange.requestMethod != "GET") return error(exchange, 405, "METHOD_NOT_ALLOWED")
                    val status = catalogStatus ?: return error(exchange, 404, "NOT_FOUND")
                    respondTransfer(exchange, transfer) { obj("serverId" to text(metadata.serverId), "sourceHash" to text(status())) }
                }
                "/api/v2/catalog/export" -> {
                    if (exchange.requestMethod != "POST") return error(exchange, 405, "METHOD_NOT_ALLOWED")
                    val export = exportCatalog ?: return error(exchange, 404, "NOT_FOUND")
                    val request = JsonObject.of(body(exchange, transfer), "export").rejectUnknown("document", "snapshotHash", "targetServerId")
                    val target = request.optionalString("targetServerId")
                    if (target != null && target != metadata.serverId) return error(exchange, 409, "TARGET_MISMATCH")
                    val document = request.raw("document") ?: throw JsonException("Missing document")
                    if (EditorDraftStore.digest(Json.canonicalize(document)) != request.requiredString("snapshotHash")) {
                        return error(exchange, 400, "SNAPSHOT_MISMATCH")
                    }
                    respondTransfer(exchange, transfer) { export(document) }
                }
                "/api/v2/document" -> when (exchange.requestMethod) {
                    "GET" -> {
                        val snapshot = drafts.alignBudgets(ProjectDocumentEncoder.budgetsJson(budgets()), DEFAULT_BUDGETS)
                            ?: return error(exchange, 404, "DRAFT_NOT_FOUND")
                        respond(exchange, 200, JsonValue.Obj((snapshot.json() as JsonValue.Obj).entries + ("serverId" to text(metadata.serverId))))
                    }
                    "PUT" -> {
                        val body = JsonObject.of(body(exchange, transfer), "save").rejectUnknown("document", "expectedHash", "targetServerId")
                        val target = body.optionalString("targetServerId")
                        if (target != null && target != metadata.serverId) return error(exchange, 409, "TARGET_MISMATCH")
                        val document = body.raw("document") ?: throw JsonException("Missing document")
                        val saved = drafts.save(document, body.requiredString("expectedHash"))
                        respond(exchange, 200, obj(
                            "serverId" to text(metadata.serverId),
                            "snapshotHash" to text(saved.snapshotHash),
                            "revision" to JsonValue.Num(saved.revision.toDouble()),
                            "diagnostics" to JsonValue.Arr(emptyList()),
                        ))
                    }
                    else -> error(exchange, 405, "METHOD_NOT_ALLOWED")
                }
                "/api/v2/preview" -> {
                    if (exchange.requestMethod != "POST") return error(exchange, 405, "METHOD_NOT_ALLOWED")
                    if (metadata.minecraftVersion !in PREVIEW_VERSIONS) return error(exchange, 422, "PREVIEW_VERSION_UNSUPPORTED")
                    val requestValue = body(exchange, transfer)
                    val request = JsonObject.of(requestValue, "preview")
                        .rejectUnknown("document", "itemId", "viewer", "snapshotHash", "targetServerId", "scenario")
                    if (request.raw("scenario") != null && previewScenarios == null) return error(exchange, 422, "PREVIEW_PROVIDERS_UNSUPPORTED")
                    val target = request.optionalString("targetServerId")
                    if (target != null && target != metadata.serverId) return error(exchange, 409, "TARGET_MISMATCH")
                    val document = request.raw("document") ?: throw JsonException("Missing document")
                    if (EditorDraftStore.digest(Json.canonicalize(document)) != request.requiredString("snapshotHash")) {
                        return error(exchange, 400, "SNAPSHOT_MISMATCH")
                    }
                    respond(exchange, 200, obj("artifact" to compile(requestValue), "stale" to JsonValue.Bool(false)))
                }
                "/api/v2/preview/scenarios" -> {
                    if (exchange.requestMethod != "POST") return error(exchange, 405, "METHOD_NOT_ALLOWED")
                    val list = previewScenarios ?: return error(exchange, 404, "NOT_FOUND")
                    if (metadata.minecraftVersion !in PREVIEW_VERSIONS) return error(exchange, 422, "PREVIEW_VERSION_UNSUPPORTED")
                    val requestValue = body(exchange, transfer)
                    val request = JsonObject.of(requestValue, "scenarios")
                        .rejectUnknown("document", "itemId", "locale", "snapshotHash", "targetServerId")
                    val target = request.optionalString("targetServerId")
                    if (target != null && target != metadata.serverId) return error(exchange, 409, "TARGET_MISMATCH")
                    if (request.raw("document") == null) throw JsonException("Missing document")
                    respond(exchange, 200, list(requestValue))
                }
                else -> error(exchange, 404, "NOT_FOUND")
            }
        } catch (_: ServerMetadataStore.Conflict) {
            error(exchange, 409, "SERVER_ALIAS_CONFLICT")
        } catch (failure: CatalogTransferException) {
            respond(exchange, 422, obj("code" to text(failure.code), "diagnostics" to JsonValue.Arr(failure.diagnostics)))
        } catch (conflict: EditorDraftStore.Conflict) {
            respond(exchange, 409, obj("code" to text("DRAFT_CONFLICT"), "actualHash" to text(conflict.actualHash)))
        } catch (_: TooLarge) {
            respond(exchange, 413, obj("code" to text("REQUEST_TOO_LARGE"), "serverId" to text(metadata.serverId),
                "limitBytes" to JsonValue.Num(transfer.messageBytes.toDouble())))
        } catch (failure: EditorTransferLimits.DocumentTooLarge) {
            respond(exchange, 413, obj("code" to text("DOCUMENT_TOO_LARGE"), "serverId" to text(metadata.serverId),
                "actualBytes" to JsonValue.Num(failure.actualBytes.toDouble()), "limitBytes" to JsonValue.Num(failure.limitBytes.toDouble())))
        } catch (_: Busy) {
            exchange.responseHeaders.set("Retry-After", "1")
            error(exchange, 429, "EDITOR_BUSY")
        } catch (_: JsonException) {
            error(exchange, 400, "INVALID_DOCUMENT")
        } catch (_: java.nio.charset.CharacterCodingException) {
            error(exchange, 400, "INVALID_UTF8")
        } catch (_: IllegalArgumentException) {
            error(exchange, 400, "INVALID_REQUEST")
        } catch (failure: Exception) {
            // Do not log request bodies or authentication headers.
            onFailure(failure)
            runCatching { error(exchange, 500, "INTERNAL_ERROR") }
        } finally {
            (exchange.getAttribute(LARGE_PERMITS) as? Int)?.let(largeSlots::release)
            deadline.cancel()
            exchange.close()
        }
    }

    private fun body(exchange: HttpExchange, transfer: EditorTransferLimits): JsonValue {
        if (exchange.requestHeaders.getFirst("Content-Type")?.substringBefore(';')?.trim() != "application/json") {
            throw JsonException("Expected JSON")
        }
        val head = exchange.requestBody.readNBytes(EditorTransferLimits.SMALL_MESSAGE_BYTES + 1)
        val bytes = if (head.size <= EditorTransferLimits.SMALL_MESSAGE_BYTES) head else {
            // The slot is held until the handler finishes, because the decoded tree lives that long.
            val permits = transfer.largeMessagePermits
            if (!largeSlots.tryAcquire(permits, EditorTransferLimits.LARGE_MESSAGE_WAIT_MILLIS, TimeUnit.MILLISECONDS)) throw Busy()
            exchange.setAttribute(LARGE_PERMITS, permits)
            head + exchange.requestBody.readNBytes(transfer.messageBytes + 1 - head.size)
        }
        if (bytes.size > transfer.messageBytes) throw TooLarge()
        val decoder = Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
        return Json.parse(decoder.decode(ByteBuffer.wrap(bytes)).toString())
    }

    private fun handshake(transfer: EditorTransferLimits): JsonValue = obj(
        "product" to text("itemerness"),
        "authentication" to text(if (authorization == null) "none" else "bearer"),
        "serverId" to text(metadata.serverId),
        "serverName" to text(metadata.serverName),
        "serverAlias" to text(serverMetadata?.alias() ?: ""),
        "pluginVersion" to text(metadata.pluginVersion),
        "minecraftVersion" to text(metadata.minecraftVersion),
        "platform" to text(metadata.platform),
        "compilerDigest" to text(metadata.compilerDigest),
        "protocols" to JsonValue.Arr(listOf(obj(
            "major" to JsonValue.Num(2.0), "minMinor" to JsonValue.Num(0.0), "maxMinor" to JsonValue.Num(0.0),
        ))),
        "documentSchemas" to JsonValue.Arr(
            ProjectDocumentCodec.SUPPORTED_SCHEMA_VERSIONS.map {
                JsonValue.Num(it.toDouble())
            },
        ),
        "previewSchemas" to JsonValue.Arr(listOf(JsonValue.Num(1.0))),
        "limits" to transfer.json(),
        "capabilities" to JsonValue.Arr((listOf(
            "draft.read", "draft.write", "presentation.segmented-frame.decorations",
            "catalog.base-components.attributes-enchantments", "catalog.data-keys.field-constraints",
            "catalog.data-schemas.owner", "presentation.theme-selectors", "assets.resource-pack-bindings.delivery",
            "presentation.shown-flags", "presentation.groups", "presentation.composition", "presentation.hiding",
            "transfer.limits",
        ) +
            (if (metadata.persistentIdentity) listOf("server.identity.persistent") else emptyList()) +
            (if (serverMetadata != null) listOf("server.alias.write") else emptyList()) +
            (if (metadata.minecraftVersion in PREVIEW_VERSIONS) listOf("preview.compile") else emptyList()) +
            (if (previewScenarios != null && metadata.minecraftVersion in PREVIEW_VERSIONS) listOf("preview.providers") else emptyList()) +
            (if (readCatalog != null) listOf("catalog.read") else emptyList()) +
            (if (exportCatalog != null) listOf("catalog.export") else emptyList()) +
            (if (catalogStatus != null) listOf("catalog.status") else emptyList()) +
            (if (readCatalog != null && exportCatalog != null) listOf("catalog.source-layout") else emptyList())).map(::text)),
        *listOfNotNull(
            metadata.dataComponentTypes.takeIf { it.isNotEmpty() }?.let { types ->
                "dataComponentTypes" to JsonValue.Arr(types.sorted().map(::text))
            },
        ).toTypedArray(),
    )

    private fun error(exchange: HttpExchange, status: Int, code: String) = respond(exchange, status, obj("code" to text(code), "serverId" to text(metadata.serverId)))

    private fun respondTransfer(exchange: HttpExchange, limits: EditorTransferLimits, transfer: () -> JsonValue) {
        if (!transferSlot.tryAcquire()) {
            exchange.responseHeaders.set("Retry-After", "1")
            return error(exchange, 429, "CATALOG_BUSY")
        }
        try {
            val body = transfer()
            val bytes = Json.canonicalize(body).toByteArray(Charsets.UTF_8).size
            if (bytes > limits.messageBytes) {
                throw CatalogTransferException("CATALOG_RESPONSE_TOO_LARGE", listOf(EditorTransferLimits.diagnostic(
                    "CATALOG.RESPONSE_TOO_LARGE", "diagnostics.catalog.response_too_large", bytes, limits.messageBytes)))
            }
            respond(exchange, 200, body)
        } finally {
            transferSlot.release()
        }
    }

    private fun respond(exchange: HttpExchange, status: Int, body: JsonValue) {
        val bytes = Json.canonicalize(body).toByteArray(Charsets.UTF_8)
        exchange.responseHeaders.set("Content-Type", "application/json; charset=utf-8")
        exchange.sendResponseHeaders(status, bytes.size.toLong())
        exchange.responseBody.write(bytes)
    }

    private class TooLarge : RuntimeException()
    private class Busy : RuntimeException()

    companion object {
        const val PROTOCOL: String = "2.0"
        const val LAYOUT_HEADER: String = "X-Itemerness-Catalog-Layout"
        private const val LARGE_PERMITS = "itemerness.large-permits"
        private val PREVIEW_VERSIONS = setOf("1.21.11", "26.1.1", "26.1.2", "26.2", "26.3")
        /** What a document without a `budgets` object decodes to. */
        private val DEFAULT_BUDGETS = ProjectDocumentEncoder.budgetsJson(PresentationBudgets())
        private fun text(value: String): JsonValue = JsonValue.Text(value)
        private fun obj(vararg values: Pair<String, JsonValue>): JsonValue = JsonValue.Obj(mapOf(*values))
    }
}
