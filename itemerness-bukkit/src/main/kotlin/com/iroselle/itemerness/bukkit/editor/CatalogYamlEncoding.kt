package com.iroselle.itemerness.bukkit.editor

import com.iroselle.itemerness.core.catalog.*
import com.iroselle.itemerness.core.presentation.*
import com.iroselle.itemerness.editor.protocol.DocumentDataKeyIntegration
import com.iroselle.itemerness.bukkit.editor.YamlEncoding.mapping as map

internal object CatalogYamlEncoding {
    fun schema(schema: DataSchemaSource, integrations: Map<com.iroselle.itemerness.api.ItemKey, DocumentDataKeyIntegration>): Map<String, Any?> = map(
        "schema-version" to schema.version, "id" to schema.id,
        "keys" to schema.keys.associate { key -> key.id to key(key, requireNotNull(integrations[com.iroselle.itemerness.api.ItemKey.parse(key.id)])) },
    )

    private fun key(key: DataKeySource, policy: DocumentDataKeyIntegration): Map<String, Any?> = map(
        "type" to type(key.type), "scope" to YamlEncoding.enum(key.scope), "nullable" to key.nullable,
        "affects-stacking" to key.affectsStacking, "presentation-readable" to key.presentationReadable,
        "constraints" to map("minimum" to key.constraints.minimum?.let(YamlEncoding::exactNumber), "maximum" to key.constraints.maximum?.let(YamlEncoding::exactNumber), "scale" to key.constraints.scale,
            "maximum-codepoints" to key.constraints.maximumCodePoints, "maximum-elements" to key.constraints.maximumElements,
            "maximum-entries" to key.constraints.maximumEntries, "maximum-depth" to key.constraints.maximumDepth,
            "allowed" to key.constraints.allowedValues.map(YamlEncoding::source)),
        "read-sources" to (listOf(if (key.scope == DataScope.DEFINITION) "catalog-definition" else "canonical-nbt") +
            policy.pdcFallbackKeys.map { map("pdc" to map("key" to it.toString(), "mode" to "fallback-read-only")) }),
        "access" to map("read" to YamlEncoding.enum(policy.readAccess), "write" to policy.writePrincipals.toList()),
        "placeholder-api" to map("exposed" to policy.placeholderExposed, "formatter" to policy.placeholderFormatter?.toString()),
    ) + (key.defaultValue?.let { mapOf("default" to YamlEncoding.source(it)) } ?: emptyMap())

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
            "fields" to fields.associate { it.name to map("type" to type(it.type), "nullable" to it.nullable) }) } ?: "compound"
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
        "presentation" to map("layout" to layout, "theme" to theme, "name" to map("message" to presentation.nameMessage), "blocks" to presentation.blocks.map(::block)),
    )

    private fun assignments(assignments: List<DataAssignmentSource>): Map<String, Any?> = assignments.associate { it.key to YamlEncoding.source(it.value) }

    private fun block(block: PresentationBlockSource): Map<String, Any?> = map("style" to block.style, "anchor" to block.anchor) + when (block) {
        is PresentationBlockSource.Text -> map("type" to "text", "data" to block.data, "wrapping" to block.wrapping, "unbreakable" to block.unbreakable, "missing-policy" to YamlEncoding.enum(block.missingPolicy))
        is PresentationBlockSource.Field -> map("type" to "field", "data" to block.data, "label" to block.labelMessage, "format" to block.format, "icon" to block.icon, "wrapping" to block.wrapping, "missing-policy" to YamlEncoding.enum(block.missingPolicy))
        is PresentationBlockSource.Description -> map("type" to "description", "message" to block.message, "wrapping" to block.wrapping)
        is PresentationBlockSource.Conditional -> map("type" to "conditional", "condition" to map("operator" to YamlEncoding.enum(block.condition.operator),
            "left" to reference(block.condition.left), "right" to block.condition.right?.let(::reference)),
            "then" to block.thenBlocks.map(::block), "otherwise" to block.otherwiseBlocks.map(::block))
        is PresentationBlockSource.Repeat -> map("type" to "repeat", "data" to block.data, "maximum-elements" to block.maximumElements,
            "missing-policy" to YamlEncoding.enum(block.missingPolicy), "template" to map("type" to "compound-field", "label" to block.template.labelMessage,
                "value-path" to block.template.valuePath, "missing-message" to block.template.missingMessage, "icon" to block.template.icon, "format" to block.template.format))
        is PresentationBlockSource.NestedItemList -> map("type" to "nested-item-list")
    }

    private fun reference(reference: ValueReferenceSource): Map<String, Any?> = when (reference) {
        is ValueReferenceSource.Data -> map("data" to reference.key)
        is ValueReferenceSource.Fact -> map("fact" to reference.key)
        is ValueReferenceSource.Literal -> map("literal" to YamlEncoding.typed(reference.value))
    }
}
