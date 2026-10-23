package com.iroselle.itemerness.editor.protocol

import com.iroselle.itemerness.core.catalog.CatalogSource
import com.iroselle.itemerness.core.catalog.DataAssignmentSource
import com.iroselle.itemerness.core.catalog.DataGeneratorSource
import com.iroselle.itemerness.core.catalog.DataSchemaSource
import com.iroselle.itemerness.core.catalog.ItemDefinitionSource
import com.iroselle.itemerness.core.presentation.ConditionSource
import com.iroselle.itemerness.core.presentation.FieldPartStyles
import com.iroselle.itemerness.core.presentation.FieldSeparatorSource
import com.iroselle.itemerness.core.presentation.FormatSource
import com.iroselle.itemerness.core.presentation.FragmentSource
import com.iroselle.itemerness.core.presentation.GroupDividers
import com.iroselle.itemerness.core.presentation.GroupEmptyPolicy
import com.iroselle.itemerness.core.presentation.GroupHeaderMissingPolicy
import com.iroselle.itemerness.core.presentation.GroupMarker
import com.iroselle.itemerness.core.presentation.HidingWeight
import com.iroselle.itemerness.core.presentation.ItemPresentationSource
import com.iroselle.itemerness.core.presentation.PresentationBlockSource
import com.iroselle.itemerness.core.presentation.PresentationBudgets
import com.iroselle.itemerness.core.presentation.PresentationSource
import com.iroselle.itemerness.core.presentation.ResourcePackDelivery
import com.iroselle.itemerness.core.presentation.SummarySource
import com.iroselle.itemerness.core.presentation.ThemeSelectorSource
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
        ).let { node ->
            // Verified delivery stays absent so existing documents keep their canonical hash.
            if (binding.delivery == ResourcePackDelivery.VERIFIED) node
            else JsonValue.Obj(node.entries + ("delivery" to JsonValue.Text(binding.delivery.name)))
        } },
        "viewerFacts" to presentation.viewerFacts.map { fact -> node("facts", fact.id,
            "id" to fact.id, "type" to fact.type, "providers" to fact.providers, "defaultValue" to fact.defaultValue?.let(DocumentEncoding::typedValue),
            "nullable" to fact.nullable, "cacheKey" to fact.cacheKey, "previewValue" to null,
        ) },
        "layouts" to presentation.layouts.map { layout -> withIdentity("layouts", layout.id, PresentationDocumentEncoding.layout(layout)) },
        "themes" to presentation.themes.map { theme -> withIdentity("themes", theme.id, PresentationDocumentEncoding.theme(theme)) },
        "spacing" to presentation.spacing?.let(PresentationDocumentEncoding::spacing),
        "accessPolicies" to emptyList<JsonValue>(),
        )
        // Absent selectors stay absent so documents without them keep their canonical hash.
        val withSelectors = if (presentation.themeSelectors.isEmpty()) encoded else JsonValue.Obj(encoded.entries + (
            "themeSelectors" to JsonValue.Arr(presentation.themeSelectors.map(::themeSelector))
        ))
        return if (defaults == null) withSelectors else JsonValue.Obj(withSelectors.entries + obj("defaultLayout" to defaults.layout, "defaultTheme" to defaults.theme).entries)
    }

    private fun themeSelector(selector: ThemeSelectorSource): JsonValue = node("themeSelectors", selector.id,
        "id" to selector.id,
        "cases" to selector.cases.map { case -> obj("condition" to condition(case.condition), "theme" to case.theme) },
        "defaultTheme" to selector.defaultTheme,
    )

    private fun assetNodes(assets: JsonObject, kind: String): List<JsonValue> = assets.requiredObjects(kind).map { asset ->
        val metadata = JsonValue.Obj((asset.keys - setOf("uuid", "extensions")).associateWith { requireNotNull(asset.raw(it)) })
        withIdentity(kind, asset.requiredString("id"), metadata)
    }

    private fun objectValue(node: JsonObject): JsonValue.Obj = JsonValue.Obj(node.keys.associateWith { requireNotNull(node.raw(it)) })

    private fun node(domain: String, id: String, vararg fields: Pair<String, Any?>): JsonValue.Obj =
        withIdentity(domain, id, obj(*fields))

    private fun withIdentity(domain: String, id: String, value: JsonValue.Obj): JsonValue.Obj =
        JsonValue.Obj(value.entries + ("uuid" to JsonValue.Text(UUID.nameUUIDFromBytes("$documentId/$domain/$id".toByteArray(Charsets.UTF_8)).toString())))

    private fun schema(schema: DataSchemaSource, integrations: Map<String, JsonValue>): JsonValue.Obj = schemaNode(schema, integrations).let { node ->
        // An absent owner stays absent so unowned schemas keep their canonical hash.
        schema.owner?.let { owner -> JsonValue.Obj(node.entries + ("owner" to JsonValue.Text(owner))) } ?: node
    }

    private fun schemaNode(schema: DataSchemaSource, integrations: Map<String, JsonValue>): JsonValue.Obj = node("schemas", "${schema.id}@${schema.version}",
        "id" to schema.id, "version" to schema.version,
        "keys" to schema.keys.map { key -> node("keys", "${schema.id}@${schema.version}/${key.id}",
            "id" to key.id, "type" to DocumentEncoding.type(key.type), "scope" to key.scope, "nullable" to key.nullable,
            "defaultValue" to key.defaultValue?.let(DocumentEncoding::sourceValue),
            "affectsStacking" to key.affectsStacking, "presentationReadable" to key.presentationReadable,
            "constraints" to DocumentEncoding.constraints(key.constraints),
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
                // Omitted when empty so documents without shown components keep their hashes.
                *listOfNotNull(presentation.shownFlags.takeIf { it.isNotEmpty() }?.let { "shownFlags" to it }).toTypedArray(),
                // The implicit root group's defaults stay absent for the same reason.
                *listOfNotNull(
                    presentation.marker.takeIf { it != GroupMarker.NONE }?.let { "marker" to it },
                    presentation.dividers.takeIf { it != GroupDividers.BETWEEN_CHILDREN }?.let { "dividers" to it },
                    presentation.nameBefore.takeIf { it.isNotEmpty() }?.let { "nameBefore" to it.map(::fragment) },
                    presentation.nameAfter.takeIf { it.isNotEmpty() }?.let { "nameAfter" to it.map(::fragment) },
                    presentation.overflow?.let { "overflow" to it },
                ).toTypedArray(),
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
            is PresentationBlockSource.Field -> withPartStyles(withSeparator(
                obj("type" to "field", "data" to block.data, "labelMessage" to block.labelMessage, "format" to block.format, "icon" to block.icon, "wrapping" to block.wrapping, "missingPolicy" to block.missingPolicy),
                block.separator,
            ), block.partStyles)
            is PresentationBlockSource.Description -> obj("type" to "description", "message" to block.message, "wrapping" to block.wrapping)
            is PresentationBlockSource.Conditional -> obj("type" to "conditional", "condition" to condition(block.condition),
                "thenBlocks" to block.thenBlocks.mapIndexed { index, child -> block(child, "$path/then/$index") },
                "otherwiseBlocks" to block.otherwiseBlocks.mapIndexed { index, child -> block(child, "$path/otherwise/$index") },
            )
            is PresentationBlockSource.Repeat -> obj("type" to "repeat", "data" to block.data, "maximumElements" to block.maximumElements, "missingPolicy" to block.missingPolicy,
                "template" to withPartStyles(withSeparator(
                    obj("labelMessage" to block.template.labelMessage, "valuePath" to block.template.valuePath, "missingMessage" to block.template.missingMessage, "icon" to block.template.icon, "format" to block.template.format),
                    block.template.separator,
                ), block.template.partStyles),
            )
            is PresentationBlockSource.NestedItemList -> obj("type" to "nestedItemList")
            is PresentationBlockSource.Group -> JsonValue.Obj(buildMap {
                put("type", JsonValue.Text("group"))
                block.header?.let { put("header", block(it, "$path/header")) }
                put("children", JsonValue.Arr(block.children.mapIndexed { index, child -> block(child, "$path/children/$index") }))
                // Defaults stay absent so a group's shape names only what an author changed.
                if (block.marker != GroupMarker.NONE) put("marker", JsonValue.Text(block.marker.name))
                if (block.dividers != GroupDividers.NONE) put("dividers", JsonValue.Text(block.dividers.name))
                if (block.whenHeaderMissing != GroupHeaderMissingPolicy.HIDE) put("whenHeaderMissing", JsonValue.Text(block.whenHeaderMissing.name))
                if (block.whenEmpty != GroupEmptyPolicy.SHOW_HEADER) put("whenEmpty", JsonValue.Text(block.whenEmpty.name))
                if (block.gapBeforeLines != 0) put("gapBeforeLines", JsonValue.Num(block.gapBeforeLines.toDouble()))
            })
            is PresentationBlockSource.Row -> obj("type" to "row", "left" to block.left.map(::fragment), "right" to block.right.map(::fragment), "wrapping" to block.wrapping)
            is PresentationBlockSource.Rule -> obj("type" to "rule", "title" to block.title.map(::fragment))
        }
        // Hiding settings stay absent when unset so existing documents keep their hashes.
        val hiding = present("weight" to block.weight?.let(::weight), "summary" to block.summary?.let(::summary))
        return withIdentity("blocks", path, JsonValue.Obj(fields.entries + obj("style" to block.style, "anchor" to block.anchor).entries + hiding.entries))
    }

    /** Like [obj], but null values are absent rather than JSON null. */
    private fun present(vararg values: Pair<String, Any?>): JsonValue.Obj = obj(*values.filter { it.second != null }.toTypedArray())

    private fun weight(weight: HidingWeight): Any = when (weight) {
        HidingWeight.Never -> "never"
        is HidingWeight.Ranked -> weight.value
    }

    private fun summary(summary: SummarySource): JsonValue = present("slot" to summary.slot, "piece" to summary.piece?.let(::fragment),
        "valuePath" to summary.valuePath, "format" to summary.format, "style" to summary.style)

    private fun withPartStyles(node: JsonValue.Obj, styles: FieldPartStyles?): JsonValue.Obj =
        if (styles == null) node else JsonValue.Obj(node.entries + ("partStyles" to present(
            "icon" to styles.icon, "label" to styles.label, "separator" to styles.separator, "value" to styles.value,
        )))

    private fun fragment(fragment: FragmentSource): JsonValue {
        val fields = when (fragment) {
            is FragmentSource.Message -> present("kind" to "message", "message" to fragment.message)
            is FragmentSource.Data -> present("kind" to "data", "data" to fragment.data, "format" to fragment.format)
            is FragmentSource.Glyph -> present("kind" to "glyph", "glyph" to fragment.glyph)
            is FragmentSource.Literal -> present("kind" to "literal", "text" to fragment.text)
            is FragmentSource.Slot -> present("kind" to "slot", "id" to fragment.id, "prefix" to fragment.prefix?.let(::fragment),
                "suffix" to fragment.suffix?.let(::fragment), "separator" to fragment.separator?.let(::fragment),
                "maximumEntries" to fragment.maximumEntries, "overflowCountMessage" to fragment.overflowCountMessage)
        }
        return JsonValue.Obj(fields.entries + present("style" to fragment.style, "condition" to fragment.condition?.let(::condition)).entries)
    }

    /** Absent separators inherit; they stay absent so existing documents keep their hashes. */
    private fun withSeparator(node: JsonValue.Obj, separator: FieldSeparatorSource?): JsonValue.Obj =
        if (separator == null) node else JsonValue.Obj(node.entries + ("separator" to PresentationDocumentEncoding.separator(separator)))

    private fun condition(condition: ConditionSource): JsonValue = obj("operator" to condition.operator, "left" to reference(condition.left), "right" to condition.right?.let(::reference))

    private fun reference(reference: ValueReferenceSource): JsonValue = when (reference) {
        is ValueReferenceSource.Data -> obj("kind" to "data", "key" to reference.key)
        is ValueReferenceSource.Fact -> obj("kind" to "fact", "key" to reference.key)
        is ValueReferenceSource.Literal -> obj("kind" to "literal", "value" to DocumentEncoding.typedValue(reference.value))
    }
}
