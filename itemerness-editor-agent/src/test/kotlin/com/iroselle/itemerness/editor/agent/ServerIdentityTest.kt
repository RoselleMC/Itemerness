package com.iroselle.itemerness.editor.agent

import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Files
import java.nio.file.Path
import java.util.UUID
import java.util.concurrent.Executors

class ServerIdentityTest {
    @TempDir lateinit var directory: Path

    @Test
    fun `identities survive restarts and differ between servers`() {
        val path = directory.resolve("first/editor/server-id")
        val id = ServerIdentity.loadOrCreate(path)
        assertEquals(id, UUID.fromString(id).toString())
        assertEquals(id, ServerIdentity.loadOrCreate(path))
        assertNotEquals(id, ServerIdentity.loadOrCreate(directory.resolve("second/editor/server-id")))
    }

    @Test
    fun `concurrent startup shares one persisted identity`() {
        val path = directory.resolve("editor/server-id")
        Executors.newFixedThreadPool(8).use { pool ->
            val results = (1..16).map { pool.submit<String> { ServerIdentity.loadOrCreate(path) } }.map { it.get() }
            assertEquals(1, results.toSet().size)
            assertEquals(results.first(), Files.readString(path).trim())
        }
    }

    @Test
    fun `corruption never silently replaces a servers identity`() {
        val path = directory.resolve("server-id")
        for (value in listOf("", "not-a-uuid", "a".repeat(100))) {
            Files.writeString(path, value)
            assertThrows(IllegalArgumentException::class.java) { ServerIdentity.loadOrCreate(path) }
            assertEquals(value, Files.readString(path))
        }
    }
}
