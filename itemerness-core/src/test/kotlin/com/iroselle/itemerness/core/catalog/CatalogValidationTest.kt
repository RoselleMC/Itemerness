package com.iroselle.itemerness.core.catalog

import com.iroselle.itemerness.api.ItemInstanceMode
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.math.BigDecimal
import java.util.EnumSet

class CatalogValidationTest {
    @Test
    fun `rejects malformed references scopes values and generator contracts together`() {
        val source = CatalogSource(
            schemas = listOf(
                DataSchemaSource(
                    id = "itemerness:common",
                    version = 1,
                    keys = listOf(
                        DataKeySource(
                            id = "example:level",
                            type = DataType.IntegerType,
                            scope = DataScope.DEFINITION,
                            constraints = DataConstraintsSource(minimum = BigDecimal.ONE, maximum = BigDecimal.TEN),
                        ),
                        DataKeySource(
                            id = "example:quality",
                            type = DataType.NamespacedKeyType,
                            scope = DataScope.INSTANCE,
                            constraints = DataConstraintsSource(
                                allowedValues = listOf(SourceDataValue.StringValue("example:rare")),
                            ),
                        ),
                    ),
                ),
            ),
            items = listOf(
                ItemDefinitionSource(
                    id = "itemerness:broken",
                    enabled = true,
                    material = "minecraft:paper",
                    definitionData = listOf(
                        DataAssignmentSource("example:level", SourceDataValue.IntegerValue(50)),
                    ),
                    instance = ItemInstanceSource(
                        mode = ItemInstanceMode.FUNGIBLE,
                        idGenerator = InstanceIdGenerator.UUID_V4,
                        schemas = listOf(
                            SchemaReferenceSource("itemerness:common", 1),
                            SchemaReferenceSource("missing:schema", 1),
                        ),
                        defaults = listOf(
                            DataAssignmentSource("example:quality", SourceDataValue.StringValue("example:forged")),
                            DataAssignmentSource("example:level", SourceDataValue.IntegerValue(2)),
                        ),
                        generators = listOf(DataGeneratorSource.UnixMillis("example:quality")),
                    ),
                ),
            ),
        )

        val compilation = CatalogCompiler().compile(source)

        assertFalse(compilation.successful)
        assertNull(compilation.candidate)
        val codes = compilation.diagnostics.mapTo(EnumSet.noneOf(CatalogDiagnosticCode::class.java), CatalogDiagnostic::code)
        assertTrue(CatalogDiagnosticCode.INVALID_VALUE in codes)
        assertTrue(CatalogDiagnosticCode.INVALID_SCOPE in codes)
        assertTrue(CatalogDiagnosticCode.INVALID_INSTANCE_MODE in codes)
        assertTrue(CatalogDiagnosticCode.INVALID_GENERATOR in codes)
        assertTrue(CatalogDiagnosticCode.MISSING_REFERENCE in codes)
    }

    @Test
    fun `rejects unsafe structure duplicate ids and invalid constraints`() {
        val deepType = (1..17).fold(DataType.StringType as DataType) { nested, _ ->
            DataType.ListType(nested)
        }
        val source = CatalogSource(
            schemas = listOf(
                DataSchemaSource(
                    id = "itemerness:bad",
                    version = 1,
                    keys = listOf(
                        DataKeySource(
                            id = "example:deep",
                            type = deepType,
                            scope = DataScope.INSTANCE,
                        ),
                        DataKeySource(
                            id = "example:deep",
                            type = DataType.StringType,
                            scope = DataScope.INSTANCE,
                        ),
                        DataKeySource(
                            id = "example:text",
                            type = DataType.StringType,
                            scope = DataScope.INSTANCE,
                            constraints = DataConstraintsSource(maximumElements = 10),
                        ),
                    ),
                ),
            ),
            items = emptyList(),
        )

        val compilation = CatalogCompiler().compile(source)

        assertFalse(compilation.successful)
        assertTrue(compilation.diagnostics.any { it.code == CatalogDiagnosticCode.INVALID_SCHEMA })
        assertTrue(compilation.diagnostics.any { it.code == CatalogDiagnosticCode.DUPLICATE_ID })
        assertTrue(compilation.diagnostics.any { it.code == CatalogDiagnosticCode.INVALID_CONSTRAINT })
    }

    @Test
    fun `applies compound field constraints inside lists`() {
        fun skills(trigger: String, cooldown: String) = SourceDataValue.ListValue(
            listOf(
                SourceDataValue.CompoundValue(
                    mapOf(
                        "trigger" to SourceDataValue.StringValue(trigger),
                        "cooldown" to SourceDataValue.DecimalValue(BigDecimal(cooldown)),
                    ),
                ),
            ),
        )
        fun source(fieldConstraints: DataConstraintsSource, default: SourceDataValue) = CatalogSource(
            schemas = listOf(
                DataSchemaSource(
                    id = "example:skills",
                    version = 1,
                    keys = listOf(
                        DataKeySource(
                            id = "example:skills",
                            type = DataType.ListType(
                                DataType.CompoundType(
                                    listOf(
                                        CompoundFieldSource("trigger", DataType.NamespacedKeyType, constraints = fieldConstraints),
                                        CompoundFieldSource(
                                            "cooldown",
                                            DataType.DecimalType,
                                            constraints = DataConstraintsSource(minimum = BigDecimal.ZERO),
                                        ),
                                    ),
                                ),
                            ),
                            scope = DataScope.INSTANCE,
                        ),
                    ),
                ),
            ),
            items = listOf(
                ItemDefinitionSource(
                    id = "example:sword",
                    enabled = true,
                    material = "minecraft:iron_sword",
                    instance = ItemInstanceSource(
                        mode = ItemInstanceMode.UNIQUE,
                        idGenerator = InstanceIdGenerator.UUID_V4,
                        schemas = listOf(SchemaReferenceSource("example:skills", 1)),
                        defaults = listOf(DataAssignmentSource("example:skills", default)),
                    ),
                ),
            ),
        )
        val triggers = DataConstraintsSource(allowedValues = listOf(SourceDataValue.StringValue("example:on_hit")))

        assertTrue(CatalogCompiler().compile(source(triggers, skills("example:on_hit", "1.5"))).successful)

        val invalid = CatalogCompiler().compile(source(triggers, skills("example:on_hti", "-1")))
        assertFalse(invalid.successful)
        val messages = invalid.diagnostics.filter { it.code == CatalogDiagnosticCode.INVALID_VALUE }.map { it.message }
        assertTrue(messages.any { "[0].trigger" in it && "allowed" in it }, messages.toString())
        assertTrue(messages.any { "[0].cooldown" in it && "minimum" in it }, messages.toString())

        val misplaced = CatalogCompiler().compile(source(DataConstraintsSource(maximumElements = 2), skills("example:on_hit", "0")))
        assertTrue(
            misplaced.diagnostics.any {
                it.code == CatalogDiagnosticCode.INVALID_CONSTRAINT && "fields.trigger.constraints" in it.path
            },
            misplaced.diagnostics.toString(),
        )
    }

    @Test
    fun `schema owners are plugin principals without runtime effect`() {
        fun compile(owner: String?) = CatalogCompiler().compile(
            CatalogSource(
                schemas = listOf(
                    DataSchemaSource(
                        id = "example:owned",
                        version = 1,
                        owner = owner,
                        keys = listOf(DataKeySource("example:value", DataType.StringType, DataScope.INSTANCE)),
                    ),
                ),
                items = emptyList(),
            ),
        )

        assertTrue(compile(null).successful)
        assertTrue(compile("plugin:ExampleConsumer").successful)
        val invalid = compile("ExampleConsumer")
        assertTrue(invalid.diagnostics.any { it.code == CatalogDiagnosticCode.INVALID_SCHEMA && it.path.endsWith(".owner") })
    }
}
