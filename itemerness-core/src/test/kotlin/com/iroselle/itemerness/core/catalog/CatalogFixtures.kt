package com.iroselle.itemerness.core.catalog

import com.iroselle.itemerness.api.ItemInstanceMode
import java.math.BigDecimal

internal fun validCatalog(
    itemId: String = "itemerness:ember-blade",
    schemaVersion: Int = 7,
): CatalogSource = CatalogSource(
    schemas = listOf(
        DataSchemaSource(
            id = "itemerness:common",
            version = schemaVersion,
            keys = listOf(
                DataKeySource(
                    id = "itemerness:created-at",
                    type = DataType.LongType,
                    scope = DataScope.INSTANCE,
                ),
                DataKeySource(
                    id = "example:quality",
                    type = DataType.NamespacedKeyType,
                    scope = DataScope.INSTANCE,
                    defaultValue = SourceDataValue.StringValue("example:common"),
                    constraints = DataConstraintsSource(
                        allowedValues = listOf(
                            SourceDataValue.StringValue("example:common"),
                            SourceDataValue.StringValue("example:rare"),
                        ),
                    ),
                ),
                DataKeySource(
                    id = "example:attack-damage",
                    type = DataType.DecimalType,
                    scope = DataScope.INSTANCE,
                    defaultValue = SourceDataValue.DecimalValue(BigDecimal.ONE),
                    constraints = DataConstraintsSource(
                        minimum = BigDecimal.ZERO,
                        maximum = BigDecimal("100.0"),
                        scale = 2,
                    ),
                ),
                DataKeySource(
                    id = "example:required-level",
                    type = DataType.IntegerType,
                    scope = DataScope.DEFINITION,
                    defaultValue = SourceDataValue.IntegerValue(1),
                    constraints = DataConstraintsSource(
                        minimum = BigDecimal.ONE,
                        maximum = BigDecimal("1000"),
                    ),
                ),
                DataKeySource(
                    id = "example:region",
                    type = DataType.NamespacedKeyType,
                    scope = DataScope.INSTANCE,
                    nullable = true,
                ),
                DataKeySource(
                    id = "example:sockets",
                    type = DataType.ListType(
                        DataType.CompoundType(
                            listOf(
                                CompoundFieldSource("type", DataType.NamespacedKeyType),
                                CompoundFieldSource("inserted", DataType.NamespacedKeyType, nullable = true),
                            ),
                        ),
                    ),
                    scope = DataScope.INSTANCE,
                    defaultValue = SourceDataValue.ListValue(emptyList()),
                    constraints = DataConstraintsSource(maximumElements = 8, maximumDepth = 4),
                ),
                DataKeySource(
                    id = "example:metadata",
                    type = DataType.CompoundType(),
                    scope = DataScope.INSTANCE,
                    defaultValue = SourceDataValue.CompoundValue(emptyMap()),
                    constraints = DataConstraintsSource(maximumEntries = 32, maximumDepth = 4),
                ),
            ),
        ),
    ),
    items = listOf(
        ItemDefinitionSource(
            id = itemId,
            enabled = true,
            material = "minecraft:netherite_sword",
            definitionData = listOf(
                DataAssignmentSource("example:required-level", SourceDataValue.IntegerValue(12)),
            ),
            instance = ItemInstanceSource(
                mode = ItemInstanceMode.UNIQUE,
                idGenerator = InstanceIdGenerator.UUID_V4,
                schemas = listOf(SchemaReferenceSource("itemerness:common", schemaVersion)),
                defaults = listOf(
                    DataAssignmentSource("example:quality", SourceDataValue.StringValue("example:rare")),
                    DataAssignmentSource("example:region", SourceDataValue.NullValue),
                    DataAssignmentSource(
                        "example:sockets",
                        SourceDataValue.ListValue(
                            listOf(
                                SourceDataValue.CompoundValue(
                                    mapOf(
                                        "type" to SourceDataValue.StringValue("example:gem"),
                                        "inserted" to SourceDataValue.NullValue,
                                    ),
                                ),
                            ),
                        ),
                    ),
                    DataAssignmentSource(
                        "example:metadata",
                        SourceDataValue.CompoundValue(
                            mapOf(
                                "completion" to SourceDataValue.DecimalValue(BigDecimal("0.625")),
                                "counts" to SourceDataValue.ListValue(
                                    listOf(SourceDataValue.IntegerValue(18), SourceDataValue.IntegerValue(32)),
                                ),
                            ),
                        ),
                    ),
                ),
                generators = listOf(
                    DataGeneratorSource.UnixMillis("itemerness:created-at"),
                    DataGeneratorSource.RandomDecimal(
                        key = "example:attack-damage",
                        minimum = BigDecimal("34.0"),
                        maximum = BigDecimal("42.0"),
                        scale = 1,
                    ),
                ),
            ),
        ),
    ),
)
