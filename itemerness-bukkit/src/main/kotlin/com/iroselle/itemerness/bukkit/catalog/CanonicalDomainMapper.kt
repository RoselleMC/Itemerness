package com.iroselle.itemerness.bukkit.catalog

import com.iroselle.itemerness.api.BooleanDataValue
import com.iroselle.itemerness.api.CompoundDataValue
import com.iroselle.itemerness.api.DataKey
import com.iroselle.itemerness.api.DecimalDataValue
import com.iroselle.itemerness.api.IntegerDataValue
import com.iroselle.itemerness.api.ItemDataValue
import com.iroselle.itemerness.api.ItemDefinition
import com.iroselle.itemerness.api.ItemKey
import com.iroselle.itemerness.api.ListDataValue
import com.iroselle.itemerness.api.LongDataValue
import com.iroselle.itemerness.api.NamespacedKeyDataValue
import com.iroselle.itemerness.api.StringDataValue
import com.iroselle.itemerness.api.UuidDataValue
import com.iroselle.itemerness.core.catalog.CanonicalItemInstance
import com.iroselle.itemerness.core.catalog.DataType
import com.iroselle.itemerness.projection.BooleanProjectionValue
import com.iroselle.itemerness.projection.CanonicalItemSnapshot
import com.iroselle.itemerness.projection.DecimalProjectionValue
import com.iroselle.itemerness.projection.IntegerProjectionValue
import com.iroselle.itemerness.projection.KeyProjectionValue
import com.iroselle.itemerness.projection.ListProjectionValue
import com.iroselle.itemerness.projection.LongProjectionValue
import com.iroselle.itemerness.projection.ProjectionCompound
import com.iroselle.itemerness.projection.ProjectionValue
import com.iroselle.itemerness.projection.StringProjectionValue
import com.iroselle.itemerness.projection.UuidProjectionValue
import java.util.TreeMap

internal object CanonicalDomainMapper {
    fun restore(
        canonical: CanonicalItemSnapshot,
        catalog: RuntimeCatalogSnapshot,
    ): CanonicalDomainResult = try {
        val definition = requireNotNull(catalog.domain.findItem(canonical.itemKey)) {
            "Definition ${canonical.itemKey} is not present in the active catalog"
        }
        require(definition.material == canonical.materialKey) {
            "Canonical material ${canonical.materialKey} does not match ${definition.material}"
        }
        val expectedName = catalog.settings.pendingName(canonical.itemKey)
        require(canonical.pendingName == expectedName) {
            "Canonical pending name does not match '$expectedName'"
        }
        val data = TreeMap<DataKey, ItemDataValue>()
        canonical.data.entries.forEach { entry ->
            val key = DataKey.parse(entry.key)
            val keyDefinition = requireNotNull(catalog.domain.dataKeyDefinition(canonical.itemKey, key)) {
                "Canonical data key $key is not defined for ${canonical.itemKey}"
            }
            data[key] = convert(entry.value, keyDefinition.type, key.toString())
        }
        val schemas = canonical.dataSchemas.entries.associate { schema ->
            schema.schemaKey to schema.version
        }
        CanonicalDomainResult.Valid(
            definition = definition,
            instance = catalog.domain.restoreInstance(
                itemKey = canonical.itemKey,
                createdAgainstRevision = canonical.createdAgainstRevision,
                instanceRevision = canonical.instanceRevision,
                schemaVersions = schemas,
                instanceId = canonical.instanceId,
                data = data,
            ),
        )
    } catch (exception: RuntimeException) {
        CanonicalDomainResult.Invalid(exception.message ?: "Invalid canonical item")
    }

    private fun convert(
        value: ProjectionValue,
        type: DataType,
        path: String,
    ): ItemDataValue = when (type) {
        DataType.BooleanType -> BooleanDataValue((value as? BooleanProjectionValue).required(path).value)
        DataType.IntegerType -> IntegerDataValue((value as? IntegerProjectionValue).required(path).value)
        DataType.LongType -> LongDataValue((value as? LongProjectionValue).required(path).value)
        DataType.DecimalType -> DecimalDataValue((value as? DecimalProjectionValue).required(path).value.toDouble())
        DataType.StringType -> StringDataValue((value as? StringProjectionValue).required(path).value)
        DataType.UuidType -> UuidDataValue((value as? UuidProjectionValue).required(path).value)
        DataType.NamespacedKeyType -> NamespacedKeyDataValue(
            when (value) {
                is KeyProjectionValue -> value.value
                is StringProjectionValue -> ItemKey.parse(value.value)
                else -> error("Canonical value at $path is not a namespaced key")
            },
        )
        is DataType.ListType -> {
            val list = (value as? ListProjectionValue).required(path)
            ListDataValue(list.values.mapIndexed { index, child -> convert(child, type.element, "$path[$index]") })
        }
        is DataType.CompoundType -> {
            val compound = (value as? ProjectionCompound).required(path)
            val fields = type.fields?.associateBy { field -> field.name }
            CompoundDataValue(
                compound.entries.associate { entry ->
                    val fieldType = fields?.get(entry.key)?.type
                    entry.key to if (fieldType == null && fields == null) {
                        infer(entry.value, "$path.${entry.key}")
                    } else {
                        convert(entry.value, requireNotNull(fieldType) { "Unknown field ${entry.key} at $path" }, "$path.${entry.key}")
                    }
                },
            )
        }
    }

    private fun infer(
        value: ProjectionValue,
        path: String,
    ): ItemDataValue = when (value) {
        is BooleanProjectionValue -> BooleanDataValue(value.value)
        is IntegerProjectionValue -> IntegerDataValue(value.value)
        is LongProjectionValue -> LongDataValue(value.value)
        is DecimalProjectionValue -> DecimalDataValue(value.value.toDouble())
        is StringProjectionValue -> StringDataValue(value.value)
        is UuidProjectionValue -> UuidDataValue(value.value)
        is KeyProjectionValue -> NamespacedKeyDataValue(value.value)
        is ListProjectionValue -> ListDataValue(value.values.mapIndexed { index, child -> infer(child, "$path[$index]") })
        is ProjectionCompound -> CompoundDataValue(
            value.entries.associate { entry -> entry.key to infer(entry.value, "$path.${entry.key}") },
        )
    }

    private fun <T : Any> T?.required(path: String): T =
        requireNotNull(this) { "Canonical value at $path has the wrong physical type" }
}

internal sealed interface CanonicalDomainResult {
    data class Valid(
        val definition: ItemDefinition,
        val instance: CanonicalItemInstance,
    ) : CanonicalDomainResult

    data class Invalid(
        val reason: String,
    ) : CanonicalDomainResult
}
