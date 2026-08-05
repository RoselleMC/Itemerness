package com.iroselle.itemerness.projection

import com.iroselle.itemerness.api.ItemKey
import java.math.BigDecimal
import java.util.UUID

/** A platform-neutral value copied from validated canonical item data. */
sealed interface ProjectionValue

data class BooleanProjectionValue(
    val value: Boolean,
) : ProjectionValue

data class IntegerProjectionValue(
    val value: Int,
) : ProjectionValue

data class LongProjectionValue(
    val value: Long,
) : ProjectionValue

data class DecimalProjectionValue(
    val value: BigDecimal,
) : ProjectionValue

data class StringProjectionValue(
    val value: String,
) : ProjectionValue {
    init {
        require(value.length <= MAX_LENGTH) {
            "Projection strings must not exceed $MAX_LENGTH characters"
        }
    }

    private companion object {
        const val MAX_LENGTH = 8_192
    }
}

data class UuidProjectionValue(
    val value: UUID,
) : ProjectionValue

data class KeyProjectionValue(
    val value: ItemKey,
) : ProjectionValue

class ListProjectionValue(values: Collection<ProjectionValue>) : ProjectionValue {
    val values: List<ProjectionValue> = java.util.List.copyOf(values)

    init {
        require(this.values.size <= MAX_ELEMENTS) {
            "Projection lists must not exceed $MAX_ELEMENTS elements"
        }
    }

    override fun equals(other: Any?): Boolean =
        this === other || other is ListProjectionValue && values == other.values

    override fun hashCode(): Int = values.hashCode()

    override fun toString(): String = "ListProjectionValue(values=$values)"

    private companion object {
        const val MAX_ELEMENTS = 256
    }
}

class ProjectionCompound(entries: Collection<Entry> = emptyList()) : ProjectionValue {
    val entries: List<Entry> = java.util.List.copyOf(entries.sortedBy(Entry::key))

    init {
        require(this.entries.size <= MAX_ENTRIES) {
            "Projection compounds must not exceed $MAX_ENTRIES entries"
        }
        require(this.entries.mapTo(HashSet()) { it.key }.size == this.entries.size) {
            "Projection compound keys must be unique"
        }
    }

    operator fun get(key: String): ProjectionValue? = entries.firstOrNull { it.key == key }?.value

    override fun equals(other: Any?): Boolean =
        this === other || other is ProjectionCompound && entries == other.entries

    override fun hashCode(): Int = entries.hashCode()

    override fun toString(): String = "ProjectionCompound(entries=$entries)"

    data class Entry(
        val key: String,
        val value: ProjectionValue,
    ) {
        init {
            require(key.isNotBlank()) { "Projection compound key must not be blank" }
            require(key.length <= MAX_KEY_LENGTH) {
                "Projection compound key must not exceed $MAX_KEY_LENGTH characters"
            }
            require(key.none(Char::isISOControl)) {
                "Projection compound key must not contain control characters"
            }
        }
    }

    companion object {
        private const val MAX_ENTRIES = 256
        private const val MAX_KEY_LENGTH = 128
    }
}
