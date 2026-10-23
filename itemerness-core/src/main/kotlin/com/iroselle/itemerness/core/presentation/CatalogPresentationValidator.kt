package com.iroselle.itemerness.core.presentation

import com.iroselle.itemerness.api.BooleanDataValue
import com.iroselle.itemerness.api.CompoundDataValue
import com.iroselle.itemerness.api.DataKey
import com.iroselle.itemerness.api.DecimalDataValue
import com.iroselle.itemerness.api.IntegerDataValue
import com.iroselle.itemerness.api.ItemDataValue
import com.iroselle.itemerness.api.ItemKey
import com.iroselle.itemerness.api.ListDataValue
import com.iroselle.itemerness.api.LongDataValue
import com.iroselle.itemerness.api.NamespacedKeyDataValue
import com.iroselle.itemerness.api.StringDataValue
import com.iroselle.itemerness.api.UuidDataValue
import com.iroselle.itemerness.core.catalog.CatalogDiagnostic
import com.iroselle.itemerness.core.catalog.CatalogDiagnosticCode
import com.iroselle.itemerness.core.catalog.CatalogItemDefinition
import com.iroselle.itemerness.core.catalog.CatalogSnapshot
import com.iroselle.itemerness.core.catalog.DataType

/** Shared catalog/presentation validation for local YAML and editor previews. */
object CatalogPresentationValidator {
    fun validate(
        domain: CatalogSnapshot,
        presentation: PresentationCatalogSnapshot,
    ): List<CatalogDiagnostic> {
        val diagnostics = ArrayList<CatalogDiagnostic>()
        validatePresentation(domain, presentation, diagnostics)
        return diagnostics.sortedWith(compareBy({ it.path }, { it.code.name }, { it.message }))
    }

    fun formatAccepts(
        id: ItemKey,
        type: DataType,
        formats: Map<ItemKey, FormatSource>,
    ): Boolean = formatAccepts(id, type, formats, HashSet())

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
            listOf("before" to item.nameBefore, "after" to item.nameAfter).forEach { (side, fragments) ->
                validateFragments(fragments, "presentation.items.${item.key}.name.$side", definition, domain, presentation, diagnostics)
            }
            validateBlocks(
                item.blocks,
                "presentation.items.${item.key}.blocks",
                definition,
                domain,
                presentation,
                diagnostics,
            )
            // Selector conditions read the same item data as conditional blocks, so every item
            // bound to a selector must define and expose each referenced data key.
            presentation.themeSelectors[item.theme]?.cases?.forEachIndexed { index, case ->
                validateCondition(
                    case.condition,
                    "presentation.items.${item.key}.theme-selector.${item.theme}.cases[$index].when",
                    definition,
                    domain,
                    presentation,
                    diagnostics,
                )
            }
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
            validateBlock(block, "$path[$index]", item, domain, presentation, diagnostics)
        }
    }

    private fun validateBlock(
        block: CompiledPresentationBlock,
        blockPath: String,
        item: CatalogItemDefinition,
        domain: CatalogSnapshot,
        presentation: PresentationCatalogSnapshot,
        diagnostics: MutableList<CatalogDiagnostic>,
    ) {
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
                    block.summary?.valuePath?.let { valuePath ->
                        when (val resolved = resolveCompoundPath(compound, valuePath)) {
                            CompoundPath.Open -> Unit
                            CompoundPath.Missing -> diagnostics += CatalogDiagnostic(
                                CatalogDiagnosticCode.MISSING_REFERENCE,
                                "$blockPath.summary.value-path",
                                "Compound path $valuePath is not defined by ${block.data}",
                            )
                            is CompoundPath.Resolved -> validateFormat(
                                resolved.type,
                                block.summary.format,
                                "$blockPath.summary.format",
                                presentation,
                                diagnostics,
                            )
                        }
                    }
                }
            }

            is CompiledPresentationBlock.Row -> {
                validateFragments(block.left, "$blockPath.left", item, domain, presentation, diagnostics)
                validateFragments(block.right, "$blockPath.right", item, domain, presentation, diagnostics)
            }

            is CompiledPresentationBlock.Rule -> validateFragments(block.title, "$blockPath.title", item, domain, presentation, diagnostics)

            is CompiledPresentationBlock.Group -> {
                block.header?.let { validateBlock(it, "$blockPath.header", item, domain, presentation, diagnostics) }
                validateBlocks(block.children, "$blockPath.children", item, domain, presentation, diagnostics)
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

    private fun validateFragments(
        fragments: List<CompiledFragment>,
        path: String,
        item: CatalogItemDefinition,
        domain: CatalogSnapshot,
        presentation: PresentationCatalogSnapshot,
        diagnostics: MutableList<CatalogDiagnostic>,
    ) {
        fragments.forEachIndexed { index, fragment ->
            val fragmentPath = "$path[$index]"
            fragment.condition?.let { validateCondition(it, "$fragmentPath.when", item, domain, presentation, diagnostics) }
            if (fragment is CompiledFragment.Data) {
                val type = dataType(item, domain, fragment.data, "$fragmentPath.data", diagnostics)
                validateFormat(type, fragment.format, "$fragmentPath.format", presentation, diagnostics)
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
        if (left != null && right != null && !left.comparableWith(right) && !textLiteralCompares(condition, left, right)) {
            diagnostics += CatalogDiagnostic(
                CatalogDiagnosticCode.INVALID_VALUE,
                path,
                "Condition operands ${left.label} and ${right.label} are not comparable",
            )
        }
    }

    /** A string literal may name a key or UUID in an equality, matching the runtime comparison. */
    private fun textLiteralCompares(condition: CompiledCondition, left: ValueKind, right: ValueKind): Boolean {
        if (condition.operator != ConditionOperator.EQUALS && condition.operator != ConditionOperator.NOT_EQUALS) return false
        fun literalFits(reference: CompiledValueReference?, kind: ValueKind): Boolean {
            val text = ((reference as? CompiledValueReference.Literal)?.value as? StringDataValue)?.value ?: return false
            return when (kind) {
                ValueKind.NAMESPACED_KEY -> runCatching { ItemKey.parse(text) }.isSuccess
                ValueKind.UUID -> runCatching { java.util.UUID.fromString(text) }.isSuccess
                else -> false
            }
        }
        return literalFits(condition.right, left) || literalFits(condition.left, right)
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

    fun describe(type: DataType): String = when (type) {
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

}
