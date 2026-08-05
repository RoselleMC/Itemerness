package com.iroselle.itemerness.bukkit.catalog

import com.iroselle.itemerness.api.BooleanDataValue
import com.iroselle.itemerness.api.CompoundDataValue
import com.iroselle.itemerness.api.DataKey
import com.iroselle.itemerness.api.DecimalDataValue
import com.iroselle.itemerness.api.IntegerDataValue
import com.iroselle.itemerness.api.ItemDataValue
import com.iroselle.itemerness.api.ItemInstanceMode
import com.iroselle.itemerness.api.ItemKey
import com.iroselle.itemerness.api.ListDataValue
import com.iroselle.itemerness.api.LongDataValue
import com.iroselle.itemerness.api.NamespacedKeyDataValue
import com.iroselle.itemerness.api.StringDataValue
import com.iroselle.itemerness.api.UuidDataValue
import com.iroselle.itemerness.bukkit.config.ItemernessSettings
import com.iroselle.itemerness.core.catalog.BaseItemComponent
import com.iroselle.itemerness.core.catalog.CatalogDiagnostic
import com.iroselle.itemerness.core.catalog.CatalogDiagnosticCode
import com.iroselle.itemerness.core.catalog.CatalogItemDefinition
import com.iroselle.itemerness.core.catalog.CatalogSnapshot
import com.iroselle.itemerness.core.catalog.CatalogSource
import com.iroselle.itemerness.core.catalog.CanonicalStorageValidator
import com.iroselle.itemerness.core.catalog.DataType
import com.iroselle.itemerness.core.presentation.CompiledCondition
import com.iroselle.itemerness.core.presentation.CompiledItemPresentation
import com.iroselle.itemerness.core.presentation.CompiledPresentationBlock
import com.iroselle.itemerness.core.presentation.CompiledValueReference
import com.iroselle.itemerness.core.presentation.ConditionOperator
import com.iroselle.itemerness.core.presentation.FormatSource
import com.iroselle.itemerness.core.presentation.PresentationCatalogSnapshot
import com.iroselle.itemerness.core.presentation.ViewerFactType
import java.util.Locale
import org.bukkit.Bukkit
import org.bukkit.Material

/** Performs platform and cross-domain checks before a complete runtime snapshot is published. */
internal class RuntimeCatalogValidator(
    private val materialProvider: () -> Map<ItemKey, MaterialProperties> = ::bukkitMaterialProperties,
) {
    private val materials: Map<ItemKey, MaterialProperties> by lazy(LazyThreadSafetyMode.PUBLICATION, materialProvider)

    fun validate(
        settings: ItemernessSettings,
        source: CatalogSource,
        domain: CatalogSnapshot,
        presentation: PresentationCatalogSnapshot,
        integrations: Map<ItemKey, DataKeyIntegration>,
    ): List<CatalogDiagnostic> {
        val diagnostics = ArrayList<CatalogDiagnostic>()
        validateDefaults(settings, presentation, diagnostics)
        validateMaterials(source, domain, diagnostics)
        validateCanonicalStorage(settings, domain, diagnostics)
        validatePresentation(domain, presentation, diagnostics)
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
                                "${describe(previous.second)} for ${previous.first} and ${describe(type)} for $key",
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
                if (!formatAccepts(format, type, presentation.formats, HashSet())) {
                    diagnostics += CatalogDiagnostic(
                        CatalogDiagnosticCode.INVALID_VALUE,
                        path,
                        "Placeholder formatter $format is incompatible with ${describe(type)} data",
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

    private fun validatePresentation(
        domain: CatalogSnapshot,
        presentation: PresentationCatalogSnapshot,
        diagnostics: MutableList<CatalogDiagnostic>,
    ) {
        domain.items.keys.filterNot(presentation.validationItems::containsKey).sorted().forEach { key ->
            diagnostics += CatalogDiagnostic(
                CatalogDiagnosticCode.MISSING_REFERENCE,
                "presentation.items.$key",
                "Item $key has no compiled presentation",
            )
        }
        presentation.validationItems.values.sortedBy(CompiledItemPresentation::key).forEach { item ->
            val definition = domain.findItem(item.key) as? CatalogItemDefinition
            if (definition == null) {
                diagnostics += CatalogDiagnostic(
                    CatalogDiagnosticCode.MISSING_REFERENCE,
                    "presentation.items.${item.key}",
                    "Presentation ${item.key} has no compiled item definition",
                )
                return@forEach
            }
            validateBlocks(
                item.blocks,
                "presentation.items.${item.key}.blocks",
                definition,
                domain,
                presentation,
                diagnostics,
            )
        }
    }

    private fun validateBlocks(
        blocks: List<CompiledPresentationBlock>,
        path: String,
        item: CatalogItemDefinition,
        domain: CatalogSnapshot,
        presentation: PresentationCatalogSnapshot,
        diagnostics: MutableList<CatalogDiagnostic>,
    ) {
        blocks.forEachIndexed { index, block ->
            val blockPath = "$path[$index]"
            when (block) {
                is CompiledPresentationBlock.Text -> dataType(
                    item,
                    domain,
                    block.data,
                    "$blockPath.data",
                    diagnostics,
                )

                is CompiledPresentationBlock.Field -> {
                    val type = dataType(item, domain, block.data, "$blockPath.data", diagnostics)
                    validateFormat(type, block.format, "$blockPath.format", presentation, diagnostics)
                }

                is CompiledPresentationBlock.Description -> Unit
                is CompiledPresentationBlock.Conditional -> {
                    validateCondition(block.condition, "$blockPath.condition", item, domain, presentation, diagnostics)
                    validateBlocks(block.thenBlocks, "$blockPath.then", item, domain, presentation, diagnostics)
                    validateBlocks(block.otherwiseBlocks, "$blockPath.otherwise", item, domain, presentation, diagnostics)
                }

                is CompiledPresentationBlock.Repeat -> {
                    val type = dataType(item, domain, block.data, "$blockPath.data", diagnostics)
                    val compound = (type as? DataType.ListType)?.element as? DataType.CompoundType
                    if (type != null && compound == null) {
                        diagnostics += CatalogDiagnostic(
                            CatalogDiagnosticCode.INVALID_VALUE,
                            "$blockPath.data",
                            "Repeat data ${block.data} must be a list of compounds",
                        )
                    } else if (compound != null) {
                        when (val resolved = resolveCompoundPath(compound, block.template.valuePath)) {
                            CompoundPath.Open -> Unit
                            CompoundPath.Missing -> diagnostics += CatalogDiagnostic(
                                CatalogDiagnosticCode.MISSING_REFERENCE,
                                "$blockPath.template.value-path",
                                "Compound path ${block.template.valuePath} is not defined by ${block.data}",
                            )

                            is CompoundPath.Resolved -> validateFormat(
                                resolved.type,
                                block.template.format,
                                "$blockPath.template.format",
                                presentation,
                                diagnostics,
                            )
                        }
                    }
                }

                is CompiledPresentationBlock.NestedItemList -> if (item.contents.isEmpty()) {
                    diagnostics += CatalogDiagnostic(
                        CatalogDiagnosticCode.INVALID_CONTENT,
                        blockPath,
                        "A nested item list requires configured item contents",
                    )
                }
            }
        }
    }

    private fun dataType(
        item: CatalogItemDefinition,
        domain: CatalogSnapshot,
        key: DataKey,
        path: String,
        diagnostics: MutableList<CatalogDiagnostic>,
    ): DataType? {
        val definition = domain.dataKeyDefinition(item.key, key)
        if (definition == null) {
            diagnostics += CatalogDiagnostic(
                CatalogDiagnosticCode.MISSING_REFERENCE,
                path,
                "Data key $key is not defined for ${item.key}",
            )
            return null
        }
        if (!definition.presentationReadable) {
            diagnostics += CatalogDiagnostic(
                CatalogDiagnosticCode.INVALID_SCOPE,
                path,
                "Data key $key is not presentation-readable",
            )
        }
        return definition.type
    }

    private fun validateFormat(
        type: DataType?,
        format: ItemKey?,
        path: String,
        presentation: PresentationCatalogSnapshot,
        diagnostics: MutableList<CatalogDiagnostic>,
    ) {
        if (type == null || format == null) return
        if (!formatAccepts(format, type, presentation.formats, HashSet())) {
            diagnostics += CatalogDiagnostic(
                CatalogDiagnosticCode.INVALID_VALUE,
                path,
                "Formatter $format is incompatible with ${describe(type)} data",
            )
        }
    }

    private fun formatAccepts(
        id: ItemKey,
        type: DataType,
        formats: Map<ItemKey, FormatSource>,
        active: MutableSet<ItemKey>,
    ): Boolean {
        val format = formats[id] ?: return true
        if (!active.add(id)) return false
        return try {
            when (format) {
                is FormatSource.IntegerFormat -> type == DataType.IntegerType || type == DataType.LongType
                is FormatSource.DecimalFormat -> type == DataType.IntegerType ||
                    type == DataType.LongType ||
                    type == DataType.DecimalType
                is FormatSource.BooleanFormat -> type == DataType.BooleanType
                is FormatSource.NamespacedKeyFormat -> type == DataType.NamespacedKeyType
                is FormatSource.ListFormat -> type is DataType.ListType && formatAccepts(
                    ItemKey.parse(format.elementFormat),
                    type.element,
                    formats,
                    active,
                )
            }
        } finally {
            active.remove(id)
        }
    }

    private fun validateCondition(
        condition: CompiledCondition,
        path: String,
        item: CatalogItemDefinition,
        domain: CatalogSnapshot,
        presentation: PresentationCatalogSnapshot,
        diagnostics: MutableList<CatalogDiagnostic>,
    ) {
        val left = referenceKind(condition.left, "$path.left", item, domain, presentation, diagnostics)
        if (condition.operator == ConditionOperator.EXISTS) return
        val right = condition.right?.let {
            referenceKind(it, "$path.right", item, domain, presentation, diagnostics)
        }
        if (left != null && right != null && !left.comparableWith(right)) {
            diagnostics += CatalogDiagnostic(
                CatalogDiagnosticCode.INVALID_VALUE,
                path,
                "Condition operands ${left.label} and ${right.label} are not comparable",
            )
        }
    }

    private fun referenceKind(
        reference: CompiledValueReference,
        path: String,
        item: CatalogItemDefinition,
        domain: CatalogSnapshot,
        presentation: PresentationCatalogSnapshot,
        diagnostics: MutableList<CatalogDiagnostic>,
    ): ValueKind? = when (reference) {
        is CompiledValueReference.Data -> dataType(item, domain, reference.key, path, diagnostics)?.valueKind()
        is CompiledValueReference.Fact -> presentation.viewerFacts[reference.key]?.type?.valueKind()
        is CompiledValueReference.Literal -> reference.value.valueKind()
    }

    private sealed interface CompoundPath {
        data object Open : CompoundPath
        data object Missing : CompoundPath
        data class Resolved(val type: DataType) : CompoundPath
    }

    private fun resolveCompoundPath(root: DataType.CompoundType, path: String): CompoundPath {
        var type: DataType = root
        path.split('.').forEach { segment ->
            val compound = type as? DataType.CompoundType ?: return CompoundPath.Missing
            val fields = compound.fields ?: return CompoundPath.Open
            type = fields.firstOrNull { it.name == segment }?.type ?: return CompoundPath.Missing
        }
        return CompoundPath.Resolved(type)
    }

    private fun describe(type: DataType): String = when (type) {
        DataType.BooleanType -> "boolean"
        DataType.IntegerType -> "integer"
        DataType.LongType -> "long"
        DataType.DecimalType -> "decimal"
        DataType.StringType -> "string"
        DataType.UuidType -> "uuid"
        DataType.NamespacedKeyType -> "namespaced-key"
        is DataType.ListType -> "list<${describe(type.element)}>"
        is DataType.CompoundType -> "compound"
    }

    private enum class ValueKind(val label: String) {
        NUMERIC("numeric"),
        BOOLEAN("boolean"),
        STRING("string"),
        UUID("uuid"),
        NAMESPACED_KEY("namespaced-key"),
        CONTAINER("container");

        fun comparableWith(other: ValueKind): Boolean = this == other && this != CONTAINER
    }

    private fun DataType.valueKind(): ValueKind = when (this) {
        DataType.IntegerType, DataType.LongType, DataType.DecimalType -> ValueKind.NUMERIC
        DataType.BooleanType -> ValueKind.BOOLEAN
        DataType.StringType -> ValueKind.STRING
        DataType.UuidType -> ValueKind.UUID
        DataType.NamespacedKeyType -> ValueKind.NAMESPACED_KEY
        is DataType.ListType, is DataType.CompoundType -> ValueKind.CONTAINER
    }

    private fun ViewerFactType.valueKind(): ValueKind = when (this) {
        ViewerFactType.INTEGER, ViewerFactType.LONG, ViewerFactType.DECIMAL -> ValueKind.NUMERIC
        ViewerFactType.BOOLEAN -> ValueKind.BOOLEAN
        ViewerFactType.LOCALE, ViewerFactType.STRING -> ValueKind.STRING
        ViewerFactType.UUID -> ValueKind.UUID
        ViewerFactType.NAMESPACED_KEY -> ValueKind.NAMESPACED_KEY
    }

    private fun ItemDataValue.valueKind(): ValueKind = when (this) {
        is IntegerDataValue, is LongDataValue, is DecimalDataValue -> ValueKind.NUMERIC
        is BooleanDataValue -> ValueKind.BOOLEAN
        is StringDataValue -> ValueKind.STRING
        is UuidDataValue -> ValueKind.UUID
        is NamespacedKeyDataValue -> ValueKind.NAMESPACED_KEY
        is ListDataValue, is CompoundDataValue -> ValueKind.CONTAINER
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
