package com.iroselle.itemerness.bukkit.editor

import com.iroselle.itemerness.bukkit.config.EditorEndpoint

internal interface EditorAgentHandle {
    val endpoint: EditorEndpoint

    fun start()

    fun stop()
}

internal interface PreparedEditorAgentPublication {
    fun commit()

    fun rollback()

    fun complete()
}

/** Guards the paired endpoint across reloads; changing it requires a server restart. */
internal class EditorAgentCoordinator(
    private val factory: (EditorEndpoint) -> EditorAgentHandle,
) : AutoCloseable {
    private var active: EditorAgentHandle? = null
    private var closed = false

    @Synchronized
    fun start(endpoint: EditorEndpoint?) {
        check(!closed) { "Editor agent coordinator is closed" }
        check(active == null) { "Editor agent has already been started" }
        if (endpoint == null) return
        val candidate = factory(endpoint)
        try {
            candidate.start()
            active = candidate
        } catch (failure: Throwable) {
            runCatching(candidate::stop).onFailure(failure::addSuppressed)
            throw failure
        }
    }

    @Synchronized
    fun prepare(endpoint: EditorEndpoint?): PreparedEditorAgentPublication {
        check(!closed) { "Editor agent coordinator is closed" }
        val current = active?.endpoint
        check(current == endpoint) {
            "Changing editor.url or editor.token requires a server restart"
        }
        return NoOpEditorAgentPublication
    }

    @Synchronized
    override fun close() {
        if (closed) return
        closed = true
        active.also { active = null }?.stop()
    }

    private object NoOpEditorAgentPublication : PreparedEditorAgentPublication {
        override fun commit() = Unit

        override fun rollback() = Unit

        override fun complete() = Unit
    }
}
