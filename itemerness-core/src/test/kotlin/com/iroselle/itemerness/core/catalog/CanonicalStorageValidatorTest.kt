package com.iroselle.itemerness.core.catalog

import com.iroselle.itemerness.api.CompoundDataValue
import com.iroselle.itemerness.api.DataKey
import com.iroselle.itemerness.api.IntegerDataValue
import com.iroselle.itemerness.api.ItemDataValue
import com.iroselle.itemerness.api.ItemInstanceMode
import com.iroselle.itemerness.api.ItemKey
import com.iroselle.itemerness.api.ListDataValue
import com.iroselle.itemerness.api.StringDataValue
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class CanonicalStorageValidatorTest {
    @Test
    fun `accepts values exactly at independent physical boundaries`() {
        val schemas = (0 until CanonicalStorageLimits.MAX_SCHEMA_ENTRIES).associate { index ->
            ItemKey.parse("example:schema-$index") to 1
        }
        val exactKey = DataKey(
            ItemKey.parse("a:${"k".repeat(CanonicalStorageLimits.MAX_KEY_LENGTH - 2)}"),
        )
        val data = mapOf(
            exactKey to StringDataValue("x".repeat(CanonicalStorageLimits.MAX_STRING_LENGTH)),
            DataKey.parse("example:list") to ListDataValue(
                List(CanonicalStorageLimits.MAX_LIST_ELEMENTS) { IntegerDataValue(1) },
            ),
            DataKey.parse("example:compound") to CompoundDataValue(
                (0 until CanonicalStorageLimits.MAX_COMPOUND_ENTRIES).associate { index ->
                    "field-$index" to IntegerDataValue(index)
                },
            ),
        )

        val failures = CanonicalStorageValidator.validate(
            instance(schemaVersions = schemas, data = data),
            "p".repeat(CanonicalStorageLimits.MAX_PENDING_NAME_LENGTH),
        )

        assertTrue(failures.isEmpty(), failures.toString())
    }

    @Test
    fun `rejects canonical keys and strings beyond physical limits`() {
        val overlongKey = DataKey(
            ItemKey.parse("a:${"k".repeat(CanonicalStorageLimits.MAX_KEY_LENGTH - 1)}"),
        )
        val keyFailures = CanonicalStorageValidator.validate(
            instance(data = mapOf(overlongKey to StringDataValue("value"))),
        )
        assertHasFailure(keyFailures, "compound key exceeds")

        val stringFailures = CanonicalStorageValidator.validate(
            instance(
                data = mapOf(
                    VALUE_KEY to StringDataValue("x".repeat(CanonicalStorageLimits.MAX_STRING_LENGTH + 1)),
                ),
            ),
        )
        assertHasFailure(stringFailures, "string value exceeds")
    }

    @Test
    fun `rejects more than sixty four schema versions without traversing the excess`() {
        val schemas = (0..CanonicalStorageLimits.MAX_SCHEMA_ENTRIES).associate { index ->
            ItemKey.parse("example:schema-$index") to 1
        }

        val failures = CanonicalStorageValidator.validate(instance(schemaVersions = schemas))

        assertHasFailure(failures, "data schema map exceeds")
    }

    @Test
    fun `rejects compounds and lists beyond physical entry limits`() {
        val compound = CompoundDataValue(
            (0..CanonicalStorageLimits.MAX_COMPOUND_ENTRIES).associate { index ->
                "field-$index" to IntegerDataValue(index)
            },
        )
        val compoundFailures = CanonicalStorageValidator.validate(
            instance(data = mapOf(VALUE_KEY to compound)),
        )
        assertHasFailure(compoundFailures, "compound exceeds")

        val list = ListDataValue(
            (0..CanonicalStorageLimits.MAX_LIST_ELEMENTS).map(::IntegerDataValue),
        )
        val listFailures = CanonicalStorageValidator.validate(
            instance(data = mapOf(VALUE_KEY to list)),
        )
        assertHasFailure(listFailures, "list exceeds")
    }

    @Test
    fun `rejects aggregate node exhaustion across individually bounded containers`() {
        val value = ListDataValue(
            List(CanonicalStorageLimits.MAX_LIST_ELEMENTS) {
                ListDataValue(List(8) { IntegerDataValue(1) })
            },
        )

        val failures = CanonicalStorageValidator.validate(
            instance(data = mapOf(VALUE_KEY to value)),
        )

        assertHasFailure(failures, "data exceeds node budget")
    }

    @Test
    fun `rejects attacker controlled depth without traversing the entire chain`() {
        var value: ItemDataValue = StringDataValue("leaf")
        repeat(10_000) {
            value = ListDataValue(listOf(value))
        }

        val failures = CanonicalStorageValidator.validate(
            instance(data = mapOf(VALUE_KEY to value)),
        )

        assertHasFailure(failures, "data exceeds maximum depth")
    }

    @Test
    fun `schema validation rejects attacker depth before computing configured container depth`() {
        var value: ItemDataValue = CompoundDataValue(emptyMap())
        repeat(10_000) {
            value = CompoundDataValue(mapOf("next" to value))
        }
        val dataDefinition = DataKeyDefinition(
            key = VALUE_KEY,
            type = DataType.CompoundType(),
            scope = DataScope.INSTANCE,
            nullable = false,
            hasDefault = true,
            defaultValue = CompoundDataValue(emptyMap()),
            affectsStacking = true,
            presentationReadable = true,
            constraints = CompiledDataConstraints(
                minimum = null,
                maximum = null,
                scale = null,
                maximumCodePoints = null,
                maximumElements = null,
                maximumEntries = null,
                maximumDepth = 4,
                allowedValues = emptyList(),
            ),
        )
        val catalog = snapshot(
            definition(
                dataKeys = mapOf(VALUE_KEY to dataDefinition),
                defaults = mapOf(VALUE_KEY to CompoundDataValue(emptyMap())),
            ),
        )

        val failures = catalog.validateDataValue(ITEM_KEY, VALUE_KEY, value)

        assertHasFailure(failures, "data exceeds maximum depth")
    }

    @Test
    fun `pending names are nonblank control free bounded and share the UTF8 budget`() {
        assertHasFailure(CanonicalStorageValidator.validatePendingName("   "), "must not be blank")
        assertHasFailure(CanonicalStorageValidator.validatePendingName("line\nbreak"), "control characters")
        assertHasFailure(
            CanonicalStorageValidator.validatePendingName(
                "x".repeat(CanonicalStorageLimits.MAX_PENDING_NAME_LENGTH + 1),
            ),
            "pending name exceeds",
        )

        val almostFullBudget = buildMap {
            repeat(10) { index ->
                put(DataKey.parse("example:text-$index"), StringDataValue("界".repeat(8_192)))
            }
            put(DataKey.parse("example:tail"), StringDataValue("界".repeat(4_500)))
        }
        val storage = instance(data = almostFullBudget)
        assertTrue(CanonicalStorageValidator.validate(storage).isEmpty())
        assertHasFailure(
            CanonicalStorageValidator.validate(storage, "界".repeat(CanonicalStorageLimits.MAX_PENDING_NAME_LENGTH)),
            "UTF-8 budget",
        )
    }

    @Test
    fun `create rejects a definition whose materialized state exceeds storage`() {
        val schemas = (0..CanonicalStorageLimits.MAX_SCHEMA_ENTRIES).associate { index ->
            ItemKey.parse("example:schema-$index") to 1
        }
        val snapshot = snapshot(definition(schemaVersions = schemas))

        val failure = assertThrows(IllegalArgumentException::class.java) {
            snapshot.createInstance(ITEM_KEY)
        }

        assertTrue(failure.message.orEmpty().contains("physical storage limits"))
    }

    @Test
    fun `edit rejects aggregate storage exhaustion atomically`() {
        val definitions = (0 until 8).associate { index ->
            val key = DataKey.parse("example:list-$index")
            key to dataDefinition(
                key = key,
                type = DataType.ListType(DataType.IntegerType),
                default = ListDataValue(emptyList()),
            )
        }
        val catalog = snapshot(
            definition(
                dataKeys = definitions,
                defaults = definitions.keys.associateWith { ListDataValue(emptyList()) },
            ),
        )
        val original = catalog.createInstance(ITEM_KEY)
        val mutations = definitions.keys.map { key ->
            InstanceDataMutation.Set(
                key,
                ListDataValue(List(CanonicalStorageLimits.MAX_LIST_ELEMENTS) { IntegerDataValue(1) }),
            )
        }

        val failure = assertThrows(IllegalArgumentException::class.java) {
            catalog.editInstance(original, mutations)
        }

        assertTrue(failure.message.orEmpty().contains("physical storage limits"))
        assertTrue(original.data.values.all { (it as ListDataValue).values.isEmpty() })
        assertTrue(original.instanceRevision == 0L)
    }

    @Test
    fun `restore rejects aggregate storage exhaustion before accepting persisted data`() {
        val definitions = (0 until 8).associate { index ->
            val key = DataKey.parse("example:list-$index")
            key to dataDefinition(
                key = key,
                type = DataType.ListType(DataType.IntegerType),
                default = ListDataValue(emptyList()),
            )
        }
        val catalog = snapshot(
            definition(
                dataKeys = definitions,
                defaults = definitions.keys.associateWith { ListDataValue(emptyList()) },
            ),
        )
        val persisted = definitions.keys.associateWith {
            ListDataValue(List(CanonicalStorageLimits.MAX_LIST_ELEMENTS) { IntegerDataValue(1) })
        }

        val failure = assertThrows(IllegalArgumentException::class.java) {
            catalog.restoreInstance(
                itemKey = ITEM_KEY,
                createdAgainstRevision = 1,
                instanceRevision = 0,
                schemaVersions = SCHEMA_VERSIONS,
                instanceId = null,
                data = persisted,
            )
        }

        assertTrue(failure.message.orEmpty().contains("physical storage limits"))
    }

    @Test
    fun `restore materializes a missing required instance default`() {
        val required = dataDefinition(
            key = VALUE_KEY,
            type = DataType.StringType,
            default = StringDataValue("default"),
        )
        val catalog = snapshot(
            definition(
                dataKeys = mapOf(VALUE_KEY to required),
                defaults = mapOf(VALUE_KEY to StringDataValue("default")),
            ),
        )

        val restored = catalog.restoreInstance(
            itemKey = ITEM_KEY,
            createdAgainstRevision = 1,
            instanceRevision = 0,
            schemaVersions = SCHEMA_VERSIONS,
            instanceId = null,
            data = emptyMap(),
        )

        assertEquals(StringDataValue("default"), restored.data[VALUE_KEY])
        assertEquals(0L, restored.instanceRevision)
    }

    @Test
    fun `restore leaves a missing nullable default absent for integration fallbacks`() {
        val optional = dataDefinition(
            key = VALUE_KEY,
            type = DataType.StringType,
            default = StringDataValue("default"),
            nullable = true,
        )
        val catalog = snapshot(
            definition(
                dataKeys = mapOf(VALUE_KEY to optional),
                defaults = mapOf(VALUE_KEY to StringDataValue("default")),
            ),
        )

        val restored = catalog.restoreInstance(
            itemKey = ITEM_KEY,
            createdAgainstRevision = 1,
            instanceRevision = 0,
            schemaVersions = SCHEMA_VERSIONS,
            instanceId = null,
            data = emptyMap(),
        )

        assertFalse(VALUE_KEY in restored.data)
    }

    @Test
    fun `compiler rejects instance data that claims not to affect stacking`() {
        val source = CatalogSource(
            schemas = listOf(
                DataSchemaSource(
                    id = SCHEMA_KEY.toString(),
                    version = 1,
                    keys = listOf(
                        DataKeySource(
                            id = VALUE_KEY.toString(),
                            type = DataType.StringType,
                            scope = DataScope.INSTANCE,
                            defaultValue = SourceDataValue.StringValue("value"),
                            affectsStacking = false,
                        ),
                    ),
                ),
            ),
            items = listOf(
                ItemDefinitionSource(
                    id = ITEM_KEY.toString(),
                    enabled = true,
                    material = "minecraft:paper",
                    instance = ItemInstanceSource(
                        mode = ItemInstanceMode.FUNGIBLE,
                        schemas = listOf(SchemaReferenceSource(SCHEMA_KEY.toString(), 1)),
                    ),
                ),
            ),
        )

        val compilation = CatalogCompiler().compile(source)

        assertFalse(compilation.successful)
        assertTrue(
            compilation.diagnostics.any { diagnostic ->
                diagnostic.code == CatalogDiagnosticCode.INVALID_SCHEMA &&
                    diagnostic.message.contains("must affect stacking")
            },
            compilation.diagnostics.toString(),
        )
    }

    private fun instance(
        schemaVersions: Map<ItemKey, Int> = SCHEMA_VERSIONS,
        data: Map<DataKey, ItemDataValue> = emptyMap(),
    ): CanonicalItemInstance = CanonicalItemInstance(
        itemKey = ITEM_KEY,
        createdAgainstRevision = 1,
        instanceRevision = 0,
        schemaVersions = schemaVersions,
        instanceId = null,
        data = data,
    )

    private fun snapshot(definition: CatalogItemDefinition): CatalogSnapshot = CatalogSnapshot(
        revision = 1,
        items = mapOf(definition.key to definition),
        schemas = emptyMap(),
    )

    private fun definition(
        schemaVersions: Map<ItemKey, Int> = SCHEMA_VERSIONS,
        dataKeys: Map<DataKey, DataKeyDefinition> = emptyMap(),
        defaults: Map<DataKey, ItemDataValue> = emptyMap(),
    ): CatalogItemDefinition = CatalogItemDefinition(
        key = ITEM_KEY,
        material = ItemKey.parse("minecraft:paper"),
        instanceMode = ItemInstanceMode.FUNGIBLE,
        instanceIdGenerator = null,
        schemaVersions = schemaVersions,
        definitionData = emptyMap(),
        instanceDefaults = defaults,
        dataKeys = dataKeys,
        generators = emptyMap(),
        baseComponents = emptyList(),
        contentComponent = null,
        contents = emptyList(),
    )

    private fun dataDefinition(
        key: DataKey,
        type: DataType,
        default: ItemDataValue,
        nullable: Boolean = false,
    ): DataKeyDefinition = DataKeyDefinition(
        key = key,
        type = type,
        scope = DataScope.INSTANCE,
        nullable = nullable,
        hasDefault = true,
        defaultValue = default,
        affectsStacking = true,
        presentationReadable = true,
        constraints = CompiledDataConstraints(
            minimum = null,
            maximum = null,
            scale = null,
            maximumCodePoints = null,
            maximumElements = null,
            maximumEntries = null,
            maximumDepth = null,
            allowedValues = emptyList(),
        ),
    )

    private fun assertHasFailure(failures: List<String>, expected: String) {
        assertTrue(failures.any { expected in it }, failures.toString())
    }

    private companion object {
        val ITEM_KEY: ItemKey = ItemKey.parse("itemerness:test-item")
        val SCHEMA_KEY: ItemKey = ItemKey.parse("itemerness:test-schema")
        val VALUE_KEY: DataKey = DataKey.parse("example:value")
        val SCHEMA_VERSIONS: Map<ItemKey, Int> = mapOf(SCHEMA_KEY to 1)
    }
}
