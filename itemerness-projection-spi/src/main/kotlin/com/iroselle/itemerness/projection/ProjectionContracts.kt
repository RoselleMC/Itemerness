package com.iroselle.itemerness.projection

import com.iroselle.itemerness.api.ItemKey
import java.util.UUID

data class ProjectionGeneration(
    val catalogRevision: Long,
    val epoch: Long,
) {
    init {
        require(catalogRevision >= 0) { "Catalog revision must not be negative" }
        require(epoch >= 0) { "Projection epoch must not be negative" }
    }
}

data class ProjectionContext(
    val viewer: ViewerProjectionSnapshot,
    val generation: ProjectionGeneration,
)

fun interface ProjectionContextSource {
    /**
     * Returns one internally consistent viewer and catalog generation snapshot. Implementations
     * must be thread-safe, non-blocking, bounded, and must only read already-published immutable
     * state.
     */
    fun acquire(viewerId: UUID): ProjectionContext?
}

data class ProjectionRequest(
    val canonical: CanonicalItemSnapshot,
    val context: ProjectionContext,
)

fun interface ItemProjector {
    /**
     * Validates the decoded pending name and schema versions against the current catalog before
     * rendering. Implementations must be thread-safe, non-blocking, bounded, and must not access
     * Bukkit objects, files, networks, databases, or third-party plugin callbacks.
     */
    fun project(request: ProjectionRequest): ProjectionResult
}

sealed interface ProjectionResult {
    data class Rendered(
        val display: RenderedDisplay,
    ) : ProjectionResult

    data class Fallback(
        val reason: ProjectionFallbackReason,
    ) : ProjectionResult
}

enum class ProjectionFallbackReason {
    DEFINITION_NOT_FOUND,
    INVALID_CANONICAL_DATA,
    RENDER_LIMIT_EXCEEDED,
    RENDERING_FAILED,
}

class ProjectionRuntime(
    val projector: ItemProjector,
    val contexts: ProjectionContextSource,
)

data class MinecraftVersion(
    val value: String,
) {
    init {
        require(PATTERN.matches(value)) { "Invalid Minecraft version: $value" }
    }

    companion object {
        private val PATTERN = Regex("[0-9]+(?:\\.[0-9]+){1,2}(?:[-+][A-Za-z0-9._-]+)?")
    }
}

data class ProjectionAdapterDescriptor(
    val id: ItemKey,
    val minecraftVersion: MinecraftVersion,
)

/** Service-loaded entry point for one exact Minecraft ABI. */
interface ProjectionAdapterFactory {
    val descriptor: ProjectionAdapterDescriptor

    fun create(runtime: ProjectionRuntime): ProjectionAdapter
}

/** Lifecycle owned by the final platform module. */
interface ProjectionAdapter : AutoCloseable {
    val descriptor: ProjectionAdapterDescriptor

    /** Installs connection hooks. Implementations accept exactly one successful start. */
    fun start()

    /** Removes hooks and releases connection state. Closing an already closed adapter is safe. */
    override fun close()
}
