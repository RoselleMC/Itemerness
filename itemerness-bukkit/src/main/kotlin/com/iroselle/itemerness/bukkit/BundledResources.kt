package com.iroselle.itemerness.bukkit

import org.bukkit.plugin.java.JavaPlugin
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption

internal object BundledResources {
    const val INDEX_PATH: String = "itemerness-resources.txt"
    const val STATE_FILE_NAME: String = ".itemerness-resources-state"

    fun extract(plugin: JavaPlugin) {
        val index = checkNotNull(plugin.getResource(INDEX_PATH)) {
            "Missing bundled resource index: $INDEX_PATH"
        }
        val paths = index.bufferedReader(Charsets.UTF_8).use { reader ->
            parseIndex(reader.readText())
        }

        val dataDirectory = plugin.dataFolder.toPath().toAbsolutePath().normalize()
        val stateFile = dataDirectory.resolve(STATE_FILE_NAME)
        val recorded = readState(stateFile).toSet()

        paths.forEach { path ->
            checkNotNull(plugin.getResource(path)) {
                "Bundled resource does not exist: $path"
            }.close()
        }

        val updated = installIndexedResources(
            paths = paths,
            recorded = recorded,
            exists = { path -> Files.exists(dataDirectory.resolve(path).normalize()) },
            copy = { path ->
                val destination = dataDirectory.resolve(path).normalize()
                check(destination.startsWith(dataDirectory)) {
                    "Bundled resource escapes the plugin data directory: $path"
                }
                plugin.saveResource(path, false)
            },
        )

        if (updated != recorded || Files.notExists(stateFile)) {
            writeState(stateFile, updated)
        }
    }

    internal fun installIndexedResources(
        paths: List<String>,
        recorded: Set<String>,
        exists: (String) -> Boolean,
        copy: (String) -> Unit,
    ): Set<String> = buildSet {
        addAll(recorded)
        paths.forEach { path ->
            if (path !in this) {
                if (!exists(path)) copy(path)
                add(path)
            }
        }
    }

    fun parseIndex(content: String): List<String> =
        parsePaths(content, "Bundled resource index")

    internal fun parseState(content: String): List<String> =
        parsePaths(content, "Bundled resource state")

    internal fun renderState(paths: Collection<String>): String = buildString {
        appendLine("# Paths already installed from the bundled resource index.")
        paths.forEach { path -> appendLine(path) }
    }

    private fun parsePaths(content: String, label: String): List<String> {
        val paths = content.lineSequence()
            .map(String::trim)
            .filter { it.isNotEmpty() && !it.startsWith("#") }
            .toList()

        check(paths.size == paths.toSet().size) {
            "$label contains duplicate paths"
        }
        paths.forEach { path ->
            check(!path.startsWith("/") && path.split('/').none { it == ".." || it.isEmpty() }) {
                "$label contains an unsafe path: $path"
            }
        }
        return paths
    }

    private fun readState(path: Path): List<String> =
        if (Files.exists(path)) {
            parseState(Files.readString(path, Charsets.UTF_8))
        } else {
            emptyList()
        }

    private fun writeState(path: Path, resources: Collection<String>) {
        Files.createDirectories(path.parent)
        val temporary = path.resolveSibling("${path.fileName}.tmp")
        Files.writeString(temporary, renderState(resources), Charsets.UTF_8)
        try {
            Files.move(
                temporary,
                path,
                StandardCopyOption.ATOMIC_MOVE,
                StandardCopyOption.REPLACE_EXISTING,
            )
        } catch (_: AtomicMoveNotSupportedException) {
            Files.move(temporary, path, StandardCopyOption.REPLACE_EXISTING)
        }
    }
}
