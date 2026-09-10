package com.iroselle.itemerness.editor.agent

import com.iroselle.itemerness.editor.protocol.Json
import com.iroselle.itemerness.editor.protocol.JsonException
import com.iroselle.itemerness.editor.protocol.JsonObject
import com.iroselle.itemerness.editor.protocol.JsonValue
import com.iroselle.itemerness.editor.protocol.ProjectDocumentCodec
import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import java.net.InetSocketAddress
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.security.MessageDigest
import java.util.concurrent.Executor
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.Semaphore

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
    private val readCatalog: (() -> JsonValue)? = null,
    private val exportCatalog: ((JsonValue) -> JsonValue)? = null,
    private val serverMetadata: ServerMetadataStore? = null,
) : AutoCloseable {
    data class Metadata(
        val serverId: String,
        val pluginVersion: String,
        val minecraftVersion: String,
        val platform: String,
        val compilerDigest: String,
        val serverName: String = serverId,
        val persistentIdentity: Boolean = false,
    )

    private val authorization = token.takeIf(String::isNotEmpty)?.let { "Bearer $it".toByteArray(Charsets.UTF_8) }
    private val origins = allowedOrigins.toSet()
    private val slots = Semaphore(8)
    private val transferSlot = Semaphore(1)
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
                exchange.responseHeaders.set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Itemerness-Protocol")
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
                return respond(exchange, 200, handshake())
            }
            if (exchange.requestHeaders["X-Itemerness-Protocol"] != listOf(PROTOCOL)) {
                return error(exchange, 426, "PROTOCOL_INCOMPATIBLE")
            }
            when (path) {
                "/api/v2/server" -> {
                    if (exchange.requestMethod != "PUT") return error(exchange, 405, "METHOD_NOT_ALLOWED")
                    val store = serverMetadata ?: return error(exchange, 404, "NOT_FOUND")
                    val request = JsonObject.of(body(exchange), "server").rejectUnknown("alias", "expectedAlias", "targetServerId")
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
                    respondTransfer(exchange, read)
                }
                "/api/v2/catalog/export" -> {
                    if (exchange.requestMethod != "POST") return error(exchange, 405, "METHOD_NOT_ALLOWED")
                    val export = exportCatalog ?: return error(exchange, 404, "NOT_FOUND")
                    val request = JsonObject.of(body(exchange), "export").rejectUnknown("document", "snapshotHash", "targetServerId")
                    val target = request.optionalString("targetServerId")
                    if (target != null && target != metadata.serverId) return error(exchange, 409, "TARGET_MISMATCH")
                    val document = request.raw("document") ?: throw JsonException("Missing document")
                    if (EditorDraftStore.digest(Json.canonicalize(document)) != request.requiredString("snapshotHash")) {
                        return error(exchange, 400, "SNAPSHOT_MISMATCH")
                    }
                    respondTransfer(exchange) { export(document) }
                }
                "/api/v2/document" -> when (exchange.requestMethod) {
                    "GET" -> {
                        val snapshot = drafts.read() ?: return error(exchange, 404, "DRAFT_NOT_FOUND")
                        respond(exchange, 200, JsonValue.Obj((snapshot.json() as JsonValue.Obj).entries + ("serverId" to text(metadata.serverId))))
                    }
                    "PUT" -> {
                        val body = JsonObject.of(body(exchange), "save").rejectUnknown("document", "expectedHash", "targetServerId")
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
                    val requestValue = body(exchange)
                    val request = JsonObject.of(requestValue, "preview")
                        .rejectUnknown("document", "itemId", "viewer", "snapshotHash", "targetServerId")
                    val target = request.optionalString("targetServerId")
                    if (target != null && target != metadata.serverId) return error(exchange, 409, "TARGET_MISMATCH")
                    val document = request.raw("document") ?: throw JsonException("Missing document")
                    if (EditorDraftStore.digest(Json.canonicalize(document)) != request.requiredString("snapshotHash")) {
                        return error(exchange, 400, "SNAPSHOT_MISMATCH")
                    }
                    respond(exchange, 200, obj("artifact" to compile(requestValue), "stale" to JsonValue.Bool(false)))
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
            error(exchange, 413, "REQUEST_TOO_LARGE")
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
            deadline.cancel()
            exchange.close()
        }
    }

    private fun body(exchange: HttpExchange): JsonValue {
        if (exchange.requestHeaders.getFirst("Content-Type")?.substringBefore(';')?.trim() != "application/json") {
            throw JsonException("Expected JSON")
        }
        val bytes = exchange.requestBody.readNBytes(EditorDraftStore.MAX_BYTES + 1)
        if (bytes.size > EditorDraftStore.MAX_BYTES) throw TooLarge()
        val decoder = Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
        return Json.parse(decoder.decode(ByteBuffer.wrap(bytes)).toString())
    }

    private fun handshake(): JsonValue = obj(
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
        "capabilities" to JsonValue.Arr((listOf(
            "draft.read", "draft.write", "presentation.segmented-frame.decorations",
            "catalog.base-components.attributes-enchantments",
        ) +
            (if (metadata.persistentIdentity) listOf("server.identity.persistent") else emptyList()) +
            (if (serverMetadata != null) listOf("server.alias.write") else emptyList()) +
            (if (metadata.minecraftVersion in PREVIEW_VERSIONS) listOf("preview.compile") else emptyList()) +
            (if (readCatalog != null) listOf("catalog.read") else emptyList()) +
            (if (exportCatalog != null) listOf("catalog.export") else emptyList())).map(::text)),
    )

    private fun error(exchange: HttpExchange, status: Int, code: String) = respond(exchange, status, obj("code" to text(code), "serverId" to text(metadata.serverId)))

    private fun respondTransfer(exchange: HttpExchange, transfer: () -> JsonValue) {
        if (!transferSlot.tryAcquire()) {
            exchange.responseHeaders.set("Retry-After", "1")
            return error(exchange, 429, "CATALOG_BUSY")
        }
        try {
            val body = transfer()
            if (Json.canonicalize(body).toByteArray(Charsets.UTF_8).size > EditorDraftStore.MAX_BYTES) {
                throw CatalogTransferException("CATALOG_RESPONSE_TOO_LARGE")
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

    companion object {
        const val PROTOCOL: String = "2.0"
        private val PREVIEW_VERSIONS = setOf("1.21.11", "26.1.1", "26.1.2", "26.2")
        private fun text(value: String): JsonValue = JsonValue.Text(value)
        private fun obj(vararg values: Pair<String, JsonValue>): JsonValue = JsonValue.Obj(mapOf(*values))
    }
}
