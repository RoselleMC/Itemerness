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
    themeSelectors: Collection<ThemeSelectorSource> = emptyList(),
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
    val themeSelectors: List<ThemeSelectorSource> = java.util.List.copyOf(themeSelectors)
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
    val delivery: ResourcePackDelivery = ResourcePackDelivery.VERIFIED,
)

/**
 * How a viewer is known to have a bound resource pack.
 *
 * [VERIFIED] activates the binding only after the client reports loading the exact pack. [ASSUMED] is an operator
 * declaration that every viewer has the pack because it is mandatory and delivered elsewhere, such as by a proxy.
 */
enum class ResourcePackDelivery {
    VERIFIED,
    ASSUMED,
}

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
        /** Default separator between field labels and values; null keeps the built-in colon. */
        val fieldSeparator: FieldSeparatorSource? = null,
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
    /** Marker art for decorated groups; absent pieces keep the built-in defaults. */
    val markers: MarkerThemeSource? = null,
) {
    val requiredCapabilities: Set<String> = immutableSet(requiredCapabilities)
    val fonts: Map<String, String> = immutableMap(fonts)
    val styles: Map<String, TextStyleSource> = immutableMap(styles)
}

/**
 * Theme art for group markers. [style] names the style role of marker runs and defaults to
 * "label". Every absent piece uses its built-in default, so themes without markers still render
 * decorated groups.
 */
data class MarkerThemeSource(
    val style: String? = null,
    val bullet: MarkerPieceSource? = null,
    val tree: TreeMarkerSource? = null,
)

data class TreeMarkerSource(
    val branch: MarkerPieceSource? = null,
    val last: MarkerPieceSource? = null,
    val vertical: MarkerPieceSource? = null,
)

/** One marker piece: literal text, or a resource-pack glyph like a field icon. */
sealed interface MarkerPieceSource {
    data class Text(val text: String) : MarkerPieceSource

    data class Glyph(val glyph: String) : MarkerPieceSource
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
    val center: String? = null,
    val kern: String? = null,
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
    val includeName: Boolean = false,
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

/**
 * A reusable, data-driven choice between concrete themes. Selector ids share the theme id space,
 * so an item or the settings default theme may reference either. The first case whose condition
 * holds wins; otherwise [defaultTheme] applies. Cases never reference another selector.
 */
class ThemeSelectorSource(
    val id: String,
    cases: Collection<ThemeSelectorCaseSource>,
    val defaultTheme: String,
) {
    val cases: List<ThemeSelectorCaseSource> = java.util.List.copyOf(cases)
}

data class ThemeSelectorCaseSource(
    val condition: ConditionSource,
    val theme: String,
)

class ItemPresentationSource(
    val id: String,
    val layout: String,
    val theme: String,
    val nameMessage: String,
    blocks: Collection<PresentationBlockSource>,
    val enabled: Boolean = true,
    /**
     * Data component ids whose vanilla tooltip lines stay visible. Every other vanilla tooltip
     * line is hidden. Kept as authored, in order and with duplicates, so the compiler can report
     * them.
     */
    shownFlags: Collection<String> = emptyList(),
    /** How the item's top-level blocks are decorated; the item root is the implicit root group. */
    val marker: GroupMarker = GroupMarker.NONE,
    /** Root dividers default to a section boundary between every rendered block, as before groups. */
    val dividers: GroupDividers = GroupDividers.BETWEEN_CHILDREN,
) {
    val blocks: List<PresentationBlockSource> = java.util.List.copyOf(blocks)
    val shownFlags: List<String> = java.util.List.copyOf(shownFlags)
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
        /** Overrides the layout separator; null inherits it. */
        val separator: FieldSeparatorSource? = null,
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

    /**
     * A recursive container with an optional single-row [header]. Its children are decorated by
     * [marker] and separated by [dividers]. [style] is accepted for block uniformity and, like a
     * conditional's, emits nothing because a group has no text of its own.
     */
    class Group(
        val header: PresentationBlockSource?,
        children: Collection<PresentationBlockSource>,
        val marker: GroupMarker = GroupMarker.NONE,
        val dividers: GroupDividers = GroupDividers.NONE,
        val whenHeaderMissing: GroupHeaderMissingPolicy = GroupHeaderMissingPolicy.HIDE,
        val whenEmpty: GroupEmptyPolicy = GroupEmptyPolicy.SHOW_HEADER,
        val gapBeforeLines: Int = 0,
        override val style: String? = null,
        override val anchor: String? = null,
    ) : PresentationBlockSource {
        val children: List<PresentationBlockSource> = java.util.List.copyOf(children)
    }
}

enum class GroupMarker {
    NONE,
    BULLET,
    TREE,
}

enum class GroupDividers {
    NONE,
    BETWEEN_CHILDREN,
}

enum class GroupHeaderMissingPolicy {
    HIDE,
    SHOW_CHILDREN,
}

enum class GroupEmptyPolicy {
    SHOW_HEADER,
    HIDE,
}

/** The run between a field label and its value. */
sealed interface FieldSeparatorSource {
    data object None : FieldSeparatorSource

    data class Message(val message: String) : FieldSeparatorSource
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
    /** Overrides the layout separator; null inherits it. */
    val separator: FieldSeparatorSource? = null,
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
