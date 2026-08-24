package com.iroselle.itemerness.editor.agent

import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import java.util.HexFormat

/**
 * The last-known-good document, on local disk.
 *
 * A control plane that is unreachable must not take a server's catalog with it. The agent keeps
 * the artifact it last verified so the plugin can start, and keep running, with no network at all.
 *
 * Writes go to a temporary file, are flushed, and are then moved into place, so a crash mid-write
 * leaves either the previous artifact or the new one and never a truncated file. The digest is
 * verified on read for the same reason: a corrupted artifact must be rejected loudly rather than
 * compiled into a catalog that is subtly wrong.
 */
class LocalArtifactStore(private val directory: Path) {
    class CorruptArtifactException(message: String) : RuntimeException(message)

    data class StoredArtifact(val digest: String, val json: String)

    fun store(json: String): StoredArtifact {
        Files.createDirectories(directory)
        val digest = digestOf(json)
        val target = directory.resolve(fileName(digest))
        if (Files.notExists(target)) {
            val temporary = Files.createTempFile(directory, "artifact-", ".tmp")
            try {
                Files.newOutputStream(temporary).use { output ->
                    output.write(json.toByteArray(StandardCharsets.UTF_8))
                    output.flush()
                    // fsync before the rename: without it the directory entry can land ahead of the
                    // bytes, and a power loss leaves a file that exists and is empty.
                    (output as? java.io.FileOutputStream)?.fd?.sync()
                }
                Files.move(temporary, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
            } finally {
                Files.deleteIfExists(temporary)
            }
        }
        writePointer(digest)
        return StoredArtifact(digest, json)
    }

    /** Returns the active artifact, or null when nothing has been stored yet. */
    fun active(): StoredArtifact? {
        val pointer = directory.resolve(POINTER)
        if (Files.notExists(pointer)) return null
        val digest = Files.readString(pointer, StandardCharsets.UTF_8).trim()
        val target = directory.resolve(fileName(digest))
        if (Files.notExists(target)) return null
        val json = Files.readString(target, StandardCharsets.UTF_8)
        val actual = digestOf(json)
        if (actual != digest) {
            throw CorruptArtifactException("Stored artifact $digest hashes to $actual")
        }
        return StoredArtifact(digest, json)
    }

    /** The digest recorded before the current one, for a rollback that needs no network. */
    fun previous(): StoredArtifact? {
        val pointer = directory.resolve(PREVIOUS_POINTER)
        if (Files.notExists(pointer)) return null
        val digest = Files.readString(pointer, StandardCharsets.UTF_8).trim()
        val target = directory.resolve(fileName(digest))
        if (Files.notExists(target)) return null
        val json = Files.readString(target, StandardCharsets.UTF_8)
        return if (digestOf(json) == digest) StoredArtifact(digest, json) else null
    }

    /**
     * Deletes artifacts that are neither active nor the previous one.
     *
     * Retention is deliberately conservative: the two pointers are what a rollback depends on, and
     * a cleanup that removes them would turn a recoverable bad publish into an outage.
     */
    fun prune(): Int {
        if (Files.notExists(directory)) return 0
        val keep = setOfNotNull(active()?.digest, previous()?.digest).map(::fileName).toSet()
        var removed = 0
        Files.newDirectoryStream(directory, "artifact-*.json").use { entries ->
            for (entry in entries) {
                if (entry.fileName.toString() in keep) continue
                Files.deleteIfExists(entry)
                removed += 1
            }
        }
        return removed
    }

    private fun writePointer(digest: String) {
        val pointer = directory.resolve(POINTER)
        if (Files.exists(pointer)) {
            val current = Files.readString(pointer, StandardCharsets.UTF_8).trim()
            if (current != digest) atomicWrite(directory.resolve(PREVIOUS_POINTER), current)
        }
        atomicWrite(pointer, digest)
    }

    private fun atomicWrite(target: Path, content: String) {
        val temporary = Files.createTempFile(directory, "pointer-", ".tmp")
        try {
            Files.writeString(temporary, content, StandardCharsets.UTF_8)
            Files.move(temporary, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        } finally {
            Files.deleteIfExists(temporary)
        }
    }

    private fun fileName(digest: String): String = "artifact-${digest.removePrefix("sha256:")}.json"

    private companion object {
        const val POINTER = "active.pointer"
        const val PREVIOUS_POINTER = "previous.pointer"

        fun digestOf(json: String): String {
            val bytes = MessageDigest.getInstance("SHA-256").digest(json.toByteArray(StandardCharsets.UTF_8))
            return "sha256:${HexFormat.of().formatHex(bytes)}"
        }
    }
}
