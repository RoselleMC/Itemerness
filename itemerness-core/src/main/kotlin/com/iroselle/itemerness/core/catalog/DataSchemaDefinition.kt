package com.iroselle.itemerness.core.catalog

import com.iroselle.itemerness.api.DataKey
import com.iroselle.itemerness.api.ItemDataValue
import com.iroselle.itemerness.api.ItemKey
import java.math.BigDecimal
import java.util.Collections
import java.util.TreeMap

data class SchemaVersion(
    val id: ItemKey,
    val version: Int,
) : Comparable<SchemaVersion> {
    init {
        require(version > 0) { "Schema versions must be positive" }
    }

    override fun compareTo(other: SchemaVersion): Int {
        val idOrder = id.toString().compareTo(other.id.toString())
        return if (idOrder != 0) idOrder else version.compareTo(other.version)
    }

    override fun toString(): String = "$id@$version"
}

class DataSchemaDefinition internal constructor(
    val identity: SchemaVersion,
    keys: Map<DataKey, DataKeyDefinition>,
) {
    val keys: Map<DataKey, DataKeyDefinition> = immutableSortedMap(keys)

    operator fun get(key: DataKey): DataKeyDefinition? = keys[key]
}

class DataKeyDefinition internal constructor(
    val key: DataKey,
    val type: DataType,
    val scope: DataScope,
    val nullable: Boolean,
    val hasDefault: Boolean,
    val defaultValue: ItemDataValue?,
    val affectsStacking: Boolean,
    val presentationReadable: Boolean,
    internal val constraints: CompiledDataConstraints,
)

internal class CompiledDataConstraints(
    val minimum: BigDecimal?,
    val maximum: BigDecimal?,
    val scale: Int?,
    val maximumCodePoints: Int?,
    val maximumElements: Int?,
    val maximumEntries: Int?,
    val maximumDepth: Int?,
    allowedValues: Collection<ItemDataValue>,
) {
    val allowedValues: Set<ItemDataValue> = Collections.unmodifiableSet(LinkedHashSet(allowedValues))
}

internal fun <K : Comparable<K>, V> immutableSortedMap(source: Map<K, V>): Map<K, V> {
    val sorted = TreeMap<K, V>()
    sorted.putAll(source)
    return Collections.unmodifiableMap(sorted)
}
