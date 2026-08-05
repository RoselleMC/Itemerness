package com.iroselle.itemerness.core.presentation

import com.iroselle.itemerness.api.ItemDataValue
import java.util.Collections
import java.util.UUID

/** Parser-independent input for the presentation compiler. */
class PresentationSource(
    formats: Collection<FormatSource>,
    locales: Collection<LocaleSource>,
    fonts: Collection<FontSource>,
    glyphs: Collection<GlyphSource>,
    bitmaps: Collection<BitmapSource>,
    assetProfiles: Collection<AssetProfileSource>,
    viewerFacts: Collection<ViewerFactSource> = emptyList(),
    resourcePackBindings: Collection<ResourcePackBindingSource> = emptyList(),
    layouts: Collection<LayoutSource>,
    themes: Collection<ThemeSource>,
    items: Collection<ItemPresentationSource>,
    val spacing: SpacingSource? = null,
    tooltipStyles: Collection<String> = emptyList(),
) {
    val formats: List<FormatSource> = java.util.List.copyOf(formats)
    val locales: List<LocaleSource> = java.util.List.copyOf(locales)
    val fonts: List<FontSource> = java.util.List.copyOf(fonts)
    val glyphs: List<GlyphSource> = java.util.List.copyOf(glyphs)
    val bitmaps: List<BitmapSource> = java.util.List.copyOf(bitmaps)
    val assetProfiles: List<AssetProfileSource> = java.util.List.copyOf(assetProfiles)
    val viewerFacts: List<ViewerFactSource> = java.util.List.copyOf(viewerFacts)
    val resourcePackBindings: List<ResourcePackBindingSource> = java.util.List.copyOf(resourcePackBindings)
    val layouts: List<LayoutSource> = java.util.List.copyOf(layouts)
    val themes: List<ThemeSource> = java.util.List.copyOf(themes)
    val items: List<ItemPresentationSource> = java.util.List.copyOf(items)
    val tooltipStyles: Set<String> = immutableSet(tooltipStyles)
}

sealed interface FormatSource {
    val id: String

    data class IntegerFormat(
        override val id: String,
        val pattern: String = "0",
    ) : FormatSource

    data class DecimalFormat(
        override val id: String,
        val pattern: String,
        val multiply: Double = 1.0,
        val suffixMessage: String? = null,
    ) : FormatSource

    data class BooleanFormat(
        override val id: String,
        val trueMessage: String,
        val falseMessage: String,
    ) : FormatSource

    data class NamespacedKeyFormat(
        override val id: String,
        val mode: NamespacedKeyFormatMode,
        val messagePattern: String? = null,
        val missingValue: MissingKeyValue = MissingKeyValue.PATH,
    ) : FormatSource

    class ListFormat(
        override val id: String,
        val elementFormat: String,
        val separatorMessage: String,
    ) : FormatSource
}

enum class NamespacedKeyFormatMode {
    PATH,
    MESSAGE,
}

enum class MissingKeyValue {
    PATH,
    FULL_KEY,
    ERROR,
}

class LocaleSource(
    val locale: String,
    val fallback: String? = null,
    messages: Map<String, String>,
) {
    val messages: Map<String, String> = immutableMap(messages)
}

class FontSource(
    val id: String,
    val metricsRevision: String,
    glyphs: Map<Int, GlyphMetricSource> = emptyMap(),
    val fallback: String? = null,
    val fallbackAdvancePixels: Double? = null,
    val boldExtraAdvancePixels: Double = 1.0,
    val fallbackGlyph: GlyphMetricSource? = null,
) {
    val glyphs: Map<Int, GlyphMetricSource> = immutableMap(glyphs)
}

data class GlyphMetricSource(
    val advancePixels: Double,
    val visualBounds: VisualBoundsSource = VisualBoundsSource(0.0, advancePixels, -8.0, 1.0),
    val boldExtraAdvancePixels: Double? = null,
    val hasInk: Boolean = true,
)

data class VisualBoundsSource(
    val left: Double,
    val right: Double,
    val top: Double,
    val bottom: Double,
)

data class GlyphSource(
    val id: String,
    val font: String,
    val codePoint: Int,
    val advancePixels: Double,
    val visualBounds: VisualBoundsSource,
    val bitmap: String? = null,
)

data class BitmapSource(
    val id: String,
    val baselineVariant: String? = null,
    val renderWidthPixels: Int,
    val renderHeightPixels: Int,
    val ascentPixels: Int,
    val visualBounds: VisualBoundsSource,
)

class AssetProfileSource(
    val id: String,
    capabilities: Collection<String>,
    val metricsRevision: String? = null,
    val fallback: String? = null,
) {
    val capabilities: Set<String> = immutableSet(capabilities)
}

enum class ViewerFactType {
    LOCALE,
    BOOLEAN,
    INTEGER,
    LONG,
    DECIMAL,
    STRING,
    UUID,
    NAMESPACED_KEY,
}

class ViewerFactSource(
    val id: String,
    val type: ViewerFactType,
    providers: Collection<String>,
    val defaultValue: ItemDataValue? = null,
    val nullable: Boolean = false,
    val cacheKey: Boolean = true,
) {
    val providers: List<String> = java.util.List.copyOf(providers)
}

data class ResourcePackBindingSource(
    val id: String,
    val enabled: Boolean,
    val packId: UUID? = null,
    val sha1: String? = null,
    val assetProfile: String,
)

data class SpacingRangeSource(
    val firstCodePoint: Int,
    val lastCodePoint: Int,
    val minimumAdvancePixels: Int,
    val maximumAdvancePixels: Int,
)

data class SpacingSource(
    val font: String,
    val negative: SpacingRangeSource,
    val positive: SpacingRangeSource,
)

sealed interface LayoutSource {
    val id: String

    class Flow(
        override val id: String,
        val minimumWidthPixels: Int,
        val maximumWidthPixels: Int,
        val blockGapAfterPixels: Int = 0,
        val fieldLeftPaddingPixels: Int = 0,
        val fieldIconGapPixels: Int = 0,
        val fieldValueAlignment: FieldValueAlignment = FieldValueAlignment.LEFT,
        val descriptionLeftPaddingPixels: Int = 0,
        val descriptionRightPaddingPixels: Int = 0,
        val descriptionGapBeforePixels: Int = 0,
        wrapping: Map<String, WrappingSource> = mapOf("body" to WrappingSource()),
    ) : LayoutSource {
        val wrapping: Map<String, WrappingSource> = immutableMap(wrapping)
    }

    class Canvas(
        override val id: String,
        val widthPixels: Int,
        val heightPixels: Int,
        val maximumWidthPixels: Int,
        val maximumHeightPixels: Int,
        val reserveTooltipLines: Int,
        anchors: Map<String, CanvasAnchorSource>,
        wrapping: Map<String, WrappingSource>,
    ) : LayoutSource {
        val anchors: Map<String, CanvasAnchorSource> = immutableMap(anchors)
        val wrapping: Map<String, WrappingSource> = immutableMap(wrapping)
    }
}

enum class FieldValueAlignment {
    LEFT,
    RIGHT,
}

data class WrappingSource(
    val widthPixels: Int? = null,
    val maximumLines: Int = 16,
    val overflow: OverflowPolicy = OverflowPolicy.ELLIPSIS,
    val preserveExplicitLines: Boolean = true,
    val continuationIndentPixels: Int = 0,
    val lineHeightPixels: Int = 10,
)

data class CanvasAnchorSource(
    val x: Int,
    val y: Int,
    val width: Int,
    val height: Int,
    val overflow: OverflowPolicy,
)

enum class OverflowPolicy {
    ERROR,
    ELLIPSIS,
    ALLOW_OVERFLOW,
}

enum class ThemeRenderer {
    PLAIN,
    VANILLA_CHARACTER_FRAME,
    NATIVE_TOOLTIP_STYLE,
    SEGMENTED_FRAME,
    BITMAP_CANVAS,
}

enum class VanillaTooltipLinePolicy {
    PRESERVE,
    PRESERVE_OUTSIDE_FRAME,
    REQUIRE_MANAGED,
}

class ThemeSource(
    val id: String,
    val renderer: ThemeRenderer,
    val requiresResourcePack: Boolean,
    requiredCapabilities: Collection<String> = emptyList(),
    val vanillaTooltipLines: VanillaTooltipLinePolicy,
    val fallback: String? = null,
    fonts: Map<String, String>,
    styles: Map<String, TextStyleSource> = emptyMap(),
    val tooltipStyle: String? = null,
    val content: ContentAreaSource? = null,
    val characterFrame: CharacterFrameSource? = null,
    val segmentedFrame: SegmentedFrameSource? = null,
    val canvas: CanvasThemeSource? = null,
    val requireExactFontMetrics: Boolean = false,
) {
    val requiredCapabilities: Set<String> = immutableSet(requiredCapabilities)
    val fonts: Map<String, String> = immutableMap(fonts)
    val styles: Map<String, TextStyleSource> = immutableMap(styles)
}

data class TextStyleSource(
    val color: String? = null,
    val bold: Boolean = false,
    val italic: Boolean = false,
    val underlined: Boolean = false,
    val strikethrough: Boolean = false,
)

data class ContentAreaSource(
    val minimumWidthPixels: Int,
    val maximumWidthPixels: Int,
    val leftPaddingPixels: Int = 0,
    val rightPaddingPixels: Int = 0,
)

enum class CharacterFramePreset {
    UNICODE_SINGLE,
    UNICODE_DOUBLE,
    ASCII_SAFE,
    BRACKETED_SECTION,
    SEPARATOR_ONLY,
}

data class CharacterFrameSource(
    val preset: CharacterFramePreset,
    val minimumWidthPixels: Int,
    val maximumWidthPixels: Int,
    val leftPaddingPixels: Int,
    val rightPaddingPixels: Int,
    val alignmentTolerancePixels: Int,
    val maximumLines: Int,
    val fallbackBidirectionalText: Boolean = true,
)

data class FrameRowSource(
    val left: String,
    val fill: String,
    val right: String,
)

data class SegmentedFrameSource(
    val minimumWidthPixels: Int,
    val maximumWidthPixels: Int,
    val leftPaddingPixels: Int,
    val rightPaddingPixels: Int,
    val top: FrameRowSource,
    val body: FrameRowSource,
    val connector: FrameRowSource? = null,
    val bottom: FrameRowSource,
)

data class CanvasLayerSource(
    val asset: String,
    val anchor: CanvasLayerAnchor = CanvasLayerAnchor.TOP_LEFT,
    val xPixels: Int,
    val baselineLine: Int,
    val baselineVariant: String,
    val drawOrder: Int,
)

enum class CanvasLayerAnchor {
    TOP_LEFT,
    TOP_RIGHT,
}

class CanvasThemeSource(
    val widthPixels: Int,
    val heightPixels: Int,
    val maximumWidthPixels: Int,
    val maximumHeightPixels: Int,
    val reserveTooltipLines: Int,
    layers: Collection<CanvasLayerSource>,
    val measuredAdvancePixels: Int,
    val finalTooltipWidthPixels: Int,
    val rejectNegativeFinalAdvance: Boolean = true,
    val rejectOutOfBoundsLayer: Boolean = true,
    val maximumEmittedComponents: Int = 256,
    val normalizeVisualOrigin: Boolean = true,
) {
    val layers: List<CanvasLayerSource> = java.util.List.copyOf(layers)
}

class ItemPresentationSource(
    val id: String,
    val layout: String,
    val theme: String,
    val nameMessage: String,
    blocks: Collection<PresentationBlockSource>,
    val enabled: Boolean = true,
) {
    val blocks: List<PresentationBlockSource> = java.util.List.copyOf(blocks)
}

sealed interface PresentationBlockSource {
    val style: String?
    val anchor: String?

    data class Text(
        val data: String,
        override val style: String? = null,
        override val anchor: String? = null,
        val wrapping: String? = null,
        val unbreakable: Boolean = false,
        val missingPolicy: MissingDataPolicy = MissingDataPolicy.ERROR,
    ) : PresentationBlockSource

    data class Field(
        val labelMessage: String,
        val data: String,
        val format: String? = null,
        val icon: String? = null,
        override val style: String? = null,
        override val anchor: String? = null,
        val wrapping: String? = null,
        val missingPolicy: MissingDataPolicy = MissingDataPolicy.ERROR,
    ) : PresentationBlockSource

    data class Description(
        val message: String,
        override val style: String? = "description",
        override val anchor: String? = null,
        val wrapping: String? = "body",
    ) : PresentationBlockSource

    class Conditional(
        val condition: ConditionSource,
        thenBlocks: Collection<PresentationBlockSource>,
        otherwiseBlocks: Collection<PresentationBlockSource> = emptyList(),
        override val style: String? = null,
        override val anchor: String? = null,
    ) : PresentationBlockSource {
        val thenBlocks: List<PresentationBlockSource> = java.util.List.copyOf(thenBlocks)
        val otherwiseBlocks: List<PresentationBlockSource> = java.util.List.copyOf(otherwiseBlocks)
    }

    data class Repeat(
        val data: String,
        val maximumElements: Int,
        val template: CompoundFieldTemplateSource,
        override val style: String? = null,
        override val anchor: String? = null,
        val missingPolicy: MissingDataPolicy = MissingDataPolicy.ERROR,
    ) : PresentationBlockSource

    data class NestedItemList(
        override val style: String? = null,
        override val anchor: String? = null,
    ) : PresentationBlockSource
}

enum class MissingDataPolicy {
    ERROR,
    OMIT,
}

data class CompoundFieldTemplateSource(
    val labelMessage: String,
    val valuePath: String,
    val missingMessage: String,
    val icon: String? = null,
    val format: String? = null,
)

enum class ConditionOperator {
    LESS_THAN,
    LESS_THAN_OR_EQUAL,
    GREATER_THAN,
    GREATER_THAN_OR_EQUAL,
    EQUALS,
    NOT_EQUALS,
    EXISTS,
}

data class ConditionSource(
    val operator: ConditionOperator,
    val left: ValueReferenceSource,
    val right: ValueReferenceSource? = null,
)

sealed interface ValueReferenceSource {
    data class Data(val key: String) : ValueReferenceSource

    data class Fact(val key: String) : ValueReferenceSource

    data class Literal(val value: ItemDataValue) : ValueReferenceSource
}

private fun <K, V> immutableMap(source: Map<K, V>): Map<K, V> =
    Collections.unmodifiableMap(LinkedHashMap(source))

private fun <T> immutableSet(source: Collection<T>): Set<T> =
    Collections.unmodifiableSet(LinkedHashSet(source))
