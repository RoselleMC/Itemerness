package com.iroselle.itemerness.editor.agent

import com.iroselle.itemerness.editor.protocol.Json
import com.iroselle.itemerness.editor.protocol.JsonObject
import com.iroselle.itemerness.editor.protocol.JsonValue
import java.nio.ByteBuffer
import java.nio.channels.FileChannel
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.nio.file.StandardOpenOption
import java.security.MessageDigest
import java.util.HexFormat

/** One serialized, atomic authoring draft. This file is never an active catalog artifact. */
class EditorDraftStore(
    private val path: Path,
    /** The server's current transfer limits; saves follow them, reads accept up to the hard ceiling. */
    private val limits: () -> EditorTransferLimits = { EditorTransferLimits() },
    private val validate: (String) -> Unit,
) {
    class Conflict(val actualHash: String) : RuntimeException("Draft changed")

    data class Snapshot(val document: JsonValue, val snapshotHash: String, val revision: Int) {
        fun json(): JsonValue = JsonValue.Obj(mapOf(
            "document" to document,
            "snapshotHash" to JsonValue.Text(snapshotHash),
            "revision" to JsonValue.Num(revision.toDouble()),
        ))
    }

    private var loaded = false
    private var current: Snapshot? = null

    @Synchronized
    fun read(): Snapshot? {
        if (!loaded) {
            if (Files.exists(path)) {
                // A draft saved under a higher limit stays readable after the operator lowers it.
                require(Files.size(path) <= MAX_BYTES + 1024) { "Editor draft exceeds size limit" }
                val saved = JsonObject.of(Json.parse(Files.readString(path)), "draft")
                val document = requireNotNull(saved.raw("document"))
                val canonical = Json.canonicalize(document)
                validate(canonical)
                val hash = digest(canonical)
                require(saved.requiredString("snapshotHash") == hash) { "Editor draft hash mismatch" }
                val revision = saved.requiredInt("revision")
                require(revision >= 1) { "Invalid editor draft revision" }
                current = Snapshot(document, hash, revision)
            }
            loaded = true
        }
        return current
    }

    @Synchronized
    fun save(document: JsonValue, expectedHash: String): Snapshot {
        val previous = read()
        if (expectedHash != (previous?.snapshotHash ?: "")) throw Conflict(previous?.snapshotHash ?: "")
        val canonical = Json.canonicalize(document)
        limits().requireDocument(canonical)
        validate(canonical)
        val hash = digest(canonical)
        if (previous?.snapshotHash == hash) return previous
        val next = Snapshot(document, hash, Math.incrementExact(previous?.revision ?: 0))
        Files.createDirectories(path.parent)
        val temporary = Files.createTempFile(path.parent, "draft-", ".tmp")
        try {
            FileChannel.open(temporary, StandardOpenOption.WRITE).use { channel ->
                val bytes = ByteBuffer.wrap(Json.canonicalize(next.json()).toByteArray(Charsets.UTF_8))
                while (bytes.hasRemaining()) channel.write(bytes)
                channel.force(true)
            }
            Files.move(temporary, path, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
            current = next
        } finally {
            Files.deleteIfExists(temporary)
        }
        return next
    }

    /**
     * Rewrites the stored draft's limits to [budgets] when they differ, as a new revision.
     *
     * Limits are server configuration, not authored content: after an operator changes them, a
     * draft saved under the old ones must still open instead of failing every preview.
     */
    @Synchronized
    fun alignBudgets(budgets: JsonValue.Obj, defaults: JsonValue.Obj): Snapshot? {
        val previous = read() ?: return null
        val document = previous.document as? JsonValue.Obj ?: return previous
        val stored = document.entries["budgets"] ?: defaults
        if (stored == budgets) return previous
        return save(JsonValue.Obj(document.entries + ("budgets" to budgets)), previous.snapshotHash)
    }

    companion object {
        /** The draft file holds one document plus a small envelope. */
        const val MAX_BYTES: Int = EditorTransferLimits.MAXIMUM_DOCUMENT_BYTES

        fun digest(canonical: String): String = "sha256:" + HexFormat.of().formatHex(
            MessageDigest.getInstance("SHA-256").digest(canonical.toByteArray(Charsets.UTF_8)),
        )
    }
}
