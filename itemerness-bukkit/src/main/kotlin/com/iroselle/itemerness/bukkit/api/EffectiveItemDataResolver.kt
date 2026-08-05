package com.iroselle.itemerness.bukkit.api

import com.iroselle.itemerness.api.DataKey
import com.iroselle.itemerness.api.ItemDataValue
import com.iroselle.itemerness.bukkit.catalog.CanonicalDomainResult
import com.iroselle.itemerness.bukkit.catalog.RuntimeCatalogSnapshot
import com.iroselle.itemerness.core.catalog.CatalogItemDefinition
import java.util.Collections
import java.util.LinkedHashMap
import org.bukkit.inventory.ItemStack

/** Resolves canonical, definition, then explicitly declared read-only PDC values in that order. */
internal class EffectiveItemDataResolver(
    private val pdcFallbackReader: PdcFallbackReader = BukkitPdcFallbackReader,
) {
    fun resolveAll(
        source: ItemStack,
        runtime: RuntimeCatalogSnapshot,
        restored: CanonicalDomainResult.Valid,
    ): EffectiveItemDataResult {
        val definition = restored.definition as? CatalogItemDefinition
            ?: return EffectiveItemDataResult.Invalid("The active item definition has no compiled data")
        val merged = LinkedHashMap(definition.definitionData)
        merged.putAll(restored.instance.data)

        for ((rawKey, integration) in runtime.source.dataKeyIntegrations) {
            val key = DataKey(rawKey)
            if (key in merged || integration.pdcFallbacks.isEmpty()) continue
            val keyDefinition = runtime.domain.dataKeyDefinition(restored.definition.key, key) ?: continue
            when (
                val fallback = resolveFallback(
                    source = source,
                    runtime = runtime,
                    itemKey = restored.definition.key,
                    key = key,
                    type = keyDefinition.type,
                )
            ) {
                EffectiveItemDataRead.Absent -> Unit
                is EffectiveItemDataRead.Invalid -> return EffectiveItemDataResult.Invalid(fallback.reason)
                is EffectiveItemDataRead.Value -> merged[key] = fallback.value
            }
        }
        return EffectiveItemDataResult.Valid(Collections.unmodifiableMap(merged))
    }

    fun resolveKey(
        source: ItemStack,
        runtime: RuntimeCatalogSnapshot,
        restored: CanonicalDomainResult.Valid,
        key: DataKey,
    ): EffectiveItemDataRead {
        restored.instance[key]?.let { return EffectiveItemDataRead.Value(it) }
        (restored.definition as? CatalogItemDefinition)
            ?.definitionData
            ?.get(key)
            ?.let { return EffectiveItemDataRead.Value(it) }
        val keyDefinition = runtime.domain.dataKeyDefinition(restored.definition.key, key)
            ?: return EffectiveItemDataRead.Invalid("Data key $key is not defined for ${restored.definition.key}")
        return resolveFallback(
            source = source,
            runtime = runtime,
            itemKey = restored.definition.key,
            key = key,
            type = keyDefinition.type,
        )
    }

    private fun resolveFallback(
        source: ItemStack,
        runtime: RuntimeCatalogSnapshot,
        itemKey: com.iroselle.itemerness.api.ItemKey,
        key: DataKey,
        type: com.iroselle.itemerness.core.catalog.DataType,
    ): EffectiveItemDataRead {
        val integration = runtime.source.dataKeyIntegrations[key.id]
            ?: return EffectiveItemDataRead.Absent
        for (fallback in integration.pdcFallbacks) {
            when (val read = pdcFallbackReader.read(source, fallback.key, type)) {
                PdcFallbackRead.Absent -> Unit
                is PdcFallbackRead.Invalid -> return EffectiveItemDataRead.Invalid(
                    "PDC fallback ${fallback.key} is invalid: ${read.reason}",
                )

                is PdcFallbackRead.Value -> {
                    val violations = runtime.domain.validateDataValue(itemKey, key, read.value)
                    if (violations.isNotEmpty()) {
                        return EffectiveItemDataRead.Invalid(
                            "PDC fallback ${fallback.key} violates the data schema: ${violations.joinToString()}",
                        )
                    }
                    return EffectiveItemDataRead.Value(read.value)
                }
            }
        }
        return EffectiveItemDataRead.Absent
    }
}

internal sealed interface EffectiveItemDataResult {
    data class Valid(
        val data: Map<DataKey, ItemDataValue>,
    ) : EffectiveItemDataResult

    data class Invalid(
        val reason: String,
    ) : EffectiveItemDataResult
}

internal sealed interface EffectiveItemDataRead {
    data object Absent : EffectiveItemDataRead

    data class Value(
        val value: ItemDataValue,
    ) : EffectiveItemDataRead

    data class Invalid(
        val reason: String,
    ) : EffectiveItemDataRead
}
