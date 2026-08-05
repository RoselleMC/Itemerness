package com.iroselle.itemerness.api

import java.util.Collections
import java.util.TreeMap
import java.util.UUID

/** A namespaced key in an Itemerness data schema. */
data class DataKey(
    val id: ItemKey,
) : Comparable<DataKey> {
    override fun compareTo(other: DataKey): Int = id.compareTo(other.id)

    override fun toString(): String = id.toString()

    companion object {
        @JvmStatic
        fun parse(input: String): DataKey = DataKey(ItemKey.parse(input))
    }
}

/**
 * Platform-neutral values accepted by Itemerness data schemas.
 *
 * Container implementations defensively copy their inputs and never expose mutable storage.
 */
sealed interface ItemDataValue

data class BooleanDataValue(val value: Boolean) : ItemDataValue

data class IntegerDataValue(val value: Int) : ItemDataValue

data class LongDataValue(val value: Long) : ItemDataValue

data class DecimalDataValue(val value: Double) : ItemDataValue {
    init {
        require(value.isFinite()) { "Decimal data values must be finite" }
    }
}

data class StringDataValue(val value: String) : ItemDataValue

data class UuidDataValue(val value: UUID) : ItemDataValue

data class NamespacedKeyDataValue(val value: ItemKey) : ItemDataValue

class ListDataValue(values: Collection<ItemDataValue>) : ItemDataValue {
    val values: List<ItemDataValue> = java.util.List.copyOf(values)

    override fun equals(other: Any?): Boolean = other is ListDataValue && values == other.values

    override fun hashCode(): Int = values.hashCode()

    override fun toString(): String = values.toString()
}

class CompoundDataValue(entries: Map<String, ItemDataValue>) : ItemDataValue {
    val entries: Map<String, ItemDataValue>

    init {
        val sorted = TreeMap<String, ItemDataValue>()
        entries.forEach { (key, value) ->
            require(key.isNotBlank()) { "Compound data keys must not be blank" }
            require(key.length <= MAX_COMPOUND_KEY_LENGTH) {
                "Compound data keys must not exceed $MAX_COMPOUND_KEY_LENGTH characters"
            }
            require(key.codePoints().allMatch { !Character.isISOControl(it) }) {
                "Compound data keys must not contain control characters: $key"
            }
            sorted[key] = value
        }
        this.entries = Collections.unmodifiableMap(sorted)
    }

    override fun equals(other: Any?): Boolean = other is CompoundDataValue && entries == other.entries

    override fun hashCode(): Int = entries.hashCode()

    override fun toString(): String = entries.toString()

    private companion object {
        const val MAX_COMPOUND_KEY_LENGTH = 128
    }
}
