package com.iroselle.itemerness.editor.agent

import com.iroselle.itemerness.core.presentation.PresentationBudgets
import com.iroselle.itemerness.editor.protocol.Json
import com.iroselle.itemerness.editor.protocol.JsonObject
import com.iroselle.itemerness.editor.protocol.JsonValue
import com.iroselle.itemerness.editor.protocol.ProjectDocumentEncoder
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.net.InetSocketAddress
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.file.Files
import java.nio.file.Path
import java.time.Duration
import java.util.concurrent.Executors
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class EditorApiServerTest {
    @TempDir lateinit var directory: Path
    private val token = "test-" + "a".repeat(40)
    private val document = Json.parse("""{"schemaVersion":1,"value":"draft"}""")
    private val CHUNK = 1 shl 19

    private fun fixture(version: String = "26.1.2", apiToken: String = token,
                        readCatalog: ((Boolean) -> JsonValue)? = null, exportCatalog: ((JsonValue) -> JsonValue)? = null,
                        catalogStatus: (() -> String)? = null,
                        persistentIdentity: Boolean = false,
                        budgets: PresentationBudgets = PresentationBudgets(),
                        compile: (JsonValue) -> JsonValue = { JsonValue.Text("compiled") },
                        action: (EditorApiServer, AtomicInteger) -> Unit) {
        val workers = Executors.newFixedThreadPool(8)
        val clock = Executors.newSingleThreadScheduledExecutor()
        val scheduler = object : AgentScheduler {
            override fun execute(action: () -> Unit): Boolean { workers.execute(action); return true }
            override fun schedule(delayMillis: Long, action: () -> Unit): AgentTask =
                clock.schedule(action, delayMillis, TimeUnit.MILLISECONDS).let { AgentTask { it.cancel(false) } }
            override fun repeat(initialDelayMillis: Long, periodMillis: Long, action: () -> Unit): AgentTask =
                clock.scheduleAtFixedRate(action, initialDelayMillis, periodMillis, TimeUnit.MILLISECONDS).let { AgentTask { it.cancel(false) } }
        }
        val compiles = AtomicInteger()
        val api = EditorApiServer(
            InetSocketAddress("127.0.0.1", 0), apiToken, listOf("http://127.0.0.1:5173"),
            EditorApiServer.Metadata("test", "0.1.0", version, "Folia", "sha256:" + "0".repeat(64), "Test Server", persistentIdentity),
            EditorDraftStore(directory.resolve("draft.json")) { Json.parse(it) },
            { compiles.incrementAndGet(); compile(it) }, workers, scheduler, { throw AssertionError(it) },
            readCatalog, exportCatalog, catalogStatus,
            serverMetadata = if (persistentIdentity) ServerMetadataStore(directory.resolve("server-metadata.json"), "test") else null,
            budgets = { budgets },
        )
        try { api.start(); action(api, compiles) } finally {
            api.close(); workers.shutdownNow(); clock.shutdownNow()
            workers.awaitTermination(5, TimeUnit.SECONDS)
        }
    }

    private fun request(api: EditorApiServer, path: String, method: String = "GET", body: String? = null,
                        auth: String? = token, protocol: String? = "2.0", origin: String? = null,
                        headers: Map<String, String> = emptyMap()): HttpResponse<String> {
        val builder = HttpRequest.newBuilder(URI("http://127.0.0.1:${api.port}$path")).timeout(Duration.ofSeconds(5))
        headers.forEach(builder::header)
        auth?.let { builder.header("Authorization", "Bearer $it") }
        protocol?.let { builder.header("X-Itemerness-Protocol", it) }
        origin?.let { builder.header("Origin", it) }
        body?.let { builder.header("Content-Type", "application/json") }
        builder.method(method, body?.let(HttpRequest.BodyPublishers::ofString) ?: HttpRequest.BodyPublishers.noBody())
        return HttpClient.newHttpClient().use { it.send(builder.build(), HttpResponse.BodyHandlers.ofString()) }
    }

    private fun saveBody(hash: String = "") = Json.canonicalize(JsonValue.Obj(mapOf("document" to document, "expectedHash" to JsonValue.Text(hash))))

    @Test
    fun `server alias writes are authenticated target bound and independent of drafts`() = fixture(persistentIdentity = true) { api, _ ->
        fun aliasBody(alias: String, expected: String = "", target: String = "test") = Json.canonicalize(JsonValue.Obj(mapOf(
            "alias" to JsonValue.Text(alias), "expectedAlias" to JsonValue.Text(expected), "targetServerId" to JsonValue.Text(target),
        )))
        assertEquals(401, request(api, "/api/v2/server", "PUT", aliasBody("Preview"), auth = null).statusCode())
        assertEquals(426, request(api, "/api/v2/server", "PUT", aliasBody("Preview"), protocol = null).statusCode())
        assertEquals(403, request(api, "/api/v2/server", "PUT", aliasBody("Preview"), origin = "https://evil.example").statusCode())
        assertEquals(409, request(api, "/api/v2/server", "PUT", aliasBody("Preview", target = "other")).statusCode())
        assertEquals(400, request(api, "/api/v2/server", "PUT", aliasBody("x".repeat(81))).statusCode())
        assertEquals(200, request(api, "/api/v2/server", "PUT", aliasBody("Preview")).statusCode())
        val stale = request(api, "/api/v2/server", "PUT", aliasBody("Overwrite"))
        assertEquals(409, stale.statusCode())
        assertTrue(stale.body().contains("SERVER_ALIAS_CONFLICT"))
        val handshake = JsonObject.of(Json.parse(request(api, "/api/handshake").body()), "handshake")
        assertEquals("Preview", handshake.requiredString("serverAlias"))
        assertFalse(Files.exists(directory.resolve("draft.json")))
    }

    @Test
    fun `persistent identity is advertised and mismatched saves cannot touch the draft`() = fixture(persistentIdentity = true) { api, _ ->
        val handshake = JsonObject.of(Json.parse(request(api, "/api/handshake").body()), "handshake")
        assertEquals("Test Server", handshake.requiredString("serverName"))
        assertTrue(JsonValue.Text("server.identity.persistent") in handshake.requiredArray("capabilities"))
        val mismatched = Json.canonicalize(JsonValue.Obj(mapOf(
            "document" to document, "expectedHash" to JsonValue.Text(""), "targetServerId" to JsonValue.Text("another-server"),
        )))
        val response = request(api, "/api/v2/document", "PUT", mismatched)
        assertEquals(409, response.statusCode())
        assertTrue(response.body().contains("TARGET_MISMATCH"))
        assertFalse(Files.exists(directory.resolve("draft.json")))
        val saved = JsonObject.of(Json.parse(request(api, "/api/v2/document", "PUT", saveBody()).body()), "save")
        assertEquals("test", saved.requiredString("serverId"))
        val loaded = JsonObject.of(Json.parse(request(api, "/api/v2/document").body()), "load")
        assertEquals("test", loaded.requiredString("serverId"))
    }

    @Test
    fun `handshake authenticates and mutations require negotiated protocol`() = fixture { api, _ ->
        assertEquals(401, request(api, "/api/handshake", auth = null).statusCode())
        assertEquals(401, request(api, "/api/handshake", auth = "").statusCode())
        assertEquals(401, request(api, "/api/handshake", auth = "wrong").statusCode())
        val handshake = request(api, "/api/handshake", protocol = null)
        assertEquals(200, handshake.statusCode())
        assertTrue(handshake.body().contains("draft.write"))
        assertFalse(handshake.body().contains(token))
        assertEquals("bearer", JsonObject.of(Json.parse(handshake.body()), "handshake").requiredString("authentication"))
        for (version in listOf(null, "1.0", "2.1", "3.0")) {
            assertEquals(426, request(api, "/api/v2/document", "PUT", saveBody(), protocol = version).statusCode())
        }
        assertFalse(Files.exists(directory.resolve("draft.json")))
    }

    @Test
    fun `segmented frame document capability is advertised independently of preview ABI`() {
        for (version in listOf("1.21.11", "26.1.1", "26.1.2", "26.2", "26.3")) {
            fixture(version) { api, _ ->
                val handshake = JsonObject.of(Json.parse(request(api, "/api/handshake").body()), "handshake")
                assertTrue(
                    JsonValue.Text("presentation.segmented-frame.decorations") in handshake.requiredArray("capabilities"),
                    version,
                )
                assertTrue(
                    JsonValue.Text("catalog.base-components.attributes-enchantments") in handshake.requiredArray("capabilities"),
                    version,
                )
                assertTrue(
                    JsonValue.Text("catalog.data-keys.field-constraints") in handshake.requiredArray("capabilities"),
                    version,
                )
                assertTrue(
                    JsonValue.Text("catalog.data-schemas.owner") in handshake.requiredArray("capabilities"),
                    version,
                )
                assertTrue(
                    JsonValue.Text("presentation.theme-selectors") in handshake.requiredArray("capabilities"),
                    version,
                )
                assertTrue(
                    JsonValue.Text("assets.resource-pack-bindings.delivery") in handshake.requiredArray("capabilities"),
                    version,
                )
                assertTrue(
                    JsonValue.Text("presentation.shown-flags") in handshake.requiredArray("capabilities"),
                    version,
                )
                assertTrue(
                    JsonValue.Text("presentation.groups") in handshake.requiredArray("capabilities"),
                    version,
                )
                // Suggestions are optional and omitted when the server provides none.
                assertFalse(handshake.contains("dataComponentTypes"), version)
            }
        }
    }

    @Test
    fun `handshake advertises server data component ids as sorted suggestions`() {
        val workers = Executors.newFixedThreadPool(2)
        val scheduler = object : AgentScheduler {
            override fun execute(action: () -> Unit): Boolean { workers.execute(action); return true }
            override fun schedule(delayMillis: Long, action: () -> Unit): AgentTask = AgentTask {}
            override fun repeat(initialDelayMillis: Long, periodMillis: Long, action: () -> Unit): AgentTask = AgentTask {}
        }
        val api = EditorApiServer(
            InetSocketAddress("127.0.0.1", 0), token, listOf("http://127.0.0.1:5173"),
            EditorApiServer.Metadata(
                "test", "0.1.0", "26.1.2", "Folia", "sha256:" + "0".repeat(64),
                dataComponentTypes = listOf("minecraft:unbreakable", "minecraft:enchantments"),
            ),
            EditorDraftStore(directory.resolve("draft.json")) { Json.parse(it) },
            { JsonValue.Text("compiled") }, workers, scheduler, { throw AssertionError(it) },
        )
        try {
            api.start()
            val handshake = JsonObject.of(Json.parse(request(api, "/api/handshake").body()), "handshake")
            assertEquals(listOf("minecraft:enchantments", "minecraft:unbreakable"), handshake.requiredStrings("dataComponentTypes"))
        } finally {
            api.close()
            workers.shutdownNow()
            workers.awaitTermination(5, TimeUnit.SECONDS)
        }
    }

    @Test
    fun `origin allowlist preflight and route restrictions apply before mutations`() = fixture { api, _ ->
        assertEquals(403, request(api, "/api/v2/document", "PUT", saveBody(), origin = "https://evil.example").statusCode())
        val preflight = request(api, "/api/v2/document", "OPTIONS", auth = null, origin = "http://127.0.0.1:5173")
        assertEquals(204, preflight.statusCode())
        assertEquals("http://127.0.0.1:5173", preflight.headers().firstValue("Access-Control-Allow-Origin").orElseThrow())
        assertEquals(404, request(api, "/api/v2/console").statusCode())
        assertEquals(400, request(api, "/api/handshake?token=secret").statusCode())
        assertEquals(405, request(api, "/api/v2/document", "DELETE").statusCode())
    }

    @Test
    fun `draft writes persist and reject stale hashes without losing the winner`() = fixture { api, _ ->
        assertEquals(404, request(api, "/api/v2/document").statusCode())
        assertEquals(200, request(api, "/api/v2/document", "PUT", saveBody()).statusCode())
        val hash = EditorDraftStore.digest(Json.canonicalize(document))
        val stale = request(api, "/api/v2/document", "PUT", saveBody())
        assertEquals(409, stale.statusCode())
        assertTrue(stale.body().contains(hash))
        assertEquals(200, request(api, "/api/v2/document", "PUT", saveBody(hash)).statusCode())
        val stored = EditorDraftStore(directory.resolve("draft.json")) { Json.parse(it) }.read()!!
        assertEquals(hash, stored.snapshotHash)
        assertEquals(1, stored.revision)
        assertEquals(document, stored.document)
    }

    @Test
    fun `a draft saved under other limits is realigned to the server's limits when read`() {
        fixture { api, _ -> assertEquals(200, request(api, "/api/v2/document", "PUT", saveBody()).statusCode()) }
        val raised = PresentationBudgets(maximumHeightPixels = 320)
        fixture(budgets = raised) { api, _ ->
            val body = request(api, "/api/v2/document").body()
            val first = JsonObject.parse(body, "draft")
            val aligned = first.requiredObject("document")
            assertEquals(ProjectDocumentEncoder.budgetsJson(raised), aligned.raw("budgets"))
            assertEquals("draft", aligned.requiredString("value"))
            assertEquals(2, first.requiredInt("revision"))
            // Already aligned: further reads change nothing.
            assertEquals(body, request(api, "/api/v2/document").body())
        }
        // Default limits leave a draft without a budgets object untouched.
        Files.delete(directory.resolve("draft.json"))
        fixture { api, _ ->
            assertEquals(200, request(api, "/api/v2/document", "PUT", saveBody()).statusCode())
            val read = JsonObject.parse(request(api, "/api/v2/document").body(), "draft")
            assertEquals(1, read.requiredInt("revision"))
            assertEquals(document, read.raw("document"))
        }
    }

    @Test
    fun `corrupt drafts fail rather than resetting their content`() {
        Files.writeString(directory.resolve("draft.json"), "{}")
        assertThrows(RuntimeException::class.java) { EditorDraftStore(directory.resolve("draft.json")) {}.read() }
        assertEquals("{}", Files.readString(directory.resolve("draft.json")))
    }

    @Test
    fun `oversized and malformed bodies are bounded and never saved`() = fixture { api, _ ->
        assertEquals(413, request(api, "/api/v2/document", "PUT", "x".repeat(EditorTransferLimits.MESSAGE_BYTES + 1)).statusCode())
        assertEquals(400, request(api, "/api/v2/document", "PUT", "{").statusCode())
        assertFalse(Files.exists(directory.resolve("draft.json")))
    }

    /** A schema-free document whose canonical form has exactly [bytes] UTF-8 bytes. */
    private fun sized(bytes: Int): JsonValue {
        fun build(payload: Int) = JsonValue.Obj(mapOf("schemaVersion" to JsonValue.Num(1.0), "value" to JsonValue.Arr(
            (0 until payload step CHUNK).map { JsonValue.Text("x".repeat(minOf(CHUNK, payload - it))) })))
        fun size(value: JsonValue) = Json.canonicalize(value).toByteArray(Charsets.UTF_8).size
        var payload = bytes
        repeat(4) { payload += bytes - size(build(payload)) }
        return build(payload).also { check(size(it) == bytes) }
    }

    @Test
    fun `the handshake advertises the transfer limits both peers apply`() = fixture { api, _ ->
        val handshake = JsonObject.of(Json.parse(request(api, "/api/handshake").body()), "handshake")
        assertTrue(JsonValue.Text("transfer.limits") in handshake.requiredArray("capabilities"))
        val limits = handshake.requiredObject("limits")
        assertEquals(EditorTransferLimits.DOCUMENT_BYTES, limits.requiredInt("documentBytes"))
        assertEquals(EditorTransferLimits.MESSAGE_BYTES, limits.requiredInt("requestBytes"))
        assertEquals(EditorTransferLimits.MESSAGE_BYTES, limits.requiredInt("responseBytes"))
    }

    @Test
    fun `documents above the old two mebibyte limit save and read back unchanged`() = fixture { api, _ ->
        val large = sized(3_400_000)
        val body = Json.canonicalize(JsonValue.Obj(mapOf("document" to large, "expectedHash" to JsonValue.Text(""))))
        val saved = request(api, "/api/v2/document", "PUT", body)
        assertEquals(200, saved.statusCode(), saved.body())
        val loaded = JsonObject.of(Json.parse(request(api, "/api/v2/document").body()), "load")
        assertEquals(large, loaded.raw("document"))
    }

    @Test
    fun `a document above the limit is refused with its size and the saved draft is kept`() = fixture { api, _ ->
        val first = JsonObject.of(Json.parse(request(api, "/api/v2/document", "PUT", saveBody()).body()), "save")
        val oversized = sized(EditorTransferLimits.DOCUMENT_BYTES + 1)
        val body = Json.canonicalize(JsonValue.Obj(mapOf("document" to oversized, "expectedHash" to JsonValue.Text(first.requiredString("snapshotHash")))))
        val response = request(api, "/api/v2/document", "PUT", body)
        assertEquals(413, response.statusCode())
        val refusal = JsonObject.parse(response.body(), "refusal")
        assertEquals("DOCUMENT_TOO_LARGE", refusal.requiredString("code"))
        assertEquals(EditorTransferLimits.DOCUMENT_BYTES + 1, refusal.requiredInt("actualBytes"))
        assertEquals(EditorTransferLimits.DOCUMENT_BYTES, refusal.requiredInt("limitBytes"))
        assertEquals(document, JsonObject.of(Json.parse(request(api, "/api/v2/document").body()), "load").raw("document"))
    }

    @Test
    fun `concurrent large requests queue for a bounded number of slots`() {
        val release = CountDownLatch(1)
        val running = AtomicInteger()
        val peak = AtomicInteger()
        fixture(compile = {
            peak.accumulateAndGet(running.incrementAndGet(), ::maxOf)
            release.await(10, TimeUnit.SECONDS)
            running.decrementAndGet()
            JsonValue.Text("compiled")
        }) { api, compiles ->
            val large = sized(2_500_000)
            val body = Json.canonicalize(JsonValue.Obj(mapOf("document" to large,
                "snapshotHash" to JsonValue.Text(EditorDraftStore.digest(Json.canonicalize(large))))))
            val requests = (1..EditorTransferLimits.LARGE_MESSAGE_SLOTS + 1).map {
                CompletableFuture.supplyAsync { request(api, "/api/v2/preview", "POST", body).statusCode() }
            }
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(3)
            while (compiles.get() < EditorTransferLimits.LARGE_MESSAGE_SLOTS && System.nanoTime() < deadline) Thread.sleep(20)
            Thread.sleep(300)
            assertEquals(EditorTransferLimits.LARGE_MESSAGE_SLOTS, compiles.get(), "the next large request waits for a slot")
            release.countDown()
            assertEquals(List(requests.size) { 200 }, requests.map { it.get(10, TimeUnit.SECONDS) })
            assertEquals(EditorTransferLimits.LARGE_MESSAGE_SLOTS, peak.get())
        }
    }

    @Test
    fun `preview compiles the exact embedded snapshot and never saves it`() = fixture { api, count ->
        val payload = JsonValue.Obj(mapOf("document" to document, "snapshotHash" to JsonValue.Text(EditorDraftStore.digest(Json.canonicalize(document)))))
        assertEquals(200, request(api, "/api/v2/preview", "POST", Json.canonicalize(payload)).statusCode())
        assertEquals(1, count.get())
        assertFalse(Files.exists(directory.resolve("draft.json")))
        assertEquals(400, request(api, "/api/v2/preview", "POST", """{"document":{},"snapshotHash":"wrong"}""").statusCode())
        assertEquals(1, count.get())
    }

    @Test
    fun `unsupported preview versions are not advertised or compiled`() = fixture("1.21.10") { api, count ->
        assertFalse(request(api, "/api/handshake").body().contains("preview.compile"))
        assertEquals(422, request(api, "/api/v2/preview", "POST", "{}").statusCode())
        assertEquals(0, count.get())
    }

    @Test
    fun `every supported version can import its first draft and preview without implicit writes`() {
        for (version in listOf("1.21.11", "26.1.1", "26.1.2", "26.2", "26.3")) {
            fixture(version, readCatalog = { _ -> document }, exportCatalog = { it }) { api, count ->
                val capabilities = JsonObject.parse(request(api, "/api/handshake").body(), "handshake").requiredArray("capabilities")
                for (capability in listOf("catalog.read", "catalog.export", "preview.compile")) {
                    assertTrue(JsonValue.Text(capability) in capabilities, "$version: $capability")
                }
                assertEquals(404, request(api, "/api/v2/document").statusCode())
                assertEquals(document, Json.parse(request(api, "/api/v2/catalog").body()))
                assertFalse(Files.exists(directory.resolve("draft.json")))
                assertEquals(200, request(api, "/api/v2/document", "PUT", saveBody()).statusCode())
                val saved = request(api, "/api/v2/document").body()
                val payload = Json.canonicalize(JsonValue.Obj(mapOf("document" to document,
                    "snapshotHash" to JsonValue.Text(EditorDraftStore.digest(Json.canonicalize(document))))))
                assertEquals(200, request(api, "/api/v2/preview", "POST", payload).statusCode())
                assertEquals(1, count.get())
                assertEquals(200, request(api, "/api/v2/catalog/export", "POST", payload).statusCode())
                assertEquals(saved, request(api, "/api/v2/document").body())
            }
            Files.delete(directory.resolve("draft.json"))
        }
    }

    @Test
    fun `the catalog source layout is read only when the client asks for it`() {
        val layouts = java.util.Collections.synchronizedList(ArrayList<Boolean>())
        fixture(readCatalog = { layout -> layouts += layout; document }, exportCatalog = { it }) { api, _ ->
            assertTrue(request(api, "/api/handshake").body().contains("catalog.source-layout"))
            assertEquals(200, request(api, "/api/v2/catalog").statusCode())
            assertEquals(200, request(api, "/api/v2/catalog", headers = mapOf(EditorApiServer.LAYOUT_HEADER to "1")).statusCode())
            assertEquals(listOf(false, true), layouts.toList())
        }
        fixture(readCatalog = { _ -> document }) { api, _ ->
            assertFalse(request(api, "/api/handshake").body().contains("catalog.source-layout"), "Export is required as well")
        }
    }

    @Test
    fun `stop releases the listener for a subsequent plugin instance`() = fixture { api, _ ->
        val port = api.port
        api.close()
        java.net.ServerSocket().use { socket -> socket.bind(InetSocketAddress("127.0.0.1", port)) }
    }

    @Test
    fun `empty server token permits direct requests without bypassing other guards`() = fixture(apiToken = "") { api, count ->
        val handshake = request(api, "/api/handshake", auth = null, protocol = null)
        assertEquals(200, handshake.statusCode())
        assertEquals("none", JsonObject.of(Json.parse(handshake.body()), "handshake").requiredString("authentication"))
        assertEquals(200, request(api, "/api/handshake", auth = "unused").statusCode())
        assertEquals(200, request(api, "/api/v2/document", "PUT", saveBody(), auth = null).statusCode())
        assertEquals(200, request(api, "/api/v2/document", auth = null).statusCode())
        assertEquals(409, request(api, "/api/v2/document", "PUT", saveBody(), auth = null).statusCode())
        assertEquals(426, request(api, "/api/v2/document", "PUT", saveBody(), auth = null, protocol = "1.0").statusCode())
        assertEquals(403, request(api, "/api/v2/document", "PUT", saveBody(), auth = null, origin = "https://evil.example").statusCode())
        val payload = JsonValue.Obj(mapOf("document" to document, "snapshotHash" to JsonValue.Text(EditorDraftStore.digest(Json.canonicalize(document)))))
        assertEquals(200, request(api, "/api/v2/preview", "POST", Json.canonicalize(payload), auth = null).statusCode())
        assertEquals(1, count.get())
    }

    @Test
    fun `configuration transfer is explicit authenticated versioned and never creates drafts`() {
        val reads = AtomicInteger()
        val exports = AtomicInteger()
        fixture(readCatalog = { _ -> reads.incrementAndGet(); document }, exportCatalog = { exports.incrementAndGet(); it }) { api, _ ->
            assertEquals(0, reads.get())
            val handshake = request(api, "/api/handshake")
            assertTrue(handshake.body().contains("catalog.read"))
            assertTrue(handshake.body().contains("catalog.export"))
            assertEquals(0, reads.get())
            assertEquals(401, request(api, "/api/v2/catalog", auth = null).statusCode())
            assertEquals(403, request(api, "/api/v2/catalog", origin = "https://evil.example").statusCode())
            assertEquals(426, request(api, "/api/v2/catalog", protocol = "1.0").statusCode())
            assertEquals(405, request(api, "/api/v2/catalog", "PUT", "{}").statusCode())
            assertEquals(0, reads.get())
            assertEquals(200, request(api, "/api/v2/catalog").statusCode())
            assertEquals(1, reads.get())
            val payload = JsonValue.Obj(mapOf("document" to document, "snapshotHash" to JsonValue.Text(EditorDraftStore.digest(Json.canonicalize(document)))))
            assertEquals(401, request(api, "/api/v2/catalog/export", "POST", Json.canonicalize(payload), auth = null).statusCode())
            assertEquals(426, request(api, "/api/v2/catalog/export", "POST", Json.canonicalize(payload), protocol = "9.0").statusCode())
            assertEquals(400, request(api, "/api/v2/catalog/export", "POST", """{"document":{},"snapshotHash":"wrong"}""").statusCode())
            assertEquals(409, request(api, "/api/v2/catalog/export", "POST", Json.canonicalize(JsonValue.Obj(payload.entries + ("targetServerId" to JsonValue.Text("another"))))).statusCode())
            assertEquals(0, exports.get())
            assertEquals(200, request(api, "/api/v2/catalog/export", "POST", Json.canonicalize(payload)).statusCode())
            assertEquals(1, exports.get())
            assertFalse(Files.exists(directory.resolve("draft.json")))
        }
    }

    @Test
    fun `unsupported transfer is not advertised and structured refusals do not log payloads`() {
        fixture { api, _ ->
            assertFalse(request(api, "/api/handshake").body().contains("catalog.read"))
            assertFalse(request(api, "/api/handshake").body().contains("catalog.export"))
            assertEquals(404, request(api, "/api/v2/catalog").statusCode())
        }
        fixture(readCatalog = { _ -> throw CatalogTransferException("CATALOG_SETTINGS_INVALID") }) { api, _ ->
            val response = request(api, "/api/v2/catalog")
            assertEquals(422, response.statusCode())
            assertEquals("CATALOG_SETTINGS_INVALID", JsonObject.parse(response.body(), "response").requiredString("code"))
        }
    }

    @Test
    fun `catalog status reports the current source fingerprint without touching the draft`() {
        fixture { api, _ ->
            assertFalse(request(api, "/api/handshake").body().contains("catalog.status"))
            assertEquals(404, request(api, "/api/v2/catalog/status").statusCode())
        }
        val hash = "sha256:" + "a".repeat(64)
        fixture(catalogStatus = { hash }) { api, _ ->
            assertTrue(request(api, "/api/handshake").body().contains("\"catalog.status\""))
            val response = request(api, "/api/v2/catalog/status")
            assertEquals(200, response.statusCode())
            val body = JsonObject.parse(response.body(), "status")
            assertEquals(hash, body.requiredString("sourceHash"))
            assertEquals("test", body.requiredString("serverId"))
            assertEquals(405, request(api, "/api/v2/catalog/status", "POST", "{}").statusCode())
            assertFalse(Files.exists(directory.resolve("draft.json")))
        }
        fixture(catalogStatus = { throw CatalogTransferException("CATALOG_INVALID") }) { api, _ ->
            val response = request(api, "/api/v2/catalog/status")
            assertEquals(422, response.statusCode())
            assertEquals("CATALOG_INVALID", JsonObject.parse(response.body(), "response").requiredString("code"))
        }
    }

    @Test
    fun `transfer response byte limits include the envelope and UTF8 expansion`() {
        fixture(readCatalog = { _ -> JsonValue.Text("\u4e2d".repeat(EditorTransferLimits.MESSAGE_BYTES / 2)) }) { api, _ ->
            val response = request(api, "/api/v2/catalog")
            assertEquals(422, response.statusCode())
            val body = JsonObject.parse(response.body(), "response")
            assertEquals("CATALOG_RESPONSE_TOO_LARGE", body.requiredString("code"))
            val params = body.requiredObjects("diagnostics").single().requiredObject("params")
            assertEquals((EditorTransferLimits.MESSAGE_BYTES / 2 * 3 + 2).toString(), params.requiredString("actualBytes"))
            assertEquals(EditorTransferLimits.MESSAGE_BYTES.toString(), params.requiredString("limitBytes"))
            assertFalse(Files.exists(directory.resolve("draft.json")))
        }
    }

    @Test
    fun `only one transfer runs at a time without blocking ordinary API requests`() {
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        fixture(readCatalog = { entered.countDown(); check(release.await(5, TimeUnit.SECONDS)); document }) { api, _ ->
            val first = CompletableFuture.supplyAsync { request(api, "/api/v2/catalog") }
            try {
                assertTrue(entered.await(2, TimeUnit.SECONDS))
                val busy = request(api, "/api/v2/catalog")
                assertEquals(429, busy.statusCode())
                assertEquals("CATALOG_BUSY", JsonObject.parse(busy.body(), "busy").requiredString("code"))
                assertEquals(200, request(api, "/api/handshake").statusCode())
                assertEquals(404, request(api, "/api/v2/document").statusCode())
            } finally {
                release.countDown()
            }
            assertEquals(200, first.get(5, TimeUnit.SECONDS).statusCode())
            assertEquals(200, request(api, "/api/v2/catalog").statusCode())
        }
    }
}
