package com.iroselle.itemerness.bukkit.editor

import com.iroselle.itemerness.bukkit.config.EditorEndpoint
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test

class EditorAgentCoordinatorTest {
    @Test
    fun `unchanged endpoint participates in catalog publication as a no-op`() {
        val events = mutableListOf<String>()
        val coordinator = coordinator(events)
        coordinator.start(endpoint("old"))

        val publication = coordinator.prepare(endpoint("old"))
        publication.commit()
        publication.complete()
        coordinator.close()

        assertEquals(listOf("start:old", "stop:old"), events)
    }

    @Test
    fun `rotating credentials during reload is rejected without touching the old connection`() {
        val events = mutableListOf<String>()
        val coordinator = coordinator(events)
        coordinator.start(endpoint("old"))

        assertThrows(IllegalStateException::class.java) {
            coordinator.prepare(endpoint("new"))
        }
        coordinator.close()

        assertEquals(listOf("start:old", "stop:old"), events)
    }

    @Test
    fun `enabling or disabling pairing during reload requires restart`() {
        val events = mutableListOf<String>()
        val disabled = coordinator(events)
        assertThrows(IllegalStateException::class.java) {
            disabled.prepare(endpoint("new"))
        }
        disabled.close()

        val enabled = coordinator(events)
        enabled.start(endpoint("old"))
        assertThrows(IllegalStateException::class.java) {
            enabled.prepare(null)
        }
        enabled.close()

        assertEquals(listOf("start:old", "stop:old"), events)
    }

    @Test
    fun `failed initial start stops the partially constructed agent`() {
        val events = mutableListOf<String>()
        val coordinator = EditorAgentCoordinator { endpoint ->
            FakeHandle(endpoint, events, failStart = endpoint.token == "bad")
        }
        assertThrows(IllegalStateException::class.java) {
            coordinator.start(endpoint("bad"))
        }
        coordinator.close()

        assertEquals(listOf("start:bad", "stop:bad"), events)
    }

    private fun coordinator(events: MutableList<String>): EditorAgentCoordinator =
        EditorAgentCoordinator { endpoint -> FakeHandle(endpoint, events) }

    private fun endpoint(token: String): EditorEndpoint =
        EditorEndpoint("https://items.example.com", token)

    private class FakeHandle(
        override val endpoint: EditorEndpoint,
        private val events: MutableList<String>,
        private val failStart: Boolean = false,
    ) : EditorAgentHandle {
        override fun start() {
            events += "start:${endpoint.token}"
            if (failStart) throw IllegalStateException("start failed")
        }

        override fun stop() {
            events += "stop:${endpoint.token}"
        }
    }
}
