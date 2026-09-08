package com.iroselle.itemerness.bukkit.editor

import com.iroselle.itemerness.bukkit.config.StrictYamlException
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.nio.file.Path
import java.security.MessageDigest
import java.util.HexFormat
import kotlin.io.path.extension

/** A bounded, private snapshot. Configuration credentials never enter the staging directory. */
internal class EditorCatalogFiles private constructor(private val files: Map<String, ByteArray>) {
    val digest: String = run {
        val hash = MessageDigest.getInstance("SHA-256")
        files.toSortedMap().forEach { (path, bytes) ->
            hash.update(path.toByteArray(Charsets.UTF_8))
            hash.update(0.toByte())
            hash.update(MessageDigest.getInstance("SHA-256").digest(bytes))
        }
        "sha256:${HexFormat.of().formatHex(hash.digest())}"
    }

    fun <T> withDirectory(action: (Path) -> T): T {
        val root = Files.createTempDirectory("itemerness-editor-catalog-")
        try {
            DOMAINS.forEach { Files.createDirectory(root.resolve(it)) }
            files.forEach { (name, bytes) ->
                val path = root.resolve(name)
                Files.createDirectories(path.parent)
                Files.write(path, bytes)
            }
            return action(root)
        } finally {
            Files.walk(root).use { paths -> paths.sorted(Comparator.reverseOrder()).forEach(Files::deleteIfExists) }
        }
    }

    companion object {
        val DOMAINS: Set<String> = java.util.Collections.unmodifiableSet(linkedSetOf("data-keys", "items", "formats", "locales", "layouts", "themes", "assets", "viewer-facts"))
        private const val MAX_FILES_PER_DOMAIN = 1024
        private const val MAX_BYTES_PER_DOMAIN = 16 * 1024 * 1024

        fun capture(root: Path): EditorCatalogFiles {
            val files = LinkedHashMap<String, ByteArray>()
            DOMAINS.forEach { domain ->
                val directory = root.resolve(domain)
                if (!Files.isDirectory(directory, NOFOLLOW_LINKS)) {
                    throw StrictYamlException("Missing configuration directory: $domain")
                }
                val paths = Files.walk(directory).use { entries ->
                    entries.peek { path ->
                        if (Files.isSymbolicLink(path)) throw StrictYamlException("Configuration paths cannot be symbolic links")
                    }.filter { Files.isRegularFile(it, NOFOLLOW_LINKS) && it.extension.lowercase() in setOf("yml", "yaml") }
                        .sorted().limit((MAX_FILES_PER_DOMAIN + 1).toLong()).toList()
                }
                if (paths.size > MAX_FILES_PER_DOMAIN) throw StrictYamlException("Too many configuration files in $domain")
                var remaining = MAX_BYTES_PER_DOMAIN
                paths.forEach { path ->
                    // readNBytes applies the bound even when a file grows after discovery.
                    val bytes = Files.newInputStream(path, NOFOLLOW_LINKS).use { it.readNBytes(remaining + 1) }
                    if (bytes.size > remaining) throw StrictYamlException("Configuration byte limit exceeded in $domain")
                    remaining -= bytes.size
                    files[root.relativize(path).joinToString("/")] = bytes
                }
            }
            return EditorCatalogFiles(files)
        }

        fun from(files: Map<String, String>): EditorCatalogFiles {
            val encoded = LinkedHashMap<String, ByteArray>()
            val sizes = HashMap<String, Int>()
            val counts = HashMap<String, Int>()
            files.forEach { (name, value) ->
                val parts = name.split('/')
                require(parts.size >= 2 && parts.first() in DOMAINS && parts.all { it.matches(Regex("[A-Za-z0-9_.-]+")) && it !in setOf(".", "..") }) {
                    "Invalid configuration file path"
                }
                require(parts.last().substringAfterLast('.').lowercase() in setOf("yml", "yaml")) { "Expected a YAML file" }
                val bytes = value.toByteArray(Charsets.UTF_8)
                val size = sizes.getOrDefault(parts.first(), 0).toLong() + bytes.size
                val count = counts.getOrDefault(parts.first(), 0) + 1
                require(size <= MAX_BYTES_PER_DOMAIN && count <= MAX_FILES_PER_DOMAIN) { "Configuration limit exceeded" }
                sizes[parts.first()] = size.toInt()
                counts[parts.first()] = count
                encoded[name] = bytes
            }
            return EditorCatalogFiles(encoded)
        }
    }
}
