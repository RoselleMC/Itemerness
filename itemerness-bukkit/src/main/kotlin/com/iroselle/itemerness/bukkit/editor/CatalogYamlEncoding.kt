package com.iroselle.itemerness.bukkit.editor

import com.iroselle.itemerness.core.catalog.*
import com.iroselle.itemerness.core.presentation.*
import com.iroselle.itemerness.editor.protocol.DocumentDataKeyIntegration
import com.iroselle.itemerness.bukkit.editor.YamlEncoding.mapping as map

internal object CatalogYamlEncoding {
    fun schema(schema: DataSchemaSource, integrations: Map<com.iroselle.itemerness.api.ItemKey, DocumentDataKeyIntegration>): Map<String, Any?> = map(
        "schema-version" to schema.version, "id" to schema.id, "owner" to schema.owner,
        "keys" to schema.keys.associate { key -> key.id to key(key, requireNotNull(integrations[com.iroselle.itemerness.api.ItemKey.parse(key.id)])) },
    )

    private fun key(key: DataKeySource, policy: DocumentDataKeyIntegration): Map<String, Any?> = map(
        "type" to type(key.type), "scope" to YamlEncoding.enum(key.scope), "nullable" to key.nullable,
        "affects-stacking" to key.affectsStacking, "presentation-readable" to key.presentationReadable,
        "constraints" to constraints(key.constraints),
        "read-sources" to (listOf(if (key.scope == DataScope.DEFINITION) "catalog-definition" else "canonical-nbt") +
            policy.pdcFallbackKeys.map { map("pdc" to map("key" to it.toString(), "mode" to "fallback-read-only")) }),
        "access" to map("read" to YamlEncoding.enum(policy.readAccess), "write" to policy.writePrincipals.toList()),
        "placeholder-api" to map("exposed" to policy.placeholderExposed, "formatter" to policy.placeholderFormatter?.toString()),
    ) + (key.defaultValue?.let { mapOf("default" to YamlEncoding.source(it)) } ?: emptyMap())

    private fun constraints(constraints: DataConstraintsSource): Map<String, Any?> = map(
        "minimum" to constraints.minimum?.let(YamlEncoding::exactNumber), "maximum" to constraints.maximum?.let(YamlEncoding::exactNumber), "scale" to constraints.scale,
        "maximum-codepoints" to constraints.maximumCodePoints, "maximum-elements" to constraints.maximumElements,
        "maximum-entries" to constraints.maximumEntries, "maximum-depth" to constraints.maximumDepth,
        "allowed" to constraints.allowedValues.map(YamlEncoding::source))

    private fun type(type: DataType): Any = when (type) {
        DataType.BooleanType -> "boolean"
        DataType.IntegerType -> "integer"
        DataType.LongType -> "long"
        DataType.DecimalType -> "decimal"
        DataType.StringType -> "string"
        DataType.UuidType -> "uuid"
        DataType.NamespacedKeyType -> "namespaced-key"
        is DataType.ListType -> map("kind" to "list", "element" to type(type.element))
        is DataType.CompoundType -> type.fields?.let { fields -> map("kind" to "compound",
            "fields" to fields.associate { field -> field.name to map("type" to type(field.type), "nullable" to field.nullable) +
                (if (field.constraints.isEmpty) emptyMap() else mapOf("constraints" to constraints(field.constraints))) }) } ?: "compound"
    }

    fun item(item: ItemDefinitionSource, presentation: ItemPresentationSource, layout: String?, theme: String?): Map<String, Any?> = map(
        "enabled" to item.enabled,
        "base" to map("material" to item.material, "components" to item.baseComponents.associate { it.id to YamlEncoding.source(it.value) }),
        "definition-data" to assignments(item.definitionData),
        "instance" to map("mode" to YamlEncoding.enum(item.instance.mode), "id-generator" to item.instance.idGenerator?.let(YamlEncoding::enum),
            "schemas" to item.instance.schemas.map { "${it.id}@${it.version}" }, "defaults" to assignments(item.instance.defaults),
            "generate-on-create" to item.instance.generators.associate { generator -> generator.key to when (generator) {
                is DataGeneratorSource.UnixMillis -> map("generator" to "unix-millis")
                is DataGeneratorSource.RandomDecimal -> map("generator" to "random-decimal", "minimum" to YamlEncoding.exactNumber(generator.minimum), "maximum" to YamlEncoding.exactNumber(generator.maximum), "scale" to generator.scale)
            } }),
        "contents" to item.contents.map { map("item" to it.item, "amount" to it.amount) },
        "presentation" to map("layout" to layout, "theme" to theme, "name" to map("message" to presentation.nameMessage,
                "before" to presentation.nameBefore.takeIf { it.isNotEmpty() }?.map(::fragment),
                "after" to presentation.nameAfter.takeIf { it.isNotEmpty() }?.map(::fragment)), "blocks" to presentation.blocks.map(::block),
            "shown-flags" to presentation.shownFlags.takeIf { it.isNotEmpty() },
            // The root group's defaults are the pre-group behaviour and stay implicit.
            "marker" to presentation.marker.takeIf { it != GroupMarker.NONE }?.let(YamlEncoding::enum),
            "dividers" to presentation.dividers.takeIf { it != GroupDividers.BETWEEN_CHILDREN }?.let(YamlEncoding::enum),
            "overflow" to presentation.overflow?.let(YamlEncoding::enum)),
    )

    private fun assignments(assignments: List<DataAssignmentSource>): Map<String, Any?> = assignments.associate { it.key to YamlEncoding.source(it.value) }

    private fun block(block: PresentationBlockSource): Map<String, Any?> = map("style" to block.style, "anchor" to block.anchor,
        "weight" to block.weight?.let(::weight), "summary" to block.summary?.let(::summary)) + when (block) {
        is PresentationBlockSource.Text -> map("type" to "text", "data" to block.data, "wrapping" to block.wrapping, "unbreakable" to block.unbreakable, "missing-policy" to YamlEncoding.enum(block.missingPolicy))
        is PresentationBlockSource.Field -> map("type" to "field", "data" to block.data, "label" to block.labelMessage, "format" to block.format, "icon" to block.icon, "wrapping" to block.wrapping, "missing-policy" to YamlEncoding.enum(block.missingPolicy),
            "separator" to block.separator?.let(::separator), "styles" to block.partStyles?.let(::partStyles))
        is PresentationBlockSource.Description -> map("type" to "description", "message" to block.message, "wrapping" to block.wrapping)
        is PresentationBlockSource.Conditional -> map("type" to "conditional", "condition" to condition(block.condition),
            "then" to block.thenBlocks.map(::block), "otherwise" to block.otherwiseBlocks.map(::block))
        is PresentationBlockSource.Repeat -> map("type" to "repeat", "data" to block.data, "maximum-elements" to block.maximumElements,
            "missing-policy" to YamlEncoding.enum(block.missingPolicy), "template" to map("type" to "compound-field", "label" to block.template.labelMessage,
                "value-path" to block.template.valuePath, "missing-message" to block.template.missingMessage, "icon" to block.template.icon, "format" to block.template.format,
                "separator" to block.template.separator?.let(::separator), "styles" to block.template.partStyles?.let(::partStyles)))
        is PresentationBlockSource.NestedItemList -> map("type" to "nested-item-list")
        is PresentationBlockSource.Group -> map("type" to "group", "header" to block.header?.let(::block), "children" to block.children.map(::block),
            "marker" to block.marker.takeIf { it != GroupMarker.NONE }?.let(YamlEncoding::enum),
            "dividers" to block.dividers.takeIf { it != GroupDividers.NONE }?.let(YamlEncoding::enum),
            "when-header-missing" to block.whenHeaderMissing.takeIf { it != GroupHeaderMissingPolicy.HIDE }?.let(YamlEncoding::enum),
            "when-empty" to block.whenEmpty.takeIf { it != GroupEmptyPolicy.SHOW_HEADER }?.let(YamlEncoding::enum),
            "gap-before-lines" to block.gapBeforeLines.takeIf { it != 0 })
        is PresentationBlockSource.Row -> map("type" to "row", "left" to block.left.takeIf { it.isNotEmpty() }?.map(::fragment),
            "right" to block.right.takeIf { it.isNotEmpty() }?.map(::fragment), "wrapping" to block.wrapping)
        is PresentationBlockSource.Rule -> map("type" to "rule", "title" to block.title.takeIf { it.isNotEmpty() }?.map(::fragment))
    }

    private fun weight(weight: HidingWeight): Any = when (weight) {
        HidingWeight.Never -> "never"
        is HidingWeight.Ranked -> weight.value
    }

    private fun summary(summary: SummarySource): Map<String, Any?> = map("slot" to summary.slot, "piece" to summary.piece?.let(::fragment),
        "value-path" to summary.valuePath, "format" to summary.format, "style" to summary.style)

    private fun partStyles(styles: FieldPartStyles): Map<String, Any?> =
        map("icon" to styles.icon, "label" to styles.label, "separator" to styles.separator, "value" to styles.value)

    private fun fragment(fragment: FragmentSource): Map<String, Any?> = when (fragment) {
        is FragmentSource.Message -> map("message" to fragment.message)
        is FragmentSource.Data -> map("data" to fragment.data, "format" to fragment.format)
        is FragmentSource.Glyph -> map("glyph" to fragment.glyph)
        is FragmentSource.Literal -> map("literal" to fragment.text)
        is FragmentSource.Slot -> map("slot" to fragment.id, "prefix" to fragment.prefix?.let(::fragment), "suffix" to fragment.suffix?.let(::fragment),
            "separator" to fragment.separator?.let(::fragment), "maximum-entries" to fragment.maximumEntries,
            "overflow-count-message" to fragment.overflowCountMessage)
    } + map("style" to fragment.style, "when" to fragment.condition?.let(::condition))

    /** Shared by fields, repeat templates and flow layouts. */
    fun separator(separator: FieldSeparatorSource): Any = when (separator) {
        FieldSeparatorSource.None -> "none"
        is FieldSeparatorSource.Message -> map("message" to separator.message)
    }

    /** Shared by conditional blocks and theme selector cases, which use the same condition model. */
    fun condition(condition: ConditionSource): Map<String, Any?> = map("operator" to YamlEncoding.enum(condition.operator),
        "left" to reference(condition.left), "right" to condition.right?.let(::reference))

    private fun reference(reference: ValueReferenceSource): Map<String, Any?> = when (reference) {
        is ValueReferenceSource.Data -> map("data" to reference.key)
        is ValueReferenceSource.Fact -> map("fact" to reference.key)
        is ValueReferenceSource.Literal -> map("literal" to YamlEncoding.typed(reference.value))
    }
}
