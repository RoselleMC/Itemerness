package com.iroselle.itemerness.editor.agent

import java.net.URI
import java.net.http.HttpClient
import java.net.http.WebSocket
import java.time.Duration
import java.util.concurrent.CompletionStage
import java.util.concurrent.CompletableFuture
import java.util.concurrent.Executor
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/**
 * The socket the agent dials out on.
 *
 * Transport is behind an interface for one reason: the interesting behaviour of the client is its
 * state machine — backoff, connection fencing, deadlines, backpressure — and none of that should
 * need a real server to test. `JdkWebSocketTransport` is the production implementation; tests drive
 * the same client through a fake.
 */
interface AgentTransport {
    fun interface Factory {
        fun open(listener: Listener): AgentTransport
    }

    interface Listener {
        /**
         * Delivered with the transport itself.
         *
         * The JDK invokes `onOpen` before `buildAsync` completes, so a listener that reached for a
         * transport reference stored by the factory's caller would find it null and silently drop
         * the handshake. Passing it in removes the ordering question entirely.
         */
        fun onOpen(transport: AgentTransport)

        fun onText(message: String)

        fun onClose(code: Int, reason: String)

        fun onError(failure: Throwable)
    }

    /** Returns false when the send was refused, which the caller treats as backpressure. */
    fun send(text: String): Boolean

    fun close(reason: String)
}

/**
 * Outbound WebSocket over the JDK HTTP client.
 *
 * TLS and hostname verification come from the JDK's default `SSLContext`, so a misconfigured or
 * intercepted endpoint fails the handshake rather than silently accepting a token. Plaintext is
 * only reachable through a `ws://localhost` URL, which the settings loader is what actually gates.
 *
 * The JDK delivers text in fragments; they are accumulated until `last` so a handler never sees
 * half an envelope.
 */
class JdkWebSocketTransport internal constructor(
    private val listener: AgentTransport.Listener,
    private val maximumQueuedBytes: Int = MAXIMUM_QUEUED_OUTBOUND_BYTES,
) : AgentTransport {
    private val socket = AtomicReference<WebSocket?>(null)
    private val sendLock = Any()
    private val failureReported = AtomicBoolean(false)
    private var sendTail: CompletableFuture<WebSocket>? = null
    private var queuedBytes = 0

    override fun send(text: String): Boolean {
        val open = socket.get() ?: return false
        if (open.isOutputClosed) return false
        val byteCount = text.toByteArray(Charsets.UTF_8).size
        synchronized(sendLock) {
            if (socket.get() !== open || open.isOutputClosed) return false
            if (byteCount > maximumQueuedBytes - queuedBytes) return false
            queuedBytes += byteCount
            val predecessor = sendTail ?: CompletableFuture.completedFuture(open)
            val current = predecessor.thenCompose { connected ->
                if (socket.get() !== connected || connected.isOutputClosed) {
                    CompletableFuture.failedFuture(IllegalStateException("WebSocket output is closed"))
                } else {
                    connected.sendText(text, true)
                }
            }
            sendTail = current
            current.whenComplete { _, failure ->
                synchronized(sendLock) {
                    queuedBytes -= byteCount
                    if (sendTail === current && queuedBytes == 0) sendTail = null
                }
                if (failure != null && failureReported.compareAndSet(false, true)) {
                    listener.onError(unwrapCompletionFailure(failure))
                }
            }
            return true
        }
    }

    override fun close(reason: String) {
        val open = socket.getAndSet(null) ?: return
        val predecessor = synchronized(sendLock) {
            sendTail ?: CompletableFuture.completedFuture(open)
        }
        predecessor.handle { _, _ -> open }
            .thenCompose { connected ->
                if (connected.isOutputClosed) CompletableFuture.completedFuture(connected)
                else connected.sendClose(WebSocket.NORMAL_CLOSURE, reason.take(120))
            }
            .whenComplete { _, _ -> runCatching(open::abort) }
    }

    internal fun attach(open: WebSocket) {
        if (!socket.compareAndSet(null, open)) {
            open.abort()
            return
        }
        open.request(1)
        listener.onOpen(this)
    }

    companion object {
        const val MAXIMUM_MESSAGE_BYTES: Int = 8 * 1024 * 1024
        const val MAXIMUM_QUEUED_OUTBOUND_BYTES: Int = 16 * 1024 * 1024

        fun factory(
            endpoint: URI,
            token: String,
            executor: Executor,
            connectTimeout: Duration = Duration.ofSeconds(15),
        ): AgentTransport.Factory =
            AgentTransport.Factory { listener ->
                val client = HttpClient.newBuilder()
                    .connectTimeout(connectTimeout)
                    // Redirects are not followed: a redirect to another host would present the
                    // agent token to a server the operator never configured.
                    .followRedirects(HttpClient.Redirect.NEVER)
                    .executor(executor)
                    .build()

                val transport = JdkWebSocketTransport(listener)
                client.newWebSocketBuilder()
                    .connectTimeout(connectTimeout)
                    // Bearer rather than a query parameter, so the token never lands in an access log.
                    .header("authorization", "Bearer $token")
                    .header("user-agent", "Itemerness-Agent")
                    .buildAsync(endpoint, Accumulator(listener, transport))
                    // Joining surfaces a refused or misconfigured endpoint as an exception the
                    // client can back off from, rather than a connection that never speaks.
                    .join()
                transport
            }

        private fun unwrapCompletionFailure(failure: Throwable): Throwable {
            var current = failure
            while ((current is java.util.concurrent.CompletionException ||
                    current is java.util.concurrent.ExecutionException) && current.cause != null) {
                current = current.cause!!
            }
            return current
        }
    }

    private class Accumulator(
        private val listener: AgentTransport.Listener,
        private val transport: JdkWebSocketTransport,
    ) : WebSocket.Listener {
        private val buffer = StringBuilder()

        override fun onOpen(webSocket: WebSocket) {
            // The socket arrives as a parameter here, so it is attached before anyone can try to
            // send on it.
            transport.attach(webSocket)
        }

        override fun onText(webSocket: WebSocket, data: CharSequence, last: Boolean): CompletionStage<*>? {
            if (buffer.length + data.length > MAXIMUM_MESSAGE_BYTES) {
                buffer.setLength(0)
                listener.onError(IllegalStateException("Inbound message exceeds $MAXIMUM_MESSAGE_BYTES bytes"))
                webSocket.abort()
                return null
            }
            buffer.append(data)
            if (last) {
                val message = buffer.toString()
                buffer.setLength(0)
                listener.onText(message)
            }
            webSocket.request(1)
            return null
        }

        override fun onClose(webSocket: WebSocket, statusCode: Int, reason: String): CompletionStage<*>? {
            listener.onClose(statusCode, reason)
            return null
        }

        override fun onError(webSocket: WebSocket, error: Throwable) {
            listener.onError(error)
        }

        override fun onPing(webSocket: WebSocket, message: java.nio.ByteBuffer): CompletionStage<*>? {
            webSocket.request(1)
            return null
        }

        override fun onPong(webSocket: WebSocket, message: java.nio.ByteBuffer): CompletionStage<*>? {
            webSocket.request(1)
            return null
        }
    }
}
