package com.iroselle.itemerness.editor.protocol

import com.iroselle.itemerness.api.BooleanDataValue
import com.iroselle.itemerness.api.CompoundDataValue
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
import com.iroselle.itemerness.core.catalog.BaseItemComponentSource
import com.iroselle.itemerness.core.catalog.CatalogSource
import com.iroselle.itemerness.core.catalog.CompoundFieldSource
import com.iroselle.itemerness.core.catalog.DataAssignmentSource
import com.iroselle.itemerness.core.catalog.DataConstraintsSource
import com.iroselle.itemerness.core.catalog.DataGeneratorSource
import com.iroselle.itemerness.core.catalog.DataKeySource
import com.iroselle.itemerness.core.catalog.DataSchemaSource
import com.iroselle.itemerness.core.catalog.DataScope
import com.iroselle.itemerness.core.catalog.DataType
import com.iroselle.itemerness.core.catalog.InstanceIdGenerator
import com.iroselle.itemerness.core.catalog.ItemContentSource
import com.iroselle.itemerness.core.catalog.ItemDefinitionSource
import com.iroselle.itemerness.core.catalog.ItemInstanceSource
import com.iroselle.itemerness.core.catalog.NestedContentComponent
import com.iroselle.itemerness.core.catalog.SchemaReferenceSource
import com.iroselle.itemerness.core.catalog.SourceDataValue
import com.iroselle.itemerness.core.presentation.AssetProfileSource
import com.iroselle.itemerness.core.presentation.BitmapSource
import com.iroselle.itemerness.core.presentation.CanvasAnchorSource
import com.iroselle.itemerness.core.presentation.CanvasLayerAnchor
import com.iroselle.itemerness.core.presentation.CanvasLayerSource
import com.iroselle.itemerness.core.presentation.CanvasThemeSource
import com.iroselle.itemerness.core.presentation.CharacterFramePreset
import com.iroselle.itemerness.core.presentation.CharacterFrameSource
import com.iroselle.itemerness.core.presentation.CompoundFieldTemplateSource
import com.iroselle.itemerness.core.presentation.ConditionOperator
import com.iroselle.itemerness.core.presentation.ConditionSource
import com.iroselle.itemerness.core.presentation.ContentAreaSource
import com.iroselle.itemerness.core.presentation.FieldValueAlignment
import com.iroselle.itemerness.core.presentation.FontSource
import com.iroselle.itemerness.core.presentation.FormatSource
import com.iroselle.itemerness.core.presentation.FrameRowSource
import com.iroselle.itemerness.core.presentation.GlyphMetricSource
import com.iroselle.itemerness.core.presentation.GlyphSource
import com.iroselle.itemerness.core.presentation.LayoutSource
import com.iroselle.itemerness.core.presentation.LocaleSource
import com.iroselle.itemerness.core.presentation.MissingDataPolicy
import com.iroselle.itemerness.core.presentation.MissingKeyValue
import com.iroselle.itemerness.core.presentation.NamespacedKeyFormatMode
import com.iroselle.itemerness.core.presentation.OverflowPolicy
import com.iroselle.itemerness.core.presentation.PresentationBlockSource
import com.iroselle.itemerness.core.presentation.PresentationBudgets
import com.iroselle.itemerness.core.presentation.PresentationSource
import com.iroselle.itemerness.core.presentation.ResourcePackBindingSource
import com.iroselle.itemerness.core.presentation.SegmentedFrameSource
import com.iroselle.itemerness.core.presentation.SpacingRangeSource
import com.iroselle.itemerness.core.presentation.SpacingSource
import com.iroselle.itemerness.core.presentation.TextStyleSource
import com.iroselle.itemerness.core.presentation.ThemeRenderer
import com.iroselle.itemerness.core.presentation.ThemeSource
import com.iroselle.itemerness.core.presentation.ValueReferenceSource
import com.iroselle.itemerness.core.presentation.VanillaTooltipLinePolicy
import com.iroselle.itemerness.core.presentation.ViewerFactSource
import com.iroselle.itemerness.core.presentation.ViewerFactType
import com.iroselle.itemerness.core.presentation.VisualBoundsSource
import com.iroselle.itemerness.core.presentation.WrappingSource
import com.iroselle.itemerness.core.presentation.ItemPresentationSource
import java.util.UUID

/**
 * Decodes an authoring document into the platform-neutral compiler inputs.
 *
 * This is the single most important boundary in the editor product. `PresentationSource` and
 * `CatalogSource` are exactly what the local YAML loader produces, so a managed document and a
 * local install go through the same `PresentationCompiler`, `CatalogCompiler`, and
 * `PresentationEngine`. There is no second interpreter and no YAML round trip in the middle.
 *
 * Everything fails closed. An unknown key, an unknown enum constant, or a reference the document
 * does not declare raises rather than being dropped, because a silently ignored field is how an
 * editor publishes content that looks approved and renders differently.
 */
object ProjectDocumentCodec {
    const val SUPPORTED_SCHEMA_VERSION: Int = 2
    val SUPPORTED_SCHEMA_VERSIONS: List<Int> = java.util.List.of(1, SUPPORTED_SCHEMA_VERSION)

    class Decoded(
        val schemaVersion: Int,
        val documentId: String,
        val namespace: String,
        val presentation: PresentationSource,
        val catalog: CatalogSource,
        val budgets: PresentationBudgets,
        val defaultLocale: String,
        val defaultLayout: String?,
        val defaultTheme: String?,
        /** Editor-only preview values, keyed by item id. Never part of the published catalog. */
        previewData: Map<String, List<DataAssignmentSource>>,
        /** Editor-only viewer fact values used when previewing. */
        previewFacts: Map<String, ItemDataValue>,
        dataKeyIntegrations: Map<ItemKey, DocumentDataKeyIntegration>,
        val measurementClientVersion: String? = null,
    ) {
        val previewData: Map<String, List<DataAssignmentSource>> =
            java.util.Collections.unmodifiableMap(LinkedHashMap(previewData))
        val previewFacts: Map<String, ItemDataValue> =
            java.util.Collections.unmodifiableMap(LinkedHashMap(previewFacts))
        val dataKeyIntegrations: Map<ItemKey, DocumentDataKeyIntegration> =
            java.util.Collections.unmodifiableMap(LinkedHashMap(dataKeyIntegrations))
    }

    fun decode(json: String, builtinFontMetrics: BuiltinFontMetrics = BuiltinFontMetrics.NONE): Decoded =
        decode(JsonObject.parse(json, "document"), builtinFontMetrics)

    fun decode(root: JsonObject, builtinFontMetrics: BuiltinFontMetrics): Decoded =
        decodeChecked("document") { decodeDocument(root, builtinFontMetrics) }

    private fun decodeDocument(root: JsonObject, builtinFontMetrics: BuiltinFontMetrics): Decoded {
        root.rejectUnknown(
            "schemaVersion", "documentId", "namespace", "defaultLocale", "defaultLayout", "defaultTheme", "budgets", "formats", "locales",
            "fonts", "glyphs", "bitmaps", "assetProfiles", "resourcePackBindings", "tooltipStyles", "spacing",
            "viewerFacts", "layouts", "themes", "dataSchemas", "items", "accessPolicies", "measurement", "extensions",
        )
        if (root.optionalArray("accessPolicies").orEmpty().isNotEmpty()) {
            throw JsonException("document.accessPolicies has no runtime policy mapping and must remain empty")
        }
        val schemaVersion = root.requiredInt("schemaVersion")
        if (schemaVersion !in SUPPORTED_SCHEMA_VERSIONS) {
            throw JsonException("Unsupported document schema version $schemaVersion")
        }
        val namespace = root.requiredString("namespace")
        ItemKey(namespace, "validation")
        val defaultLocale = root.requiredString("defaultLocale")
        fun defaultReference(field: String, library: String): String? {
            if (schemaVersion == 1 && root.raw(field) != null) {
                throw JsonException("document.$field requires document schema 2")
            }
            return root.optionalString(field)?.also { id ->
                ItemKey.parse(id)
                if (root.optionalObjects(library).none { it.requiredString("id") == id }) {
                    throw JsonException("document.$field must reference a declared $library entry")
                }
            }
        }
        val defaultLayout = defaultReference("defaultLayout", "layouts")
        val defaultTheme = defaultReference("defaultTheme", "themes")
        var measurementClientVersion: String? = null
        val boldExtraAdvancePixels = if (schemaVersion == 1) {
            if (root.raw("measurement") != null) {
                throw JsonException("document.measurement requires document schema 2")
            }
            1.0
        } else {
            val measurement = root.requiredObject("measurement").rejectUnknown("boldExtraAdvancePixels", "clientVersion", "missingGlyph")
            measurement.optionalString("clientVersion")?.let {
                if (it !in setOf("server", "1.21.11", "26.1.1", "26.1.2", "26.2")) {
                    throw JsonException("document.measurement.clientVersion must be server or a supported Minecraft client version")
                }
                measurementClientVersion = it
            }
            measurement.optionalString("missingGlyph")?.let {
                if (it != "error") throw JsonException("document.measurement.missingGlyph must be error")
            }
            measurement.requiredDouble("boldExtraAdvancePixels").also {
                if (!it.isFinite() || it !in 0.0..4096.0) {
                    throw JsonException("document.measurement.boldExtraAdvancePixels must be between 0 and 4096")
                }
            }
        }

        val glyphs = root.optionalObjects("glyphs").map(::glyph)
        val explicitMetrics = glyphs.groupBy(GlyphSource::font).mapValues { (font, values) ->
            val metrics = LinkedHashMap<Int, GlyphMetricSource>()
            values.forEach { glyph ->
                if (metrics.put(glyph.codePoint, GlyphMetricSource(glyph.advancePixels, glyph.visualBounds,
                        hasInk = glyph.visualBounds.right > glyph.visualBounds.left && glyph.visualBounds.bottom > glyph.visualBounds.top)) != null) {
                    throw JsonException("Font $font assigns U+${glyph.codePoint.toString(16)} more than once")
                }
            }
            metrics
        }

        val presentation = PresentationSource(
            formats = root.optionalObjects("formats").map(::format),
            locales = root.optionalObjects("locales").map(::locale),
            fonts = root.optionalObjects("fonts").map { font(it, explicitMetrics, builtinFontMetrics, boldExtraAdvancePixels) },
            glyphs = glyphs,
            bitmaps = root.optionalObjects("bitmaps").map(::bitmap),
            assetProfiles = root.optionalObjects("assetProfiles").map(::assetProfile),
            viewerFacts = root.optionalObjects("viewerFacts").map(::viewerFact),
            resourcePackBindings = root.optionalObjects("resourcePackBindings").map(::resourcePackBinding),
            layouts = root.optionalObjects("layouts").map(::layout),
            themes = root.optionalObjects("themes").map(::theme),
            items = root.optionalObjects("items").map { itemPresentation(it, namespace, schemaVersion, defaultLayout, defaultTheme) },
            spacing = root.optionalObject("spacing")?.let(::spacing),
            tooltipStyles = root.optionalObjects("tooltipStyles").map { it.requiredString("id") },
        )

        val integrations = LinkedHashMap<ItemKey, DocumentDataKeyIntegration>()
        val catalog = CatalogSource(
            schemas = root.optionalObjects("dataSchemas").map { dataSchema(it, schemaVersion, integrations) },
            items = root.optionalObjects("items").map { itemDefinition(it, namespace, schemaVersion) },
        )

        val previewData = LinkedHashMap<String, List<DataAssignmentSource>>()
        for (item in root.optionalObjects("items")) {
            val id = itemKey(item, namespace, schemaVersion)
            if (previewData.containsKey(id)) throw JsonException("Duplicate item key $id")
            previewData[id] = item.optionalObjects("previewData").map(::assignment)
        }
        val previewFacts = LinkedHashMap<String, ItemDataValue>()
        for (fact in root.optionalObjects("viewerFacts")) {
            val type = enum<ViewerFactType>(fact.requiredString("type"))
            val id = fact.requiredString("id")
            val value = fact.optionalObject("previewValue")?.let { viewerFactValue(type, it, "$id.previewValue") }
                ?: fact.optionalObject("defaultValue")?.let { viewerFactValue(type, it, "$id.defaultValue") }
            if (value != null) previewFacts[id] = value
        }

        return Decoded(
            schemaVersion = schemaVersion,
            documentId = root.requiredString("documentId"),
            namespace = namespace,
            presentation = presentation,
            catalog = catalog,
            budgets = budgets(root.optionalObject("budgets")),
            defaultLocale = defaultLocale,
            defaultLayout = defaultLayout,
            defaultTheme = defaultTheme,
            previewData = previewData,
            previewFacts = previewFacts,
            dataKeyIntegrations = integrations,
            measurementClientVersion = measurementClientVersion,
        )
    }

    // --- shared values ---------------------------------------------------------------------

    private inline fun <T> decodeChecked(path: String, decode: () -> T): T =
        try {
            decode()
        } catch (exception: IllegalArgumentException) {
            throw JsonException("Invalid value at $path: ${exception.message ?: "value is outside the supported range"}", exception)
        }

    private fun budgets(node: JsonObject?): PresentationBudgets {
        if (node == null) return PresentationBudgets()
        node.rejectUnknown(
            "maximumWidthPixels", "maximumHeightPixels", "maximumLines", "maximumRuns", "maximumTextCodePoints",
            "maximumBlocksPerItem", "maximumBlockDepth", "maximumRepeatElements", "maximumCanvasLayers",
            "maximumEmittedGlyphs",
        )
        val defaults = PresentationBudgets()
        return decodeChecked("document.budgets") {
            PresentationBudgets(
                maximumWidthPixels = node.optionalInt("maximumWidthPixels") ?: defaults.maximumWidthPixels,
                maximumHeightPixels = node.optionalInt("maximumHeightPixels") ?: defaults.maximumHeightPixels,
                maximumLines = node.optionalInt("maximumLines") ?: defaults.maximumLines,
                maximumRuns = node.optionalInt("maximumRuns") ?: defaults.maximumRuns,
                maximumTextCodePoints = node.optionalInt("maximumTextCodePoints") ?: defaults.maximumTextCodePoints,
                maximumBlocksPerItem = node.optionalInt("maximumBlocksPerItem") ?: defaults.maximumBlocksPerItem,
                maximumBlockDepth = node.optionalInt("maximumBlockDepth") ?: defaults.maximumBlockDepth,
                maximumRepeatElements = node.optionalInt("maximumRepeatElements") ?: defaults.maximumRepeatElements,
                maximumCanvasLayers = node.optionalInt("maximumCanvasLayers") ?: defaults.maximumCanvasLayers,
                maximumEmittedGlyphs = node.optionalInt("maximumEmittedGlyphs") ?: defaults.maximumEmittedGlyphs,
            )
        }
    }

    private fun bounds(node: JsonObject): VisualBoundsSource {
        node.rejectUnknown("left", "right", "top", "bottom")
        return VisualBoundsSource(
            left = node.requiredDouble("left"),
            right = node.requiredDouble("right"),
            top = node.requiredDouble("top"),
            bottom = node.requiredDouble("bottom"),
        )
    }

    /** The tagged data-value union shared by defaults, literals, and preview values. */
    private fun sourceDataValue(node: JsonObject): SourceDataValue =
        when (val kind = node.requiredString("kind")) {
            "null" -> {
                node.rejectUnknown("kind")
                SourceDataValue.NullValue
            }
            "boolean" -> SourceDataValue.BooleanValue(node.rejectUnknown("kind", "value").requiredBoolean("value"))
            "integer" -> SourceDataValue.IntegerValue(node.rejectUnknown("kind", "value").requiredLongString("value"))
            "decimal" -> SourceDataValue.DecimalValue(node.rejectUnknown("kind", "value").requiredDecimalString("value"))
            "string" -> SourceDataValue.StringValue(node.rejectUnknown("kind", "value").requiredString("value"))
            "list" -> SourceDataValue.ListValue(node.rejectUnknown("kind", "values").requiredObjects("values").map(::sourceDataValue))
            "compound" -> {
                node.rejectUnknown("kind", "entries")
                val entries = node.requiredObject("entries")
                SourceDataValue.CompoundValue(
                    entries.keys.associateWith { key -> sourceDataValue(entries.requiredObject(key)) },
                )
            }

            else -> throw JsonException("Unknown data value kind \"$kind\"")
        }

    private fun literalValue(source: SourceDataValue): ItemDataValue =
        when (source) {
            SourceDataValue.NullValue -> throw JsonException("A condition literal must not contain null values")
            is SourceDataValue.BooleanValue -> BooleanDataValue(source.value)
            is SourceDataValue.IntegerValue -> {
                if (source.value in Int.MIN_VALUE.toLong()..Int.MAX_VALUE.toLong()) {
                    IntegerDataValue(source.value.toInt())
                } else {
                    LongDataValue(source.value)
                }
            }
            is SourceDataValue.DecimalValue -> decodeChecked("condition.literal") { DecimalDataValue(source.value.toDouble()) }
            is SourceDataValue.StringValue -> StringDataValue(source.value)
            is SourceDataValue.ListValue -> ListDataValue(source.values.map(::literalValue))
            is SourceDataValue.CompoundValue -> CompoundDataValue(source.entries.mapValues { (_, value) -> literalValue(value) })
        }

    private fun viewerFactValue(type: ViewerFactType, node: JsonObject, path: String): ItemDataValue? {
        val source = sourceDataValue(node)
        if (source == SourceDataValue.NullValue) return null
        fun mismatch(): Nothing = throw JsonException("Expected $type data at viewer-facts.$path")
        fun text(): String = (source as? SourceDataValue.StringValue)?.value ?: mismatch()
        return decodeChecked("viewer-facts.$path") {
            when (type) {
                ViewerFactType.LOCALE, ViewerFactType.STRING -> StringDataValue(text())
                ViewerFactType.BOOLEAN -> BooleanDataValue((source as? SourceDataValue.BooleanValue)?.value ?: mismatch())
                ViewerFactType.INTEGER -> {
                    val value = (source as? SourceDataValue.IntegerValue)?.value ?: mismatch()
                    if (value !in Int.MIN_VALUE.toLong()..Int.MAX_VALUE.toLong()) mismatch()
                    IntegerDataValue(value.toInt())
                }
                ViewerFactType.LONG -> LongDataValue((source as? SourceDataValue.IntegerValue)?.value ?: mismatch())
                ViewerFactType.DECIMAL -> DecimalDataValue(
                    when (source) {
                        is SourceDataValue.IntegerValue -> source.value.toDouble()
                        is SourceDataValue.DecimalValue -> source.value.toDouble()
                        else -> mismatch()
                    },
                )
                ViewerFactType.UUID -> UuidDataValue(UUID.fromString(text()))
                ViewerFactType.NAMESPACED_KEY -> NamespacedKeyDataValue(ItemKey.parse(text()))
            }
        }
    }

    private fun assignment(node: JsonObject): DataAssignmentSource {
        node.rejectUnknown("key", "value")
        return DataAssignmentSource(node.requiredString("key"), sourceDataValue(node.requiredObject("value")))
    }

    private fun dataType(node: JsonObject): DataType =
        when (val kind = node.requiredString("kind")) {
            "boolean" -> DataType.BooleanType
            "integer" -> DataType.IntegerType
            "long" -> DataType.LongType
            "decimal" -> DataType.DecimalType
            "string" -> DataType.StringType
            "uuid" -> DataType.UuidType
            "namespacedKey" -> DataType.NamespacedKeyType
            "list" -> DataType.ListType(dataType(node.requiredObject("element")))
            "compound" ->
                DataType.CompoundType(
                    if (node.raw("fields") is JsonValue.Null || !node.contains("fields")) {
                        null
                    } else {
                        node.requiredObjects("fields").map { field ->
                            field.rejectUnknown("name", "type", "nullable")
                            CompoundFieldSource(
                                name = field.requiredString("name"),
                                type = dataType(field.requiredObject("type")),
                                nullable = field.optionalBoolean("nullable", false),
                            )
                        }
                    },
                )

            else -> throw JsonException("Unknown data type kind \"$kind\"")
        }

    private inline fun <reified T : Enum<T>> enum(value: String): T =
        enumValues<T>().firstOrNull { it.name == value }
            ?: throw JsonException("Unknown ${T::class.simpleName} constant \"$value\"")

    // --- presentation ----------------------------------------------------------------------

    private fun format(node: JsonObject): FormatSource {
        val id = node.requiredString("id")
        return when (val kind = node.requiredString("kind")) {
            "integer" -> {
                node.rejectUnknown("uuid", "extensions", "kind", "id", "pattern")
                FormatSource.IntegerFormat(id, node.optionalString("pattern") ?: "0")
            }

            "decimal" -> {
                node.rejectUnknown("uuid", "extensions", "kind", "id", "pattern", "multiply", "suffixMessage")
                FormatSource.DecimalFormat(
                    id = id,
                    pattern = node.requiredString("pattern"),
                    multiply = node.optionalDouble("multiply") ?: 1.0,
                    suffixMessage = node.optionalString("suffixMessage"),
                )
            }

            "boolean" -> {
                node.rejectUnknown("uuid", "extensions", "kind", "id", "trueMessage", "falseMessage")
                FormatSource.BooleanFormat(id, node.requiredString("trueMessage"), node.requiredString("falseMessage"))
            }

            "namespacedKey" -> {
                node.rejectUnknown("uuid", "extensions", "kind", "id", "mode", "messagePattern", "missingValue")
                FormatSource.NamespacedKeyFormat(
                    id = id,
                    mode = enum<NamespacedKeyFormatMode>(node.requiredString("mode")),
                    messagePattern = node.optionalString("messagePattern"),
                    missingValue = node.optionalString("missingValue")?.let { enum<MissingKeyValue>(it) }
                        ?: MissingKeyValue.PATH,
                )
            }

            "list" -> {
                node.rejectUnknown("uuid", "extensions", "kind", "id", "elementFormat", "separatorMessage")
                FormatSource.ListFormat(id, node.requiredString("elementFormat"), node.requiredString("separatorMessage"))
            }

            else -> throw JsonException("Unknown format kind \"$kind\"")
        }
    }

    private fun locale(node: JsonObject): LocaleSource {
        node.rejectUnknown("uuid", "extensions", "locale", "fallback", "messages")
        val messages = node.requiredObject("messages")
        return LocaleSource(
            locale = node.requiredString("locale"),
            fallback = node.optionalString("fallback"),
            messages = messages.keys.associateWith { messages.requiredString(it) },
        )
    }

    private fun font(
        node: JsonObject,
        explicitMetrics: Map<String, Map<Int, GlyphMetricSource>>,
        builtin: BuiltinFontMetrics,
        boldExtraAdvancePixels: Double,
    ): FontSource {
        node.rejectUnknown("uuid", "extensions", "id", "metrics", "fallback", "fallbackAdvancePixels", "advances")
        val id = node.requiredString("id")
        val metrics = node.requiredString("metrics")
        node.optionalObject("advances")?.let { range ->
            range.rejectUnknown("minimum", "maximum")
            if (range.requiredInt("minimum") >= range.requiredInt("maximum")) {
                throw JsonException("fonts.$id.advances.maximum must exceed minimum")
            }
        }
        val declared = explicitMetrics[id].orEmpty()

        if (metrics.startsWith("builtin:")) {
            val table = builtin.table(metrics.removePrefix("builtin:"))
                ?: throw JsonException("Unknown builtin font metrics $metrics")
            if (table.fontId != id) {
                throw JsonException("Builtin metrics $metrics belong to ${table.fontId}, not $id")
            }
            if (node.optionalString("fallback") != null || node.optionalDouble("fallbackAdvancePixels") != null) {
                throw JsonException("Builtin metrics $metrics define their own exact fallback policy")
            }
            if (declared.isNotEmpty()) {
                throw JsonException("Builtin font $id cannot override generated glyph metrics")
            }
            return FontSource(
                id = id,
                metricsRevision = table.metricsRevision,
                glyphs = table.glyphs,
                fallback = table.fallback,
                fallbackGlyph = table.fallbackGlyph,
                boldExtraAdvancePixels = boldExtraAdvancePixels,
            )
        }

        return FontSource(
            id = id,
            metricsRevision = normalizeMetricsRevision(id, metrics),
            glyphs = declared,
            fallback = node.optionalString("fallback"),
            fallbackAdvancePixels = node.optionalDouble("fallbackAdvancePixels"),
            boldExtraAdvancePixels = boldExtraAdvancePixels,
        )
    }

    /** Mirrors `PresentationSourceLoader.normalizeMetricsRevision` so both loaders agree. */
    private fun normalizeMetricsRevision(fontId: String, metrics: String): String {
        val font = ItemKey.parse(fontId)
        return when (metrics) {
            "explicit" -> "itemerness:explicit/${font.namespace}/${font.value}"
            "space-provider" -> "itemerness:space-provider/${font.namespace}/${font.value}"
            // A `manifest:` selector is itself a namespaced key, exactly as the YAML loader reads it;
            // stripping the prefix would produce a revision string neither loader recognises.
            else -> ItemKey.parse(metrics).toString()
        }
    }

    private fun glyph(node: JsonObject): GlyphSource {
        node.rejectUnknown("uuid", "extensions", "id", "font", "codePoint", "advancePixels", "visualBounds", "bitmap")
        return GlyphSource(
            id = node.requiredString("id"),
            font = node.requiredString("font"),
            codePoint = node.requiredInt("codePoint"),
            advancePixels = node.requiredDouble("advancePixels"),
            visualBounds = bounds(node.requiredObject("visualBounds")),
            bitmap = node.optionalString("bitmap"),
        )
    }

    private fun bitmap(node: JsonObject): BitmapSource {
        node.rejectUnknown(
            "uuid", "extensions", "id", "baselineVariant", "texture", "sourceWidthPixels", "sourceHeightPixels",
            "renderWidthPixels", "renderHeightPixels", "ascentPixels", "visualBounds",
        )
        return BitmapSource(
            id = node.requiredString("id"),
            baselineVariant = node.optionalString("baselineVariant"),
            renderWidthPixels = node.requiredInt("renderWidthPixels"),
            renderHeightPixels = node.requiredInt("renderHeightPixels"),
            ascentPixels = node.requiredInt("ascentPixels"),
            visualBounds = bounds(node.requiredObject("visualBounds")),
        )
    }

    private fun assetProfile(node: JsonObject): AssetProfileSource {
        node.rejectUnknown("uuid", "extensions", "id", "capabilities", "metricsRevision", "fallback")
        return AssetProfileSource(
            id = node.requiredString("id"),
            capabilities = node.optionalStrings("capabilities"),
            metricsRevision = node.optionalString("metricsRevision"),
            fallback = node.optionalString("fallback"),
        )
    }

    private fun resourcePackBinding(node: JsonObject): ResourcePackBindingSource {
        node.rejectUnknown("uuid", "extensions", "id", "enabled", "packId", "sha1", "assetProfile")
        return ResourcePackBindingSource(
            id = node.requiredString("id"),
            enabled = node.requiredBoolean("enabled"),
            packId = node.optionalString("packId")?.let(UUID::fromString),
            sha1 = node.optionalString("sha1"),
            assetProfile = node.requiredString("assetProfile"),
        )
    }

    private fun spacing(node: JsonObject): SpacingSource {
        node.rejectUnknown("font", "negative", "positive")
        return SpacingSource(
            font = node.requiredString("font"),
            negative = spacingRange(node.requiredObject("negative")),
            positive = spacingRange(node.requiredObject("positive")),
        )
    }

    private fun spacingRange(node: JsonObject): SpacingRangeSource {
        node.rejectUnknown("firstCodePoint", "lastCodePoint", "minimumAdvancePixels", "maximumAdvancePixels")
        return SpacingRangeSource(
            firstCodePoint = node.requiredInt("firstCodePoint"),
            lastCodePoint = node.requiredInt("lastCodePoint"),
            minimumAdvancePixels = node.requiredInt("minimumAdvancePixels"),
            maximumAdvancePixels = node.requiredInt("maximumAdvancePixels"),
        )
    }

    private fun viewerFact(node: JsonObject): ViewerFactSource {
        node.rejectUnknown(
            "uuid", "extensions", "id", "type", "providers", "defaultValue", "nullable", "cacheKey", "previewValue",
        )
        val id = node.requiredString("id")
        val type = enum<ViewerFactType>(node.requiredString("type"))
        return ViewerFactSource(
            id = id,
            type = type,
            providers = node.optionalStrings("providers"),
            defaultValue = node.optionalObject("defaultValue")?.let { viewerFactValue(type, it, "$id.defaultValue") },
            nullable = node.optionalBoolean("nullable", false),
            cacheKey = node.optionalBoolean("cacheKey", true),
        )
    }

    private fun wrapping(node: JsonObject): WrappingSource {
        node.rejectUnknown(
            "widthPixels", "maximumLines", "overflow", "preserveExplicitLines", "continuationIndentPixels",
            "lineHeightPixels",
        )
        return WrappingSource(
            widthPixels = node.optionalInt("widthPixels"),
            maximumLines = node.optionalInt("maximumLines") ?: 16,
            overflow = node.optionalString("overflow")?.let { enum<OverflowPolicy>(it) } ?: OverflowPolicy.ELLIPSIS,
            preserveExplicitLines = node.optionalBoolean("preserveExplicitLines", true),
            continuationIndentPixels = node.optionalInt("continuationIndentPixels") ?: 0,
            lineHeightPixels = node.optionalInt("lineHeightPixels") ?: 10,
        )
    }

    private fun wrappingMap(node: JsonObject): Map<String, WrappingSource> =
        node.keys.associateWith { wrapping(node.requiredObject(it)) }

    private fun layout(node: JsonObject): LayoutSource {
        val id = node.requiredString("id")
        return when (val kind = node.requiredString("kind")) {
            "flow" -> {
                node.rejectUnknown(
                    "uuid", "extensions", "kind", "id", "minimumWidthPixels", "maximumWidthPixels",
                    "blockGapAfterPixels", "fieldLeftPaddingPixels", "fieldIconGapPixels", "fieldValueAlignment",
                    "descriptionLeftPaddingPixels", "descriptionRightPaddingPixels", "descriptionGapBeforePixels",
                    "wrapping",
                )
                LayoutSource.Flow(
                    id = id,
                    minimumWidthPixels = node.requiredInt("minimumWidthPixels"),
                    maximumWidthPixels = node.requiredInt("maximumWidthPixels"),
                    blockGapAfterPixels = node.optionalInt("blockGapAfterPixels") ?: 0,
                    fieldLeftPaddingPixels = node.optionalInt("fieldLeftPaddingPixels") ?: 0,
                    fieldIconGapPixels = node.optionalInt("fieldIconGapPixels") ?: 0,
                    fieldValueAlignment = node.optionalString("fieldValueAlignment")
                        ?.let { enum<FieldValueAlignment>(it) } ?: FieldValueAlignment.LEFT,
                    descriptionLeftPaddingPixels = node.optionalInt("descriptionLeftPaddingPixels") ?: 0,
                    descriptionRightPaddingPixels = node.optionalInt("descriptionRightPaddingPixels") ?: 0,
                    descriptionGapBeforePixels = node.optionalInt("descriptionGapBeforePixels") ?: 0,
                    wrapping = wrappingMap(node.requiredObject("wrapping")),
                )
            }

            "canvas" -> {
                node.rejectUnknown(
                    "uuid", "extensions", "kind", "id", "widthPixels", "heightPixels", "maximumWidthPixels",
                    "maximumHeightPixels", "reserveTooltipLines", "anchors", "wrapping",
                )
                val anchors = node.requiredObject("anchors")
                LayoutSource.Canvas(
                    id = id,
                    widthPixels = node.requiredInt("widthPixels"),
                    heightPixels = node.requiredInt("heightPixels"),
                    maximumWidthPixels = node.requiredInt("maximumWidthPixels"),
                    maximumHeightPixels = node.requiredInt("maximumHeightPixels"),
                    reserveTooltipLines = node.requiredInt("reserveTooltipLines"),
                    anchors = anchors.keys.associateWith { name ->
                        val anchor = anchors.requiredObject(name)
                        anchor.rejectUnknown("x", "y", "width", "height", "overflow")
                        CanvasAnchorSource(
                            x = anchor.requiredInt("x"),
                            y = anchor.requiredInt("y"),
                            width = anchor.requiredInt("width"),
                            height = anchor.requiredInt("height"),
                            overflow = enum<OverflowPolicy>(anchor.requiredString("overflow")),
                        )
                    },
                    wrapping = wrappingMap(node.requiredObject("wrapping")),
                )
            }

            else -> throw JsonException("Unknown layout kind \"$kind\"")
        }
    }

    private fun frameRow(node: JsonObject): FrameRowSource {
        node.rejectUnknown("left", "fill", "right", "center", "kern")
        return FrameRowSource(node.requiredString("left"), node.requiredString("fill"), node.requiredString("right"), node.optionalString("center"), node.optionalString("kern"))
    }

    private fun theme(node: JsonObject): ThemeSource {
        node.rejectUnknown(
            "uuid", "extensions", "id", "renderer", "requiresResourcePack", "requiredCapabilities",
            "vanillaTooltipLines", "fallback", "fonts", "styles", "tooltipStyle", "requireExactFontMetrics",
            "content", "characterFrame", "segmentedFrame", "canvas",
        )
        val fonts = node.requiredObject("fonts")
        val styles = node.optionalObject("styles")
        val renderer = enum<ThemeRenderer>(node.requiredString("renderer"))
        return ThemeSource(
            id = node.requiredString("id"),
            renderer = renderer,
            requiresResourcePack = node.requiredBoolean("requiresResourcePack"),
            requiredCapabilities = node.optionalStrings("requiredCapabilities"),
            vanillaTooltipLines = enum<VanillaTooltipLinePolicy>(node.requiredString("vanillaTooltipLines")),
            fallback = node.optionalString("fallback"),
            fonts = fonts.keys.associateWith { fonts.requiredString(it) },
            styles = styles?.keys.orEmpty().associateWith { role ->
                val style = styles!!.requiredObject(role)
                style.rejectUnknown("color", "bold", "italic", "underlined", "strikethrough")
                TextStyleSource(
                    color = style.optionalString("color"),
                    bold = style.optionalBoolean("bold", false),
                    italic = style.optionalBoolean("italic", false),
                    underlined = style.optionalBoolean("underlined", false),
                    strikethrough = style.optionalBoolean("strikethrough", false),
                )
            },
            tooltipStyle = node.optionalString("tooltipStyle"),
            content = node.optionalObject("content")?.let {
                it.rejectUnknown("minimumWidthPixels", "maximumWidthPixels", "leftPaddingPixels", "rightPaddingPixels")
                ContentAreaSource(
                    minimumWidthPixels = it.requiredInt("minimumWidthPixels"),
                    maximumWidthPixels = it.requiredInt("maximumWidthPixels"),
                    leftPaddingPixels = it.optionalInt("leftPaddingPixels") ?: 0,
                    rightPaddingPixels = it.optionalInt("rightPaddingPixels") ?: 0,
                )
            },
            characterFrame = node.optionalObject("characterFrame")?.let {
                it.rejectUnknown(
                    "preset", "minimumWidthPixels", "maximumWidthPixels", "leftPaddingPixels", "rightPaddingPixels",
                    "alignmentTolerancePixels", "maximumLines", "fallbackBidirectionalText",
                )
                CharacterFrameSource(
                    preset = enum<CharacterFramePreset>(it.requiredString("preset")),
                    minimumWidthPixels = it.requiredInt("minimumWidthPixels"),
                    maximumWidthPixels = it.requiredInt("maximumWidthPixels"),
                    leftPaddingPixels = it.requiredInt("leftPaddingPixels"),
                    rightPaddingPixels = it.requiredInt("rightPaddingPixels"),
                    alignmentTolerancePixels = it.requiredInt("alignmentTolerancePixels"),
                    maximumLines = it.requiredInt("maximumLines"),
                    fallbackBidirectionalText = it.optionalBoolean("fallbackBidirectionalText", true),
                )
            }?.takeIf { renderer == ThemeRenderer.VANILLA_CHARACTER_FRAME },
            segmentedFrame = node.optionalObject("segmentedFrame")?.let {
                it.rejectUnknown(
                    "minimumWidthPixels", "maximumWidthPixels", "leftPaddingPixels", "rightPaddingPixels",
                    "top", "body", "connector", "bottom", "includeName",
                )
                SegmentedFrameSource(
                    minimumWidthPixels = it.requiredInt("minimumWidthPixels"),
                    maximumWidthPixels = it.requiredInt("maximumWidthPixels"),
                    leftPaddingPixels = it.requiredInt("leftPaddingPixels"),
                    rightPaddingPixels = it.requiredInt("rightPaddingPixels"),
                    top = frameRow(it.requiredObject("top")),
                    body = frameRow(it.requiredObject("body")),
                    connector = it.optionalObject("connector")?.let(::frameRow),
                    bottom = frameRow(it.requiredObject("bottom")),
                    includeName = it.optionalBoolean("includeName", false),
                )
            }?.takeIf { renderer == ThemeRenderer.SEGMENTED_FRAME },
            canvas = node.optionalObject("canvas")?.let(::canvasTheme)?.takeIf { renderer == ThemeRenderer.BITMAP_CANVAS },
            requireExactFontMetrics = node.optionalBoolean("requireExactFontMetrics", false),
        )
    }

    private fun canvasTheme(node: JsonObject): CanvasThemeSource {
        node.rejectUnknown(
            "widthPixels", "heightPixels", "maximumWidthPixels", "maximumHeightPixels", "reserveTooltipLines",
            "layers", "measuredAdvancePixels", "finalTooltipWidthPixels", "rejectNegativeFinalAdvance",
            "rejectOutOfBoundsLayer", "maximumEmittedComponents", "normalizeVisualOrigin",
        )
        return CanvasThemeSource(
            widthPixels = node.requiredInt("widthPixels"),
            heightPixels = node.requiredInt("heightPixels"),
            maximumWidthPixels = node.requiredInt("maximumWidthPixels"),
            maximumHeightPixels = node.requiredInt("maximumHeightPixels"),
            reserveTooltipLines = node.requiredInt("reserveTooltipLines"),
            layers = node.requiredObjects("layers").map { layer ->
                layer.rejectUnknown("asset", "anchor", "xPixels", "baselineLine", "baselineVariant", "drawOrder")
                CanvasLayerSource(
                    asset = layer.requiredString("asset"),
                    anchor = layer.optionalString("anchor")?.let { enum<CanvasLayerAnchor>(it) }
                        ?: CanvasLayerAnchor.TOP_LEFT,
                    xPixels = layer.requiredInt("xPixels"),
                    baselineLine = layer.requiredInt("baselineLine"),
                    baselineVariant = layer.requiredString("baselineVariant"),
                    drawOrder = layer.requiredInt("drawOrder"),
                )
            },
            measuredAdvancePixels = node.requiredInt("measuredAdvancePixels"),
            finalTooltipWidthPixels = node.requiredInt("finalTooltipWidthPixels"),
            rejectNegativeFinalAdvance = node.optionalBoolean("rejectNegativeFinalAdvance", true),
            rejectOutOfBoundsLayer = node.optionalBoolean("rejectOutOfBoundsLayer", true),
            maximumEmittedComponents = node.optionalInt("maximumEmittedComponents") ?: 256,
            normalizeVisualOrigin = node.optionalBoolean("normalizeVisualOrigin", true),
        )
    }

    private fun valueReference(node: JsonObject): ValueReferenceSource =
        when (val kind = node.requiredString("kind")) {
            "data" -> ValueReferenceSource.Data(node.requiredString("key"))
            "fact" -> ValueReferenceSource.Fact(node.requiredString("key"))
            "literal" ->
                ValueReferenceSource.Literal(
                    literalValue(sourceDataValue(node.requiredObject("value"))),
                )

            else -> throw JsonException("Unknown value reference kind \"$kind\"")
        }

    private fun block(node: JsonObject): PresentationBlockSource {
        val style = node.optionalString("style")
        val anchor = node.optionalString("anchor")
        return when (val type = node.requiredString("type")) {
            "text" -> {
                node.rejectUnknown("uuid", "type", "data", "style", "anchor", "wrapping", "unbreakable", "missingPolicy")
                PresentationBlockSource.Text(
                    data = node.requiredString("data"),
                    style = style,
                    anchor = anchor,
                    wrapping = node.optionalString("wrapping"),
                    unbreakable = node.optionalBoolean("unbreakable", false),
                    missingPolicy = node.optionalString("missingPolicy")?.let { enum<MissingDataPolicy>(it) }
                        ?: MissingDataPolicy.ERROR,
                )
            }

            "field" -> {
                node.rejectUnknown(
                    "uuid", "type", "labelMessage", "data", "format", "icon", "style", "anchor", "wrapping",
                    "missingPolicy",
                )
                PresentationBlockSource.Field(
                    labelMessage = node.requiredString("labelMessage"),
                    data = node.requiredString("data"),
                    format = node.optionalString("format"),
                    icon = node.optionalString("icon"),
                    style = style,
                    anchor = anchor,
                    wrapping = node.optionalString("wrapping"),
                    missingPolicy = node.optionalString("missingPolicy")?.let { enum<MissingDataPolicy>(it) }
                        ?: MissingDataPolicy.ERROR,
                )
            }

            "description" -> {
                node.rejectUnknown("uuid", "type", "message", "style", "anchor", "wrapping")
                PresentationBlockSource.Description(
                    message = node.requiredString("message"),
                    style = style,
                    anchor = anchor,
                    wrapping = node.optionalString("wrapping"),
                )
            }

            "conditional" -> {
                node.rejectUnknown("uuid", "type", "condition", "thenBlocks", "otherwiseBlocks", "style", "anchor")
                val condition = node.requiredObject("condition")
                condition.rejectUnknown("operator", "left", "right")
                PresentationBlockSource.Conditional(
                    condition = ConditionSource(
                        operator = enum<ConditionOperator>(condition.requiredString("operator")),
                        left = valueReference(condition.requiredObject("left")),
                        right = condition.optionalObject("right")?.let(::valueReference),
                    ),
                    thenBlocks = node.requiredObjects("thenBlocks").map(::block),
                    otherwiseBlocks = node.optionalObjects("otherwiseBlocks").map(::block),
                    style = style,
                    anchor = anchor,
                )
            }

            "repeat" -> {
                node.rejectUnknown("uuid", "type", "data", "maximumElements", "template", "style", "anchor", "missingPolicy")
                val template = node.requiredObject("template")
                template.rejectUnknown("labelMessage", "valuePath", "missingMessage", "icon", "format")
                PresentationBlockSource.Repeat(
                    data = node.requiredString("data"),
                    maximumElements = node.requiredInt("maximumElements"),
                    template = CompoundFieldTemplateSource(
                        labelMessage = template.requiredString("labelMessage"),
                        valuePath = template.requiredString("valuePath"),
                        missingMessage = template.requiredString("missingMessage"),
                        icon = template.optionalString("icon"),
                        format = template.optionalString("format"),
                    ),
                    style = style,
                    anchor = anchor,
                    missingPolicy = node.optionalString("missingPolicy")?.let { enum<MissingDataPolicy>(it) }
                        ?: MissingDataPolicy.ERROR,
                )
            }

            "nestedItemList" -> {
                node.rejectUnknown("uuid", "type", "style", "anchor")
                PresentationBlockSource.NestedItemList(style = style, anchor = anchor)
            }

            else -> throw JsonException("Unknown presentation block type \"$type\"")
        }
    }

    private fun itemKey(node: JsonObject, namespace: String, schemaVersion: Int): String {
        val id = node.requiredString("id")
        if (schemaVersion == 1 && (id.length > 200 || !id.matches(Regex("[a-z0-9_./-]+")))) {
            throw JsonException("Document schema 1 requires an item path of at most 200 characters")
        }
        return ItemKey.parse(if (':' in id) id else "$namespace:$id").toString()
    }

    private fun itemPresentation(
        node: JsonObject, namespace: String, schemaVersion: Int, defaultLayout: String?, defaultTheme: String?,
    ): ItemPresentationSource {
        val presentation = node.requiredObject("presentation")
        presentation.rejectUnknown("layout", "theme", "nameMessage", "blocks")
        return ItemPresentationSource(
            id = itemKey(node, namespace, schemaVersion),
            layout = if (schemaVersion == 1) presentation.requiredString("layout") else
                presentation.optionalString("layout") ?: defaultLayout
                    ?: throw JsonException("Inherited item layout requires document.defaultLayout"),
            theme = if (schemaVersion == 1) presentation.requiredString("theme") else
                presentation.optionalString("theme") ?: defaultTheme
                    ?: throw JsonException("Inherited item theme requires document.defaultTheme"),
            nameMessage = presentation.requiredString("nameMessage"),
            blocks = presentation.requiredObjects("blocks").map(::block),
            enabled = node.requiredBoolean("enabled"),
        )
    }

    // --- catalog ---------------------------------------------------------------------------

    private fun dataSchema(
        node: JsonObject,
        schemaVersion: Int,
        integrations: MutableMap<ItemKey, DocumentDataKeyIntegration>,
    ): DataSchemaSource {
        node.rejectUnknown("uuid", "extensions", "id", "version", "keys")
        return DataSchemaSource(
            id = node.requiredString("id"),
            version = node.requiredInt("version"),
            keys = node.requiredObjects("keys").map { key ->
                dataKey(key).also { source ->
                    if (schemaVersion == 1) {
                        if (key.raw("integration") != null) {
                            throw JsonException("Data key ${source.id}.integration requires document schema 2")
                        }
                    } else {
                        val integration = DocumentDataKeyIntegration.decode(key.requiredObject("integration"), source)
                        if (integrations.put(ItemKey.parse(source.id), integration) != null) {
                            throw JsonException("Data key ${source.id} has more than one integration policy, which YAML does not support")
                        }
                    }
                }
            },
        )
    }

    private fun dataKey(node: JsonObject): DataKeySource {
        node.rejectUnknown(
            "uuid", "extensions", "id", "type", "scope", "nullable", "defaultValue", "affectsStacking",
            "presentationReadable", "constraints", "integration",
        )
        val constraints = node.optionalObject("constraints")
        constraints?.rejectUnknown(
            "minimum", "maximum", "scale", "maximumCodePoints", "maximumElements", "maximumEntries",
            "maximumDepth", "allowedValues",
        )
        return DataKeySource(
            id = node.requiredString("id"),
            type = dataType(node.requiredObject("type")),
            scope = enum<DataScope>(node.requiredString("scope")),
            nullable = node.optionalBoolean("nullable", false),
            defaultValue = node.optionalObject("defaultValue")?.let(::sourceDataValue),
            affectsStacking = node.optionalBoolean("affectsStacking", true),
            presentationReadable = node.optionalBoolean("presentationReadable", false),
            constraints = if (constraints == null) {
                DataConstraintsSource()
            } else {
                DataConstraintsSource(
                    minimum = constraints.optionalDecimalString("minimum"),
                    maximum = constraints.optionalDecimalString("maximum"),
                    scale = constraints.optionalInt("scale"),
                    maximumCodePoints = constraints.optionalInt("maximumCodePoints"),
                    maximumElements = constraints.optionalInt("maximumElements"),
                    maximumEntries = constraints.optionalInt("maximumEntries"),
                    maximumDepth = constraints.optionalInt("maximumDepth"),
                    allowedValues = constraints.optionalObjects("allowedValues").map(::sourceDataValue),
                )
            },
        )
    }

    private fun itemDefinition(node: JsonObject, namespace: String, schemaVersion: Int): ItemDefinitionSource {
        node.rejectUnknown("uuid", "extensions", "id", "enabled", "definition", "presentation", "previewData")
        val definition = node.requiredObject("definition")
        definition.rejectUnknown(
            "material", "baseComponents", "contentComponent", "contents", "definitionData", "instance",
        )
        val instance = definition.requiredObject("instance")
        instance.rejectUnknown("mode", "idGenerator", "schemas", "defaults", "generators")

        return ItemDefinitionSource(
            id = itemKey(node, namespace, schemaVersion),
            enabled = node.requiredBoolean("enabled"),
            material = definition.requiredString("material"),
            instance = ItemInstanceSource(
                mode = enum<ItemInstanceMode>(instance.requiredString("mode")),
                idGenerator = instance.optionalString("idGenerator")?.let { enum<InstanceIdGenerator>(it) },
                schemas = instance.requiredObjects("schemas").map {
                    it.rejectUnknown("id", "version")
                    SchemaReferenceSource(it.requiredString("id"), it.requiredInt("version"))
                },
                defaults = instance.optionalObjects("defaults").map(::assignment),
                generators = instance.optionalObjects("generators").map(::generator),
            ),
            baseComponents = definition.optionalObjects("baseComponents").map {
                it.rejectUnknown("id", "value")
                BaseItemComponentSource(it.requiredString("id"), sourceDataValue(it.requiredObject("value")))
            },
            contentComponent = definition.optionalString("contentComponent")?.let { enum<NestedContentComponent>(it) },
            contents = definition.optionalObjects("contents").map {
                it.rejectUnknown("item", "amount")
                ItemContentSource(it.requiredString("item"), it.requiredInt("amount"))
            },
            definitionData = definition.optionalObjects("definitionData").map(::assignment),
        )
    }

    private fun generator(node: JsonObject): DataGeneratorSource =
        when (val kind = node.requiredString("kind")) {
            "unixMillis" -> {
                node.rejectUnknown("kind", "key")
                DataGeneratorSource.UnixMillis(node.requiredString("key"))
            }

            "randomDecimal" -> {
                node.rejectUnknown("kind", "key", "minimum", "maximum", "scale")
                DataGeneratorSource.RandomDecimal(
                    key = node.requiredString("key"),
                    minimum = node.requiredDecimalString("minimum"),
                    maximum = node.requiredDecimalString("maximum"),
                    scale = node.requiredInt("scale"),
                )
            }

            else -> throw JsonException("Unknown data generator kind \"$kind\"")
        }
}
