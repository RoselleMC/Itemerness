package com.iroselle.itemerness.bukkit.catalog

import com.iroselle.itemerness.api.ItemInstanceMode
import com.iroselle.itemerness.api.ItemKey
import com.iroselle.itemerness.bukkit.config.ItemernessSettings
import com.iroselle.itemerness.core.catalog.BaseItemComponent
import com.iroselle.itemerness.core.catalog.CatalogDiagnostic
import com.iroselle.itemerness.core.catalog.CatalogDiagnosticCode
import com.iroselle.itemerness.core.catalog.CatalogItemDefinition
import com.iroselle.itemerness.core.catalog.CatalogSnapshot
import com.iroselle.itemerness.core.catalog.CatalogSource
import com.iroselle.itemerness.core.catalog.CanonicalStorageValidator
import com.iroselle.itemerness.core.catalog.DataType
import com.iroselle.itemerness.core.presentation.CatalogPresentationValidator
import com.iroselle.itemerness.core.presentation.PresentationCatalogSnapshot
import io.papermc.paper.registry.RegistryAccess
import io.papermc.paper.registry.RegistryKey
import java.util.Locale
import org.bukkit.Bukkit
import org.bukkit.Material

/** Performs platform and cross-domain checks before a complete runtime snapshot is published. */
internal class RuntimeCatalogValidator(
    enchantmentProvider: () -> Set<ItemKey> = ::bukkitEnchantmentKeys,
    materialProvider: () -> Map<ItemKey, MaterialProperties> = ::bukkitMaterialProperties,
) {
    // Capture registry properties once; async validation only reads immutable values.
    private val materials: Map<ItemKey, MaterialProperties> = java.util.Map.copyOf(materialProvider())
    private val enchantments: Set<ItemKey> = java.util.Set.copyOf(enchantmentProvider())

    fun validate(
        settings: ItemernessSettings,
        source: CatalogSource,
        domain: CatalogSnapshot,
        presentation: PresentationCatalogSnapshot,
        integrations: Map<ItemKey, DataKeyIntegration>,
    ): List<CatalogDiagnostic> {
        val diagnostics = ArrayList<CatalogDiagnostic>()
        validateDefaults(settings, presentation, diagnostics)
        diagnostics += CatalogPresentationValidator.validate(domain, presentation)
        diagnostics += validateRuntimeContent(settings, source, domain, presentation, integrations)
        return diagnostics.sortedWith(compareBy({ it.path }, { it.code.name }, { it.message }))
    }

    /** Editor items carry explicit themes/layouts; server-global defaults are not draft references. */
    fun validateRuntimeContent(
        settings: ItemernessSettings,
        source: CatalogSource,
        domain: CatalogSnapshot,
        presentation: PresentationCatalogSnapshot,
        integrations: Map<ItemKey, DataKeyIntegration>,
    ): List<CatalogDiagnostic> {
        val diagnostics = ArrayList<CatalogDiagnostic>()
        validateMaterials(source, domain, diagnostics)
        validateEnchantments(source, domain, diagnostics)
        validateCanonicalStorage(settings, domain, diagnostics)
        validateDataAccessCapabilities(integrations, diagnostics)
        validatePdcFallbacks(domain, integrations, diagnostics)
        validatePlaceholderFormats(domain, presentation, integrations, diagnostics)
        return diagnostics.sortedWith(
            compareBy<CatalogDiagnostic>({ it.path }, { it.code.name }, { it.message }),
        )
    }

    private fun validateDataAccessCapabilities(
        integrations: Map<ItemKey, DataKeyIntegration>,
        diagnostics: MutableList<CatalogDiagnostic>,
    ) {
        integrations.toSortedMap().forEach { (key, integration) ->
            if (integration.readAccess == DataReadAccess.OWNER_ONLY) {
                diagnostics += CatalogDiagnostic(
                    CatalogDiagnosticCode.INVALID_VALUE,
                    "data-keys.$key.access.read",
                    "Owner-only reads require an ownership resolver and are not available in this release",
                )
            }
        }
    }

    private fun validatePdcFallbacks(
        domain: CatalogSnapshot,
        integrations: Map<ItemKey, DataKeyIntegration>,
        diagnostics: MutableList<CatalogDiagnostic>,
    ) {
        val typesByKey = domain.schemas.values
            .asSequence()
            .flatMap { schema -> schema.keys.values.asSequence() }
            .groupBy({ definition -> definition.key.id }, { definition -> definition.type })
        val fallbackCount = integrations.values.sumOf { integration -> integration.pdcFallbacks.size }
        val physicalTypes = LinkedHashMap<ItemKey, Pair<ItemKey, DataType>>()
        if (fallbackCount > MAX_PDC_FALLBACKS) {
            diagnostics += CatalogDiagnostic(
                CatalogDiagnosticCode.BUDGET_EXCEEDED,
                "data-keys",
                "PDC fallback declarations must not exceed $MAX_PDC_FALLBACKS entries",
            )
        }
        integrations.toSortedMap().forEach { (key, integration) ->
            if (integration.pdcFallbacks.isEmpty()) return@forEach
            val path = "data-keys.$key.read-sources"
            val types = typesByKey[key].orEmpty().distinct()
            if (types.size != 1) {
                diagnostics += CatalogDiagnostic(
                    CatalogDiagnosticCode.INVALID_VALUE,
                    path,
                    "A PDC fallback data key must have one stable scalar type across schema versions",
                )
            } else if (types.single() is DataType.ListType || types.single() is DataType.CompoundType) {
                diagnostics += CatalogDiagnostic(
                    CatalogDiagnosticCode.INVALID_VALUE,
                    path,
                    "PDC fallback values must use a scalar data type",
                )
            } else {
                val type = types.single()
                integration.pdcFallbacks.forEach { fallback ->
                    val previous = physicalTypes[fallback.key]
                    if (previous == null) {
                        physicalTypes[fallback.key] = key to type
                    } else if (previous.second != type) {
                        diagnostics += CatalogDiagnostic(
                            CatalogDiagnosticCode.INVALID_VALUE,
                            path,
                            "Physical PDC key ${fallback.key} has conflicting scalar types: " +
                                "${CatalogPresentationValidator.describe(previous.second)} for ${previous.first} and " +
                                "${CatalogPresentationValidator.describe(type)} for $key",
                        )
                    }
                }
            }
        }
    }

    private fun validateCanonicalStorage(
        settings: ItemernessSettings,
        domain: CatalogSnapshot,
        diagnostics: MutableList<CatalogDiagnostic>,
    ) {
        domain.items.keys.sorted().forEach { itemKey ->
            val path = "items.$itemKey.canonical-storage"
            val instance = try {
                domain.createInstance(itemKey)
            } catch (failure: RuntimeException) {
                diagnostics += CatalogDiagnostic(
                    CatalogDiagnosticCode.INVALID_VALUE,
                    path,
                    failure.message ?: "The creation state is invalid",
                )
                return@forEach
            }
            CanonicalStorageValidator.validate(instance, settings.pendingName(itemKey)).forEach { failure ->
                diagnostics += CatalogDiagnostic(CatalogDiagnosticCode.BUDGET_EXCEEDED, path, failure)
            }
        }
    }

    private fun validateDefaults(
        settings: ItemernessSettings,
        presentation: PresentationCatalogSnapshot,
        diagnostics: MutableList<CatalogDiagnostic>,
    ) {
        if (settings.defaultLayout !in presentation.layouts) {
            diagnostics += CatalogDiagnostic(
                CatalogDiagnosticCode.MISSING_REFERENCE,
                "config.presentation.default-layout",
                "Default layout ${settings.defaultLayout} is not defined",
            )
        }
        if (settings.defaultTheme !in presentation.themes) {
            diagnostics += CatalogDiagnostic(
                CatalogDiagnosticCode.MISSING_REFERENCE,
                "config.presentation.default-theme",
                "Default theme ${settings.defaultTheme} is not defined",
            )
        }
    }

    private fun validatePlaceholderFormats(
        domain: CatalogSnapshot,
        presentation: PresentationCatalogSnapshot,
        integrations: Map<ItemKey, DataKeyIntegration>,
        diagnostics: MutableList<CatalogDiagnostic>,
    ) {
        val typesByKey = domain.schemas.values
            .asSequence()
            .flatMap { schema -> schema.keys.values.asSequence() }
            .groupBy({ definition -> definition.key.id }, { definition -> definition.type })
        integrations.toSortedMap().forEach { (key, integration) ->
            if (integration.placeholderExposed && integration.readAccess != DataReadAccess.PUBLIC) {
                diagnostics += CatalogDiagnostic(
                    CatalogDiagnosticCode.INVALID_VALUE,
                    "data-keys.$key.placeholder-api.exposed",
                    "PlaceholderAPI exposure requires public read access",
                )
            }
            val format = integration.placeholderFormatter ?: return@forEach
            val path = "data-keys.$key.placeholder-api.formatter"
            if (format !in presentation.formats) {
                diagnostics += CatalogDiagnostic(
                    CatalogDiagnosticCode.MISSING_REFERENCE,
                    path,
                    "Placeholder formatter $format is not defined",
                )
                return@forEach
            }
            typesByKey[key].orEmpty().distinct().forEach { type ->
                if (!CatalogPresentationValidator.formatAccepts(format, type, presentation.formats)) {
                    diagnostics += CatalogDiagnostic(
                        CatalogDiagnosticCode.INVALID_VALUE,
                        path,
                        "Placeholder formatter $format is incompatible with ${CatalogPresentationValidator.describe(type)} data",
                    )
                }
            }
        }
    }

    private fun validateEnchantments(
        source: CatalogSource,
        domain: CatalogSnapshot,
        diagnostics: MutableList<CatalogDiagnostic>,
    ) {
        source.items.forEachIndexed { itemIndex, item ->
            val definition = domain.findItem(ItemKey.parse(item.id)) as? CatalogItemDefinition ?: return@forEachIndexed
            definition.baseComponents.filterIsInstance<BaseItemComponent.EnchantmentLevels>().forEach { component ->
                val id = when (component) {
                    is BaseItemComponent.Enchantments -> "minecraft:enchantments"
                    is BaseItemComponent.StoredEnchantments -> "minecraft:stored_enchantments"
                }
                val componentIndex = item.baseComponents.indexOfFirst { it.id == id }
                component.levels.keys.filterNot(enchantments::contains).forEach { key ->
                    diagnostics += CatalogDiagnostic(
                        CatalogDiagnosticCode.MISSING_REFERENCE,
                        "items[$itemIndex].base.components[$componentIndex].value.$key",
                        "Enchantment $key is not registered in the supported server version",
                    )
                }
            }
        }
    }

    private fun validateMaterials(
        source: CatalogSource,
        domain: CatalogSnapshot,
        diagnostics: MutableList<CatalogDiagnostic>,
    ) {
        source.items.forEachIndexed { index, item ->
            val key = runCatching { ItemKey.parse(item.material) }.getOrNull() ?: return@forEachIndexed
            val properties = materials[key]
            if (properties == null) {
                diagnostics += CatalogDiagnostic(
                    CatalogDiagnosticCode.INVALID_VALUE,
                    "items[$index].material",
                    "Material $key is not a concrete Minecraft item in the supported server version",
                )
                return@forEachIndexed
            }
            val definition = domain.findItem(ItemKey.parse(item.id)) as? CatalogItemDefinition
                ?: return@forEachIndexed
            if (item.contentComponent != null && item.contentComponent != nestedContentComponent(key)) {
                diagnostics += CatalogDiagnostic(
                    CatalogDiagnosticCode.INVALID_CONTENT,
                    "items[$index].contents",
                    "The nested contents carrier ${item.contentComponent} is not supported by material $key in YAML configuration",
                )
            }
            val maximumStackSize = definition.baseComponents
                .filterIsInstance<BaseItemComponent.MaxStackSize>()
                .singleOrNull()
                ?.value
                ?: properties.maximumStackSize
            val maximumDamage = definition.baseComponents
                .filterIsInstance<BaseItemComponent.MaxDamage>()
                .singleOrNull()
                ?.value
                ?: properties.maximumDamage?.takeIf { it > 0 }
            val damage = definition.baseComponents
                .filterIsInstance<BaseItemComponent.Damage>()
                .singleOrNull()
                ?.value
            if (maximumDamage != null && maximumStackSize != null && maximumStackSize > 1) {
                diagnostics += CatalogDiagnostic(
                    CatalogDiagnosticCode.INVALID_COMPONENT,
                    "items[$index].base.components",
                    "The effective maximum stack size must be one when the item has maximum damage",
                )
            }
            if (damage != null && maximumDamage == null) {
                diagnostics += CatalogDiagnostic(
                    CatalogDiagnosticCode.INVALID_COMPONENT,
                    "items[$index].base.components.minecraft:damage",
                    "minecraft:damage requires an effective maximum damage value",
                )
            } else if (damage != null && maximumDamage != null && damage > maximumDamage) {
                diagnostics += CatalogDiagnostic(
                    CatalogDiagnosticCode.INVALID_COMPONENT,
                    "items[$index].base.components.minecraft:damage",
                    "minecraft:damage must not exceed the effective maximum damage $maximumDamage",
                )
            }
            if (definition.instanceMode == ItemInstanceMode.UNIQUE &&
                maximumStackSize != null &&
                maximumStackSize != 1
            ) {
                diagnostics += CatalogDiagnostic(
                    CatalogDiagnosticCode.INVALID_INSTANCE_MODE,
                    "items[$index].base.components.minecraft:max_stack_size",
                    "Unique items require an effective maximum stack size of one",
                )
            }
        }
    }


    private companion object {
        const val MAX_PDC_FALLBACKS = 256
    }
}

internal data class MaterialProperties(
    val maximumStackSize: Int?,
    val maximumDamage: Int?,
)

private fun bukkitMaterialProperties(): Map<ItemKey, MaterialProperties> {
    val hasLiveRegistry = runCatching { Bukkit.getServer() }.getOrNull() != null
    return Material.entries
        .asSequence()
        .filterNot(Material::isLegacy)
        .filter { material ->
            if (hasLiveRegistry) {
                material.isItem && !material.isAir
            } else {
                material.name !in FALLBACK_NON_ITEMS && !material.name.endsWith("_AIR")
            }
        }
        .associate { material ->
            ItemKey("minecraft", material.name.lowercase(Locale.ROOT)) to if (hasLiveRegistry) {
                MaterialProperties(
                    maximumStackSize = material.maxStackSize,
                    maximumDamage = material.maxDurability.toInt(),
                )
            } else {
                MaterialProperties(maximumStackSize = null, maximumDamage = null)
            }
        }
}

private fun bukkitEnchantmentKeys(): Set<ItemKey> {
    if (runCatching { Bukkit.getServer() }.getOrNull() == null) return emptySet()
    return RegistryAccess.registryAccess().getRegistry(RegistryKey.ENCHANTMENT).keyStream().use { keys ->
        // Registry IDs outside the authoring key contract cannot be referenced, but must not block startup.
        keys.toList().mapNotNull { key -> runCatching { ItemKey(key.namespace, key.key) }.getOrNull() }.toSet()
    }
}

private val FALLBACK_NON_ITEMS = setOf(
    "AIR",
    "WATER",
    "LAVA",
    "FIRE",
    "SOUL_FIRE",
    "NETHER_PORTAL",
    "END_PORTAL",
    "END_GATEWAY",
    "BUBBLE_COLUMN",
    "MOVING_PISTON",
    "PISTON_HEAD",
)
