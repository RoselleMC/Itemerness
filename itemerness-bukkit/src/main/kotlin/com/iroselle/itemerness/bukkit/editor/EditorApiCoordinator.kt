package com.iroselle.itemerness.bukkit.editor

import com.iroselle.itemerness.bukkit.config.EditorEndpoint

internal interface EditorApiHandle {
    val endpoint: EditorEndpoint

    fun start()

    fun stop()
}

internal interface PreparedEditorApiPublication {
    fun commit()

    fun rollback()

    fun complete()
}

/** Guards the plugin API listener across reloads; changing it requires a server restart. */
internal class EditorApiCoordinator(
    private val factory: (EditorEndpoint) -> EditorApiHandle,
) : AutoCloseable {
    private var active: EditorApiHandle? = null
    private var closed = false

    @Synchronized
    fun start(endpoint: EditorEndpoint?) {
        check(!closed) { "Editor API coordinator is closed" }
        check(active == null) { "Editor API has already been started" }
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
    fun prepare(endpoint: EditorEndpoint?): PreparedEditorApiPublication {
        check(!closed) { "Editor API coordinator is closed" }
        val current = active?.endpoint
        check(current == endpoint) {
            "Changing editor API settings requires a server restart"
        }
        return NoOpEditorAgentPublication
    }

    @Synchronized
    override fun close() {
        if (closed) return
        closed = true
        active.also { active = null }?.stop()
    }

    private object NoOpEditorAgentPublication : PreparedEditorApiPublication {
        override fun commit() = Unit

        override fun rollback() = Unit

        override fun complete() = Unit
    }
}
