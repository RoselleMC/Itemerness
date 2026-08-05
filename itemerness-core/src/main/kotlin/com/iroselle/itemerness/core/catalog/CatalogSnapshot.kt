package com.iroselle.itemerness.core.catalog

import com.iroselle.itemerness.api.DataKey
import com.iroselle.itemerness.api.DecimalDataValue
import com.iroselle.itemerness.api.ItemDataValue
import com.iroselle.itemerness.api.ItemDefinition
import com.iroselle.itemerness.api.ItemInstanceMode
import com.iroselle.itemerness.api.ItemKey
import com.iroselle.itemerness.api.LongDataValue
import java.math.BigDecimal
import java.math.RoundingMode
import java.security.SecureRandom
import java.time.Clock
import java.util.TreeMap
import java.util.UUID
import java.util.function.Supplier
import java.util.random.RandomGenerator

class CatalogCandidate internal constructor(
    items: Map<ItemKey, CatalogItemDefinition>,
    validationItems: Map<ItemKey, CatalogItemDefinition>,
    schemas: Map<SchemaVersion, DataSchemaDefinition>,
) {
    internal val compiledItems: Map<ItemKey, CatalogItemDefinition> = immutableSortedMap(items)
    private val compiledValidationItems: Map<ItemKey, CatalogItemDefinition> = immutableSortedMap(validationItems)
    val items: Map<ItemKey, ItemDefinition> = compiledItems
    val schemas: Map<SchemaVersion, DataSchemaDefinition> = immutableSortedMap(schemas)

    /** Materializes this fully validated candidate without publishing it. */
    fun materialize(revision: Long): CatalogSnapshot = CatalogSnapshot(
        revision = revision,
        items = compiledItems,
        schemas = schemas,
    )

    /** Materializes every valid source item, including disabled definitions, for pre-publication validation. */
    fun materializeValidationView(revision: Long = 0): CatalogSnapshot = CatalogSnapshot(
        revision = revision,
        items = compiledValidationItems,
        schemas = schemas,
    )
}

class CatalogSnapshot internal constructor(
    val revision: Long,
    items: Map<ItemKey, CatalogItemDefinition>,
    schemas: Map<SchemaVersion, DataSchemaDefinition>,
) {
    init {
        require(revision >= 0) { "Catalog revision must not be negative" }
    }

    internal val compiledItems: Map<ItemKey, CatalogItemDefinition> = immutableSortedMap(items)
    val items: Map<ItemKey, ItemDefinition> = compiledItems
    val schemas: Map<SchemaVersion, DataSchemaDefinition> = immutableSortedMap(schemas)

    fun findItem(key: ItemKey): ItemDefinition? = items[key]

    fun createInstance(
        key: ItemKey,
        context: InstanceCreationContext = InstanceCreationContext.system(),
    ): CanonicalItemInstance = requireNotNull(compiledItems[key]) {
        "Unknown item definition: $key"
    }.createInstance(revision, context)

    fun dataKeyDefinition(
        itemKey: ItemKey,
        dataKey: DataKey,
    ): DataKeyDefinition? = compiledItems[itemKey]?.dataKeyDefinition(dataKey)

    fun validateDataValue(
        itemKey: ItemKey,
        dataKey: DataKey,
        value: ItemDataValue,
    ): List<String> {
        val item = requireNotNull(compiledItems[itemKey]) { "Unknown item definition: $itemKey" }
        val definition = requireNotNull(item.dataKeyDefinition(dataKey)) {
            "Data key $dataKey is not defined for $itemKey"
        }
        return java.util.List.copyOf(DataValueValidator.validate(definition, value))
    }

    /** Reconstructs and validates a persisted canonical instance before any edit is attempted. */
    fun restoreInstance(
        itemKey: ItemKey,
        createdAgainstRevision: Long,
        instanceRevision: Long,
        schemaVersions: Map<ItemKey, Int>,
        instanceId: UUID?,
        data: Map<DataKey, ItemDataValue>,
    ): CanonicalItemInstance = requireNotNull(compiledItems[itemKey]) {
        "Unknown item definition: $itemKey"
    }.restoreInstance(
        createdAgainstRevision,
        instanceRevision,
        schemaVersions,
        instanceId,
        data,
    )

    /**
     * Applies a validated immutable edit. Caller authorization and persistence are deliberately
     * outside this platform-neutral operation.
     */
    fun editInstance(
        instance: CanonicalItemInstance,
        mutations: Collection<InstanceDataMutation>,
    ): CanonicalItemInstance = requireNotNull(compiledItems[instance.itemKey]) {
        "Unknown item definition: ${instance.itemKey}"
    }.editInstance(instance, mutations)

    companion object {
        @JvmStatic
        fun empty(): CatalogSnapshot = CatalogSnapshot(0, emptyMap(), emptyMap())
    }
}

class CatalogItemDefinition internal constructor(
    override val key: ItemKey,
    override val material: ItemKey,
    override val instanceMode: ItemInstanceMode,
    val instanceIdGenerator: InstanceIdGenerator?,
    schemaVersions: Map<ItemKey, Int>,
    definitionData: Map<DataKey, ItemDataValue>,
    instanceDefaults: Map<DataKey, ItemDataValue>,
    dataKeys: Map<DataKey, DataKeyDefinition>,
    generators: Map<DataKey, CompiledDataGenerator>,
    baseComponents: Collection<BaseItemComponent>,
    val contentComponent: NestedContentComponent?,
    contents: Collection<ItemContentDefinition>,
) : ItemDefinition {
    val schemaVersions: Map<ItemKey, Int> = immutableSortedMap(schemaVersions)
    val definitionData: Map<DataKey, ItemDataValue> = immutableSortedMap(definitionData)
    val instanceDefaults: Map<DataKey, ItemDataValue> = immutableSortedMap(instanceDefaults)
    val baseComponents: List<BaseItemComponent> = immutableList(baseComponents)
    val contents: List<ItemContentDefinition> = immutableList(contents)

    internal fun dataKeyDefinition(key: DataKey): DataKeyDefinition? = dataKeys[key]
    private val dataKeys: Map<DataKey, DataKeyDefinition> = immutableSortedMap(dataKeys)
    private val generators: Map<DataKey, CompiledDataGenerator> = immutableSortedMap(generators)

    internal fun createInstance(
        revision: Long,
        context: InstanceCreationContext,
    ): CanonicalItemInstance {
        val values = TreeMap(instanceDefaults)
        generators.forEach { (key, generator) ->
            val generated = generator.generate(context)
            val violations = DataValueValidator.validate(dataKeys.getValue(key), generated)
            check(violations.isEmpty()) {
                "Generator produced an invalid value for $key: ${violations.joinToString()}"
            }
            values[key] = generated
        }

        val instanceId = when (instanceIdGenerator) {
            null -> null
            InstanceIdGenerator.UUID_V4 -> context.uuidSupplier.get().also { uuid ->
                require(uuid.version() == 4) { "The UUID v4 generator returned a version ${uuid.version()} UUID" }
            }
        }

        val instance = CanonicalItemInstance(
            itemKey = key,
            createdAgainstRevision = revision,
            instanceRevision = 0,
            schemaVersions = schemaVersions,
            instanceId = instanceId,
            data = values,
        )
        CanonicalStorageValidator.requireValid(instance)
        return instance
    }

    internal fun editInstance(
        instance: CanonicalItemInstance,
        mutations: Collection<InstanceDataMutation>,
    ): CanonicalItemInstance {
        CanonicalStorageValidator.requireValid(instance)
        require(instance.schemaVersions == schemaVersions) {
            "Instance schema versions do not match the current definition for $key"
        }
        val values = TreeMap(instance.data)
        val edited = HashSet<DataKey>()
        var changed = false
        mutations.forEach { mutation ->
            require(edited.add(mutation.key)) { "Data key ${mutation.key} is edited more than once" }
            val definition = requireNotNull(dataKeys[mutation.key]) {
                "Data key ${mutation.key} is not defined for $key"
            }
            require(definition.scope == DataScope.INSTANCE) {
                "Data key ${mutation.key} is not instance-scoped"
            }
            when (mutation) {
                is InstanceDataMutation.Set -> {
                    val violations = DataValueValidator.validate(definition, mutation.value)
                    require(violations.isEmpty()) {
                        "Invalid value for ${mutation.key}: ${violations.joinToString()}"
                    }
                    if (values.put(mutation.key, mutation.value) != mutation.value) {
                        changed = true
                    }
                }

                is InstanceDataMutation.Remove -> {
                    require(definition.nullable) { "Data key ${mutation.key} is not nullable" }
                    if (values.remove(mutation.key) != null) {
                        changed = true
                    }
                }
            }
        }
        if (!changed) {
            return instance
        }
        check(instance.instanceRevision != Long.MAX_VALUE) { "Instance revision is exhausted" }
        val editedInstance = CanonicalItemInstance(
            itemKey = instance.itemKey,
            createdAgainstRevision = instance.createdAgainstRevision,
            instanceRevision = instance.instanceRevision + 1,
            schemaVersions = instance.schemaVersions,
            instanceId = instance.instanceId,
            data = values,
        )
        CanonicalStorageValidator.requireValid(editedInstance)
        return editedInstance
    }

    internal fun restoreInstance(
        createdAgainstRevision: Long,
        instanceRevision: Long,
        schemaVersions: Map<ItemKey, Int>,
        instanceId: UUID?,
        data: Map<DataKey, ItemDataValue>,
    ): CanonicalItemInstance {
        require(createdAgainstRevision >= 0) { "Creation revision must not be negative" }
        require(instanceRevision >= 0) { "Instance revision must not be negative" }
        CanonicalStorageValidator.requireValid(key, schemaVersions, instanceId, data)
        require(schemaVersions == this.schemaVersions) {
            "Persisted schema versions do not match the current definition for $key"
        }
        when (instanceMode) {
            ItemInstanceMode.FUNGIBLE -> require(instanceId == null) {
                "Fungible item $key must not have an instance ID"
            }
            ItemInstanceMode.UNIQUE -> requireNotNull(instanceId) {
                "Unique item $key is missing its instance ID"
            }
        }
        data.forEach { (dataKey, value) ->
            val definition = requireNotNull(dataKeys[dataKey]) {
                "Persisted data key $dataKey is not defined for $key"
            }
            require(definition.scope == DataScope.INSTANCE) {
                "Persisted data key $dataKey is not instance-scoped"
            }
            val violations = DataValueValidator.validate(definition, value)
            require(violations.isEmpty()) {
                "Invalid persisted value for $dataKey: ${violations.joinToString()}"
            }
        }
        dataKeys.values
            .filter { definition -> definition.scope == DataScope.INSTANCE && !definition.nullable }
            .forEach { definition ->
                require(definition.key in data) {
                    "Persisted instance is missing required data key ${definition.key}"
                }
            }
        return CanonicalItemInstance(
            itemKey = key,
            createdAgainstRevision = createdAgainstRevision,
            instanceRevision = instanceRevision,
            schemaVersions = schemaVersions,
            instanceId = instanceId,
            data = data,
        )
    }
}

class CanonicalItemInstance internal constructor(
    val itemKey: ItemKey,
    val createdAgainstRevision: Long,
    val instanceRevision: Long,
    schemaVersions: Map<ItemKey, Int>,
    val instanceId: UUID?,
    data: Map<DataKey, ItemDataValue>,
) {
    init {
        require(createdAgainstRevision >= 0) { "Creation revision must not be negative" }
        require(instanceRevision >= 0) { "Instance revision must not be negative" }
    }

    val schemaVersions: Map<ItemKey, Int> = immutableSortedMap(schemaVersions)
    val data: Map<DataKey, ItemDataValue> = immutableSortedMap(data)

    operator fun get(key: DataKey): ItemDataValue? = data[key]
}

sealed interface InstanceDataMutation {
    val key: DataKey

    data class Set(
        override val key: DataKey,
        val value: ItemDataValue,
    ) : InstanceDataMutation

    data class Remove(
        override val key: DataKey,
    ) : InstanceDataMutation
}

class InstanceCreationContext(
    val clock: Clock,
    val random: RandomGenerator,
    val uuidSupplier: Supplier<UUID>,
) {
    companion object {
        @JvmStatic
        fun system(): InstanceCreationContext = InstanceCreationContext(
            clock = Clock.systemUTC(),
            random = SecureRandom(),
            uuidSupplier = Supplier(UUID::randomUUID),
        )
    }
}

internal sealed interface CompiledDataGenerator {
    fun generate(context: InstanceCreationContext): ItemDataValue

    data object UnixMillis : CompiledDataGenerator {
        override fun generate(context: InstanceCreationContext): ItemDataValue =
            LongDataValue(context.clock.millis())
    }

    class RandomDecimal(
        val minimum: BigDecimal,
        val maximum: BigDecimal,
        val scale: Int,
    ) : CompiledDataGenerator {
        override fun generate(context: InstanceCreationContext): ItemDataValue {
            val unit = BigDecimal.valueOf(context.random.nextDouble())
            val value = minimum
                .add(maximum.subtract(minimum).multiply(unit))
                .setScale(scale, RoundingMode.HALF_UP)
            return DecimalDataValue(value.toDouble())
        }
    }
}
