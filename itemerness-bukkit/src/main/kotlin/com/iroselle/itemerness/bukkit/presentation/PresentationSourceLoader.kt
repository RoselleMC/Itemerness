package com.iroselle.itemerness.bukkit.presentation

import com.iroselle.itemerness.api.BooleanDataValue
import com.iroselle.itemerness.api.CompoundDataValue
import com.iroselle.itemerness.api.DecimalDataValue
import com.iroselle.itemerness.api.IntegerDataValue
import com.iroselle.itemerness.api.ItemDataValue
import com.iroselle.itemerness.api.ItemKey
import com.iroselle.itemerness.api.ListDataValue
import com.iroselle.itemerness.api.LongDataValue
import com.iroselle.itemerness.api.NamespacedKeyDataValue
import com.iroselle.itemerness.api.StringDataValue
import com.iroselle.itemerness.api.UuidDataValue
import com.iroselle.itemerness.bukkit.catalog.LoadedCatalogSource
import com.iroselle.itemerness.bukkit.config.StrictYaml
import com.iroselle.itemerness.bukkit.config.StrictYamlException
import com.iroselle.itemerness.bukkit.config.YamlObject
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
import com.iroselle.itemerness.core.presentation.FieldPartStyles
import com.iroselle.itemerness.core.presentation.FieldSeparatorSource
import com.iroselle.itemerness.core.presentation.FieldValueAlignment
import com.iroselle.itemerness.core.presentation.FontSource
import com.iroselle.itemerness.core.presentation.FormatSource
import com.iroselle.itemerness.core.presentation.FragmentSource
import com.iroselle.itemerness.core.presentation.FrameRowSource
import com.iroselle.itemerness.core.presentation.GlyphMetricSource
import com.iroselle.itemerness.core.presentation.GlyphSource
import com.iroselle.itemerness.core.presentation.GroupDividers
import com.iroselle.itemerness.core.presentation.GroupEmptyPolicy
import com.iroselle.itemerness.core.presentation.GroupHeaderMissingPolicy
import com.iroselle.itemerness.core.presentation.GroupMarker
import com.iroselle.itemerness.core.presentation.HidingWeight
import com.iroselle.itemerness.core.presentation.ItemPresentationSource
import com.iroselle.itemerness.core.presentation.LayoutSource
import com.iroselle.itemerness.core.presentation.LocaleSource
import com.iroselle.itemerness.core.presentation.MarkerPieceSource
import com.iroselle.itemerness.core.presentation.MarkerThemeSource
import com.iroselle.itemerness.core.presentation.MissingDataPolicy
import com.iroselle.itemerness.core.presentation.MissingKeyValue
import com.iroselle.itemerness.core.presentation.NamespacedKeyFormatMode
import com.iroselle.itemerness.core.presentation.OverflowPolicy
import com.iroselle.itemerness.core.presentation.OverflowStrategy
import com.iroselle.itemerness.core.presentation.PresentationBlockSource
import com.iroselle.itemerness.core.presentation.PresentationBudgets
import com.iroselle.itemerness.core.presentation.PresentationCompilation
import com.iroselle.itemerness.core.presentation.PresentationCompiler
import com.iroselle.itemerness.core.presentation.PresentationSource
import com.iroselle.itemerness.core.presentation.RuleThemeSource
import com.iroselle.itemerness.core.presentation.SegmentedFrameSource
import com.iroselle.itemerness.core.presentation.SpacingRangeSource
import com.iroselle.itemerness.core.presentation.SpacingSource
import com.iroselle.itemerness.core.presentation.SummarySource
import com.iroselle.itemerness.core.presentation.TextStyleSource
import com.iroselle.itemerness.core.presentation.ThemeRenderer
import com.iroselle.itemerness.core.presentation.ThemeSelectorCaseSource
import com.iroselle.itemerness.core.presentation.ThemeSelectorSource
import com.iroselle.itemerness.core.presentation.ThemeSource
import com.iroselle.itemerness.core.presentation.TreeMarkerSource
import com.iroselle.itemerness.core.presentation.ValueReferenceSource
import com.iroselle.itemerness.core.presentation.VanillaTooltipLinePolicy
import com.iroselle.itemerness.core.presentation.VisualBoundsSource
import com.iroselle.itemerness.core.presentation.ViewerFactSource
import com.iroselle.itemerness.core.presentation.ViewerFactType
import com.iroselle.itemerness.core.presentation.WrappingSource
import com.iroselle.itemerness.core.presentation.ResourcePackBindingSource
import com.iroselle.itemerness.core.presentation.ResourcePackDelivery
import java.math.BigDecimal
import java.math.BigInteger
import java.nio.file.Files
import java.nio.file.Path
import java.util.Collections
import java.util.LinkedHashMap
import java.util.LinkedHashSet
import java.util.TreeMap
import java.util.UUID
import java.util.stream.Collectors

internal class LoadedPresentationSource(
    val source: PresentationSource,
    val compilation: PresentationCompilation,
    locales: Collection<String>,
) {
    val locales: Set<String> = Collections.unmodifiableSet(java.util.TreeSet(locales))
}

/** Strictly maps user presentation YAML into the platform-neutral compiler input. */
internal class PresentationSourceLoader(
    private val builtinFontMetrics: BuiltinFontMetricsArtifact,
) {
    fun loadAndCompile(
        root: Path,
        catalog: LoadedCatalogSource,
        defaultLocale: String,
        defaultLayout: ItemKey? = null,
        defaultTheme: ItemKey? = null,
        revision: Long = 0,
        budgets: PresentationBudgets = PresentationBudgets(),
    ): LoadedPresentationSource {
        val formats = yamlFiles(root, "formats").flatMap(::parseFormats)
        val locales = yamlFiles(root, "locales").map(::parseLocale)
        val layouts = yamlFiles(root, "layouts").flatMap(::parseLayouts)
        val themeFiles = yamlFiles(root, "themes").map(::parseThemeFile)
        val themes = themeFiles.flatMap(ParsedThemeFile::themes)
        val themeSelectors = themeFiles.flatMap(ParsedThemeFile::selectors)
        val assets = parseAssets(yamlFiles(root, "assets"))
        val viewerFacts = parseViewerFacts(yamlFiles(root, "viewer-facts"))
        val items = parseItems(catalog.itemDocuments, defaultLayout, defaultTheme)
        val source = PresentationSource(
            formats = formats,
            locales = locales,
            fonts = assets.fonts,
            glyphs = assets.glyphs,
            bitmaps = assets.bitmaps,
            assetProfiles = assets.assetProfiles,
            viewerFacts = viewerFacts,
            resourcePackBindings = assets.resourcePackBindings,
            layouts = layouts,
            themes = themes,
            items = items,
            spacing = assets.spacing,
            tooltipStyles = assets.tooltipStyles,
            themeSelectors = themeSelectors,
        )
        return LoadedPresentationSource(
            source = source,
            compilation = PresentationCompiler(defaultLocale, budgets).compile(source, revision),
            locales = locales.map(LocaleSource::locale),
        )
    }

    private fun parseFormats(path: Path): List<FormatSource> {
        val root = document(path).rejectUnknown("schema-version", "formats")
        requireVersion(root, path)
        val formats = root.requiredObject("formats")
        return formats.keys.map { id ->
            val node = formats.child(id, formats.raw(id))
            when (node.requiredString("type")) {
                "integer" -> {
                    node.rejectUnknown("type", "pattern")
                    FormatSource.IntegerFormat(id, node.optionalString("pattern") ?: "0")
                }
                "decimal" -> {
                    node.rejectUnknown("type", "pattern", "multiply", "suffix-message")
                    FormatSource.DecimalFormat(
                        id = id,
                        pattern = node.requiredString("pattern"),
                        multiply = node.optionalDouble("multiply") ?: 1.0,
                        suffixMessage = node.optionalString("suffix-message"),
                    )
                }
                "boolean" -> {
                    node.rejectUnknown("type", "true-message", "false-message")
                    FormatSource.BooleanFormat(
                        id,
                        node.requiredString("true-message"),
                        node.requiredString("false-message"),
                    )
                }
                "namespaced-key" -> {
                    node.rejectUnknown("type", "mode", "message-pattern", "missing-value")
                    FormatSource.NamespacedKeyFormat(
                        id = id,
                        mode = when (node.requiredString("mode")) {
                            "path" -> NamespacedKeyFormatMode.PATH
                            "message" -> NamespacedKeyFormatMode.MESSAGE
                            else -> invalid("Unsupported namespaced-key formatter mode", path, id)
                        },
                        messagePattern = node.optionalString("message-pattern"),
                        missingValue = when (node.optionalString("missing-value") ?: "path") {
                            "path" -> MissingKeyValue.PATH
                            "full-key" -> MissingKeyValue.FULL_KEY
                            "error" -> MissingKeyValue.ERROR
                            else -> invalid("Unsupported missing-value policy", path, id)
                        },
                    )
                }
                "list<namespaced-key>" -> {
                    node.rejectUnknown("type", "element-format", "separator-message")
                    FormatSource.ListFormat(
                        id,
                        node.requiredString("element-format"),
                        node.requiredString("separator-message"),
                    )
                }
                else -> invalid("Unsupported formatter type", path, id)
            }
        }
    }

    private fun parseLocale(path: Path): LocaleSource {
        val root = document(path).rejectUnknown("schema-version", "locale", "fallback", "messages")
        requireVersion(root, path)
        val messages = root.requiredObject("messages")
        return LocaleSource(
            locale = root.requiredString("locale"),
            fallback = root.optionalString("fallback"),
            messages = messages.keys.associateWith { key ->
                messages.raw(key) as? String
                    ?: throw StrictYamlException("Message $key in $path must be a string")
            },
        )
    }

    private fun parseLayouts(path: Path): List<LayoutSource> {
        val root = document(path).rejectUnknown("schema-version", "layouts")
        requireVersion(root, path)
        val layouts = root.requiredObject("layouts")
        return layouts.keys.map { id ->
            val node = layouts.child(id, layouts.raw(id))
            when (node.optionalString("renderer")) {
                null -> parseFlowLayout(id, node, path)
                "bitmap-canvas" -> parseCanvasLayout(id, node, path)
                else -> invalid("Unsupported layout renderer", path, id)
            }
        }
    }

    private fun parseFlowLayout(
        id: String,
        node: YamlObject,
        path: Path,
    ): LayoutSource.Flow {
        node.rejectUnknown("content-width", "flow", "sections", "wrapping", "overflow")
        val width = node.requiredObject("content-width").rejectUnknown(
            "minimum-pixels",
            "maximum-pixels",
            "strategy",
        )
        when (width.requiredString("strategy")) {
            "content", "clamp-content" -> Unit
            else -> invalid("Unsupported content width strategy", path, id)
        }
        val flowEntries = node.requiredList("flow")
        if (flowEntries.size != 1) {
            throw StrictYamlException("layouts.$id.flow in $path must contain exactly one blocks entry")
        }
        val blockGapAfterPixels = flowEntries.mapIndexed { index, raw ->
            val flow = objectNode(raw, path, "layouts.$id.flow[$index]").rejectUnknown(
                "source",
                "gap-after-pixels",
            )
            if (flow.requiredString("source") != "blocks") {
                invalid("Unsupported flow source", path, id)
            }
            flow.requiredInt("gap-after-pixels").also {
                requireNonNegative(it, path, "layouts.$id.flow[$index]")
            }
        }.single()
        val sections = node.optionalObject("sections")
        sections?.rejectUnknown("field", "description")
        val field = sections?.optionalObject("field")
        field?.rejectUnknown("left-padding-pixels", "icon-gap-pixels", "icon-slot-pixels", "value-alignment", "separator")
        field?.optionalString("value-alignment")?.let { alignment ->
            if (alignment !in setOf("left", "right")) invalid("Unsupported field alignment", path, id)
        }
        val description = sections?.optionalObject("description")
        description?.rejectUnknown("left-padding-pixels", "right-padding-pixels", "gap-before-pixels")
        description?.optionalInt("gap-before-pixels")?.let { requireNonNegative(it, path, "layouts.$id.sections.description") }
        return LayoutSource.Flow(
            id = id,
            minimumWidthPixels = width.requiredInt("minimum-pixels"),
            maximumWidthPixels = width.requiredInt("maximum-pixels"),
            blockGapAfterPixels = blockGapAfterPixels,
            fieldLeftPaddingPixels = field?.optionalInt("left-padding-pixels") ?: 0,
            fieldIconGapPixels = field?.optionalInt("icon-gap-pixels") ?: 0,
            fieldValueAlignment = when (field?.optionalString("value-alignment")) {
                null, "left" -> FieldValueAlignment.LEFT
                "right" -> FieldValueAlignment.RIGHT
                else -> error("Validated above")
            },
            descriptionLeftPaddingPixels = description?.optionalInt("left-padding-pixels") ?: 0,
            descriptionRightPaddingPixels = description?.optionalInt("right-padding-pixels") ?: 0,
            descriptionGapBeforePixels = description?.optionalInt("gap-before-pixels") ?: 0,
            wrapping = parseWrapping(node.requiredObject("wrapping"), path, "layouts.$id.wrapping"),
            fieldSeparator = field?.takeIf { it.contains("separator") }?.let {
                parseSeparator(it.raw("separator"), path.toString(), "layouts.$id.sections.field.separator")
            },
            fieldIconSlotPixels = field?.optionalInt("icon-slot-pixels"),
            overflow = parseOverflowStrategy(node.optionalString("overflow"), path.toString(), "layouts.$id.overflow")
                ?: OverflowStrategy.FALLBACK,
        )
    }

    private fun parseOverflowStrategy(value: String?, source: String, path: String): OverflowStrategy? = when (value) {
        null -> null
        "fallback" -> OverflowStrategy.FALLBACK
        "hide" -> OverflowStrategy.HIDE
        else -> throw StrictYamlException("Unsupported overflow strategy at $path in $source")
    }

    private fun parseCanvasLayout(
        id: String,
        node: YamlObject,
        path: Path,
    ): LayoutSource.Canvas {
        node.rejectUnknown("renderer", "canvas", "anchors", "wrapping")
        val canvas = node.requiredObject("canvas").rejectUnknown(
            "width-pixels",
            "height-pixels",
            "maximum-width-pixels",
            "maximum-height-pixels",
            "reserve-tooltip-lines",
            "clip-policy",
        )
        if (canvas.requiredString("clip-policy") != "reject") {
            invalid("Unsupported canvas clip policy", path, id)
        }
        val anchorsNode = node.requiredObject("anchors")
        val anchors = anchorsNode.keys.associateWith { anchorId ->
            val anchor = anchorsNode.child(anchorId, anchorsNode.raw(anchorId)).rejectUnknown(
                "x",
                "y",
                "width",
                "height",
                "overflow",
            )
            CanvasAnchorSource(
                x = anchor.requiredInt("x"),
                y = anchor.requiredInt("y"),
                width = anchor.requiredInt("width"),
                height = anchor.requiredInt("height"),
                overflow = parseOverflow(anchor.requiredString("overflow"), path, "layouts.$id.anchors.$anchorId"),
            )
        }
        return LayoutSource.Canvas(
            id = id,
            widthPixels = canvas.requiredInt("width-pixels"),
            heightPixels = canvas.requiredInt("height-pixels"),
            maximumWidthPixels = canvas.requiredInt("maximum-width-pixels"),
            maximumHeightPixels = canvas.requiredInt("maximum-height-pixels"),
            reserveTooltipLines = canvas.requiredInt("reserve-tooltip-lines"),
            anchors = anchors,
            wrapping = parseWrapping(node.requiredObject("wrapping"), path, "layouts.$id.wrapping"),
        )
    }

    private fun parseWrapping(
        node: YamlObject,
        source: Path,
        path: String,
    ): Map<String, WrappingSource> = node.keys.associateWith { id ->
        val wrapping = node.child(id, node.raw(id)).rejectUnknown(
            "width",
            "width-pixels",
            "line-height-pixels",
            "break-mode",
            "preserve-explicit-lines",
            "maximum-lines",
            "overflow",
            "continuation-indent-pixels",
        )
        val widthPixels = when {
            wrapping.contains("width-pixels") -> wrapping.requiredInt("width-pixels")
            wrapping.contains("width") -> when (val width = wrapping.raw("width")) {
                is Int -> width
                is Long -> width.takeIf { it in Int.MIN_VALUE..Int.MAX_VALUE }?.toInt()
                    ?: throw StrictYamlException("$path.$id.width in $source must be a 32-bit integer")
                "content", "content-minus-section-padding" -> null
                else -> throw StrictYamlException("Unsupported dynamic wrapping width at $path.$id in $source")
            }
            else -> throw StrictYamlException("Missing wrapping width at $path.$id in $source")
        }
        wrapping.optionalInt("line-height-pixels")?.let { requirePositive(it, source, "$path.$id.line-height-pixels") }
        wrapping.optionalString("break-mode")?.let {
            if (it != "word-then-codepoint") invalid("Unsupported wrapping break mode", source, "$path.$id")
        }
        WrappingSource(
            widthPixels = widthPixels,
            maximumLines = wrapping.requiredInt("maximum-lines"),
            overflow = parseOverflow(wrapping.requiredString("overflow"), source, "$path.$id"),
            preserveExplicitLines = wrapping.optionalBoolean("preserve-explicit-lines", true),
            continuationIndentPixels = wrapping.optionalInt("continuation-indent-pixels") ?: 0,
            lineHeightPixels = wrapping.optionalInt("line-height-pixels") ?: 10,
        )
    }

    private fun parseResourcePackDelivery(value: String, source: Path, path: String): ResourcePackDelivery = when (value) {
        "verified" -> ResourcePackDelivery.VERIFIED
        "assumed" -> ResourcePackDelivery.ASSUMED
        else -> invalid("Unsupported resource-pack delivery", source, path)
    }

    private fun parseOverflow(value: String, source: Path, path: String): OverflowPolicy = when (value) {
        "ellipsis" -> OverflowPolicy.ELLIPSIS
        "error", "reject" -> OverflowPolicy.ERROR
        "allow-overflow" -> OverflowPolicy.ALLOW_OVERFLOW
        else -> invalid("Unsupported overflow policy", source, path)
    }

    private fun parseAssets(paths: List<Path>): ParsedAssets {
        val fontSpecs = ArrayList<FontSpec>()
        val glyphs = ArrayList<GlyphSource>()
        val bitmaps = ArrayList<BitmapSource>()
        val profiles = ArrayList<AssetProfileSource>()
        val bindings = ArrayList<ResourcePackBindingSource>()
        val tooltipStyles = LinkedHashSet<String>()
        var spacing: SpacingSource? = null
        var boldExtraAdvancePixels: Double? = null
        paths.forEach { path ->
            val root = document(path).rejectUnknown(
                "schema-version",
                "measurement",
                "fonts",
                "tooltip-styles",
                "glyphs",
                "spacing",
                "asset-profiles",
                "resource-pack-bindings",
                "bitmaps",
            )
            requireVersion(root, path)
            root.optionalObject("measurement")?.let { measurement ->
                if (boldExtraAdvancePixels != null) {
                    throw StrictYamlException("Measurement policy is declared more than once: $path")
                }
                measurement.rejectUnknown("client-version", "missing-glyph", "bold-extra-advance-pixels")
                val configuredClientVersion = measurement.requiredString("client-version")
                if (configuredClientVersion != "server" && configuredClientVersion != builtinFontMetrics.clientVersion) {
                    throw StrictYamlException("Unsupported font measurement client version in $path")
                }
                if (measurement.requiredString("missing-glyph") != "error") {
                    throw StrictYamlException("Font measurement must fail closed on missing glyphs in $path")
                }
                boldExtraAdvancePixels = measurement.optionalDouble("bold-extra-advance-pixels") ?: 1.0
            }
            root.optionalObject("fonts")?.let { fonts ->
                fonts.keys.forEach { id ->
                    val font = fonts.child(id, fonts.raw(id)).rejectUnknown(
                        "metrics",
                        "fallback",
                        "fallback-advance-pixels",
                        "advances",
                    )
                    font.optionalObject("advances")?.let { advances ->
                        advances.rejectUnknown("minimum", "maximum", "step")
                        if (advances.requiredInt("step") != 1) {
                            throw StrictYamlException("Font advances must use a one-pixel step for $id in $path")
                        }
                        if (advances.requiredInt("minimum") >= advances.requiredInt("maximum")) {
                            throw StrictYamlException("Invalid font advance range for $id in $path")
                        }
                    }
                    fontSpecs += FontSpec(
                        id = id,
                        metrics = font.requiredString("metrics"),
                        fallback = font.optionalString("fallback"),
                        fallbackAdvancePixels = font.optionalDouble("fallback-advance-pixels"),
                    )
                }
            }
            root.optionalObject("tooltip-styles")?.let { styles ->
                styles.keys.forEach { id ->
                    val style = styles.child(id, styles.raw(id)).rejectUnknown(
                        "component-value",
                        "expected-background-sprite",
                        "expected-frame-sprite",
                        "scaling",
                    )
                    if (style.requiredString("component-value") != id) {
                        throw StrictYamlException("Tooltip style component-value must equal $id in $path")
                    }
                    ItemKey.parse(style.requiredString("expected-background-sprite"))
                    ItemKey.parse(style.requiredString("expected-frame-sprite"))
                    if (style.requiredString("scaling") !in setOf("nine-slice", "stretch")) {
                        throw StrictYamlException("Unsupported tooltip style scaling for $id in $path")
                    }
                    if (!tooltipStyles.add(id)) {
                        throw StrictYamlException("Duplicate tooltip style $id in $path")
                    }
                }
            }
            root.optionalObject("glyphs")?.let { entries ->
                entries.keys.forEach { id ->
                    val glyph = entries.child(id, entries.raw(id)).rejectUnknown(
                        "font",
                        "codepoint",
                        "bitmap",
                        "advance-pixels",
                        "visual-bounds",
                    )
                    glyphs += GlyphSource(
                        id = id,
                        font = glyph.requiredString("font"),
                        codePoint = parseCodePoint(glyph.requiredString("codepoint"), path, "glyphs.$id.codepoint"),
                        advancePixels = glyph.requiredDouble("advance-pixels"),
                        visualBounds = parseBounds(glyph.requiredObject("visual-bounds"), path, "glyphs.$id.visual-bounds"),
                        bitmap = glyph.optionalString("bitmap"),
                    )
                }
            }
            root.optionalObject("spacing")?.let { spacingNode ->
                if (spacing != null) throw StrictYamlException("Spacing assets are declared more than once: $path")
                spacingNode.rejectUnknown("negative", "positive")
                val negative = parseSpacingRange(spacingNode.requiredObject("negative"), path, "spacing.negative")
                val positive = parseSpacingRange(spacingNode.requiredObject("positive"), path, "spacing.positive")
                if (negative.first != positive.first) {
                    throw StrictYamlException("Positive and negative spacing ranges must use the same font in $path")
                }
                spacing = SpacingSource(negative.first, negative.second, positive.second)
            }
            root.optionalObject("asset-profiles")?.let { entries ->
                entries.keys.forEach { id ->
                    val profile = entries.child(id, entries.raw(id)).rejectUnknown(
                        "capabilities",
                        "metrics-revision",
                        "fallback",
                    )
                    profiles += AssetProfileSource(
                        id = id,
                        capabilities = profile.requiredStringList("capabilities", path, "asset-profiles.$id.capabilities"),
                        metricsRevision = profile.optionalString("metrics-revision"),
                        fallback = profile.optionalString("fallback"),
                    )
                }
            }
            root.optionalObject("resource-pack-bindings")?.let { entries ->
                entries.keys.forEach { id ->
                    val binding = entries.child(id, entries.raw(id)).rejectUnknown(
                        "enabled",
                        "pack-id",
                        "sha1",
                        "asset-profile",
                        "delivery",
                    )
                    bindings += ResourcePackBindingSource(
                        id = id,
                        enabled = binding.requiredBoolean("enabled"),
                        packId = binding.optionalString("pack-id")?.let { parseUuid(it, path, "resource-pack-bindings.$id.pack-id") },
                        sha1 = binding.optionalString("sha1"),
                        assetProfile = binding.requiredString("asset-profile"),
                        delivery = binding.optionalString("delivery")
                            ?.let { parseResourcePackDelivery(it, path, "resource-pack-bindings.$id.delivery") }
                            ?: ResourcePackDelivery.VERIFIED,
                    )
                }
            }
            root.optionalObject("bitmaps")?.let { entries ->
                entries.keys.forEach { id ->
                    val bitmap = entries.child(id, entries.raw(id)).rejectUnknown(
                        "baseline-variant",
                        "texture",
                        "source-width-pixels",
                        "source-height-pixels",
                        "render-width-pixels",
                        "render-height-pixels",
                        "ascent-pixels",
                        "visual-bounds",
                    )
                    ItemKey.parse(bitmap.requiredString("texture"))
                    requirePositive(bitmap.requiredInt("source-width-pixels"), path, "bitmaps.$id.source-width-pixels")
                    requirePositive(bitmap.requiredInt("source-height-pixels"), path, "bitmaps.$id.source-height-pixels")
                    val renderWidth = bitmap.requiredInt("render-width-pixels")
                    val renderHeight = bitmap.requiredInt("render-height-pixels")
                    val ascent = bitmap.requiredInt("ascent-pixels")
                    bitmaps += BitmapSource(
                        id = id,
                        baselineVariant = bitmap.optionalString("baseline-variant"),
                        renderWidthPixels = renderWidth,
                        renderHeightPixels = renderHeight,
                        ascentPixels = ascent,
                        visualBounds = bitmap.optionalObject("visual-bounds")?.let {
                            parseBounds(it, path, "bitmaps.$id.visual-bounds")
                        } ?: VisualBoundsSource(0.0, renderWidth.toDouble(), -ascent.toDouble(), (renderHeight - ascent).toDouble()),
                    )
                }
            }
        }
        val boldAdvance = boldExtraAdvancePixels
            ?: throw StrictYamlException("Assets do not define a font measurement policy")
        val metricsByFont = glyphs.groupBy(GlyphSource::font).mapValues { (font, values) ->
            val metrics = LinkedHashMap<Int, GlyphMetricSource>()
            values.forEach { glyph ->
                val previous = metrics.put(
                    glyph.codePoint,
                    GlyphMetricSource(glyph.advancePixels, glyph.visualBounds,
                        hasInk = glyph.visualBounds.right > glyph.visualBounds.left && glyph.visualBounds.bottom > glyph.visualBounds.top),
                )
                if (previous != null) {
                    throw StrictYamlException("Font $font assigns U+${glyph.codePoint.toString(16)} more than once")
                }
            }
            metrics
        }
        val fonts = fontSpecs.map { spec ->
            val explicitMetrics = metricsByFont[spec.id].orEmpty()
            val resolvedMetrics = when (spec.metrics) {
                "builtin:minecraft-default", "builtin:minecraft-uniform" ->
                    "${spec.metrics}-${builtinFontMetrics.clientVersion}"
                else -> spec.metrics
            }
            val builtin = builtinFontMetrics.tablesByRevision[resolvedMetrics]
            when {
                builtin != null -> {
                    if (builtin.fontId != spec.id) {
                        throw StrictYamlException(
                            "Builtin metrics $resolvedMetrics belong to ${builtin.fontId}, not ${spec.id}",
                        )
                    }
                    if (spec.fallback != null || spec.fallbackAdvancePixels != null) {
                        throw StrictYamlException(
                            "Builtin metrics $resolvedMetrics define their own exact fallback policy",
                        )
                    }
                    if (explicitMetrics.isNotEmpty()) {
                        throw StrictYamlException(
                            "Builtin font ${spec.id} cannot override generated glyph metrics",
                        )
                    }
                    FontSource(
                        id = spec.id,
                        metricsRevision = builtin.metricsRevision,
                        glyphs = builtin.glyphs,
                        fallback = builtin.fallback,
                        fallbackGlyph = builtin.fallbackGlyph,
                        boldExtraAdvancePixels = boldAdvance,
                    )
                }
                resolvedMetrics.startsWith("builtin:") -> throw StrictYamlException(
                    "Unknown builtin font metrics $resolvedMetrics",
                )
                else -> FontSource(
                    id = spec.id,
                    metricsRevision = normalizeMetricsRevision(spec.id, spec.metrics),
                    glyphs = explicitMetrics,
                    fallback = spec.fallback,
                    fallbackAdvancePixels = spec.fallbackAdvancePixels,
                    boldExtraAdvancePixels = boldAdvance,
                )
            }
        }
        return ParsedAssets(fonts, glyphs, bitmaps, profiles, bindings, spacing, tooltipStyles)
    }

    private fun parseSpacingRange(node: YamlObject, source: Path, path: String): Pair<String, SpacingRangeSource> {
        node.rejectUnknown(
            "font",
            "codepoint-range",
            "minimum-advance-pixels",
            "maximum-advance-pixels",
        )
        val range = node.requiredObject("codepoint-range").rejectUnknown("first", "last")
        return node.requiredString("font") to SpacingRangeSource(
            firstCodePoint = parseCodePoint(range.requiredString("first"), source, "$path.codepoint-range.first"),
            lastCodePoint = parseCodePoint(range.requiredString("last"), source, "$path.codepoint-range.last"),
            minimumAdvancePixels = node.requiredInt("minimum-advance-pixels"),
            maximumAdvancePixels = node.requiredInt("maximum-advance-pixels"),
        )
    }

    private fun parseViewerFacts(paths: List<Path>): List<ViewerFactSource> = paths.flatMap { path ->
        val root = document(path).rejectUnknown("schema-version", "facts")
        requireVersion(root, path)
        val facts = root.requiredObject("facts")
        facts.keys.map { id ->
            val node = facts.child(id, facts.raw(id)).rejectUnknown(
                "type",
                "providers",
                "default",
                "nullable",
                "cache-key",
            )
            val type = when (node.requiredString("type")) {
                "locale" -> ViewerFactType.LOCALE
                "boolean" -> ViewerFactType.BOOLEAN
                "integer" -> ViewerFactType.INTEGER
                "long" -> ViewerFactType.LONG
                "decimal" -> ViewerFactType.DECIMAL
                "string" -> ViewerFactType.STRING
                "uuid" -> ViewerFactType.UUID
                "namespaced-key" -> ViewerFactType.NAMESPACED_KEY
                else -> invalid("Unsupported viewer fact type", path, id)
            }
            ViewerFactSource(
                id = id,
                type = type,
                providers = node.requiredStringList("providers", path, "facts.$id.providers"),
                defaultValue = if (node.contains("default")) parseFactDefault(type, node.raw("default"), path, "facts.$id.default") else null,
                nullable = node.optionalBoolean("nullable", false),
                cacheKey = node.optionalBoolean("cache-key", true),
            )
        }
    }

    private class ParsedThemeFile(val themes: List<ThemeSource>, val selectors: List<ThemeSelectorSource>)

    private fun parseThemeFile(path: Path): ParsedThemeFile {
        val root = document(path).rejectUnknown("schema-version", "themes", "theme-selectors")
        requireVersion(root, path)
        // A file may hold only selectors; one with neither section is still rejected.
        val themes = if (root.contains("theme-selectors") && !root.contains("themes")) {
            emptyList()
        } else {
            parseThemes(root.requiredObject("themes"), path)
        }
        val selectors = root.optionalObject("theme-selectors")?.let { parseThemeSelectors(it, path) }.orEmpty()
        return ParsedThemeFile(themes, selectors)
    }

    private fun parseThemeSelectors(selectors: YamlObject, path: Path): List<ThemeSelectorSource> =
        selectors.keys.map { id ->
            val node = selectors.child(id, selectors.raw(id)).rejectUnknown("cases", "default")
            val source = path.toString()
            ThemeSelectorSource(
                id = id,
                cases = node.requiredList("cases").mapIndexed { index, raw ->
                    val casePath = "theme-selectors.$id.cases[$index]"
                    val case = objectNode(raw, source, casePath).rejectUnknown("when", "theme")
                    ThemeSelectorCaseSource(
                        condition = parseCondition(case.requiredObject("when"), source, "$casePath.when"),
                        theme = case.requiredString("theme"),
                    )
                },
                defaultTheme = node.requiredString("default"),
            )
        }

    private fun parseThemes(themes: YamlObject, path: Path): List<ThemeSource> {
        return themes.keys.map { id ->
            val node = themes.child(id, themes.raw(id))
            val renderer = when (node.requiredString("renderer")) {
                "plain" -> ThemeRenderer.PLAIN
                "vanilla-character-frame" -> ThemeRenderer.VANILLA_CHARACTER_FRAME
                "native-tooltip-style" -> ThemeRenderer.NATIVE_TOOLTIP_STYLE
                "segmented-frame" -> ThemeRenderer.SEGMENTED_FRAME
                "bitmap-canvas" -> ThemeRenderer.BITMAP_CANVAS
                else -> invalid("Unsupported theme renderer", path, id)
            }
            val common = setOf(
                "renderer",
                "requires-resource-pack",
                "requires-capabilities",
                "vanilla-tooltip-lines",
                "fallback",
                "fonts",
                "styles",
                "markers",
                "rules",
                "name-inset-pixels",
            )
            val rendererKeys = when (renderer) {
                ThemeRenderer.PLAIN -> setOf("icons")
                ThemeRenderer.VANILLA_CHARACTER_FRAME -> setOf("frame", "wrapping", "safety")
                ThemeRenderer.NATIVE_TOOLTIP_STYLE -> setOf("tooltip-style", "content")
                ThemeRenderer.SEGMENTED_FRAME -> setOf("frame", "wrapping", "tooltip-style")
                ThemeRenderer.BITMAP_CANVAS -> setOf("experimental", "tooltip-style", "canvas", "safety")
            }
            node.rejectUnknown(*(common + rendererKeys).toTypedArray())
            if (node.contains("experimental") && !node.requiredBoolean("experimental")) {
                throw StrictYamlException("Experimental theme flag must be true for $id in $path")
            }
            node.optionalObject("icons")?.let { icons ->
                icons.rejectUnknown("unsupported-token")
                if (icons.requiredString("unsupported-token") != "omit") {
                    throw StrictYamlException("Unsupported icon fallback for $id in $path")
                }
            }
            val fontsNode = node.requiredObject("fonts")
            val fonts = fontsNode.keys.associateWith { role ->
                fontsNode.raw(role) as? String
                    ?: throw StrictYamlException("Theme font $role for $id in $path must be a string")
            }
            val styles = node.optionalObject("styles")?.let { parseStyles(it, path, "themes.$id.styles") }.orEmpty()
            val content = node.optionalObject("content")?.let { contentNode ->
                contentNode.rejectUnknown(
                    "minimum-width-pixels",
                    "maximum-width-pixels",
                    "left-padding-pixels",
                    "right-padding-pixels",
                )
                ContentAreaSource(
                    minimumWidthPixels = contentNode.requiredInt("minimum-width-pixels"),
                    maximumWidthPixels = contentNode.requiredInt("maximum-width-pixels"),
                    leftPaddingPixels = contentNode.optionalInt("left-padding-pixels") ?: 0,
                    rightPaddingPixels = contentNode.optionalInt("right-padding-pixels") ?: 0,
                )
            }
            val characterFrame = if (renderer == ThemeRenderer.VANILLA_CHARACTER_FRAME) {
                parseCharacterFrame(node, path, id)
            } else {
                null
            }
            val segmentedFrame = if (renderer == ThemeRenderer.SEGMENTED_FRAME) {
                parseSegmentedFrame(node, path, id)
            } else {
                null
            }
            val canvas = if (renderer == ThemeRenderer.BITMAP_CANVAS) {
                parseCanvasTheme(node, path, id)
            } else {
                null
            }
            ThemeSource(
                id = id,
                renderer = renderer,
                requiresResourcePack = node.requiredBoolean("requires-resource-pack"),
                requiredCapabilities = node.optionalStringList("requires-capabilities", path, "themes.$id.requires-capabilities"),
                vanillaTooltipLines = when (node.requiredString("vanilla-tooltip-lines")) {
                    "preserve" -> VanillaTooltipLinePolicy.PRESERVE
                    "preserve-outside-frame" -> VanillaTooltipLinePolicy.PRESERVE_OUTSIDE_FRAME
                    "require-managed" -> VanillaTooltipLinePolicy.REQUIRE_MANAGED
                    else -> invalid("Unsupported vanilla tooltip line policy", path, id)
                },
                fallback = node.optionalString("fallback"),
                fonts = fonts,
                styles = styles,
                tooltipStyle = node.optionalString("tooltip-style"),
                content = content,
                characterFrame = characterFrame,
                segmentedFrame = segmentedFrame,
                canvas = canvas,
                requireExactFontMetrics = node.optionalObject("safety")
                    ?.optionalBoolean("require-exact-font-metrics", false) ?: false,
                markers = node.optionalObject("markers")?.let { parseMarkers(it, path.toString(), "themes.$id.markers") },
                rules = node.optionalObject("rules")?.let { parseRules(it, path.toString(), "themes.$id.rules") },
                nameInsetPixels = node.optionalInt("name-inset-pixels") ?: 0,
            )
        }
    }

    private fun parseMarkers(node: YamlObject, source: String, path: String): MarkerThemeSource {
        node.rejectUnknown("style", "bullet", "tree", "gap-pixels")
        val tree = node.optionalObject("tree")?.rejectUnknown("branch", "last", "vertical")
        return MarkerThemeSource(
            gapPixels = node.optionalInt("gap-pixels") ?: 0,
            style = node.optionalString("style"),
            bullet = node.raw("bullet")?.let { parseMarkerPiece(it, source, "$path.bullet") },
            tree = tree?.let {
                TreeMarkerSource(
                    branch = it.raw("branch")?.let { raw -> parseMarkerPiece(raw, source, "$path.tree.branch") },
                    last = it.raw("last")?.let { raw -> parseMarkerPiece(raw, source, "$path.tree.last") },
                    vertical = it.raw("vertical")?.let { raw -> parseMarkerPiece(raw, source, "$path.tree.vertical") },
                )
            },
        )
    }

    private fun parseRules(node: YamlObject, source: String, path: String): RuleThemeSource {
        node.rejectUnknown("style", "fill", "left", "right", "title-gap-pixels")
        return RuleThemeSource(
            style = node.optionalString("style"),
            fill = node.raw("fill")?.let { parseMarkerPiece(it, source, "$path.fill") },
            left = node.raw("left")?.let { parseMarkerPiece(it, source, "$path.left") },
            right = node.raw("right")?.let { parseMarkerPiece(it, source, "$path.right") },
            titleGapPixels = node.optionalInt("title-gap-pixels") ?: 4,
        )
    }

    /** A marker piece is literal text or, like a field icon, a resource-pack glyph token. */
    private fun parseMarkerPiece(raw: Any, source: String, path: String): MarkerPieceSource = when (raw) {
        is String -> MarkerPieceSource.Text(raw)
        is Map<*, *> -> MarkerPieceSource.Glyph(objectNode(raw, source, path).rejectUnknown("glyph").requiredString("glyph"))
        else -> throw StrictYamlException("$path in $source must be a string or a glyph mapping")
    }

    private fun parseStyles(node: YamlObject, source: Path, path: String): Map<String, TextStyleSource> =
        node.keys.associateWith { role ->
            val style = node.child(role, node.raw(role)).rejectUnknown(
                "color",
                "bold",
                "italic",
                "underlined",
                "strikethrough",
            )
            TextStyleSource(
                color = style.optionalString("color"),
                bold = style.optionalBoolean("bold", false),
                italic = style.optionalBoolean("italic", false),
                underlined = style.optionalBoolean("underlined", false),
                strikethrough = style.optionalBoolean("strikethrough", false),
            )
        }

    private fun parseCharacterFrame(node: YamlObject, source: Path, id: String): CharacterFrameSource {
        val frame = node.requiredObject("frame").rejectUnknown(
            "preset",
            "scope",
            "continuity",
            "minimum-width-pixels",
            "maximum-width-pixels",
            "left-padding-pixels",
            "right-padding-pixels",
            "alignment-tolerance-pixels",
            "separators",
        )
        if (frame.requiredString("scope") != "managed-lore" ||
            frame.requiredString("continuity") != "ornamental" ||
            frame.requiredString("separators") != "section-boundaries"
        ) {
            throw StrictYamlException("Unsupported character frame composition for $id in $source")
        }
        val wrapping = node.requiredObject("wrapping").rejectUnknown(
            "enforce-frame-width",
            "overflow",
            "maximum-lines",
        )
        if (!wrapping.requiredBoolean("enforce-frame-width") || wrapping.requiredString("overflow") != "wrap") {
            throw StrictYamlException("Character frame wrapping must enforce and wrap the frame for $id in $source")
        }
        val safety = node.requiredObject("safety").rejectUnknown(
            "bidirectional-layout",
            "unknown-glyph",
            "personal-font-overrides",
        )
        if (safety.requiredString("unknown-glyph") != "fallback" ||
            safety.requiredString("personal-font-overrides") != "approximate"
        ) {
            throw StrictYamlException("Unsupported character frame safety policy for $id in $source")
        }
        return CharacterFrameSource(
            preset = when (frame.requiredString("preset")) {
                "unicode-single" -> CharacterFramePreset.UNICODE_SINGLE
                "unicode-double" -> CharacterFramePreset.UNICODE_DOUBLE
                "ascii-safe" -> CharacterFramePreset.ASCII_SAFE
                "bracketed-section" -> CharacterFramePreset.BRACKETED_SECTION
                "separator-only" -> CharacterFramePreset.SEPARATOR_ONLY
                else -> invalid("Unsupported character frame preset", source, id)
            },
            minimumWidthPixels = frame.requiredInt("minimum-width-pixels"),
            maximumWidthPixels = frame.requiredInt("maximum-width-pixels"),
            leftPaddingPixels = frame.requiredInt("left-padding-pixels"),
            rightPaddingPixels = frame.requiredInt("right-padding-pixels"),
            alignmentTolerancePixels = frame.requiredInt("alignment-tolerance-pixels"),
            maximumLines = wrapping.requiredInt("maximum-lines"),
            fallbackBidirectionalText = when (safety.requiredString("bidirectional-layout")) {
                "fallback" -> true
                else -> invalid("Unsupported bidirectional layout policy", source, id)
            },
        )
    }

    private fun parseSegmentedFrame(node: YamlObject, source: Path, id: String): SegmentedFrameSource {
        val frame = node.requiredObject("frame").rejectUnknown(
            "width",
            "minimum-width-pixels",
            "maximum-width-pixels",
            "left-padding-pixels",
            "right-padding-pixels",
            "top",
            "body",
            "connector",
            "bottom",
            "fill-mode",
            "height-mode",
            "include-name",
        )
        if (frame.requiredString("width") != "layout" ||
            frame.requiredString("fill-mode") != "exact-pixel" ||
            frame.requiredString("height-mode") != "repeat-for-rendered-lines"
        ) {
            throw StrictYamlException("Unsupported segmented frame sizing for $id in $source")
        }
        val wrapping = node.requiredObject("wrapping").rejectUnknown("enforce-frame-width", "overflow")
        if (!wrapping.requiredBoolean("enforce-frame-width") || wrapping.requiredString("overflow") != "wrap") {
            throw StrictYamlException("Segmented frame wrapping must enforce and wrap the frame for $id in $source")
        }
        return SegmentedFrameSource(
            minimumWidthPixels = frame.requiredInt("minimum-width-pixels"),
            maximumWidthPixels = frame.requiredInt("maximum-width-pixels"),
            leftPaddingPixels = frame.requiredInt("left-padding-pixels"),
            rightPaddingPixels = frame.requiredInt("right-padding-pixels"),
            top = parseFrameRow(frame.requiredObject("top")),
            body = parseFrameRow(frame.requiredObject("body")),
            connector = frame.optionalObject("connector")?.let(::parseFrameRow),
            bottom = parseFrameRow(frame.requiredObject("bottom")),
            includeName = frame.optionalBoolean("include-name", false),
        )
    }

    private fun parseFrameRow(node: YamlObject): FrameRowSource {
        node.rejectUnknown("left", "fill", "right", "center", "kern")
        return FrameRowSource(
            node.requiredString("left"),
            node.requiredString("fill"),
            node.requiredString("right"),
            node.optionalString("center"),
            node.optionalString("kern"),
        )
    }

    private fun parseCanvasTheme(node: YamlObject, source: Path, id: String): CanvasThemeSource {
        val canvas = node.requiredObject("canvas").rejectUnknown(
            "composition",
            "width-pixels",
            "height-pixels",
            "maximum-width-pixels",
            "maximum-height-pixels",
            "normalize-visual-origin",
            "emit-width-anchor",
            "reserve-tooltip-lines",
            "layers",
            "measured-advance-pixels",
            "final-tooltip-width-pixels",
        )
        if (canvas.requiredString("composition") != "bitmap-overlay" ||
            !canvas.requiredBoolean("emit-width-anchor")
        ) {
            throw StrictYamlException("Unsupported bitmap canvas composition for $id in $source")
        }
        val layers = canvas.requiredList("layers").mapIndexed { index, raw ->
            val layer = objectNode(raw, source, "themes.$id.canvas.layers[$index]").rejectUnknown(
                "asset",
                "anchor",
                "x-pixels",
                "baseline-line",
                "baseline-variant",
                "draw-order",
            )
            CanvasLayerSource(
                asset = layer.requiredString("asset"),
                anchor = when (layer.requiredString("anchor")) {
                    "top-left" -> CanvasLayerAnchor.TOP_LEFT
                    "top-right" -> CanvasLayerAnchor.TOP_RIGHT
                    else -> invalid("Unsupported canvas layer anchor", source, "$id[$index]")
                },
                xPixels = layer.requiredInt("x-pixels"),
                baselineLine = layer.requiredInt("baseline-line"),
                baselineVariant = layer.requiredString("baseline-variant"),
                drawOrder = layer.requiredInt("draw-order"),
            )
        }
        val safety = node.requiredObject("safety").rejectUnknown(
            "force-decoration-bold",
            "require-exact-font-metrics",
            "reject-negative-final-advance",
            "reject-out-of-bounds-layer",
            "maximum-emitted-components",
        )
        if (safety.requiredBoolean("force-decoration-bold")) {
            throw StrictYamlException("Canvas decoration bold must remain disabled for $id in $source")
        }
        return CanvasThemeSource(
            widthPixels = canvas.requiredInt("width-pixels"),
            heightPixels = canvas.requiredInt("height-pixels"),
            maximumWidthPixels = canvas.requiredInt("maximum-width-pixels"),
            maximumHeightPixels = canvas.requiredInt("maximum-height-pixels"),
            reserveTooltipLines = canvas.requiredInt("reserve-tooltip-lines"),
            layers = layers,
            measuredAdvancePixels = canvas.requiredInt("measured-advance-pixels"),
            finalTooltipWidthPixels = canvas.requiredInt("final-tooltip-width-pixels"),
            rejectNegativeFinalAdvance = safety.requiredBoolean("reject-negative-final-advance"),
            rejectOutOfBoundsLayer = safety.requiredBoolean("reject-out-of-bounds-layer"),
            maximumEmittedComponents = safety.requiredInt("maximum-emitted-components"),
            normalizeVisualOrigin = canvas.requiredBoolean("normalize-visual-origin"),
        )
    }

    private fun parseItems(
        documents: Map<ItemKey, Map<String, Any?>>,
        defaultLayout: ItemKey?,
        defaultTheme: ItemKey?,
    ): List<ItemPresentationSource> =
        documents.entries.map { (itemKey, document) ->
            rejectPrivateUse(document, "catalog item $itemKey", "\$")
            val item = YamlObject.root(document, "catalog item $itemKey")
            val presentation = item.requiredObject("presentation").rejectUnknown(
                "layout",
                "theme",
                "nested-items",
                "name",
                "blocks",
                "shown-flags",
                "marker",
                "dividers",
                "overflow",
            )
            presentation.optionalString("nested-items")?.let {
                if (it != "recursive") {
                    throw StrictYamlException("Unsupported nested item projection for $itemKey")
                }
            }
            val name = presentation.requiredObject("name").rejectUnknown("message", "before", "after")
            ItemPresentationSource(
                id = itemKey.toString(),
                layout = presentation.optionalString("layout")
                    ?: defaultLayout?.toString()
                    ?: presentation.requiredString("layout"),
                theme = presentation.optionalString("theme")
                    ?: defaultTheme?.toString()
                    ?: presentation.requiredString("theme"),
                nameMessage = name.requiredString("message"),
                blocks = parseBlocks(
                    presentation.requiredList("blocks"),
                    "catalog item $itemKey",
                    "presentation.blocks",
                ),
                enabled = item.requiredBoolean("enabled"),
                shownFlags = presentation.optionalList("shown-flags").orEmpty().mapIndexed { index, value ->
                    value as? String ?: throw StrictYamlException(
                        "presentation.shown-flags[$index] in catalog item $itemKey must be a string",
                    )
                },
                marker = parseGroupMarker(presentation.optionalString("marker"), "catalog item $itemKey", "presentation.marker"),
                dividers = parseGroupDividers(
                    presentation.optionalString("dividers"),
                    GroupDividers.BETWEEN_CHILDREN,
                    "catalog item $itemKey",
                    "presentation.dividers",
                ),
                nameBefore = parseFragments(name.optionalList("before"), "catalog item $itemKey", "presentation.name.before"),
                nameAfter = parseFragments(name.optionalList("after"), "catalog item $itemKey", "presentation.name.after"),
                overflow = parseOverflowStrategy(presentation.optionalString("overflow"), "catalog item $itemKey", "presentation.overflow"),
            )
        }

    private fun parseBlocks(
        values: List<Any?>,
        source: String,
        path: String,
    ): List<PresentationBlockSource> = values.mapIndexed { index, raw -> parseBlock(raw, source, "$path[$index]") }

    private fun parseBlock(
        raw: Any?,
        source: String,
        blockPath: String,
    ): PresentationBlockSource {
        val node = objectNode(raw, source, blockPath)
        return when (node.requiredString("type")) {
            "text" -> {
                node.rejectUnknown("type", "id", "data", "style", "anchor", "wrapping", "unbreakable", "missing-policy", *HIDING_KEYS)
                validateOptionalSemanticId(node, source, blockPath)
                PresentationBlockSource.Text(
                    weight = parseWeight(node, source, blockPath),
                    summary = parseSummary(node, source, blockPath),
                    data = node.requiredString("data"),
                    style = node.optionalString("style"),
                    anchor = node.optionalString("anchor"),
                    wrapping = node.optionalString("wrapping"),
                    unbreakable = node.optionalBoolean("unbreakable", false),
                    missingPolicy = parseMissingDataPolicy(node.optionalString("missing-policy"), source, blockPath),
                )
            }
            "field" -> {
                node.rejectUnknown(
                    "type", "id", "icon", "label", "data", "format", "style", "styles", "anchor", "wrapping", "missing-policy",
                    "separator", *HIDING_KEYS,
                )
                validateOptionalSemanticId(node, source, blockPath)
                PresentationBlockSource.Field(
                    partStyles = parsePartStyles(node, source, blockPath),
                    weight = parseWeight(node, source, blockPath),
                    summary = parseSummary(node, source, blockPath),
                    labelMessage = node.requiredString("label"),
                    data = node.requiredString("data"),
                    format = node.optionalString("format"),
                    icon = node.optionalString("icon"),
                    style = node.optionalString("style"),
                    anchor = node.optionalString("anchor"),
                    wrapping = node.optionalString("wrapping"),
                    missingPolicy = parseMissingDataPolicy(node.optionalString("missing-policy"), source, blockPath),
                    separator = node.takeIf { it.contains("separator") }?.let {
                        parseSeparator(it.raw("separator"), source, "$blockPath.separator")
                    },
                )
            }
            "description" -> {
                node.rejectUnknown("type", "id", "message", "style", "anchor", "wrapping", *HIDING_KEYS)
                validateOptionalSemanticId(node, source, blockPath)
                PresentationBlockSource.Description(
                    weight = parseWeight(node, source, blockPath),
                    summary = parseSummary(node, source, blockPath),
                    message = node.requiredString("message"),
                    style = node.optionalString("style") ?: "description",
                    anchor = node.optionalString("anchor"),
                    wrapping = node.optionalString("wrapping") ?: "body",
                )
            }
            "conditional" -> {
                node.rejectUnknown("type", "id", "condition", "then", "otherwise", "style", "anchor", "weight")
                validateOptionalSemanticId(node, source, blockPath)
                PresentationBlockSource.Conditional(
                    weight = parseWeight(node, source, blockPath),
                    condition = parseCondition(node.requiredObject("condition"), source, "$blockPath.condition"),
                    thenBlocks = parseBlocks(node.requiredList("then"), source, "$blockPath.then"),
                    otherwiseBlocks = node.optionalList("otherwise")?.let {
                        parseBlocks(it, source, "$blockPath.otherwise")
                    }.orEmpty(),
                    style = node.optionalString("style"),
                    anchor = node.optionalString("anchor"),
                )
            }
            "repeat" -> {
                node.rejectUnknown("type", "id", "data", "maximum-elements", "template", "style", "anchor", "missing-policy", *HIDING_KEYS)
                validateOptionalSemanticId(node, source, blockPath)
                val template = node.requiredObject("template").rejectUnknown(
                    "type",
                    "icon",
                    "label",
                    "value-path",
                    "missing-message",
                    "format",
                    "separator",
                    "styles",
                )
                if (template.requiredString("type") != "compound-field") {
                    throw StrictYamlException("Unsupported repeat template at $blockPath in $source")
                }
                PresentationBlockSource.Repeat(
                    data = node.requiredString("data"),
                    maximumElements = node.requiredInt("maximum-elements"),
                    template = CompoundFieldTemplateSource(
                        labelMessage = template.requiredString("label"),
                        valuePath = template.requiredString("value-path"),
                        missingMessage = template.requiredString("missing-message"),
                        icon = template.optionalString("icon"),
                        format = template.optionalString("format"),
                        separator = template.takeIf { it.contains("separator") }?.let {
                            parseSeparator(it.raw("separator"), source, "$blockPath.template.separator")
                        },
                        partStyles = parsePartStyles(template, source, "$blockPath.template"),
                    ),
                    weight = parseWeight(node, source, blockPath),
                    summary = parseSummary(node, source, blockPath),
                    style = node.optionalString("style"),
                    anchor = node.optionalString("anchor"),
                    missingPolicy = parseMissingDataPolicy(node.optionalString("missing-policy"), source, blockPath),
                )
            }
            "nested-item-list" -> {
                node.rejectUnknown("type", "id", "style", "anchor", *HIDING_KEYS)
                validateOptionalSemanticId(node, source, blockPath)
                PresentationBlockSource.NestedItemList(
                    weight = parseWeight(node, source, blockPath),
                    summary = parseSummary(node, source, blockPath),
                    style = node.optionalString("style"),
                    anchor = node.optionalString("anchor"),
                )
            }
            "group" -> {
                node.rejectUnknown(
                    "type", "id", "header", "children", "marker", "dividers", "when-header-missing", "when-empty",
                    "gap-before-lines", "style", "anchor", "weight",
                )
                validateOptionalSemanticId(node, source, blockPath)
                PresentationBlockSource.Group(
                    weight = parseWeight(node, source, blockPath),
                    header = node.optionalObject("header")?.let { parseBlock(node.raw("header"), source, "$blockPath.header") },
                    children = parseBlocks(node.requiredList("children"), source, "$blockPath.children"),
                    marker = parseGroupMarker(node.optionalString("marker"), source, "$blockPath.marker"),
                    dividers = parseGroupDividers(node.optionalString("dividers"), GroupDividers.NONE, source, "$blockPath.dividers"),
                    whenHeaderMissing = when (node.optionalString("when-header-missing") ?: "hide") {
                        "hide" -> GroupHeaderMissingPolicy.HIDE
                        "show-children" -> GroupHeaderMissingPolicy.SHOW_CHILDREN
                        else -> throw StrictYamlException("Unsupported when-header-missing policy at $blockPath in $source")
                    },
                    whenEmpty = when (node.optionalString("when-empty") ?: "show-header") {
                        "show-header" -> GroupEmptyPolicy.SHOW_HEADER
                        "hide" -> GroupEmptyPolicy.HIDE
                        else -> throw StrictYamlException("Unsupported when-empty policy at $blockPath in $source")
                    },
                    gapBeforeLines = node.optionalInt("gap-before-lines") ?: 0,
                    style = node.optionalString("style"),
                    anchor = node.optionalString("anchor"),
                )
            }
            "row" -> {
                node.rejectUnknown("type", "id", "left", "right", "style", "anchor", "wrapping", *HIDING_KEYS)
                validateOptionalSemanticId(node, source, blockPath)
                PresentationBlockSource.Row(
                    left = parseFragments(node.optionalList("left"), source, "$blockPath.left"),
                    right = parseFragments(node.optionalList("right"), source, "$blockPath.right"),
                    style = node.optionalString("style"),
                    anchor = node.optionalString("anchor"),
                    wrapping = node.optionalString("wrapping"),
                    weight = parseWeight(node, source, blockPath),
                    summary = parseSummary(node, source, blockPath),
                )
            }
            "rule" -> {
                node.rejectUnknown("type", "id", "title", "style", "anchor", *HIDING_KEYS)
                validateOptionalSemanticId(node, source, blockPath)
                PresentationBlockSource.Rule(
                    title = parseFragments(node.optionalList("title"), source, "$blockPath.title"),
                    style = node.optionalString("style"),
                    anchor = node.optionalString("anchor"),
                    weight = parseWeight(node, source, blockPath),
                    summary = parseSummary(node, source, blockPath),
                )
            }
            else -> throw StrictYamlException("Unsupported block type at $blockPath in $source")
        }
    }

    /** `weight` is a non-negative integer or `never`; absent inherits the enclosing block's. */
    private fun parseWeight(node: YamlObject, source: String, path: String): HidingWeight? {
        if (!node.contains("weight")) return null
        return when (node.raw("weight")) {
            "never" -> HidingWeight.Never
            is String -> throw StrictYamlException("$path.weight in $source must be an integer or never")
            else -> HidingWeight.Ranked(node.requiredInt("weight"))
        }
    }

    private fun parseSummary(node: YamlObject, source: String, path: String): SummarySource? {
        val summary = node.optionalObject("summary") ?: return null
        summary.rejectUnknown("slot", "piece", "value-path", "format", "style")
        return SummarySource(
            slot = summary.requiredString("slot"),
            piece = summary.raw("piece")?.let { parseFragment(it, source, "$path.summary.piece") },
            valuePath = summary.optionalString("value-path"),
            format = summary.optionalString("format"),
            style = summary.optionalString("style"),
        )
    }

    private fun parsePartStyles(node: YamlObject, source: String, path: String): FieldPartStyles? {
        val styles = node.optionalObject("styles") ?: return null
        styles.rejectUnknown("icon", "label", "separator", "value")
        return FieldPartStyles(
            icon = styles.optionalString("icon"),
            label = styles.optionalString("label"),
            separator = styles.optionalString("separator"),
            value = styles.optionalString("value"),
        )
    }

    private fun parseFragments(values: List<Any?>?, source: String, path: String): List<FragmentSource> =
        values.orEmpty().mapIndexed { index, raw -> parseFragment(raw, source, "$path[$index]") }

    /**
     * A fragment is a mapping with exactly one kind key: `message`, `data`, `glyph`, `literal` or
     * `slot`, plus optional `style` and `when`.
     */
    private fun parseFragment(raw: Any?, source: String, path: String): FragmentSource {
        val node = objectNode(raw, source, path)
        val kinds = node.keys.intersect(FRAGMENT_KINDS)
        if (kinds.size != 1) {
            throw StrictYamlException("$path in $source must name exactly one of ${FRAGMENT_KINDS.joinToString()}")
        }
        val style = node.optionalString("style")
        val condition = node.optionalObject("when")?.let { parseCondition(it, source, "$path.when") }
        return when (kinds.single()) {
            "message" -> {
                node.rejectUnknown("message", "style", "when")
                FragmentSource.Message(node.requiredString("message"), style, condition)
            }
            "data" -> {
                node.rejectUnknown("data", "format", "style", "when")
                FragmentSource.Data(node.requiredString("data"), node.optionalString("format"), style, condition)
            }
            "glyph" -> {
                node.rejectUnknown("glyph", "style", "when")
                FragmentSource.Glyph(node.requiredString("glyph"), style, condition)
            }
            "literal" -> {
                node.rejectUnknown("literal", "style", "when")
                FragmentSource.Literal(node.requiredString("literal"), style, condition)
            }
            else -> {
                node.rejectUnknown("slot", "prefix", "suffix", "separator", "maximum-entries", "overflow-count-message", "style", "when")
                FragmentSource.Slot(
                    id = node.requiredString("slot"),
                    prefix = node.raw("prefix")?.let { parseFragment(it, source, "$path.prefix") },
                    suffix = node.raw("suffix")?.let { parseFragment(it, source, "$path.suffix") },
                    separator = node.raw("separator")?.let { parseFragment(it, source, "$path.separator") },
                    maximumEntries = node.optionalInt("maximum-entries"),
                    overflowCountMessage = node.optionalString("overflow-count-message"),
                    style = style,
                    condition = condition,
                )
            }
        }
    }

    private fun parseGroupMarker(value: String?, source: String, path: String): GroupMarker = when (value ?: "none") {
        "none" -> GroupMarker.NONE
        "bullet" -> GroupMarker.BULLET
        "tree" -> GroupMarker.TREE
        else -> throw StrictYamlException("Unsupported marker at $path in $source")
    }

    private fun parseGroupDividers(value: String?, default: GroupDividers, source: String, path: String): GroupDividers =
        when (value) {
            null -> default
            "none" -> GroupDividers.NONE
            "between-children" -> GroupDividers.BETWEEN_CHILDREN
            else -> throw StrictYamlException("Unsupported dividers at $path in $source")
        }

    /** A field separator is `none` or a localized `{message: key}`; absent inherits the layout. */
    private fun parseSeparator(raw: Any?, source: String, path: String): FieldSeparatorSource = when (raw) {
        "none" -> FieldSeparatorSource.None
        is Map<*, *> -> FieldSeparatorSource.Message(objectNode(raw, source, path).rejectUnknown("message").requiredString("message"))
        else -> throw StrictYamlException("$path in $source must be none or a message mapping")
    }

    private fun parseMissingDataPolicy(value: String?, source: String, path: String): MissingDataPolicy = when (value ?: "error") {
        "error" -> MissingDataPolicy.ERROR
        "omit" -> MissingDataPolicy.OMIT
        else -> throw StrictYamlException("Unsupported missing-data policy at $path in $source")
    }

    private fun parseCondition(node: YamlObject, source: String, path: String): ConditionSource {
        node.rejectUnknown("operator", "left", "right")
        val operator = when (node.requiredString("operator")) {
            "less-than" -> ConditionOperator.LESS_THAN
            "less-than-or-equal" -> ConditionOperator.LESS_THAN_OR_EQUAL
            "greater-than" -> ConditionOperator.GREATER_THAN
            "greater-than-or-equal" -> ConditionOperator.GREATER_THAN_OR_EQUAL
            "equals" -> ConditionOperator.EQUALS
            "not-equals" -> ConditionOperator.NOT_EQUALS
            "exists" -> ConditionOperator.EXISTS
            else -> throw StrictYamlException("Unsupported condition operator at $path in $source")
        }
        return ConditionSource(
            operator,
            parseValueReference(node.requiredObject("left"), source, "$path.left"),
            node.optionalObject("right")?.let { parseValueReference(it, source, "$path.right") },
        )
    }

    private fun parseValueReference(node: YamlObject, source: String, path: String): ValueReferenceSource {
        node.rejectUnknown("data", "fact", "literal")
        if (node.keys.size != 1) {
            throw StrictYamlException("Value reference at $path in $source must contain exactly one source")
        }
        return when (val key = node.keys.single()) {
            "data" -> ValueReferenceSource.Data(node.requiredString(key))
            "fact" -> ValueReferenceSource.Fact(node.requiredString(key))
            "literal" -> ValueReferenceSource.Literal(parseGenericDataValue(node.raw(key), source, path))
            else -> error("Unknown value reference key was not rejected")
        }
    }

    private fun validateOptionalSemanticId(node: YamlObject, source: String, path: String) {
        node.optionalString("id")?.let { id ->
            if (!SEMANTIC_ID.matches(id)) throw StrictYamlException("Invalid semantic id $id at $path in $source")
        }
    }

    private fun yamlFiles(root: Path, domain: String): List<Path> {
        val directory = root.resolve(domain)
        if (!Files.isDirectory(directory) || Files.isSymbolicLink(directory)) {
            throw StrictYamlException("Presentation directory is missing or unsafe: $directory")
        }
        val files = Files.walk(directory).use { paths ->
            paths.filter { candidate ->
                if (candidate != directory && Files.isSymbolicLink(candidate)) {
                    throw StrictYamlException("Presentation paths must not be symbolic links: $candidate")
                }
                Files.isRegularFile(candidate) && candidate.extension() in YAML_EXTENSIONS
            }.sorted().collect(Collectors.toList())
        }
        if (files.size > MAX_FILES_PER_DOMAIN) {
            throw StrictYamlException("Presentation directory $directory exceeds the file limit")
        }
        val bytes = files.sumOf(Files::size)
        if (bytes > MAX_BYTES_PER_DOMAIN) {
            throw StrictYamlException("Presentation directory $directory exceeds the byte limit")
        }
        return files
    }

    private fun document(path: Path): YamlObject {
        val raw = StrictYaml.load(path)
        rejectPrivateUse(raw, path.toString(), "\$")
        return YamlObject.root(raw, path.toString())
    }

    private fun requireVersion(root: YamlObject, path: Path) {
        val version = root.requiredInt("schema-version")
        if (version != SUPPORTED_SCHEMA_VERSION) {
            throw StrictYamlException("Unsupported presentation schema version $version in $path")
        }
    }

    private companion object {
        const val SUPPORTED_SCHEMA_VERSION = 1
        const val MAX_FILES_PER_DOMAIN = 1_024
        const val MAX_BYTES_PER_DOMAIN = 16L * 1024L * 1024L
        val YAML_EXTENSIONS = setOf("yml", "yaml")
        val SEMANTIC_ID = Regex("[a-z0-9][a-z0-9._/-]*")
        val HIDING_KEYS = arrayOf("weight", "summary")
        val FRAGMENT_KINDS = setOf("message", "data", "glyph", "literal", "slot")
    }
}

private data class FontSpec(
    val id: String,
    val metrics: String,
    val fallback: String?,
    val fallbackAdvancePixels: Double?,
)

private class ParsedAssets(
    val fonts: List<FontSource>,
    val glyphs: List<GlyphSource>,
    val bitmaps: List<BitmapSource>,
    val assetProfiles: List<AssetProfileSource>,
    val resourcePackBindings: List<ResourcePackBindingSource>,
    val spacing: SpacingSource?,
    tooltipStyles: Collection<String>,
) {
    val tooltipStyles: Set<String> = Collections.unmodifiableSet(LinkedHashSet(tooltipStyles))
}

private fun Path.extension(): String = fileName.toString().substringAfterLast('.', "").lowercase()

private fun invalid(message: String, source: Path, id: String): Nothing =
    throw StrictYamlException("$message for $id in $source")

private fun rejectPrivateUse(value: Any?, source: String, path: String) {
    when (value) {
        is String -> if (value.codePoints().anyMatch(::isPrivateUseCodePoint)) {
            throw StrictYamlException("Raw private-use character at $path in $source; use the glyph registry")
        }
        is Map<*, *> -> value.forEach { (key, child) ->
            rejectPrivateUse(key, source, "$path.<key>")
            rejectPrivateUse(child, source, "$path.$key")
        }
        is List<*> -> value.forEachIndexed { index, child -> rejectPrivateUse(child, source, "$path[$index]") }
    }
}

private fun isPrivateUseCodePoint(codePoint: Int): Boolean =
    codePoint in 0xE000..0xF8FF || codePoint in 0xF0000..0xFFFFD || codePoint in 0x100000..0x10FFFD

private fun YamlObject.optionalDouble(key: String): Double? {
    if (!contains(key) || raw(key) == null) return null
    val value = raw(key)
    val number = when (value) {
        is Byte -> value.toDouble()
        is Short -> value.toDouble()
        is Int -> value.toDouble()
        is Long -> value.toDouble()
        is Float -> value.toDouble()
        is Double -> value
        is BigInteger -> value.toDouble()
        is BigDecimal -> value.toDouble()
        else -> throw StrictYamlException("$key must be a number")
    }
    if (!number.isFinite()) throw StrictYamlException("$key must be finite")
    return number
}

private fun YamlObject.requiredDouble(key: String): Double =
    optionalDouble(key) ?: throw StrictYamlException("Missing required numeric key $key")

private fun YamlObject.requiredStringList(key: String, source: Path, path: String): List<String> =
    requiredList(key).mapIndexed { index, value ->
        value as? String ?: throw StrictYamlException("$path[$index] in $source must be a string")
    }

private fun YamlObject.optionalStringList(key: String, source: Path, path: String): List<String> =
    optionalList(key)?.mapIndexed { index, value ->
        value as? String ?: throw StrictYamlException("$path[$index] in $source must be a string")
    }.orEmpty()

private fun objectNode(value: Any?, source: Path, path: String): YamlObject =
    objectNode(value, source.toString(), path)

private fun objectNode(value: Any?, source: String, path: String): YamlObject {
    if (value !is Map<*, *>) throw StrictYamlException("$path in $source must be a mapping")
    @Suppress("UNCHECKED_CAST")
    return YamlObject.root(value as Map<String, Any?>, "$source $path")
}

private fun requirePositive(value: Int, source: Path, path: String) {
    if (value <= 0) throw StrictYamlException("$path in $source must be positive")
}

private fun requireNonNegative(value: Int, source: Path, path: String) {
    if (value < 0) throw StrictYamlException("$path in $source must not be negative")
}

private fun parseBounds(node: YamlObject, source: Path, path: String): VisualBoundsSource {
    node.rejectUnknown("left", "right", "top", "bottom")
    return VisualBoundsSource(
        left = node.requiredDouble("left"),
        right = node.requiredDouble("right"),
        top = node.requiredDouble("top"),
        bottom = node.requiredDouble("bottom"),
    )
}

private fun parseCodePoint(value: String, source: Path, path: String): Int {
    if (!value.matches(Regex("U\\+[0-9A-Fa-f]{4,6}"))) {
        throw StrictYamlException("Invalid Unicode codepoint $value at $path in $source")
    }
    val codePoint = value.substring(2).toInt(16)
    if (!Character.isValidCodePoint(codePoint) || codePoint in 0xD800..0xDFFF) {
        throw StrictYamlException("Invalid Unicode scalar $value at $path in $source")
    }
    return codePoint
}

private fun parseUuid(value: String, source: Path, path: String): UUID = try {
    UUID.fromString(value)
} catch (exception: IllegalArgumentException) {
    throw StrictYamlException("Invalid UUID at $path in $source", exception)
}

/** Normalizes source metric modes into stable namespaced artifact revisions. */
private fun normalizeMetricsRevision(fontId: String, metrics: String): String {
    val font = ItemKey.parse(fontId)
    return when (metrics) {
        "explicit" -> "itemerness:explicit/${font.namespace}/${font.value}"
        "space-provider" -> "itemerness:space-provider/${font.namespace}/${font.value}"
        else -> ItemKey.parse(metrics).toString()
    }
}

private fun parseFactDefault(type: ViewerFactType, value: Any?, source: Path, path: String): ItemDataValue =
    when (type) {
        ViewerFactType.LOCALE, ViewerFactType.STRING -> StringDataValue(
            value as? String ?: throw StrictYamlException("$path in $source must be a string"),
        )
        ViewerFactType.BOOLEAN -> BooleanDataValue(
            value as? Boolean ?: throw StrictYamlException("$path in $source must be a boolean"),
        )
        ViewerFactType.INTEGER -> IntegerDataValue(integerValue(value, source.toString(), path))
        ViewerFactType.LONG -> LongDataValue(longValue(value, source.toString(), path))
        ViewerFactType.DECIMAL -> DecimalDataValue(decimalValue(value, source.toString(), path))
        ViewerFactType.UUID -> UuidDataValue(
            parseUuid(value as? String ?: throw StrictYamlException("$path in $source must be a UUID string"), source, path),
        )
        ViewerFactType.NAMESPACED_KEY -> NamespacedKeyDataValue(
            ItemKey.parse(value as? String ?: throw StrictYamlException("$path in $source must be a namespaced key")),
        )
    }

private fun parseGenericDataValue(value: Any?, source: String, path: String): ItemDataValue = when (value) {
    is Boolean -> BooleanDataValue(value)
    is Byte -> IntegerDataValue(value.toInt())
    is Short -> IntegerDataValue(value.toInt())
    is Int -> IntegerDataValue(value)
    is Long -> if (value in Int.MIN_VALUE.toLong()..Int.MAX_VALUE.toLong()) IntegerDataValue(value.toInt()) else LongDataValue(value)
    is BigInteger -> if (value.bitLength() <= 31) IntegerDataValue(value.toInt()) else LongDataValue(
        try {
            value.longValueExact()
        } catch (exception: ArithmeticException) {
            throw StrictYamlException("Integer literal at $path in $source exceeds signed 64-bit range", exception)
        },
    )
    is Float -> DecimalDataValue(value.toDouble())
    is Double -> DecimalDataValue(value)
    is BigDecimal -> DecimalDataValue(value.toDouble())
    is String -> StringDataValue(value)
    is List<*> -> ListDataValue(value.mapIndexed { index, child ->
        parseGenericDataValue(child, source, "$path[$index]")
    })
    is Map<*, *> -> CompoundDataValue(value.entries.associate { (key, child) ->
        val name = key as? String ?: throw StrictYamlException("Compound key at $path in $source must be a string")
        name to parseGenericDataValue(child, source, "$path.$name")
    })
    else -> throw StrictYamlException("Unsupported literal at $path in $source")
}

private fun integerValue(value: Any?, source: String, path: String): Int = when (value) {
    is Byte -> value.toInt()
    is Short -> value.toInt()
    is Int -> value
    is Long -> value.takeIf { it in Int.MIN_VALUE..Int.MAX_VALUE }?.toInt()
    is BigInteger -> try {
        value.intValueExact()
    } catch (_: ArithmeticException) {
        null
    }
    else -> null
} ?: throw StrictYamlException("$path in $source must be a 32-bit integer")

private fun longValue(value: Any?, source: String, path: String): Long = when (value) {
    is Byte -> value.toLong()
    is Short -> value.toLong()
    is Int -> value.toLong()
    is Long -> value
    is BigInteger -> try {
        value.longValueExact()
    } catch (_: ArithmeticException) {
        null
    }
    else -> null
} ?: throw StrictYamlException("$path in $source must be a signed 64-bit integer")

private fun decimalValue(value: Any?, source: String, path: String): Double {
    val decimal = when (value) {
        is Byte -> value.toDouble()
        is Short -> value.toDouble()
        is Int -> value.toDouble()
        is Long -> value.toDouble()
        is Float -> value.toDouble()
        is Double -> value
        is BigInteger -> value.toDouble()
        is BigDecimal -> value.toDouble()
        else -> throw StrictYamlException("$path in $source must be a decimal")
    }
    if (!decimal.isFinite()) throw StrictYamlException("$path in $source must be finite")
    return decimal
}
