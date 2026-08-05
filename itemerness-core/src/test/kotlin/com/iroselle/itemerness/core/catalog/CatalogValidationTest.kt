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
}
