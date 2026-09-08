package com.iroselle.itemerness.editor.agent

import com.iroselle.itemerness.editor.protocol.Json
import com.iroselle.itemerness.editor.protocol.JsonObject
import com.iroselle.itemerness.editor.protocol.JsonValue
import java.nio.ByteBuffer
import java.nio.channels.FileChannel
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.nio.file.StandardOpenOption

/** Small server-owned metadata. Construction and mutation run on the API I/O worker. */
class ServerMetadataStore(private val path: Path, val serverId: String) {
    class Conflict : RuntimeException("SERVER_ALIAS_CONFLICT")
    private var value: String = if (Files.exists(path, LinkOption.NOFOLLOW_LINKS)) {
        require(Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS) && Files.size(path) <= 4096) { "Invalid server metadata file" }
        val record = JsonObject.of(Json.parse(Files.readString(path)), "server").rejectUnknown("serverId", "alias")
        require(record.requiredString("serverId") == serverId) { "Server metadata identity mismatch" }
        record.requiredString("alias").also(::validate)
    } else ""

    @Synchronized fun alias(): String = value

    @Synchronized fun update(alias: String, expectedAlias: String): String {
        validate(alias)
        if (value != expectedAlias) throw Conflict()
        if (alias == value) return value
        Files.createDirectories(path.parent)
        val temporary = Files.createTempFile(path.parent, "server-metadata-", ".tmp")
        try {
            val record = JsonValue.Obj(mapOf("serverId" to JsonValue.Text(serverId), "alias" to JsonValue.Text(alias)))
            FileChannel.open(temporary, StandardOpenOption.WRITE).use { output ->
                val bytes = ByteBuffer.wrap(Json.canonicalize(record).toByteArray(Charsets.UTF_8))
                while (bytes.hasRemaining()) output.write(bytes)
                output.force(true)
            }
            Files.move(temporary, path, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
            value = alias
            return value
        } finally { Files.deleteIfExists(temporary) }
    }

    companion object {
        fun validate(alias: String) {
            require(alias.length <= 80 && alias == alias.trim() && alias.none(Char::isISOControl)) { "SERVER_ALIAS_INVALID" }
        }
    }
}
