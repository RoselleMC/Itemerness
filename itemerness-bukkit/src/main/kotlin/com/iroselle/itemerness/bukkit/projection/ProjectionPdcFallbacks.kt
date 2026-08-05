package com.iroselle.itemerness.bukkit.projection

import com.iroselle.itemerness.api.BooleanDataValue
import com.iroselle.itemerness.api.DataKey
import com.iroselle.itemerness.api.DecimalDataValue
import com.iroselle.itemerness.api.IntegerDataValue
import com.iroselle.itemerness.api.ItemDataValue
import com.iroselle.itemerness.api.LongDataValue
import com.iroselle.itemerness.api.NamespacedKeyDataValue
import com.iroselle.itemerness.api.StringDataValue
import com.iroselle.itemerness.api.UuidDataValue
import com.iroselle.itemerness.bukkit.catalog.CanonicalDomainResult
import com.iroselle.itemerness.bukkit.catalog.RuntimeCatalogSnapshot
import com.iroselle.itemerness.core.catalog.CatalogItemDefinition
import com.iroselle.itemerness.core.catalog.DataType
import com.iroselle.itemerness.projection.BooleanProjectionValue
import com.iroselle.itemerness.projection.DecimalProjectionValue
import com.iroselle.itemerness.projection.IntegerProjectionValue
import com.iroselle.itemerness.projection.KeyProjectionValue
import com.iroselle.itemerness.projection.LongProjectionValue
import com.iroselle.itemerness.projection.ProjectionCompound
import com.iroselle.itemerness.projection.ProjectionPdcFallback
import com.iroselle.itemerness.projection.ProjectionPdcFallbackPlan
import com.iroselle.itemerness.projection.ProjectionPdcScalarType
import com.iroselle.itemerness.projection.StringProjectionValue
import com.iroselle.itemerness.projection.UuidProjectionValue

internal fun compilePdcFallbackPlan(runtime: RuntimeCatalogSnapshot): ProjectionPdcFallbackPlan {
    val itemDefinitions = runtime.domain.items.values.map { definition ->
        require(definition is CatalogItemDefinition) {
            "PDC fallback plans require compiled catalog item definitions"
        }
        definition
    }
    val types = runtime.source.source.schemas
        .flatMap { schema -> schema.keys }
        .groupBy({ source -> DataKey.parse(source.id) }, { source -> source.type })
    return ProjectionPdcFallbackPlan(
        runtime.source.dataKeyIntegrations.entries.flatMap { (rawKey, integration) ->
            if (integration.pdcFallbacks.isEmpty()) return@flatMap emptyList()
            val dataKey = DataKey(rawKey)
            val type = requireNotNull(types[dataKey]?.distinct()?.singleOrNull()) {
                "PDC fallback data key $dataKey must have one stable schema type"
            }
            val itemKeys = itemDefinitions.asSequence()
                .filter { definition -> runtime.domain.dataKeyDefinition(definition.key, dataKey) != null }
                .filter { definition -> dataKey !in definition.definitionData }
                .map(CatalogItemDefinition::key)
                .toList()
            if (itemKeys.isEmpty()) return@flatMap emptyList()
            val scalarType = type.projectionPdcScalarType()
            integration.pdcFallbacks.map { fallback ->
                ProjectionPdcFallback(itemKeys, dataKey, fallback.key, scalarType)
            }
        },
    )
}

internal sealed interface ProjectionPdcMergeResult {
    data class Valid(
        val data: Map<DataKey, ItemDataValue>,
    ) : ProjectionPdcMergeResult

    data class Invalid(
        val reason: String,
    ) : ProjectionPdcMergeResult
}

internal fun mergeProjectionPdcFallbacks(
    runtime: RuntimeCatalogSnapshot,
    restored: CanonicalDomainResult.Valid,
    fallbackData: ProjectionCompound,
): ProjectionPdcMergeResult {
    val definition = restored.definition as? CatalogItemDefinition
        ?: return ProjectionPdcMergeResult.Invalid("The active item definition has no compiled data")
    val merged = LinkedHashMap(definition.definitionData)
    merged.putAll(restored.instance.data)
    try {
        fallbackData.entries.forEach { entry ->
            val key = DataKey.parse(entry.key)
            if (key in merged) return@forEach
            val integration = runtime.source.dataKeyIntegrations[key.id]
                ?: error("PDC fallback data key $key is not declared by the active catalog")
            require(integration.pdcFallbacks.isNotEmpty()) {
                "Data key $key has no PDC fallback declaration"
            }
            val definitionForKey = requireNotNull(runtime.domain.dataKeyDefinition(restored.definition.key, key)) {
                "PDC fallback data key $key is not defined for ${restored.definition.key}"
            }
            require(entry.value.matches(definitionForKey.type.projectionPdcScalarType())) {
                "PDC fallback $key has the wrong scalar type"
            }
            val value = entry.value.toItemDataValue()
            val violations = runtime.domain.validateDataValue(restored.definition.key, key, value)
            require(violations.isEmpty()) {
                "PDC fallback $key violates the data schema: ${violations.joinToString()}"
            }
            merged[key] = value
        }
    } catch (failure: RuntimeException) {
        return ProjectionPdcMergeResult.Invalid(failure.message ?: "Invalid PDC fallback data")
    }
    return ProjectionPdcMergeResult.Valid(java.util.Collections.unmodifiableMap(merged))
}

private fun DataType.projectionPdcScalarType(): ProjectionPdcScalarType = when (this) {
    DataType.BooleanType -> ProjectionPdcScalarType.BOOLEAN
    DataType.IntegerType -> ProjectionPdcScalarType.INTEGER
    DataType.LongType -> ProjectionPdcScalarType.LONG
    DataType.DecimalType -> ProjectionPdcScalarType.DECIMAL
    DataType.StringType -> ProjectionPdcScalarType.STRING
    DataType.UuidType -> ProjectionPdcScalarType.UUID
    DataType.NamespacedKeyType -> ProjectionPdcScalarType.NAMESPACED_KEY
    is DataType.ListType,
    is DataType.CompoundType,
    -> error("Complex PDC fallback values are not supported")
}

private fun com.iroselle.itemerness.projection.ProjectionValue.toItemDataValue(): ItemDataValue = when (this) {
    is BooleanProjectionValue -> BooleanDataValue(value)
    is IntegerProjectionValue -> IntegerDataValue(value)
    is LongProjectionValue -> LongDataValue(value)
    is DecimalProjectionValue -> DecimalDataValue(value.toDouble())
    is StringProjectionValue -> StringDataValue(value)
    is UuidProjectionValue -> UuidDataValue(value)
    is KeyProjectionValue -> NamespacedKeyDataValue(value)
    else -> error("Complex PDC fallback values are not supported")
}

private fun com.iroselle.itemerness.projection.ProjectionValue.matches(type: ProjectionPdcScalarType): Boolean =
    when (type) {
        ProjectionPdcScalarType.BOOLEAN -> this is BooleanProjectionValue
        ProjectionPdcScalarType.INTEGER -> this is IntegerProjectionValue
        ProjectionPdcScalarType.LONG -> this is LongProjectionValue
        ProjectionPdcScalarType.DECIMAL -> this is DecimalProjectionValue
        ProjectionPdcScalarType.STRING -> this is StringProjectionValue
        ProjectionPdcScalarType.UUID -> this is UuidProjectionValue
        ProjectionPdcScalarType.NAMESPACED_KEY -> this is KeyProjectionValue
    }
