package com.iroselle.itemerness.projection

import com.iroselle.itemerness.api.DataKey
import com.iroselle.itemerness.api.ItemKey

/** Scalar types that can be read from an explicitly declared, read-only PDC fallback. */
enum class ProjectionPdcScalarType {
    BOOLEAN,
    INTEGER,
    LONG,
    DECIMAL,
    STRING,
    UUID,
    NAMESPACED_KEY,
}

class ProjectionPdcFallback(
    itemKeys: Collection<ItemKey>,
    val dataKey: DataKey,
    val pdcKey: ItemKey,
    val type: ProjectionPdcScalarType,
) {
    val itemKeys: Set<ItemKey> = java.util.Collections.unmodifiableSet(LinkedHashSet(itemKeys))

    init {
        require(this.itemKeys.isNotEmpty()) { "Projection PDC fallbacks must target at least one item" }
        require(this.itemKeys.size == itemKeys.size) { "Projection PDC fallback item keys must be unique" }
    }

    override fun equals(other: Any?): Boolean =
        this === other ||
            other is ProjectionPdcFallback &&
            itemKeys == other.itemKeys &&
            dataKey == other.dataKey &&
            pdcKey == other.pdcKey &&
            type == other.type

    override fun hashCode(): Int {
        var result = itemKeys.hashCode()
        result = 31 * result + dataKey.hashCode()
        result = 31 * result + pdcKey.hashCode()
        result = 31 * result + type.hashCode()
        return result
    }

    override fun toString(): String =
        "ProjectionPdcFallback(itemKeys=$itemKeys, dataKey=$dataKey, pdcKey=$pdcKey, type=$type)"
}

/**
 * Immutable extraction plan for one retained catalog revision.
 *
 * Entries retain source order because a data key may declare more than one fallback. Exact-version
 * adapters read only entries eligible for the current item and never scan an item's complete PDC
 * namespace.
 */
class ProjectionPdcFallbackPlan(entries: Collection<ProjectionPdcFallback> = emptyList()) {
    val entries: List<ProjectionPdcFallback> = java.util.List.copyOf(entries)

    init {
        require(this.entries.size <= MAX_ENTRIES) {
            "Projection PDC fallback plans must not exceed $MAX_ENTRIES entries"
        }
        require(this.entries.toSet().size == this.entries.size) {
            "Projection PDC fallback entries must be unique"
        }
        this.entries.groupBy(ProjectionPdcFallback::pdcKey).forEach { (pdcKey, declarations) ->
            require(declarations.map(ProjectionPdcFallback::type).distinct().size == 1) {
                "Physical PDC key $pdcKey must have one scalar type"
            }
        }
    }

    companion object {
        val EMPTY = ProjectionPdcFallbackPlan()
        private const val MAX_ENTRIES = 256
    }
}

fun interface ProjectionPdcFallbackPlanSource {
    /** Returns the plan owned by [context]'s retained catalog, or an empty plan if unavailable. */
    fun acquire(context: ProjectionContext): ProjectionPdcFallbackPlan

    companion object {
        val EMPTY = ProjectionPdcFallbackPlanSource { ProjectionPdcFallbackPlan.EMPTY }
    }
}
