package com.iroselle.itemerness.core.catalog

import com.iroselle.itemerness.api.BooleanDataValue
import com.iroselle.itemerness.api.CompoundDataValue
import com.iroselle.itemerness.api.DataKey
import com.iroselle.itemerness.api.DecimalDataValue
import com.iroselle.itemerness.api.IntegerDataValue
import com.iroselle.itemerness.api.ItemDataValue
import com.iroselle.itemerness.api.ItemKey
import com.iroselle.itemerness.api.ListDataValue
import com.iroselle.itemerness.api.LongDataValue
import com.iroselle.itemerness.api.NamespacedKeyDataValue
import com.iroselle.itemerness.api.StringDataValue
import com.iroselle.itemerness.api.UuidDataValue
import java.nio.charset.StandardCharsets
import java.util.UUID

/** Stable physical limits shared by catalog validation and the exact NMS canonical codec. */
object CanonicalStorageLimits {
    const val MAX_SCHEMA_ENTRIES = 64
    const val MAX_COMPOUND_ENTRIES = 256
    const val MAX_LIST_ELEMENTS = 256
    const val MAX_DEPTH = 16
    const val MAX_VALUE_NODES = 2_048
    const val MAX_TOTAL_UTF8_BYTES = 262_144
    const val MAX_KEY_LENGTH = 128
    const val MAX_ITEM_ID_LENGTH = 256
    const val MAX_PENDING_NAME_LENGTH = 1_024
    const val MAX_STRING_LENGTH = 8_192
}

object CanonicalStorageValidator {
    fun validate(
        instance: CanonicalItemInstance,
        pendingName: String,
    ): List<String> = validate(
        itemKey = instance.itemKey,
        schemaVersions = instance.schemaVersions,
        instanceId = instance.instanceId,
        data = instance.data,
        pendingName = pendingName,
    )

    fun validate(instance: CanonicalItemInstance): List<String> =
        validate(
            itemKey = instance.itemKey,
            schemaVersions = instance.schemaVersions,
            instanceId = instance.instanceId,
            data = instance.data,
            pendingName = null,
        )

    fun validate(
        itemKey: ItemKey,
        schemaVersions: Map<ItemKey, Int>,
        data: Map<DataKey, ItemDataValue>,
    ): List<String> = validate(
        itemKey = itemKey,
        schemaVersions = schemaVersions,
        instanceId = null,
        data = data,
        pendingName = null,
    )

    internal fun requireValid(instance: CanonicalItemInstance) {
        requireValid(
            itemKey = instance.itemKey,
            schemaVersions = instance.schemaVersions,
            instanceId = instance.instanceId,
            data = instance.data,
        )
    }

    internal fun requireValid(
        itemKey: ItemKey,
        schemaVersions: Map<ItemKey, Int>,
        instanceId: UUID?,
        data: Map<DataKey, ItemDataValue>,
    ) {
        val failures = validate(itemKey, schemaVersions, instanceId, data, pendingName = null)
        require(failures.isEmpty()) {
            "Canonical instance exceeds physical storage limits: ${failures.joinToString()}"
        }
    }

    private fun validate(
        itemKey: ItemKey,
        schemaVersions: Map<ItemKey, Int>,
        instanceId: UUID?,
        data: Map<DataKey, ItemDataValue>,
        pendingName: String?,
    ): List<String> {
        val failures = ArrayList<String>()
        val budget = Budget()
        budget.node(failures)
        budget.string(
            itemKey.toString(),
            CanonicalStorageLimits.MAX_ITEM_ID_LENGTH,
            "item id",
            failures,
        )
        if (pendingName != null) validatePendingName(pendingName, budget, failures)
        if (schemaVersions.size > CanonicalStorageLimits.MAX_SCHEMA_ENTRIES) {
            failures += "data schema map exceeds ${CanonicalStorageLimits.MAX_SCHEMA_ENTRIES} entries"
        } else if (budget.node(failures)) {
            schemaVersions.forEach { (key, version) ->
                if (version <= 0) failures += "schema $key has a non-positive version"
                budget.string(key.toString(), CanonicalStorageLimits.MAX_KEY_LENGTH, "schema key", failures)
                if (!budget.node(failures)) return@forEach
            }
        }
        if (instanceId != null) budget.node(failures)
        validateEntries(
            size = data.size,
            entries = data.entries.asSequence().map { (key, value) -> key.toString() to value },
            depth = 0,
            budget = budget,
            failures = failures,
        )
        return java.util.List.copyOf(failures.distinct())
    }

    fun validateValue(value: ItemDataValue): List<String> {
        val failures = ArrayList<String>()
        validateValue(value, 0, Budget(), failures)
        return java.util.List.copyOf(failures.distinct())
    }

    fun validatePendingName(pendingName: String): List<String> {
        val failures = ArrayList<String>()
        validatePendingName(pendingName, Budget(), failures)
        return java.util.List.copyOf(failures.distinct())
    }

    private fun validatePendingName(
        pendingName: String,
        budget: Budget,
        failures: MutableList<String>,
    ) {
        val inspected = pendingName.take(CanonicalStorageLimits.MAX_PENDING_NAME_LENGTH + 1)
        if (inspected.isBlank()) failures += "pending name must not be blank"
        if (inspected.any(Char::isISOControl)) failures += "pending name must not contain control characters"
        budget.string(
            pendingName,
            CanonicalStorageLimits.MAX_PENDING_NAME_LENGTH,
            "pending name",
            failures,
        )
    }

    private fun validateCompound(
        entries: Map<String, ItemDataValue>,
        depth: Int,
        budget: Budget,
        failures: MutableList<String>,
    ) = validateEntries(entries.size, entries.entries.asSequence().map { it.toPair() }, depth, budget, failures)

    private fun validateEntries(
        size: Int,
        entries: Sequence<Pair<String, ItemDataValue>>,
        depth: Int,
        budget: Budget,
        failures: MutableList<String>,
    ) {
        if (depth > CanonicalStorageLimits.MAX_DEPTH) {
            failures += "data exceeds maximum depth"
            return
        }
        if (size > CanonicalStorageLimits.MAX_COMPOUND_ENTRIES) {
            failures += "compound exceeds ${CanonicalStorageLimits.MAX_COMPOUND_ENTRIES} entries"
            return
        }
        if (!budget.node(failures)) return
        entries.take(CanonicalStorageLimits.MAX_COMPOUND_ENTRIES).forEach { (key, value) ->
            budget.string(key, CanonicalStorageLimits.MAX_KEY_LENGTH, "compound key", failures)
            validateValue(value, depth + 1, budget, failures)
        }
    }

    private fun validateValue(
        value: ItemDataValue,
        depth: Int,
        budget: Budget,
        failures: MutableList<String>,
    ) {
        if (depth > CanonicalStorageLimits.MAX_DEPTH) {
            failures += "data exceeds maximum depth"
            return
        }
        when (value) {
            is CompoundDataValue -> validateCompound(value.entries, depth, budget, failures)
            is ListDataValue -> {
                if (value.values.size > CanonicalStorageLimits.MAX_LIST_ELEMENTS) {
                    failures += "list exceeds ${CanonicalStorageLimits.MAX_LIST_ELEMENTS} elements"
                    return
                }
                if (!budget.node(failures)) return
                if (value.values.asSequence().map(::physicalType).distinct().take(2).count() > 1) {
                    failures += "list contains more than one physical value type"
                }
                value.values.forEach { child -> validateValue(child, depth + 1, budget, failures) }
            }
            is StringDataValue -> {
                if (!budget.node(failures)) return
                budget.string(value.value, CanonicalStorageLimits.MAX_STRING_LENGTH, "string value", failures)
            }
            is NamespacedKeyDataValue -> {
                if (!budget.node(failures)) return
                budget.string(value.value.toString(), CanonicalStorageLimits.MAX_STRING_LENGTH, "key value", failures)
            }
            else -> budget.node(failures)
        }
    }

    private fun physicalType(value: ItemDataValue): PhysicalValueType = when (value) {
        is BooleanDataValue -> PhysicalValueType.BYTE
        is IntegerDataValue -> PhysicalValueType.INT
        is LongDataValue -> PhysicalValueType.LONG
        is DecimalDataValue -> PhysicalValueType.DOUBLE
        is StringDataValue,
        is NamespacedKeyDataValue,
        -> PhysicalValueType.STRING
        is UuidDataValue -> PhysicalValueType.INT_ARRAY
        is ListDataValue -> PhysicalValueType.LIST
        is CompoundDataValue -> PhysicalValueType.COMPOUND
    }

    private enum class PhysicalValueType {
        BYTE,
        INT,
        LONG,
        DOUBLE,
        STRING,
        INT_ARRAY,
        LIST,
        COMPOUND,
    }

    private class Budget {
        private var nodes = 0
        private var utf8Bytes = 0L
        private var nodeFailureReported = false
        private var utf8FailureReported = false

        fun node(failures: MutableList<String>): Boolean {
            nodes++
            if (nodes > CanonicalStorageLimits.MAX_VALUE_NODES && !nodeFailureReported) {
                failures += "data exceeds node budget"
                nodeFailureReported = true
            }
            return nodes <= CanonicalStorageLimits.MAX_VALUE_NODES
        }

        fun string(
            value: String,
            maximumLength: Int,
            field: String,
            failures: MutableList<String>,
        ) {
            if (value.length > maximumLength) failures += "$field exceeds $maximumLength characters"
            val bounded = value.take(maximumLength + 1)
            utf8Bytes += bounded.toByteArray(StandardCharsets.UTF_8).size.toLong()
            if (utf8Bytes > CanonicalStorageLimits.MAX_TOTAL_UTF8_BYTES && !utf8FailureReported) {
                failures += "data exceeds UTF-8 budget"
                utf8FailureReported = true
            }
        }
    }
}
