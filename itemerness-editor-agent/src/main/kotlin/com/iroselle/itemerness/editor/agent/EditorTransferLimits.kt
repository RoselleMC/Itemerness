package com.iroselle.itemerness.editor.agent

import com.iroselle.itemerness.editor.protocol.JsonValue

/**
 * Byte limits shared by every editor transfer. The handshake advertises them, so both peers apply the
 * same numbers instead of each keeping its own constant.
 *
 * A document is at most [documentBytes] of canonical UTF-8 JSON, which follows the server's
 * per-directory catalog budget (16 MiB unless the operator raises it, at most [MAXIMUM_DOCUMENT_BYTES]).
 * Requests and responses wrap a document in at most [ENVELOPE_BYTES] of other fields. The API runs
 * inside the game server and every request decodes into an in-memory tree several times its wire
 * size, so bodies above [SMALL_MESSAGE_BYTES] also take large-body permits: concurrent large
 * documents queue instead of multiplying the heap they hold.
 */
class EditorTransferLimits(val documentBytes: Int = DEFAULT_DOCUMENT_BYTES) {
    init {
        require(documentBytes in DEFAULT_DOCUMENT_BYTES..MAXIMUM_DOCUMENT_BYTES) { "Unsupported editor document limit $documentBytes" }
    }

    val messageBytes: Int get() = documentBytes + ENVELOPE_BYTES

    /**
     * Permits one large body holds. At the default size two may be decoded at once; once an operator
     * raises the document limit, a large body takes every permit so only one is in memory.
     */
    val largeMessagePermits: Int get() = if (documentBytes <= DEFAULT_DOCUMENT_BYTES) 1 else LARGE_MESSAGE_SLOTS

    /**
     * Requests follow the current budget, but responses may reach the hard ceiling: a draft saved
     * under a higher budget must still open after the operator lowers it, and the server already
     * holds whatever it sends.
     */
    fun json(): JsonValue = JsonValue.Obj(mapOf(
        "documentBytes" to JsonValue.Num(documentBytes.toDouble()),
        "requestBytes" to JsonValue.Num(messageBytes.toDouble()),
        "responseBytes" to JsonValue.Num((MAXIMUM_DOCUMENT_BYTES + ENVELOPE_BYTES).toDouble()),
    ))

    fun requireDocument(canonical: String) {
        val bytes = canonical.toByteArray(Charsets.UTF_8).size
        if (bytes > documentBytes) throw DocumentTooLarge(bytes, documentBytes)
    }

    /** A document over the limit; the sizes are reported so the author can see how far over it is. */
    class DocumentTooLarge(val actualBytes: Int, val limitBytes: Int) :
        IllegalStateException("Editor document has $actualBytes bytes; the limit is $limitBytes")

    companion object {
        const val DEFAULT_DOCUMENT_BYTES: Int = 16 * 1024 * 1024
        const val MAXIMUM_DOCUMENT_BYTES: Int = 64 * 1024 * 1024
        const val ENVELOPE_BYTES: Int = 1024 * 1024
        const val DEFAULT_MESSAGE_BYTES: Int = DEFAULT_DOCUMENT_BYTES + ENVELOPE_BYTES
        const val SMALL_MESSAGE_BYTES: Int = 2 * 1024 * 1024
        const val LARGE_MESSAGE_SLOTS: Int = 2
        /** Leaves part of the 15 second request deadline for the work itself. */
        const val LARGE_MESSAGE_WAIT_MILLIS: Long = 8_000

        /** A sanitized diagnostic for transfer refusals; it carries sizes only, never content. */
        fun diagnostic(code: String, messageKey: String, actualBytes: Int, limitBytes: Int): JsonValue = JsonValue.Obj(mapOf(
            "code" to JsonValue.Text(code),
            "severity" to JsonValue.Text("ERROR"),
            "origin" to JsonValue.Text("agent"),
            "messageKey" to JsonValue.Text(messageKey),
            "params" to JsonValue.Obj(mapOf(
                "actualBytes" to JsonValue.Text(actualBytes.toString()),
                "limitBytes" to JsonValue.Text(limitBytes.toString()),
            )),
        ))
    }
}
