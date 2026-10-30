package com.iroselle.itemerness.editor.agent

import com.iroselle.itemerness.editor.protocol.JsonValue

/**
 * Byte limits shared by every editor transfer. The handshake advertises them, so both peers apply the
 * same numbers instead of each keeping its own constant.
 *
 * A document is at most [DOCUMENT_BYTES] of canonical UTF-8 JSON, in line with the catalog loader's
 * 16 MiB budget per source directory. Requests and responses wrap a document in at most [ENVELOPE_BYTES]
 * of other fields. The API runs inside the game server and every request decodes into an in-memory
 * tree several times its wire size, so bodies above [SMALL_MESSAGE_BYTES] also wait for one of
 * [LARGE_MESSAGE_SLOTS]: concurrent large documents queue instead of multiplying the heap they hold.
 */
object EditorTransferLimits {
    const val DOCUMENT_BYTES: Int = 16 * 1024 * 1024
    const val ENVELOPE_BYTES: Int = 1024 * 1024
    const val MESSAGE_BYTES: Int = DOCUMENT_BYTES + ENVELOPE_BYTES
    const val SMALL_MESSAGE_BYTES: Int = 2 * 1024 * 1024
    const val LARGE_MESSAGE_SLOTS: Int = 2
    /** Leaves part of the 15 second request deadline for the work itself. */
    const val LARGE_MESSAGE_WAIT_MILLIS: Long = 8_000

    fun json(): JsonValue = JsonValue.Obj(mapOf(
        "documentBytes" to JsonValue.Num(DOCUMENT_BYTES.toDouble()),
        "requestBytes" to JsonValue.Num(MESSAGE_BYTES.toDouble()),
        "responseBytes" to JsonValue.Num(MESSAGE_BYTES.toDouble()),
    ))

    /** A document over [DOCUMENT_BYTES]; the sizes are reported so the author can see how far over it is. */
    class DocumentTooLarge(val actualBytes: Int, val limitBytes: Int = DOCUMENT_BYTES) :
        IllegalStateException("Editor document has $actualBytes bytes; the limit is $limitBytes")

    fun requireDocument(canonical: String) {
        val bytes = canonical.toByteArray(Charsets.UTF_8).size
        if (bytes > DOCUMENT_BYTES) throw DocumentTooLarge(bytes)
    }

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
