package com.iroselle.itemerness.editor.agent

import java.nio.ByteBuffer
import java.nio.channels.FileChannel
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.nio.file.StandardOpenOption
import java.util.UUID

/** Installation identity, independent of the listener address and runtime platform. Call off-thread. */
object ServerIdentity {
    @Synchronized
    fun loadOrCreate(path: Path): String {
        Files.createDirectories(path.parent)
        FileChannel.open(path.resolveSibling("${path.fileName}.lock"), StandardOpenOption.CREATE, StandardOpenOption.WRITE).use { lock ->
            lock.lock().use {
                if (Files.exists(path, LinkOption.NOFOLLOW_LINKS)) {
                    require(Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS) && Files.size(path) <= 64) {
                        "Invalid server identity file: $path"
                    }
                    val value = Files.readString(path).trim()
                    require(UUID.fromString(value).toString() == value) { "Invalid server identity in $path" }
                    return value
                }
                val id = UUID.randomUUID().toString()
                val temporary = Files.createTempFile(path.parent, "server-id-", ".tmp")
                try {
                    FileChannel.open(temporary, StandardOpenOption.WRITE).use { output ->
                        val bytes = ByteBuffer.wrap("$id\n".toByteArray(Charsets.US_ASCII))
                        while (bytes.hasRemaining()) output.write(bytes)
                        output.force(true)
                    }
                    Files.move(temporary, path, StandardCopyOption.ATOMIC_MOVE)
                } finally {
                    Files.deleteIfExists(temporary)
                }
                return id
            }
        }
    }
}
