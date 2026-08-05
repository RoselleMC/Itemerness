package com.iroselle.itemerness.projection

import com.iroselle.itemerness.api.ItemKey
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicInteger

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
    /**
     * Opaque immutable catalog retained by the publisher that created this context. Holding the
     * handle makes an already-acquired context safe across a concurrent catalog retirement; NMS
     * adapters must only pass it back to the matching [ItemProjector].
     */
    val catalogHandle: ProjectionCatalogHandle? = null,
) {
    init {
        require(catalogHandle == null || catalogHandle.revision == generation.catalogRevision) {
            "Projection catalog handle revision does not match its generation"
        }
    }
}

/** Opaque, platform-owned immutable catalog lifetime handle. */
interface ProjectionCatalogHandle {
    val revision: Long
}

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
    val resyncRequests: ProjectionResyncSink = ProjectionResyncSink.REJECTING,
    val failures: ProjectionFailureSink = ProjectionFailureSink.REJECTING,
    val pdcFallbackPlans: ProjectionPdcFallbackPlanSource = ProjectionPdcFallbackPlanSource.EMPTY,
)

/**
 * A terminal projection failure. Once emitted, an adapter must remain fail-closed until its owner
 * has completed shutdown; it must never resume forwarding projection carriers unchanged.
 */
data class ProjectionFailure(
    val operation: String,
    val cause: Throwable,
) {
    init {
        require(operation.isNotBlank()) { "Projection failure operation must not be blank" }
    }
}

/**
 * Non-blocking boundary from packet/event-loop code to the platform lifecycle owner. The owner is
 * responsible for moving plugin disable work to the platform's global owning context.
 */
fun interface ProjectionFailureSink {
    /** Returns whether the terminal failure was accepted for lifecycle shutdown. */
    fun offer(failure: ProjectionFailure): Boolean

    companion object {
        val REJECTING: ProjectionFailureSink = ProjectionFailureSink { false }
    }
}

/**
 * An immutable request emitted when an untrusted client packet must be rejected before it can
 * reach the server inventory. Consumers must execute the actual refresh in the viewer's owning
 * entity context.
 */
data class ProjectionResyncRequest(
    val viewerId: UUID,
    val connectionGeneration: Long,
    val slot: Int?,
    val fullInventory: Boolean,
) {
    init {
        require(connectionGeneration >= 0) { "Connection generation must not be negative" }
        require(fullInventory || slot != null) { "A slot is required for a partial resync" }
    }
}

/** A non-blocking boundary from a packet event loop to an owning-context refresh pump. */
interface ProjectionResyncSink {
    fun offer(request: ProjectionResyncRequest): Boolean

    fun discard(viewerId: UUID, connectionGeneration: Long) = Unit

    companion object {
        val REJECTING: ProjectionResyncSink = object : ProjectionResyncSink {
            override fun offer(request: ProjectionResyncRequest): Boolean = false
        }
    }
}

data class ProjectionResyncBatch(
    val viewerId: UUID,
    val connectionGeneration: Long,
    val slots: Set<Int>,
    val fullInventory: Boolean,
)

/**
 * Bounded MPSC queue shared by packet handlers and an entity-scheduler consumer. Requests are
 * isolated by connection generation, duplicate slots are coalesced, and per-connection overflow
 * becomes one full-inventory refresh rather than an unbounded backlog.
 */
class BoundedProjectionResyncQueue(
    private val maxConnections: Int = 1_024,
    private val maxSlotsPerConnection: Int = 64,
) : ProjectionResyncSink {
    private val queues = ConcurrentHashMap<ConnectionKey, Pending>()
    private val connectionCount = AtomicInteger()
    private val readyViewers = ConcurrentLinkedQueue<UUID>()
    private val readyViewerSet = ConcurrentHashMap.newKeySet<UUID>()

    init {
        require(maxConnections > 0) { "Resync connection capacity must be positive" }
        require(maxSlotsPerConnection > 0) { "Resync slot capacity must be positive" }
    }

    override fun offer(request: ProjectionResyncRequest): Boolean {
        val key = ConnectionKey(request.viewerId, request.connectionGeneration)
        var accepted = false
        queues.compute(key) { _, existing ->
            if (existing != null) {
                existing.offer(request)
                accepted = true
                existing
            } else if (connectionCount.incrementAndGet() <= maxConnections) {
                accepted = true
                Pending(maxSlotsPerConnection).also { it.offer(request) }
            } else {
                connectionCount.decrementAndGet()
                null
            }
        }
        if (accepted && readyViewerSet.add(request.viewerId)) {
            readyViewers.offer(request.viewerId)
        }
        return accepted
    }

    /**
     * Polls only viewers that have accepted pending work. The UUID notification is coalesced across
     * connection generations and may be stale after a concurrent disconnect; consumers must still
     * call [drain] and tolerate an empty result. A later accepted request always makes the viewer
     * eligible again.
     */
    fun pollReadyViewers(maxViewers: Int = DEFAULT_MAX_READY_VIEWERS): List<UUID> {
        require(maxViewers in 1..MAX_READY_VIEWERS) {
            "Ready viewer poll limit must be between 1 and $MAX_READY_VIEWERS"
        }
        val result = ArrayList<UUID>(maxViewers)
        while (result.size < maxViewers) {
            val viewerId = readyViewers.poll() ?: break
            if (readyViewerSet.remove(viewerId)) {
                result += viewerId
            }
        }
        return java.util.List.copyOf(result)
    }

    /**
     * Re-enqueues a polled viewer when a bounded downstream consumer cannot yet admit its work.
     * The notification remains UUID-coalesced and is published only while at least one connection
     * generation is still pending. A concurrent discard may leave one harmless stale notice;
     * consumers already tolerate an empty [drain].
     */
    fun retryReady(viewerId: UUID): Boolean {
        if (queues.keys.none { key -> key.viewerId == viewerId }) return false
        if (readyViewerSet.add(viewerId)) {
            readyViewers.offer(viewerId)
        }
        return true
    }

    fun drain(viewerId: UUID, connectionGeneration: Long): ProjectionResyncBatch? {
        val key = ConnectionKey(viewerId, connectionGeneration)
        var batch: ProjectionResyncBatch? = null
        queues.computeIfPresent(key) { _, pending ->
            batch = pending.drain(key)
            connectionCount.decrementAndGet()
            null
        }
        return batch
    }

    /**
     * Drains every currently visible connection generation for one viewer without requiring the
     * Bukkit side to know the NMS generation. An excessive reconnect backlog is removed and
     * coalesced into a full refresh while the returned list remains hard bounded.
     */
    fun drain(viewerId: UUID, maxBatches: Int = DEFAULT_MAX_DRAIN_BATCHES): List<ProjectionResyncBatch> {
        require(maxBatches in 1..MAX_DRAIN_BATCHES) {
            "Resync drain limit must be between 1 and $MAX_DRAIN_BATCHES"
        }
        val generations = queues.keys
            .asSequence()
            .filter { it.viewerId == viewerId }
            .map(ConnectionKey::generation)
            .sorted()
            .toList()
        val drained = generations.mapNotNull { generation -> drain(viewerId, generation) }
        if (drained.size <= maxBatches) {
            return java.util.List.copyOf(drained)
        }
        val bounded = drained.takeLast(maxBatches).toMutableList()
        bounded[0] = bounded[0].copy(slots = emptySet(), fullInventory = true)
        return java.util.List.copyOf(bounded)
    }

    override fun discard(viewerId: UUID, connectionGeneration: Long) {
        val key = ConnectionKey(viewerId, connectionGeneration)
        queues.computeIfPresent(key) { _, _ ->
            connectionCount.decrementAndGet()
            null
        }
    }

    fun pendingConnectionCount(): Int = connectionCount.get()

    private data class ConnectionKey(
        val viewerId: UUID,
        val generation: Long,
    )

    private class Pending(
        private val maxSlots: Int,
    ) {
        private val slots = LinkedHashSet<Int>()
        private var fullInventory = false

        @Synchronized
        fun offer(request: ProjectionResyncRequest) {
            if (fullInventory) {
                return
            }
            if (request.fullInventory) {
                fullInventory = true
                slots.clear()
                return
            }
            val slot = requireNotNull(request.slot)
            slots += slot
            if (slots.size > maxSlots) {
                fullInventory = true
                slots.clear()
            }
        }

        @Synchronized
        fun drain(key: ConnectionKey): ProjectionResyncBatch = ProjectionResyncBatch(
            viewerId = key.viewerId,
            connectionGeneration = key.generation,
            slots = if (fullInventory) emptySet() else java.util.Set.copyOf(slots),
            fullInventory = fullInventory,
        )
    }

    private companion object {
        const val DEFAULT_MAX_DRAIN_BATCHES = 16
        const val MAX_DRAIN_BATCHES = 256
        const val DEFAULT_MAX_READY_VIEWERS = 64
        const val MAX_READY_VIEWERS = 1_024
    }
}

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
