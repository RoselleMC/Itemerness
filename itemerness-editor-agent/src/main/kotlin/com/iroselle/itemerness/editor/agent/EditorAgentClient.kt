package com.iroselle.itemerness.editor.agent

import com.iroselle.itemerness.editor.protocol.AgentEnvelope
import com.iroselle.itemerness.editor.protocol.AgentError
import com.iroselle.itemerness.editor.protocol.Json
import com.iroselle.itemerness.editor.protocol.JsonException
import com.iroselle.itemerness.editor.protocol.JsonValue
import com.iroselle.itemerness.editor.protocol.respond
import java.time.Duration
import java.time.Instant
import java.util.concurrent.Executor
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

/**
 * The outbound agent connection.
 *
 * The plugin dials the control plane; the control plane never dials in. That is the whole reason
 * an operator does not have to open a port on a Minecraft server, and it is why every rule below
 * is about surviving a link that will drop: reconnect with jittered backoff, fence work issued
 * under a connection that has since been replaced, refuse work when the queue is full instead of
 * growing it, and stop taking work the moment shutdown begins.
 *
 * This class touches no Bukkit type. Handling a request is pure computation over immutable inputs
 * and runs on the supplied executor; anything that needs an owning context is the caller's job.
 */
class EditorAgentClient(
    private val serverId: String,
    private val transports: AgentTransport.Factory,
    private val handler: RequestHandler,
    private val helloPayload: () -> JsonValue,
    private val scheduler: AgentScheduler,
    private val worker: Executor,
    private val log: (Level, String, Throwable?) -> Unit,
    private val policy: Policy = Policy(),
    private val random: () -> Double = Math::random,
) {
    enum class Level { INFO, WARN, ERROR }

    enum class State {
        /** Not connected and not trying. Either never started, or stopped. */
        OFFLINE,
        CONNECTING,
        /** Socket open, hello sent, waiting for the control plane to accept it. */
        HANDSHAKING,
        READY,
    }

    fun interface RequestHandler {
        /**
         * Answers one request. Returning null means "no result", which becomes an `ok` response
         * with a null result; throwing becomes a structured internal error.
         */
        fun handle(method: String, payload: JsonValue): JsonValue?
    }

    data class Policy(
        val initialBackoff: Duration = Duration.ofSeconds(1),
        val maximumBackoff: Duration = Duration.ofSeconds(60),
        /** Fraction of the delay applied as random jitter, so restarts do not synchronise. */
        val jitter: Double = 0.25,
        val heartbeatInterval: Duration = Duration.ofSeconds(30),
        val handshakeTimeout: Duration = Duration.ofSeconds(20),
        /** Requests accepted concurrently before the agent answers OVERLOADED. */
        val maximumInFlight: Int = 8,
        val maximumOutboundBytes: Int = JdkWebSocketTransport.MAXIMUM_MESSAGE_BYTES,
    )

    private val state = AtomicReference(State.OFFLINE)
    private val generation = AtomicLong(0)
    private val sequence = AtomicLong(0)
    private val inFlight = AtomicInteger(0)
    private val attempt = AtomicInteger(0)
    private val stopping = AtomicBoolean(false)
    private val activeListener = AtomicReference<Listener?>(null)
    private val reconnectTask = AtomicReference<AgentTask?>(null)
    private val heartbeatTask = AtomicReference<AgentTask?>(null)
    private val handshakeTask = AtomicReference<AgentTask?>(null)

    val currentState: State get() = state.get()
    val connectionGeneration: Long get() = generation.get()

    /** Begins connecting. Returns immediately; connection progress is asynchronous by design. */
    fun start() {
        if (stopping.get()) return
        if (!state.compareAndSet(State.OFFLINE, State.CONNECTING)) return
        if (!scheduler.execute(::openConnection)) state.set(State.OFFLINE)
    }

    /**
     * Stops accepting work, cancels timers, and closes the socket.
     *
     * Called from plugin disable, where the contract is that shutdown only tears things down. No
     * reconnect is scheduled after this, even if the socket closes with an error.
     */
    fun stop(reason: String = "shutdown") {
        if (!stopping.compareAndSet(false, true)) return
        cancel(reconnectTask)
        cancel(heartbeatTask)
        cancel(handshakeTask)
        activeListener.getAndSet(null)?.close(reason)
        state.set(State.OFFLINE)
    }

    private fun openConnection() {
        if (stopping.get()) return
        val listener = Listener()
        activeListener.getAndSet(listener)?.close("superseded by a newer connection attempt")
        try {
            transports.open(listener)
        } catch (failure: Exception) {
            if (!activeListener.compareAndSet(listener, null)) return
            log(Level.WARN, "Editor connection attempt failed: ${failure.message}", null)
            scheduleReconnect()
        }
    }

    private fun scheduleReconnect() {
        if (stopping.get()) return
        state.set(State.CONNECTING)
        val tries = attempt.incrementAndGet()
        val base = policy.initialBackoff.toMillis().toDouble() * Math.pow(2.0, (tries - 1).coerceAtMost(16).toDouble())
        val capped = base.coerceAtMost(policy.maximumBackoff.toMillis().toDouble())
        // Jitter is symmetric around the delay: a fleet restarting together must not retry in
        // lockstep and turn a recovering control plane back over.
        val jittered = capped * (1.0 + policy.jitter * (random() * 2.0 - 1.0))
        // Clamped after jitter, not before. Applying the cap first let a jittered delay run 25%
        // past the configured maximum, which is a maximum that does not hold.
        val delay = jittered.toLong().coerceIn(1L, policy.maximumBackoff.toMillis())
        log(Level.INFO, "Retrying the editor connection in ${delay}ms (attempt $tries)", null)
        cancel(reconnectTask)
        reconnectTask.set(scheduler.schedule(delay, ::openConnection))
    }

    private fun cancel(holder: AtomicReference<AgentTask?>) {
        holder.getAndSet(null)?.cancel()
    }

    private fun send(envelope: AgentEnvelope): Boolean {
        val listener = activeListener.get() ?: return false
        return listener.send(envelope)
    }

    private fun envelope(
        kind: AgentEnvelope.Kind,
        method: String,
        requestId: String,
        payload: JsonValue,
    ): AgentEnvelope =
        AgentEnvelope(
            protocolVersion = AgentEnvelope.PROTOCOL_VERSION,
            kind = kind,
            method = method,
            requestId = requestId,
            serverId = serverId,
            connectionGeneration = generation.get(),
            sequence = sequence.incrementAndGet(),
            deadline = null,
            traceId = null,
            contentHash = null,
            payload = payload,
        )

    /** Publishes an event. Dropped silently when offline: events are not worth queueing. */
    fun publishEvent(method: String, payload: JsonValue): Boolean {
        if (state.get() != State.READY) return false
        return send(envelope(AgentEnvelope.Kind.EVENT, method, "evt-${sequence.get()}", payload))
    }

    private fun onReady(source: Listener, acceptedGeneration: Long) {
        if (stopping.get() || activeListener.get() !== source) return
        generation.set(acceptedGeneration)
        attempt.set(0)
        state.set(State.READY)
        cancel(handshakeTask)
        log(Level.INFO, "Editor agent connected as $serverId (generation $acceptedGeneration)", null)
        cancel(heartbeatTask)
        heartbeatTask.set(scheduler.repeat(
            policy.heartbeatInterval.toMillis(),
            policy.heartbeatInterval.toMillis(),
        ) {
            if (state.get() == State.READY) {
                publishEvent("agent.event", JsonValue.Obj(linkedMapOf("type" to JsonValue.Text("heartbeat"))))
            }
        })
    }

    private fun dispatch(request: AgentEnvelope, source: Listener) {
        val acceptedGeneration = generation.get()
        // A request issued under a superseded connection must not run: the control plane has
        // already moved on, and applying it would mutate state on behalf of a dead session.
        if (request.connectionGeneration != 0L && request.connectionGeneration != acceptedGeneration) {
            source.send(request.respond(null, AgentError.staleGeneration(), sequence.incrementAndGet()))
            return
        }
        if (request.protocolVersion != AgentEnvelope.PROTOCOL_VERSION) {
            source.send(request.respond(null, AgentError.unsupportedProtocol(request.protocolVersion), sequence.incrementAndGet()))
            return
        }
        if (request.method !in AgentEnvelope.SUPPORTED_METHODS) {
            source.send(request.respond(null, AgentError.unsupportedMethod(request.method), sequence.incrementAndGet()))
            return
        }
        val deadline = request.deadline?.let { runCatching { Instant.parse(it) }.getOrNull() }
        if (deadline != null && Instant.now().isAfter(deadline)) {
            source.send(request.respond(null, AgentError.deadlineExceeded(), sequence.incrementAndGet()))
            return
        }
        // Bounded concurrency instead of an unbounded queue: an overloaded server should say so
        // immediately, not accumulate compiles nobody is waiting for any more.
        if (inFlight.incrementAndGet() > policy.maximumInFlight) {
            inFlight.decrementAndGet()
            source.send(request.respond(null, AgentError.overloaded(), sequence.incrementAndGet()))
            return
        }

        try {
            worker.execute {
                try {
                    if (!isCurrent(source, acceptedGeneration)) return@execute
                    val result = handler.handle(request.method, request.payload)
                    // A compile belongs to the exact socket generation that requested it. Sending it
                    // through a replacement socket would let stale work satisfy a new session's request.
                    if (!isCurrent(source, acceptedGeneration)) return@execute
                    // A result produced after its deadline is history, not an answer.
                    if (deadline != null && Instant.now().isAfter(deadline)) {
                        source.send(request.respond(null, AgentError.deadlineExceeded(), sequence.incrementAndGet()))
                        return@execute
                    }
                    source.send(request.respond(result, null, sequence.incrementAndGet()))
                } catch (failure: Exception) {
                    log(Level.WARN, "Editor request ${request.method} failed: ${failure.message}", failure)
                    if (isCurrent(source, acceptedGeneration)) {
                        source.send(request.respond(null, AgentError.internal(failure.message ?: "failed"), sequence.incrementAndGet()))
                    }
                } finally {
                    inFlight.decrementAndGet()
                }
            }
        } catch (failure: RuntimeException) {
            inFlight.decrementAndGet()
            log(Level.WARN, "Editor worker rejected ${request.method}: ${failure.message}", failure)
            if (isCurrent(source, acceptedGeneration)) {
                source.send(request.respond(null, AgentError.overloaded(), sequence.incrementAndGet()))
            }
        }
    }

    private fun isCurrent(source: Listener, acceptedGeneration: Long): Boolean =
        !stopping.get() &&
            activeListener.get() === source &&
            state.get() == State.READY &&
            generation.get() == acceptedGeneration

    private inner class Listener : AgentTransport.Listener {
        private val opened = AtomicReference<AgentTransport?>(null)

        fun close(reason: String) {
            opened.getAndSet(null)?.close(reason)
        }

        fun send(envelope: AgentEnvelope): Boolean {
            if (stopping.get() || activeListener.get() !== this) return false
            val encoded = envelope.encode()
            val byteCount = encoded.toByteArray(Charsets.UTF_8).size
            if (byteCount > policy.maximumOutboundBytes) {
                log(Level.WARN, "Refusing to send a $byteCount byte ${envelope.method} envelope", null)
                return false
            }
            return opened.get()?.send(encoded) ?: false
        }

        override fun onOpen(transport: AgentTransport) {
            if (!opened.compareAndSet(null, transport)) {
                transport.close("duplicate open callback")
                return
            }
            if (stopping.get() || activeListener.get() !== this) {
                close("connection attempt is no longer current")
                return
            }
            state.set(State.HANDSHAKING)
            this.send(envelope(AgentEnvelope.Kind.REQUEST, "agent.hello", "hello-${sequence.get() + 1}", helloPayload()))
            cancel(handshakeTask)
            handshakeTask.set(scheduler.schedule(policy.handshakeTimeout.toMillis()) {
                if (state.get() == State.HANDSHAKING && activeListener.compareAndSet(this, null)) {
                    log(Level.WARN, "Editor handshake timed out", null)
                    close("handshake timeout")
                    scheduleReconnect()
                }
            })
        }

        override fun onText(message: String) {
            if (stopping.get() || activeListener.get() !== this) return
            val envelope =
                try {
                    AgentEnvelope.decode(message)
                } catch (failure: JsonException) {
                    log(Level.WARN, "Discarding a malformed editor message: ${failure.message}", null)
                    return
                }
            when (envelope.kind) {
                AgentEnvelope.Kind.RESPONSE -> onResponse(envelope)
                AgentEnvelope.Kind.REQUEST -> dispatch(envelope, this)
                AgentEnvelope.Kind.EVENT -> Unit
            }
        }

        private fun onResponse(envelope: AgentEnvelope) {
            if (envelope.method != "agent.hello") return
            val payload = envelope.payload as? JsonValue.Obj ?: return
            val ok = (payload.entries["ok"] as? JsonValue.Bool)?.value == true
            if (!ok) {
                val error = payload.entries["error"]
                log(Level.ERROR, "Editor rejected the agent handshake: ${error?.let(Json::canonicalize)}", null)
                if (!activeListener.compareAndSet(this, null)) return
                close("handshake rejected")
                // A rejected token will keep being rejected; back off instead of hammering.
                scheduleReconnect()
                return
            }
            val result = payload.entries["result"] as? JsonValue.Obj
            val accepted = (result?.entries?.get("connectionGeneration") as? JsonValue.Num)?.value?.toLong()
                ?: (generation.get() + 1)
            onReady(this, accepted)
        }

        override fun onClose(code: Int, reason: String) {
            opened.set(null)
            if (!activeListener.compareAndSet(this, null) || stopping.get()) return
            log(Level.INFO, "Editor connection closed ($code $reason)", null)
            cancel(heartbeatTask)
            scheduleReconnect()
        }

        override fun onError(failure: Throwable) {
            if (!activeListener.compareAndSet(this, null)) return
            close("transport error")
            if (stopping.get()) return
            log(Level.WARN, "Editor connection error: ${failure.message}", failure)
            cancel(heartbeatTask)
            scheduleReconnect()
        }
    }
}
