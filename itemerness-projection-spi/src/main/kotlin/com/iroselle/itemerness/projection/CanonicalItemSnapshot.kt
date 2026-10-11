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
     * Vanilla tooltip lines that the exact-version tooltip builder would emit for this physical
     * stack, attributed to the data components that produce them.
     *
     * The default is blocked so that only an adapter that actually ran the exact tooltip builder
     * can let a fixed-geometry theme take ownership of the whole tooltip.
     */
    val tooltipLines: TooltipLineEvidence = TooltipLineEvidence.BLOCKED,
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

/**
 * Empirical evidence about the vanilla tooltip lines of one physical stack.
 *
 * [blocked] is true when lines may appear that no data component controls, or when the adapter
 * could not evaluate the exact tooltip builder; such stacks can never be managed. Otherwise
 * [emittingComponents] lists the data component ids that would add at least one line if shown.
 */
class TooltipLineEvidence(
    val blocked: Boolean,
    emittingComponents: Collection<ItemKey> = emptyList(),
) {
    val emittingComponents: Set<ItemKey> = java.util.Collections.unmodifiableSet(
        java.util.TreeSet(emittingComponents),
    )

    init {
        require(this.emittingComponents.size <= MAX_COMPONENTS) {
            "Tooltip line evidence must not exceed $MAX_COMPONENTS components"
        }
    }

    /**
     * Whether a viewer sees no vanilla tooltip line once every component outside [shown] is
     * hidden, so the projected Name and Lore are the complete tooltip.
     */
    fun managedWith(shown: Set<ItemKey>): Boolean =
        !blocked && emittingComponents.none(shown::contains)

    override fun equals(other: Any?): Boolean =
        this === other ||
            other is TooltipLineEvidence &&
            blocked == other.blocked &&
            emittingComponents == other.emittingComponents

    override fun hashCode(): Int = 31 * blocked.hashCode() + emittingComponents.hashCode()

    override fun toString(): String =
        "TooltipLineEvidence(blocked=$blocked, emittingComponents=$emittingComponents)"

    companion object {
        private const val MAX_COMPONENTS = 1_024

        @JvmField
        val BLOCKED: TooltipLineEvidence = TooltipLineEvidence(blocked = true)

        /** Evidence for a stack whose exact tooltip builder emits no vanilla line at all. */
        @JvmField
        val SILENT: TooltipLineEvidence = TooltipLineEvidence(blocked = false)
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
