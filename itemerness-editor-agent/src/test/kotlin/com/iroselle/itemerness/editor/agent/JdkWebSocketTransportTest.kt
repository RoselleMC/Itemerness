package com.iroselle.itemerness.editor.agent

import java.net.http.WebSocket
import java.nio.ByteBuffer
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CompletionStage
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class JdkWebSocketTransportTest {
    @Test
    fun `serializes text sends until the preceding future completes`() {
        val listener = RecordingListener()
        val socket = ControllableWebSocket()
        val transport = JdkWebSocketTransport(listener)
        transport.attach(socket)

        assertTrue(transport.send("first"))
        assertTrue(transport.send("second"))
        assertEquals(listOf("first"), socket.texts)

        socket.sends[0].complete(socket)
        assertEquals(listOf("first", "second"), socket.texts)
        socket.sends[1].complete(socket)
        assertFalse(listener.failed.await(50, TimeUnit.MILLISECONDS))
    }

    @Test
    fun `reports an asynchronous send failure to the connection listener`() {
        val listener = RecordingListener()
        val socket = ControllableWebSocket()
        val transport = JdkWebSocketTransport(listener)
        transport.attach(socket)

        assertTrue(transport.send("payload"))
        val failure = IllegalStateException("write failed")
        socket.sends.single().completeExceptionally(failure)

        assertTrue(listener.failed.await(5, TimeUnit.SECONDS))
        assertSame(failure, listener.failure)
    }

    @Test
    fun `refuses a send that would exceed the bounded outbound queue`() {
        val listener = RecordingListener()
        val socket = ControllableWebSocket()
        val transport = JdkWebSocketTransport(listener, maximumQueuedBytes = 5)
        transport.attach(socket)

        assertTrue(transport.send("1234"))
        assertFalse(transport.send("12"))
        socket.sends.single().complete(socket)
        assertTrue(transport.send("12"))
    }

    private class RecordingListener : AgentTransport.Listener {
        val failed = CountDownLatch(1)

        @Volatile
        var failure: Throwable? = null

        override fun onOpen(transport: AgentTransport) = Unit

        override fun onText(message: String) = Unit

        override fun onClose(code: Int, reason: String) = Unit

        override fun onError(failure: Throwable) {
            this.failure = failure
            failed.countDown()
        }
    }

    private class ControllableWebSocket : WebSocket {
        val texts = CopyOnWriteArrayList<String>()
        val sends = CopyOnWriteArrayList<CompletableFuture<WebSocket>>()

        @Volatile
        private var outputClosed = false

        @Volatile
        private var inputClosed = false

        override fun sendText(data: CharSequence, last: Boolean): CompletableFuture<WebSocket> {
            texts += data.toString()
            return CompletableFuture<WebSocket>().also(sends::add)
        }

        override fun sendBinary(data: ByteBuffer, last: Boolean): CompletableFuture<WebSocket> =
            CompletableFuture.completedFuture(this)

        override fun sendPing(message: ByteBuffer): CompletableFuture<WebSocket> =
            CompletableFuture.completedFuture(this)

        override fun sendPong(message: ByteBuffer): CompletableFuture<WebSocket> =
            CompletableFuture.completedFuture(this)

        override fun sendClose(statusCode: Int, reason: String): CompletableFuture<WebSocket> {
            outputClosed = true
            return CompletableFuture.completedFuture(this)
        }

        override fun request(n: Long) = Unit

        override fun getSubprotocol(): String = ""

        override fun isOutputClosed(): Boolean = outputClosed

        override fun isInputClosed(): Boolean = inputClosed

        override fun abort() {
            outputClosed = true
            inputClosed = true
        }
    }
}
