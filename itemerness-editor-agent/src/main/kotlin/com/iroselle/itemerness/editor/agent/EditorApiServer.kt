package com.iroselle.itemerness.editor.agent

import com.iroselle.itemerness.editor.protocol.Json
import com.iroselle.itemerness.editor.protocol.JsonException
import com.iroselle.itemerness.editor.protocol.JsonObject
import com.iroselle.itemerness.editor.protocol.JsonValue
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
) : AutoCloseable {
    data class Metadata(
        val serverId: String,
        val pluginVersion: String,
        val minecraftVersion: String,
        val platform: String,
        val compilerDigest: String,
    )

    private val authorization = token.takeIf(String::isNotEmpty)?.let { "Bearer $it".toByteArray(Charsets.UTF_8) }
    private val origins = allowedOrigins.toSet()
    private val slots = Semaphore(8)
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
                "/api/v2/document" -> when (exchange.requestMethod) {
                    "GET" -> {
                        val snapshot = drafts.read() ?: return error(exchange, 404, "DRAFT_NOT_FOUND")
                        respond(exchange, 200, snapshot.json())
                    }
                    "PUT" -> {
                        val body = JsonObject.of(body(exchange), "save").rejectUnknown("document", "expectedHash")
                        val document = body.raw("document") ?: throw JsonException("Missing document")
                        val saved = drafts.save(document, body.requiredString("expectedHash"))
                        respond(exchange, 200, obj(
                            "snapshotHash" to text(saved.snapshotHash),
                            "revision" to JsonValue.Num(saved.revision.toDouble()),
                            "diagnostics" to JsonValue.Arr(emptyList()),
                        ))
                    }
                    else -> error(exchange, 405, "METHOD_NOT_ALLOWED")
                }
                "/api/v2/preview" -> {
                    if (exchange.requestMethod != "POST") return error(exchange, 405, "METHOD_NOT_ALLOWED")
                    if (metadata.minecraftVersion != "26.1.2") return error(exchange, 422, "PREVIEW_VERSION_UNSUPPORTED")
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
        "pluginVersion" to text(metadata.pluginVersion),
        "minecraftVersion" to text(metadata.minecraftVersion),
        "platform" to text(metadata.platform),
        "compilerDigest" to text(metadata.compilerDigest),
        "protocols" to JsonValue.Arr(listOf(obj(
            "major" to JsonValue.Num(2.0), "minMinor" to JsonValue.Num(0.0), "maxMinor" to JsonValue.Num(0.0),
        ))),
        "documentSchemas" to JsonValue.Arr(listOf(JsonValue.Num(1.0))),
        "previewSchemas" to JsonValue.Arr(listOf(JsonValue.Num(1.0))),
        "capabilities" to JsonValue.Arr((listOf("draft.read", "draft.write") +
            if (metadata.minecraftVersion == "26.1.2") listOf("preview.compile") else emptyList()).map(::text)),
    )

    private fun error(exchange: HttpExchange, status: Int, code: String) = respond(exchange, status, obj("code" to text(code)))

    private fun respond(exchange: HttpExchange, status: Int, body: JsonValue) {
        val bytes = Json.canonicalize(body).toByteArray(Charsets.UTF_8)
        exchange.responseHeaders.set("Content-Type", "application/json; charset=utf-8")
        exchange.sendResponseHeaders(status, bytes.size.toLong())
        exchange.responseBody.write(bytes)
    }

    private class TooLarge : RuntimeException()

    companion object {
        const val PROTOCOL: String = "2.0"
        private fun text(value: String): JsonValue = JsonValue.Text(value)
        private fun obj(vararg values: Pair<String, JsonValue>): JsonValue = JsonValue.Obj(mapOf(*values))
    }
}
