package com.iroselle.itemerness.core.catalog

import com.iroselle.itemerness.api.ItemInstanceMode
import java.math.BigDecimal

/** Structured, parser-independent input consumed by [CatalogCompiler]. */
class CatalogSource(
    schemas: Collection<DataSchemaSource>,
    items: Collection<ItemDefinitionSource>,
) {
    val schemas: List<DataSchemaSource> = java.util.List.copyOf(schemas)
    val items: List<ItemDefinitionSource> = java.util.List.copyOf(items)
}

class DataSchemaSource(
    val id: String,
    /** Business schema version persisted in canonical item data. */
    val version: Int,
    keys: Collection<DataKeySource>,
    /** Syntax version of the source document, independent from [version]. */
    val sourceFormatVersion: Int = 1,
) {
    val keys: List<DataKeySource> = java.util.List.copyOf(keys)
}

class DataKeySource(
    val id: String,
    val type: DataType,
    val scope: DataScope,
    val nullable: Boolean = false,
    val defaultValue: SourceDataValue? = null,
    val affectsStacking: Boolean = true,
    val presentationReadable: Boolean = false,
    val constraints: DataConstraintsSource = DataConstraintsSource(),
)

enum class DataScope {
    DEFINITION,
    INSTANCE,
}

sealed interface DataType {
    data object BooleanType : DataType

    data object IntegerType : DataType

    data object LongType : DataType

    data object DecimalType : DataType

    data object StringType : DataType

    data object UuidType : DataType

    data object NamespacedKeyType : DataType

    class ListType(
        val element: DataType,
    ) : DataType {
        override fun equals(other: Any?): Boolean = other is ListType && element == other.element

        override fun hashCode(): Int = element.hashCode()
    }

    /**
     * A null field list denotes an open compound. Integer literals use 32-bit storage when they
     * fit and 64-bit storage otherwise; null entries are normalized to an absent entry.
     */
    class CompoundType(fields: Collection<CompoundFieldSource>? = null) : DataType {
        val fields: List<CompoundFieldSource>? = fields?.let { java.util.List.copyOf(it) }

        override fun equals(other: Any?): Boolean = other is CompoundType && fields == other.fields

        override fun hashCode(): Int = fields.hashCode()
    }
}

data class CompoundFieldSource(
    val name: String,
    val type: DataType,
    val nullable: Boolean = false,
)

class DataConstraintsSource(
    val minimum: BigDecimal? = null,
    val maximum: BigDecimal? = null,
    val scale: Int? = null,
    val maximumCodePoints: Int? = null,
    val maximumElements: Int? = null,
    val maximumEntries: Int? = null,
    val maximumDepth: Int? = null,
    allowedValues: Collection<SourceDataValue> = emptyList(),
) {
    val allowedValues: List<SourceDataValue> = java.util.List.copyOf(allowedValues)
}

class ItemDefinitionSource(
    val id: String,
    val enabled: Boolean,
    val material: String,
    val instance: ItemInstanceSource,
    baseComponents: Collection<BaseItemComponentSource> = emptyList(),
    val contentComponent: NestedContentComponent? = null,
    contents: Collection<ItemContentSource> = emptyList(),
    definitionData: Collection<DataAssignmentSource> = emptyList(),
    /** Syntax version of the source document; never persisted as a data schema version. */
    val sourceFormatVersion: Int = 1,
) {
    val baseComponents: List<BaseItemComponentSource> = java.util.List.copyOf(baseComponents)
    val contents: List<ItemContentSource> = java.util.List.copyOf(contents)
    val definitionData: List<DataAssignmentSource> = java.util.List.copyOf(definitionData)
}

/** A raw, parser-independent vanilla component entry validated by [CatalogCompiler]. */
data class BaseItemComponentSource(
    val id: String,
    val value: SourceDataValue,
)

data class ItemContentSource(
    val item: String,
    val amount: Int,
)

/** The two bounded vanilla components represented by the concise `contents` item syntax. */
enum class NestedContentComponent {
    BUNDLE,
    CONTAINER,
}

class ItemInstanceSource(
    val mode: ItemInstanceMode,
    val idGenerator: InstanceIdGenerator? = null,
    schemas: Collection<SchemaReferenceSource>,
    defaults: Collection<DataAssignmentSource> = emptyList(),
    generators: Collection<DataGeneratorSource> = emptyList(),
) {
    val schemas: List<SchemaReferenceSource> = java.util.List.copyOf(schemas)
    val defaults: List<DataAssignmentSource> = java.util.List.copyOf(defaults)
    val generators: List<DataGeneratorSource> = java.util.List.copyOf(generators)
}

enum class InstanceIdGenerator {
    UUID_V4,
}

data class SchemaReferenceSource(
    val id: String,
    val version: Int,
)

data class DataAssignmentSource(
    val key: String,
    val value: SourceDataValue,
)

sealed interface DataGeneratorSource {
    val key: String

    data class UnixMillis(
        override val key: String,
    ) : DataGeneratorSource

    data class RandomDecimal(
        override val key: String,
        val minimum: BigDecimal,
        val maximum: BigDecimal,
        val scale: Int,
    ) : DataGeneratorSource
}

sealed interface SourceDataValue {
    data object NullValue : SourceDataValue

    data class BooleanValue(val value: Boolean) : SourceDataValue

    data class IntegerValue(val value: Long) : SourceDataValue

    data class DecimalValue(val value: BigDecimal) : SourceDataValue

    data class StringValue(val value: String) : SourceDataValue

    class ListValue(values: Collection<SourceDataValue>) : SourceDataValue {
        val values: List<SourceDataValue> = java.util.List.copyOf(values)

        override fun equals(other: Any?): Boolean = other is ListValue && values == other.values

        override fun hashCode(): Int = values.hashCode()
    }

    class CompoundValue(entries: Map<String, SourceDataValue>) : SourceDataValue {
        val entries: Map<String, SourceDataValue> = java.util.Map.copyOf(entries)

        override fun equals(other: Any?): Boolean = other is CompoundValue && entries == other.entries

        override fun hashCode(): Int = entries.hashCode()
    }
}
