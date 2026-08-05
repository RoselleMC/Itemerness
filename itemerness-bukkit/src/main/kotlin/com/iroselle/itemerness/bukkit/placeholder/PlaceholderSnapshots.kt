package com.iroselle.itemerness.bukkit.placeholder

import com.iroselle.itemerness.api.DataKey
import com.iroselle.itemerness.api.ItemKey
import com.iroselle.itemerness.projection.LocaleId
import java.time.Clock
import java.time.Duration
import java.time.Instant
import java.util.Collections
import java.util.TreeMap
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

internal fun interface PlaceholderSnapshotLookup {
    fun find(viewerId: UUID): PlaceholderViewerSnapshot?
}

/**
 * The complete, preformatted state exposed to PlaceholderAPI for one held item.
 *
 * Only schema-approved scalar strings belong in [exposedData]. Raw NBT and mutable Bukkit
 * objects are deliberately not representable here.
 */
internal class PlaceholderItemSnapshot(
    val present: Boolean,
    val id: ItemKey?,
    val instanceId: UUID?,
    val namePlain: String?,
    exposedData: Map<DataKey, String> = emptyMap(),
) {
    val exposedData: Map<DataKey, String> = Collections.unmodifiableMap(TreeMap(exposedData))

    init {
        if (present) {
            requireNotNull(id) { "A present placeholder item must have an id" }
        } else {
            require(id == null) { "An absent placeholder item must not have an id" }
            require(instanceId == null) { "An absent placeholder item must not have an instance id" }
            require(namePlain == null) { "An absent placeholder item must not have a display name" }
            require(this.exposedData.isEmpty()) { "An absent placeholder item must not expose data" }
        }
    }

    operator fun get(key: DataKey): String? = exposedData[key]

    companion object {
        @JvmStatic
        fun absent(): PlaceholderItemSnapshot = PlaceholderItemSnapshot(
            present = false,
            id = null,
            instanceId = null,
            namePlain = null,
        )
    }
}

/** A Bukkit-free immutable snapshot consumed by the PAPI callback. */
internal class PlaceholderViewerSnapshot(
    val viewerId: UUID,
    val catalogRevision: Long,
    val locale: LocaleId,
    val theme: ItemKey,
    val assetProfile: ItemKey?,
    val mainHand: PlaceholderItemSnapshot,
    val offHand: PlaceholderItemSnapshot,
) {
    init {
        require(catalogRevision >= 0) { "Catalog revision must not be negative" }
    }
}

/**
 * Publishes immutable viewer snapshots from entity-owned work and serves lock-free readers.
 * Stale entries fail closed instead of making a PAPI callback wait for a Bukkit scheduler.
 */
internal class PlaceholderSnapshotStore(
    private val maxAge: Duration = DEFAULT_MAX_AGE,
    private val clock: Clock = Clock.systemUTC(),
) : PlaceholderSnapshotLookup {
    private val snapshots = ConcurrentHashMap<UUID, PublishedSnapshot>()

    init {
        require(!maxAge.isZero && !maxAge.isNegative) { "Placeholder snapshot max age must be positive" }
    }

    fun publish(snapshot: PlaceholderViewerSnapshot) {
        snapshots[snapshot.viewerId] = PublishedSnapshot(snapshot, clock.instant())
    }

    override fun find(viewerId: UUID): PlaceholderViewerSnapshot? {
        val published = snapshots[viewerId] ?: return null
        if (isStale(published, clock.instant())) {
            snapshots.remove(viewerId, published)
            return null
        }
        return published.snapshot
    }

    fun remove(viewerId: UUID) {
        snapshots.remove(viewerId)
    }

    fun clear() {
        snapshots.clear()
    }

    private fun isStale(published: PublishedSnapshot, now: Instant): Boolean =
        now.isAfter(published.publishedAt.plus(maxAge))

    private data class PublishedSnapshot(
        val snapshot: PlaceholderViewerSnapshot,
        val publishedAt: Instant,
    )

    private companion object {
        val DEFAULT_MAX_AGE: Duration = Duration.ofSeconds(30)
    }
}
