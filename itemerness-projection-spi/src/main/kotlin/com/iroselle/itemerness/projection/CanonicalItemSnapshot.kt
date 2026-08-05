package com.iroselle.itemerness.projection

import com.iroselle.itemerness.api.ItemKey
import java.util.Arrays
import java.util.UUID

/**
 * The immutable, NMS-free portion of a canonical stack needed by a projector.
 *
 * The exact-version adapter owns NBT decoding and never exposes its native stack through this
 * contract.
 */
data class CanonicalItemSnapshot(
    val itemKey: ItemKey,
    val materialKey: ItemKey,
    val count: Int,
    /** Plain pending-name text retained for catalog-level identity consistency validation. */
    val pendingName: String,
    val createdAgainstRevision: Long,
    /** Monotonic revision of canonical instance data, starting at zero on creation. */
    val instanceRevision: Long,
    val dataSchemas: CanonicalDataSchemas,
    val instanceId: UUID?,
    val data: ProjectionCompound,
    val fingerprint: CanonicalItemFingerprint,
    /**
     * Whether the exact-version adapter proved that replacing all vanilla tooltip detail lines is
     * safe for this physical stack.
     *
     * This is deliberately false by default. Only an adapter that has inspected both the concrete
     * item implementation and its effective data components may grant this capability.
     */
    val canManageVanillaTooltipLines: Boolean = false,
    /**
     * Values resolved from catalog-declared, read-only PDC fallbacks by the exact-version adapter.
     * Keys are canonical data-key strings. Canonical and definition values still have precedence.
     */
    val pdcFallbackData: ProjectionCompound = ProjectionCompound(),
) {
    init {
        require(count > 0) { "Canonical item count must be positive" }
        require(pendingName.isNotBlank()) { "Canonical pending name must not be blank" }
        require(createdAgainstRevision >= 0) {
            "Canonical creation revision must not be negative"
        }
        require(instanceRevision >= 0) {
            "Canonical instance revision must not be negative"
        }
    }
}

data class CanonicalDataSchemaVersion(
    val schemaKey: ItemKey,
    val version: Int,
) {
    init {
        require(version > 0) { "Canonical data schema version must be positive" }
    }
}

class CanonicalDataSchemas(entries: Collection<CanonicalDataSchemaVersion>) {
    val entries: List<CanonicalDataSchemaVersion> = java.util.List.copyOf(
        entries.sortedBy { entry -> entry.schemaKey.toString() },
    )

    init {
        require(this.entries.size <= MAX_ENTRIES) {
            "Canonical data schemas must not exceed $MAX_ENTRIES entries"
        }
        require(this.entries.mapTo(HashSet()) { entry -> entry.schemaKey }.size == this.entries.size) {
            "Canonical data schema keys must be unique"
        }
    }

    operator fun get(key: ItemKey): Int? =
        entries.firstOrNull { entry -> entry.schemaKey == key }?.version

    override fun equals(other: Any?): Boolean =
        this === other || other is CanonicalDataSchemas && entries == other.entries

    override fun hashCode(): Int = entries.hashCode()

    override fun toString(): String = "CanonicalDataSchemas(entries=$entries)"

    private companion object {
        const val MAX_ENTRIES = 64
    }
}

/** An implementation-defined digest of the canonical stack state used for cache identity. */
class CanonicalItemFingerprint(bytes: ByteArray) {
    private val content: ByteArray = bytes.copyOf()

    init {
        require(content.isNotEmpty()) { "Canonical item fingerprint must not be empty" }
    }

    val size: Int
        get() = content.size

    fun copyBytes(): ByteArray = content.copyOf()

    override fun equals(other: Any?): Boolean =
        this === other || other is CanonicalItemFingerprint && content.contentEquals(other.content)

    override fun hashCode(): Int = Arrays.hashCode(content)

    override fun toString(): String = "CanonicalItemFingerprint(size=$size)"
}
