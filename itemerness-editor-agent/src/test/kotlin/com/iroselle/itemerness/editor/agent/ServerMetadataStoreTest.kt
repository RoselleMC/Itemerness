package com.iroselle.itemerness.editor.agent

import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Files
import java.nio.file.Path

class ServerMetadataStoreTest {
    @TempDir lateinit var directory: Path
    private val id = "0807ed00-2fd5-45d6-8214-16b77148533e"

    @Test
    fun `aliases persist with their server identity and reject stale changes`() {
        val path = directory.resolve("server-metadata.json")
        val store = ServerMetadataStore(path, id)
        assertEquals("", store.alias())
        assertEquals("Preview", store.update("Preview", ""))
        assertTrue(Files.readString(path).contains(id))
        assertEquals("Preview", ServerMetadataStore(path, id).alias())
        assertThrows(ServerMetadataStore.Conflict::class.java) { store.update("Other", "") }
        assertEquals("Preview", store.alias())
        assertEquals("", store.update("", "Preview"))
        assertEquals("", ServerMetadataStore(path, id).alias())
    }

    @Test
    fun `invalid or mismatched metadata never gets overwritten`() {
        val path = directory.resolve("server-metadata.json")
        val store = ServerMetadataStore(path, id)
        for (alias in listOf("x".repeat(81), "line\nbreak", " padded", "\u0000")) {
            assertThrows(IllegalArgumentException::class.java) { store.update(alias, "") }
        }
        assertFalse(Files.exists(path))
        store.update("Original", "")
        val original = Files.readString(path)
        assertThrows(IllegalArgumentException::class.java) { ServerMetadataStore(path, "another") }
        assertEquals(original, Files.readString(path))
    }
}
