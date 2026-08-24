package com.iroselle.itemerness.editor.agent

import java.nio.file.Files
import java.nio.file.Path
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir

class LocalArtifactStoreTest {
    @Test
    fun `returns nothing before anything is stored`(@TempDir directory: Path) {
        val store = LocalArtifactStore(directory)
        assertNull(store.active())
        assertNull(store.previous())
    }

    @Test
    fun `stores and reads back an artifact`(@TempDir directory: Path) {
        val store = LocalArtifactStore(directory)
        val stored = store.store("""{"a":1}""")

        val active = store.active()
        assertNotNull(active)
        assertEquals(stored.digest, active!!.digest)
        assertEquals("""{"a":1}""", active.json)
        assertTrue(active.digest.startsWith("sha256:"))
    }

    @Test
    fun `keeps the previous artifact so a rollback needs no network`(@TempDir directory: Path) {
        val store = LocalArtifactStore(directory)
        store.store("""{"revision":1}""")
        store.store("""{"revision":2}""")

        assertEquals("""{"revision":2}""", store.active()?.json)
        assertEquals("""{"revision":1}""", store.previous()?.json)
    }

    @Test
    fun `storing the same content twice does not displace the previous artifact`(@TempDir directory: Path) {
        val store = LocalArtifactStore(directory)
        store.store("""{"revision":1}""")
        store.store("""{"revision":2}""")
        store.store("""{"revision":2}""")

        // A repeated publish of the identical document is a no-op, not a reason to lose the only
        // version an operator could roll back to.
        assertEquals("""{"revision":1}""", store.previous()?.json)
    }

    @Test
    fun `rejects a corrupted artifact instead of compiling it`(@TempDir directory: Path) {
        val store = LocalArtifactStore(directory)
        val stored = store.store("""{"a":1}""")
        val file = directory.resolve("artifact-${stored.digest.removePrefix("sha256:")}.json")
        Files.writeString(file, """{"a":2}""")

        // Silently loading tampered content would produce a catalog that is subtly not the one
        // that was reviewed and published.
        assertThrows(LocalArtifactStore.CorruptArtifactException::class.java) { store.active() }
    }

    @Test
    fun `returns nothing when the pointer names a file that is gone`(@TempDir directory: Path) {
        val store = LocalArtifactStore(directory)
        val stored = store.store("""{"a":1}""")
        Files.delete(directory.resolve("artifact-${stored.digest.removePrefix("sha256:")}.json"))

        assertNull(store.active())
    }

    @Test
    fun `prune keeps the active and previous artifacts and removes the rest`(@TempDir directory: Path) {
        val store = LocalArtifactStore(directory)
        store.store("""{"revision":1}""")
        store.store("""{"revision":2}""")
        store.store("""{"revision":3}""")

        val removed = store.prune()

        assertEquals(1, removed)
        assertEquals("""{"revision":3}""", store.active()?.json)
        assertEquals("""{"revision":2}""", store.previous()?.json)
    }

    @Test
    fun `survives a reopen, which is what makes it a cold-start source`(@TempDir directory: Path) {
        LocalArtifactStore(directory).store("""{"revision":9}""")

        // The plugin must be able to start with the control plane unreachable.
        assertEquals("""{"revision":9}""", LocalArtifactStore(directory).active()?.json)
    }
}
