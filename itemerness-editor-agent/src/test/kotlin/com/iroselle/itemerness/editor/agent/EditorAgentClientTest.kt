package com.iroselle.itemerness.editor.agent

import com.iroselle.itemerness.editor.protocol.AgentEnvelope
import com.iroselle.itemerness.editor.protocol.JsonObject
import com.iroselle.itemerness.editor.protocol.Json
import com.iroselle.itemerness.editor.protocol.JsonValue
import java.time.Duration
import java.time.Instant
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executor
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/**
 * The client's behaviour under a link that misbehaves.
 *
 * All of this is exercised through a fake transport rather than a real socket, because the parts
 * that matter — generation fencing, deadline handling, backpressure, and not reconnecting after
 * shutdown — are decisions the client makes, not things a WebSocket does.
 */
class EditorAgentClientTest {
    private val scheduledExecutor = Executors.newSingleThreadScheduledExecutor()
    private val scheduler = object : AgentScheduler {
        override fun execute(action: () -> Unit): Boolean = try {
            scheduledExecutor.execute { action() }
            true
        } catch (_: RuntimeException) {
            false
        }

        override fun schedule(delayMillis: Long, action: () -> Unit): AgentTask? = try {
            val future = scheduledExecutor.schedule({ action() }, delayMillis, TimeUnit.MILLISECONDS)
            AgentTask { future.cancel(false) }
        } catch (_: RuntimeException) {
            null
        }

        override fun repeat(initialDelayMillis: Long, periodMillis: Long, action: () -> Unit): AgentTask? = try {
            val future = scheduledExecutor.scheduleAtFixedRate(
                { action() },
                initialDelayMillis,
                periodMillis,
                TimeUnit.MILLISECONDS,
            )
            AgentTask { future.cancel(false) }
        } catch (_: RuntimeException) {
            null
        }
    }
    private val worker = Executor(Runnable::run)

    @AfterEach
    fun tearDown() {
        scheduledExecutor.shutdownNow()
    }

    private class FakeTransport : AgentTransport {
        val sent = CopyOnWriteArrayList<String>()
        var closed: String? = null

        @Volatile
        private var connected: AgentTransport.Listener? = null

        var listener: AgentTransport.Listener
            get() = requireNotNull(connected) { "the client has not opened a connection yet" }
            set(value) {
                connected = value
            }

        /** Waits for the client to hand over its listener, which `start()` does asynchronously. */
        fun awaitListener(): AgentTransport.Listener {
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
            while (connected == null && System.nanoTime() < deadline) Thread.sleep(5)
            return listener
        }

        override fun send(text: String): Boolean {
            sent += text
            return true
        }

        override fun close(reason: String) {
            closed = reason
        }

        fun envelopes(): List<AgentEnvelope> = sent.map(AgentEnvelope::decode)

        fun lastResponse(): AgentEnvelope = envelopes().last { it.kind == AgentEnvelope.Kind.RESPONSE }
    }

    private fun client(
        transport: FakeTransport,
        handler: EditorAgentClient.RequestHandler = EditorAgentClient.RequestHandler { _, _ -> JsonValue.Null },
        policy: EditorAgentClient.Policy = EditorAgentClient.Policy(),
        opens: AtomicInteger = AtomicInteger(),
    ): EditorAgentClient =
        EditorAgentClient(
            serverId = "srv_test",
            transports = { listener ->
                opens.incrementAndGet()
                transport.listener = listener
                transport
            },
            handler = handler,
            helloPayload = { JsonValue.Obj(linkedMapOf("agentVersion" to JsonValue.Text("test"))) },
            scheduler = scheduler,
            worker = worker,
            log = { _, _, _ -> },
            policy = policy,
            random = { 0.5 },
        )

    private fun helloAccepted(generation: Long): String =
        AgentEnvelope(
            protocolVersion = 1,
            kind = AgentEnvelope.Kind.RESPONSE,
            method = "agent.hello",
            requestId = "hello-1",
            serverId = "srv_test",
            connectionGeneration = generation,
            sequence = 1,
            deadline = null,
            traceId = null,
            contentHash = null,
            payload = JsonValue.Obj(
                linkedMapOf(
                    "ok" to JsonValue.Bool(true),
                    "error" to JsonValue.Null,
                    "result" to JsonValue.Obj(
                        linkedMapOf("connectionGeneration" to JsonValue.Num(generation.toDouble())),
                    ),
                ),
            ),
        ).encode()

    private fun request(
        method: String,
        generation: Long = 7,
        deadline: Instant? = null,
        protocolVersion: Int = 1,
    ): String =
        AgentEnvelope(
            protocolVersion = protocolVersion,
            kind = AgentEnvelope.Kind.REQUEST,
            method = method,
            requestId = "req-1",
            serverId = "srv_test",
            connectionGeneration = generation,
            sequence = 2,
            deadline = deadline?.toString(),
            traceId = null,
            contentHash = null,
            payload = JsonValue.Obj(linkedMapOf("itemId" to JsonValue.Text("itemerness:travel-token"))),
        ).encode()

    private fun connect(transport: FakeTransport, client: EditorAgentClient, generation: Long = 7) {
        client.start()
        // start() hands off to the scheduler, so wait for the socket to be handed the listener.
        transport.awaitListener().onOpen(transport)
        transport.listener.onText(helloAccepted(generation))
    }

    @Test
    fun `sends a hello on open and reaches ready once the control plane accepts it`() {
        val transport = FakeTransport()
        val agent = client(transport)
        connect(transport, agent)

        val hello = transport.envelopes().first()
        assertEquals("agent.hello", hello.method)
        assertEquals(AgentEnvelope.Kind.REQUEST, hello.kind)
        assertEquals("srv_test", hello.serverId)
        assertEquals(EditorAgentClient.State.READY, agent.currentState)
        assertEquals(7L, agent.connectionGeneration)
        agent.stop()
    }

    @Test
    fun `answers a request and returns the handler result`() {
        val transport = FakeTransport()
        val agent = client(transport, { method, payload ->
            JsonValue.Obj(
                linkedMapOf(
                    "method" to JsonValue.Text(method),
                    "echo" to ((payload as JsonValue.Obj).entries.getValue("itemId")),
                ),
            )
        })
        connect(transport, agent)

        transport.listener.onText(request("preview.compile"))

        val response = transport.lastResponse()
        val payload = JsonObject.of(response.payload)
        assertTrue(payload.requiredBoolean("ok"))
        assertEquals("itemerness:travel-token", payload.requiredObject("result").requiredString("echo"))
        agent.stop()
    }

    @Test
    fun `fences a request issued under a superseded connection generation`() {
        val transport = FakeTransport()
        val handled = AtomicInteger()
        val agent = client(transport, { _, _ ->
            handled.incrementAndGet()
            JsonValue.Null
        })
        connect(transport, agent, generation = 7)

        transport.listener.onText(request("preview.compile", generation = 6))

        val payload = JsonObject.of(transport.lastResponse().payload)
        assertFalse(payload.requiredBoolean("ok"))
        assertEquals("PROTOCOL.STALE_GENERATION", payload.requiredObject("error").requiredString("code"))
        // The point of the fence is that the work never runs, not that the reply says so.
        assertEquals(0, handled.get())
        agent.stop()
    }

    @Test
    fun `refuses a method it does not implement`() {
        val transport = FakeTransport()
        val agent = client(transport)
        connect(transport, agent)

        // There is no console or arbitrary-RPC method, and an unknown one is refused by name.
        transport.listener.onText(request("console.execute"))

        val payload = JsonObject.of(transport.lastResponse().payload)
        assertFalse(payload.requiredBoolean("ok"))
        assertEquals("PROTOCOL.UNSUPPORTED_METHOD", payload.requiredObject("error").requiredString("code"))
        agent.stop()
    }

    @Test
    fun `refuses a protocol version it cannot speak`() {
        val transport = FakeTransport()
        val agent = client(transport)
        connect(transport, agent)

        transport.listener.onText(request("preview.compile", protocolVersion = 99))

        val payload = JsonObject.of(transport.lastResponse().payload)
        assertEquals("PROTOCOL.UNSUPPORTED_VERSION", payload.requiredObject("error").requiredString("code"))
        agent.stop()
    }

    @Test
    fun `discards a request whose deadline has already passed`() {
        val transport = FakeTransport()
        val handled = AtomicInteger()
        val agent = client(transport, { _, _ ->
            handled.incrementAndGet()
            JsonValue.Null
        })
        connect(transport, agent)

        transport.listener.onText(request("preview.compile", deadline = Instant.now().minusSeconds(5)))

        val payload = JsonObject.of(transport.lastResponse().payload)
        assertEquals("PROTOCOL.DEADLINE_EXCEEDED", payload.requiredObject("error").requiredString("code"))
        assertEquals(0, handled.get())
        agent.stop()
    }

    @Test
    fun `answers overloaded instead of queueing beyond the in-flight limit`() {
        val transport = FakeTransport()
        val release = CountDownLatch(1)
        val started = CountDownLatch(1)
        val pool = Executors.newFixedThreadPool(4)
        val agent = EditorAgentClient(
            serverId = "srv_test",
            transports = { listener ->
                transport.listener = listener
                transport
            },
            handler = { _, _ ->
                started.countDown()
                release.await(5, TimeUnit.SECONDS)
                JsonValue.Null
            },
            helloPayload = { JsonValue.Obj(emptyMap()) },
            scheduler = scheduler,
            worker = pool,
            log = { _, _, _ -> },
            policy = EditorAgentClient.Policy(maximumInFlight = 1),
            random = { 0.5 },
        )
        try {
            connect(transport, agent)
            transport.listener.onText(request("preview.compile"))
            assertTrue(started.await(5, TimeUnit.SECONDS))
            transport.listener.onText(request("preview.compile"))

            val payload = JsonObject.of(transport.lastResponse().payload)
            // Backpressure is an answer, not a growing queue of compiles nobody waits for.
            assertEquals("PROTOCOL.OVERLOADED", payload.requiredObject("error").requiredString("code"))
        } finally {
            release.countDown()
            agent.stop()
            pool.shutdownNow()
        }
    }

    @Test
    fun `turns a handler failure into a structured error rather than dropping the request`() {
        val transport = FakeTransport()
        val agent = client(transport, { _, _ -> throw IllegalStateException("compiler exploded") })
        connect(transport, agent)

        transport.listener.onText(request("preview.compile"))

        val payload = JsonObject.of(transport.lastResponse().payload)
        assertEquals("PROTOCOL.INTERNAL", payload.requiredObject("error").requiredString("code"))
        // A stack trace never leaves the server; the browser gets a key it can translate.
        assertNotNull(payload.requiredObject("error").requiredString("messageKey"))
        assertFalse(Json.canonicalize(payload.requiredObject("error").let { transport.lastResponse().payload })
            .contains("IllegalStateException"))
        agent.stop()
    }

    @Test
    fun `turns worker rejection into bounded backpressure`() {
        val transport = FakeTransport()
        val agent = EditorAgentClient(
            serverId = "srv_test",
            transports = { listener ->
                transport.listener = listener
                transport
            },
            handler = { _, _ -> JsonValue.Null },
            helloPayload = { JsonValue.Obj(emptyMap()) },
            scheduler = scheduler,
            worker = Executor { throw java.util.concurrent.RejectedExecutionException("retired") },
            log = { _, _, _ -> },
            random = { 0.5 },
        )
        connect(transport, agent)

        transport.listener.onText(request("preview.compile"))

        val payload = JsonObject.of(transport.lastResponse().payload)
        assertEquals("PROTOCOL.OVERLOADED", payload.requiredObject("error").requiredString("code"))
        agent.stop()
    }

    @Test
    fun `does not reconnect after stop`() {
        val transport = FakeTransport()
        val opens = AtomicInteger()
        val agent = client(
            transport,
            policy = EditorAgentClient.Policy(initialBackoff = Duration.ofMillis(10)),
            opens = opens,
        )
        connect(transport, agent)
        val opensAfterConnect = opens.get()

        agent.stop()
        transport.listener.onClose(1006, "dropped")
        Thread.sleep(150)

        // Disable means stop taking work. Reconnecting during shutdown is how a plugin leaks a
        // thread past disable and keeps answering with a catalog that is being torn down.
        assertEquals(opensAfterConnect, opens.get())
        assertEquals(EditorAgentClient.State.OFFLINE, agent.currentState)
        assertEquals("shutdown", transport.closed)
    }

    @Test
    fun `closes a socket whose open callback arrives after stop`() {
        val transport = FakeTransport()
        val agent = client(transport)
        agent.start()
        val listener = transport.awaitListener()

        agent.stop()
        listener.onOpen(transport)

        assertEquals(EditorAgentClient.State.OFFLINE, agent.currentState)
        assertEquals("connection attempt is no longer current", transport.closed)
        assertTrue(transport.sent.isEmpty())
    }

    @Test
    fun `a late close from an old socket cannot evict its replacement`() {
        val first = FakeTransport()
        val second = FakeTransport()
        val opened = AtomicInteger()
        val agent = EditorAgentClient(
            serverId = "srv_test",
            transports = { listener ->
                val selected = if (opened.getAndIncrement() == 0) first else second
                selected.listener = listener
                selected
            },
            handler = { _, _ -> JsonValue.Null },
            helloPayload = { JsonValue.Obj(emptyMap()) },
            scheduler = scheduler,
            worker = worker,
            log = { _, _, _ -> },
            policy = EditorAgentClient.Policy(initialBackoff = Duration.ofMillis(10)),
            random = { 0.5 },
        )
        agent.start()
        first.awaitListener().onOpen(first)
        first.listener.onText(helloAccepted(7))
        first.listener.onClose(1006, "dropped")
        second.awaitListener().onOpen(second)
        second.listener.onText(helloAccepted(8))

        first.listener.onClose(1006, "late duplicate close")

        assertEquals(EditorAgentClient.State.READY, agent.currentState)
        assertEquals(8L, agent.connectionGeneration)
        assertTrue(agent.publishEvent("agent.event", JsonValue.Obj(emptyMap())))
        assertTrue(second.envelopes().any { it.kind == AgentEnvelope.Kind.EVENT })
        agent.stop()
    }

    @Test
    fun `work from a replaced connection cannot answer through the new socket`() {
        val first = FakeTransport()
        val second = FakeTransport()
        val opened = AtomicInteger()
        val started = CountDownLatch(1)
        val release = CountDownLatch(1)
        val pool = Executors.newSingleThreadExecutor()
        val agent = EditorAgentClient(
            serverId = "srv_test",
            transports = { listener ->
                val selected = if (opened.getAndIncrement() == 0) first else second
                selected.listener = listener
                selected
            },
            handler = { _, _ ->
                started.countDown()
                release.await(5, TimeUnit.SECONDS)
                JsonValue.Text("old result")
            },
            helloPayload = { JsonValue.Obj(emptyMap()) },
            scheduler = scheduler,
            worker = pool,
            log = { _, _, _ -> },
            policy = EditorAgentClient.Policy(initialBackoff = Duration.ofMillis(10)),
            random = { 0.5 },
        )
        try {
            agent.start()
            first.awaitListener().onOpen(first)
            first.listener.onText(helloAccepted(7))
            first.listener.onText(request("preview.compile", generation = 7))
            assertTrue(started.await(5, TimeUnit.SECONDS))

            first.listener.onClose(1006, "dropped")
            second.awaitListener().onOpen(second)
            second.listener.onText(helloAccepted(8))
            release.countDown()
            pool.shutdown()
            assertTrue(pool.awaitTermination(5, TimeUnit.SECONDS))

            assertFalse(second.envelopes().any { it.requestId == "req-1" })
            assertFalse(first.envelopes().any { it.requestId == "req-1" })
        } finally {
            release.countDown()
            agent.stop()
            pool.shutdownNow()
        }
    }

    @Test
    fun `reconnects with jittered exponential backoff after an unexpected close`() {
        val transport = FakeTransport()
        val opens = AtomicInteger()
        val agent = client(
            transport,
            policy = EditorAgentClient.Policy(initialBackoff = Duration.ofMillis(20)),
            opens = opens,
        )
        connect(transport, agent)
        val before = opens.get()

        transport.listener.onClose(1006, "dropped")

        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
        while (opens.get() == before && System.nanoTime() < deadline) Thread.sleep(5)
        assertTrue(opens.get() > before, "the client should have retried the connection")
        agent.stop()
    }

    @Test
    fun `backs off instead of hammering when the control plane rejects the token`() {
        val transport = FakeTransport()
        val agent = client(transport, policy = EditorAgentClient.Policy(initialBackoff = Duration.ofSeconds(30)))
        agent.start()
        transport.awaitListener().onOpen(transport)

        transport.listener.onText(
            AgentEnvelope(
                protocolVersion = 1,
                kind = AgentEnvelope.Kind.RESPONSE,
                method = "agent.hello",
                requestId = "hello-1",
                serverId = "srv_test",
                connectionGeneration = 0,
                sequence = 1,
                deadline = null,
                traceId = null,
                contentHash = null,
                payload = JsonValue.Obj(
                    linkedMapOf(
                        "ok" to JsonValue.Bool(false),
                        "error" to JsonValue.Obj(linkedMapOf("code" to JsonValue.Text("AUTH.REVOKED"))),
                        "result" to JsonValue.Null,
                    ),
                ),
            ).encode(),
        )

        assertEquals(EditorAgentClient.State.CONNECTING, agent.currentState)
        assertEquals("handshake rejected", transport.closed)
        agent.stop()
    }

    @Test
    fun `never schedules a retry beyond the configured maximum backoff`() {
        val delays = CopyOnWriteArrayList<Long>()
        val transport = FakeTransport()
        val agent = EditorAgentClient(
            serverId = "srv_test",
            transports = { listener ->
                transport.listener = listener
                transport
            },
            handler = { _, _ -> JsonValue.Null },
            helloPayload = { JsonValue.Obj(emptyMap()) },
            scheduler = scheduler,
            worker = worker,
            log = { _, message, _ ->
                Regex("in (\\d+)ms").find(message)?.groupValues?.get(1)?.let { delays += it.toLong() }
            },
            policy = EditorAgentClient.Policy(
                initialBackoff = Duration.ofSeconds(30),
                maximumBackoff = Duration.ofSeconds(60),
            ),
            // Maximum positive jitter, which is where the cap used to be exceeded.
            random = { 1.0 },
        )
        connect(transport, agent)
        repeat(6) { transport.listener.onClose(1006, "dropped") }
        agent.stop()

        assertTrue(delays.isNotEmpty(), "expected the client to log its retry delays")
        // A maximum that jitter can overshoot is not a maximum.
        assertTrue(delays.all { it <= 60_000 }, "delays exceeded the cap: $delays")
    }

    @Test
    fun `ignores a malformed message without dropping the connection`() {
        val transport = FakeTransport()
        val agent = client(transport)
        connect(transport, agent)
        val before = transport.sent.size

        transport.listener.onText("{ not json")

        assertEquals(before, transport.sent.size)
        assertEquals(EditorAgentClient.State.READY, agent.currentState)
        agent.stop()
    }
}
