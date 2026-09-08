package com.iroselle.itemerness.editor.protocol

import com.iroselle.itemerness.core.catalog.CatalogSource
import com.iroselle.itemerness.core.catalog.DataAssignmentSource
import com.iroselle.itemerness.core.catalog.DataGeneratorSource
import com.iroselle.itemerness.core.catalog.DataSchemaSource
import com.iroselle.itemerness.core.catalog.ItemDefinitionSource
import com.iroselle.itemerness.core.presentation.ConditionSource
import com.iroselle.itemerness.core.presentation.FormatSource
import com.iroselle.itemerness.core.presentation.ItemPresentationSource
import com.iroselle.itemerness.core.presentation.PresentationBlockSource
import com.iroselle.itemerness.core.presentation.PresentationBudgets
import com.iroselle.itemerness.core.presentation.PresentationSource
import com.iroselle.itemerness.core.presentation.ValueReferenceSource
import com.iroselle.itemerness.editor.protocol.DocumentEncoding.obj
import java.util.UUID

/** Encodes already validated configuration sources. Asset selectors and policies stay explicit. */
class ProjectDocumentEncoder(private val documentId: UUID) {
    data class Defaults(val layout: String?, val theme: String?)
    data class ItemBindings(val layout: String?, val theme: String?)
    private val budgets = PresentationBudgets()
    fun encode(
        namespace: String,
        defaultLocale: String,
        catalog: CatalogSource,
        presentation: PresentationSource,
        assets: JsonObject,
        integrations: Map<String, JsonValue>,
        defaults: Defaults? = null,
        itemBindings: Map<String, ItemBindings>? = null,
    ): JsonValue.Obj {
        val encoded = obj(
        "schemaVersion" to 2,
        "documentId" to documentId.toString(),
        "namespace" to namespace,
        "defaultLocale" to defaultLocale,
        "budgets" to obj(
            "maximumWidthPixels" to budgets.maximumWidthPixels, "maximumHeightPixels" to budgets.maximumHeightPixels, "maximumLines" to budgets.maximumLines,
            "maximumRuns" to budgets.maximumRuns, "maximumTextCodePoints" to budgets.maximumTextCodePoints, "maximumBlocksPerItem" to budgets.maximumBlocksPerItem,
            "maximumBlockDepth" to budgets.maximumBlockDepth, "maximumRepeatElements" to budgets.maximumRepeatElements, "maximumCanvasLayers" to budgets.maximumCanvasLayers,
            "maximumEmittedGlyphs" to budgets.maximumEmittedGlyphs,
        ),
        "measurement" to objectValue(assets.requiredObject("measurement")),
        "dataSchemas" to catalog.schemas.map { schema(it, integrations) },
        "items" to catalog.items.map { item ->
            item(item, presentation.items.single { it.id == item.id }, itemBindings?.let {
                requireNotNull(it[item.id]) { "Missing authoring bindings for ${item.id}" }
            })
        },
        "formats" to presentation.formats.map(::format),
        "locales" to presentation.locales.map { locale -> node("locales", locale.locale,
            "locale" to locale.locale, "fallback" to locale.fallback, "messages" to locale.messages,
        ) },
        "fonts" to assetNodes(assets, "fonts"),
        "glyphs" to presentation.glyphs.map { glyph -> node("glyphs", glyph.id,
            "id" to glyph.id, "font" to glyph.font, "codePoint" to glyph.codePoint, "advancePixels" to glyph.advancePixels,
            "visualBounds" to PresentationDocumentEncoding.bounds(glyph.visualBounds), "bitmap" to glyph.bitmap,
        ) },
        "bitmaps" to assetNodes(assets, "bitmaps"),
        "tooltipStyles" to assetNodes(assets, "tooltipStyles"),
        "assetProfiles" to presentation.assetProfiles.map { profile -> node("profiles", profile.id,
            "id" to profile.id, "capabilities" to profile.capabilities, "metricsRevision" to profile.metricsRevision, "fallback" to profile.fallback,
        ) },
        "resourcePackBindings" to presentation.resourcePackBindings.map { binding -> node("bindings", binding.id,
            "id" to binding.id, "enabled" to binding.enabled, "packId" to binding.packId?.toString(), "sha1" to binding.sha1, "assetProfile" to binding.assetProfile,
        ) },
        "viewerFacts" to presentation.viewerFacts.map { fact -> node("facts", fact.id,
            "id" to fact.id, "type" to fact.type, "providers" to fact.providers, "defaultValue" to fact.defaultValue?.let(DocumentEncoding::typedValue),
            "nullable" to fact.nullable, "cacheKey" to fact.cacheKey, "previewValue" to null,
        ) },
        "layouts" to presentation.layouts.map { layout -> withIdentity("layouts", layout.id, PresentationDocumentEncoding.layout(layout)) },
        "themes" to presentation.themes.map { theme -> withIdentity("themes", theme.id, PresentationDocumentEncoding.theme(theme)) },
        "spacing" to presentation.spacing?.let(PresentationDocumentEncoding::spacing),
        "accessPolicies" to emptyList<JsonValue>(),
        )
        return if (defaults == null) encoded else JsonValue.Obj(encoded.entries + obj("defaultLayout" to defaults.layout, "defaultTheme" to defaults.theme).entries)
    }

    private fun assetNodes(assets: JsonObject, kind: String): List<JsonValue> = assets.requiredObjects(kind).map { asset ->
        val metadata = JsonValue.Obj((asset.keys - setOf("uuid", "extensions")).associateWith { requireNotNull(asset.raw(it)) })
        withIdentity(kind, asset.requiredString("id"), metadata)
    }

    private fun objectValue(node: JsonObject): JsonValue.Obj = JsonValue.Obj(node.keys.associateWith { requireNotNull(node.raw(it)) })

    private fun node(domain: String, id: String, vararg fields: Pair<String, Any?>): JsonValue.Obj =
        withIdentity(domain, id, obj(*fields))

    private fun withIdentity(domain: String, id: String, value: JsonValue.Obj): JsonValue.Obj =
        JsonValue.Obj(value.entries + ("uuid" to JsonValue.Text(UUID.nameUUIDFromBytes("$documentId/$domain/$id".toByteArray(Charsets.UTF_8)).toString())))

    private fun schema(schema: DataSchemaSource, integrations: Map<String, JsonValue>): JsonValue.Obj = node("schemas", "${schema.id}@${schema.version}",
        "id" to schema.id, "version" to schema.version,
        "keys" to schema.keys.map { key -> node("keys", "${schema.id}@${schema.version}/${key.id}",
            "id" to key.id, "type" to DocumentEncoding.type(key.type), "scope" to key.scope, "nullable" to key.nullable,
            "defaultValue" to key.defaultValue?.let(DocumentEncoding::sourceValue),
            "affectsStacking" to key.affectsStacking, "presentationReadable" to key.presentationReadable,
            "constraints" to obj(
                "minimum" to key.constraints.minimum?.toString(), "maximum" to key.constraints.maximum?.toString(), "scale" to key.constraints.scale,
                "maximumCodePoints" to key.constraints.maximumCodePoints, "maximumElements" to key.constraints.maximumElements,
                "maximumEntries" to key.constraints.maximumEntries, "maximumDepth" to key.constraints.maximumDepth,
                "allowedValues" to key.constraints.allowedValues.map(DocumentEncoding::sourceValue),
            ),
            "integration" to requireNotNull(integrations[key.id]) { "Missing integration policy for ${key.id}" },
        ) },
    )

    private fun item(item: ItemDefinitionSource, presentation: ItemPresentationSource, bindings: ItemBindings?): JsonValue.Obj {
        return node("items", item.id,
            "id" to item.id, "enabled" to item.enabled,
            "definition" to obj(
                "material" to item.material,
                "baseComponents" to item.baseComponents.map { obj("id" to it.id, "value" to DocumentEncoding.sourceValue(it.value)) },
                "definitionData" to item.definitionData.map(::assignment),
                "contentComponent" to item.contentComponent,
                "contents" to item.contents.map { obj("item" to it.item, "amount" to it.amount) },
                "instance" to obj(
                    "mode" to item.instance.mode, "idGenerator" to item.instance.idGenerator,
                    "schemas" to item.instance.schemas.map { obj("id" to it.id, "version" to it.version) },
                    "defaults" to item.instance.defaults.map(::assignment),
                    "generators" to item.instance.generators.map { generator -> when (generator) {
                        is DataGeneratorSource.UnixMillis -> obj("kind" to "unixMillis", "key" to generator.key)
                        is DataGeneratorSource.RandomDecimal -> obj("kind" to "randomDecimal", "key" to generator.key, "minimum" to generator.minimum.toString(), "maximum" to generator.maximum.toString(), "scale" to generator.scale)
                    } },
                ),
            ),
            "presentation" to obj(
                "layout" to (if (bindings == null) presentation.layout else bindings.layout),
                "theme" to (if (bindings == null) presentation.theme else bindings.theme), "nameMessage" to presentation.nameMessage,
                "blocks" to presentation.blocks.mapIndexed { index, block -> block(block, "${item.id}/$index") },
            ),
            "previewData" to emptyList<JsonValue>(),
        )
    }

    private fun assignment(assignment: DataAssignmentSource): JsonValue =
        obj("key" to assignment.key, "value" to DocumentEncoding.sourceValue(assignment.value))

    private fun format(format: FormatSource): JsonValue = withIdentity("formats", format.id, when (format) {
        is FormatSource.IntegerFormat -> obj("id" to format.id, "kind" to "integer", "pattern" to format.pattern)
        is FormatSource.DecimalFormat -> obj("id" to format.id, "kind" to "decimal", "pattern" to format.pattern, "multiply" to format.multiply, "suffixMessage" to format.suffixMessage)
        is FormatSource.BooleanFormat -> obj("id" to format.id, "kind" to "boolean", "trueMessage" to format.trueMessage, "falseMessage" to format.falseMessage)
        is FormatSource.NamespacedKeyFormat -> obj("id" to format.id, "kind" to "namespacedKey", "mode" to format.mode, "messagePattern" to format.messagePattern, "missingValue" to format.missingValue)
        is FormatSource.ListFormat -> obj("id" to format.id, "kind" to "list", "elementFormat" to format.elementFormat, "separatorMessage" to format.separatorMessage)
    })

    private fun block(block: PresentationBlockSource, path: String): JsonValue {
        val fields = when (block) {
            is PresentationBlockSource.Text -> obj("type" to "text", "data" to block.data, "wrapping" to block.wrapping, "unbreakable" to block.unbreakable, "missingPolicy" to block.missingPolicy)
            is PresentationBlockSource.Field -> obj("type" to "field", "data" to block.data, "labelMessage" to block.labelMessage, "format" to block.format, "icon" to block.icon, "wrapping" to block.wrapping, "missingPolicy" to block.missingPolicy)
            is PresentationBlockSource.Description -> obj("type" to "description", "message" to block.message, "wrapping" to block.wrapping)
            is PresentationBlockSource.Conditional -> obj("type" to "conditional", "condition" to condition(block.condition),
                "thenBlocks" to block.thenBlocks.mapIndexed { index, child -> block(child, "$path/then/$index") },
                "otherwiseBlocks" to block.otherwiseBlocks.mapIndexed { index, child -> block(child, "$path/otherwise/$index") },
            )
            is PresentationBlockSource.Repeat -> obj("type" to "repeat", "data" to block.data, "maximumElements" to block.maximumElements, "missingPolicy" to block.missingPolicy,
                "template" to obj("labelMessage" to block.template.labelMessage, "valuePath" to block.template.valuePath, "missingMessage" to block.template.missingMessage, "icon" to block.template.icon, "format" to block.template.format),
            )
            is PresentationBlockSource.NestedItemList -> obj("type" to "nestedItemList")
        }
        return withIdentity("blocks", path, JsonValue.Obj(fields.entries + obj("style" to block.style, "anchor" to block.anchor).entries))
    }

    private fun condition(condition: ConditionSource): JsonValue = obj("operator" to condition.operator, "left" to reference(condition.left), "right" to condition.right?.let(::reference))

    private fun reference(reference: ValueReferenceSource): JsonValue = when (reference) {
        is ValueReferenceSource.Data -> obj("kind" to "data", "key" to reference.key)
        is ValueReferenceSource.Fact -> obj("kind" to "fact", "key" to reference.key)
        is ValueReferenceSource.Literal -> obj("kind" to "literal", "value" to DocumentEncoding.typedValue(reference.value))
    }
}
