package com.iroselle.itemerness.core.presentation

import com.iroselle.itemerness.api.DataKey
import com.iroselle.itemerness.api.ItemDataValue
import com.iroselle.itemerness.api.ItemKey
import java.util.Collections
import java.util.TreeMap
import java.util.UUID

data class PresentationDiagnostic(
    val code: PresentationDiagnosticCode,
    val path: String,
    val message: String,
)

enum class PresentationDiagnosticCode {
    DUPLICATE_ID,
    INVALID_ID,
    INVALID_VALUE,
    MISSING_REFERENCE,
    REFERENCE_CYCLE,
    MISSING_MESSAGE,
    BUDGET_EXCEEDED,
}

data class PresentationBudgets(
    val maximumWidthPixels: Int = 220,
    val maximumHeightPixels: Int = 180,
    val maximumLines: Int = 64,
    val maximumRuns: Int = 512,
    val maximumTextCodePoints: Int = 16_384,
    val maximumBlocksPerItem: Int = 128,
    val maximumBlockDepth: Int = 16,
    val maximumRepeatElements: Int = 64,
    val maximumCanvasLayers: Int = 64,
    val maximumEmittedGlyphs: Int = 1_024,
) {
    init {
        require(maximumWidthPixels in 1..4096)
        require(maximumHeightPixels in 1..4096)
        require(maximumLines in 1..256)
        require(maximumRuns in 1..4096)
        require(maximumTextCodePoints in 1..131_072)
        require(maximumBlocksPerItem in 1..4096)
        require(maximumBlockDepth in 1..64)
        require(maximumRepeatElements in 1..4096)
        require(maximumCanvasLayers in 1..1024)
        require(maximumEmittedGlyphs in 1..65_536)
    }
}

class PresentationCompilation internal constructor(
    val catalog: PresentationCatalogSnapshot?,
    diagnostics: Collection<PresentationDiagnostic>,
) {
    val diagnostics: List<PresentationDiagnostic> = java.util.List.copyOf(diagnostics)
    val successful: Boolean get() = catalog != null
}

class PresentationCatalogSnapshot internal constructor(
    val revision: Long,
    val defaultLocale: String,
    val budgets: PresentationBudgets,
    formats: Map<ItemKey, FormatSource>,
    locales: Map<String, LocaleSource>,
    fonts: Map<ItemKey, CompiledFont>,
    glyphs: Map<String, CompiledGlyph>,
    bitmaps: Map<String, BitmapSource>,
    assetProfiles: Map<ItemKey, CompiledAssetProfile>,
    viewerFacts: Map<ItemKey, ViewerFactDefinition>,
    resourcePackBindings: Map<ItemKey, ResourcePackBinding>,
    layouts: Map<ItemKey, CompiledLayout>,
    themes: Map<ItemKey, CompiledTheme>,
    items: Map<ItemKey, CompiledItemPresentation>,
    validationItems: Map<ItemKey, CompiledItemPresentation>,
    val spacing: CompiledSpacing?,
    tooltipStyles: Set<ItemKey>,
    themeSelectors: Map<ItemKey, CompiledThemeSelector> = emptyMap(),
) {
    init {
        require(revision >= 0) { "Presentation catalog revision must not be negative" }
    }

    val formats: Map<ItemKey, FormatSource> = immutableSortedMap(formats)
    val locales: Map<String, LocaleSource> = immutableSortedMap(locales)
    val fonts: Map<ItemKey, CompiledFont> = immutableSortedMap(fonts)
    val glyphs: Map<String, CompiledGlyph> = immutableSortedMap(glyphs)
    val bitmaps: Map<String, BitmapSource> = immutableSortedMap(bitmaps)
    val assetProfiles: Map<ItemKey, CompiledAssetProfile> = immutableSortedMap(assetProfiles)
    val viewerFacts: Map<ItemKey, ViewerFactDefinition> = immutableSortedMap(viewerFacts)
    val resourcePackBindings: Map<ItemKey, ResourcePackBinding> = immutableSortedMap(resourcePackBindings)
    val layouts: Map<ItemKey, CompiledLayout> = immutableSortedMap(layouts)
    val themes: Map<ItemKey, CompiledTheme> = immutableSortedMap(themes)
    /** Data-driven theme choices; their ids never collide with [themes]. */
    val themeSelectors: Map<ItemKey, CompiledThemeSelector> = immutableSortedMap(themeSelectors)
    val items: Map<ItemKey, CompiledItemPresentation> = immutableSortedMap(items)
    /** Every compiled source presentation, including disabled items, used only before publication. */
    val validationItems: Map<ItemKey, CompiledItemPresentation> = immutableSortedMap(validationItems)
    val tooltipStyles: Set<ItemKey> = Collections.unmodifiableSet(java.util.TreeSet(tooltipStyles))

    fun withRevision(revision: Long): PresentationCatalogSnapshot = PresentationCatalogSnapshot(
        revision = revision,
        defaultLocale = defaultLocale,
        budgets = budgets,
        formats = formats,
        locales = locales,
        fonts = fonts,
        glyphs = glyphs,
        bitmaps = bitmaps,
        assetProfiles = assetProfiles,
        viewerFacts = viewerFacts,
        resourcePackBindings = resourcePackBindings,
        layouts = layouts,
        themes = themes,
        items = items,
        validationItems = validationItems,
        spacing = spacing,
        tooltipStyles = tooltipStyles,
        themeSelectors = themeSelectors,
    )
}

data class CompiledFont(
    val id: ItemKey,
    val metricsRevision: ItemKey,
    val glyphs: Map<Int, GlyphMetricSource>,
    val fallback: ItemKey?,
    val fallbackAdvancePixels: Double?,
    val boldExtraAdvancePixels: Double,
    val fallbackGlyph: GlyphMetricSource?,
)

data class CompiledGlyph(
    val id: String,
    val font: ItemKey,
    val codePoint: Int,
    val advancePixels: Double,
    val visualBounds: VisualBoundsSource,
    val bitmap: String?,
)

data class CompiledAssetProfile(
    val id: ItemKey,
    val capabilities: Set<ItemKey>,
    val metricsRevision: ItemKey?,
    val fallback: ItemKey?,
)

class ViewerFactDefinition(
    val id: ItemKey,
    val type: ViewerFactType,
    providers: Collection<String>,
    val defaultValue: ItemDataValue?,
    val nullable: Boolean,
    val cacheKey: Boolean,
) {
    val providers: List<String> = java.util.List.copyOf(providers)
}

data class ResourcePackBinding(
    val id: ItemKey,
    val enabled: Boolean,
    val packId: UUID?,
    val sha1: String?,
    val assetProfile: ItemKey,
    val delivery: ResourcePackDelivery = ResourcePackDelivery.VERIFIED,
)

sealed interface CompiledLayout {
    val id: ItemKey
    val source: LayoutSource

    data class Flow(
        override val id: ItemKey,
        override val source: LayoutSource.Flow,
    ) : CompiledLayout

    data class Canvas(
        override val id: ItemKey,
        override val source: LayoutSource.Canvas,
    ) : CompiledLayout
}

data class CompiledTheme(
    val id: ItemKey,
    val source: ThemeSource,
    val fallback: ItemKey?,
    val requiredCapabilities: Set<ItemKey>,
    val fonts: Map<String, ItemKey>,
    val tooltipStyle: ItemKey?,
)

class CompiledThemeSelector(
    val id: ItemKey,
    cases: Collection<CompiledThemeSelectorCase>,
    val defaultTheme: ItemKey,
) {
    val cases: List<CompiledThemeSelectorCase> = java.util.List.copyOf(cases)

    /** Every concrete theme this selector can choose, in evaluation order. */
    val reachableThemes: Set<ItemKey>
        get() = (cases.map(CompiledThemeSelectorCase::theme) + defaultTheme).toCollection(LinkedHashSet())
}

data class CompiledThemeSelectorCase(
    val condition: CompiledCondition,
    val theme: ItemKey,
)

class CompiledItemPresentation internal constructor(
    val key: ItemKey,
    val enabled: Boolean,
    val layout: ItemKey,
    val theme: ItemKey,
    val nameMessage: String,
    blocks: Collection<CompiledPresentationBlock>,
    shownFlags: Collection<ItemKey> = emptyList(),
    /** The implicit root group's marker; NONE keeps undecorated top-level blocks. */
    val marker: GroupMarker = GroupMarker.NONE,
    /** The implicit root group's dividers; BETWEEN_CHILDREN is the pre-group behaviour. */
    val dividers: GroupDividers = GroupDividers.BETWEEN_CHILDREN,
    nameBefore: Collection<CompiledFragment> = emptyList(),
    nameAfter: Collection<CompiledFragment> = emptyList(),
    /** The effective strategy: the item's own, otherwise its layout's. */
    val overflow: OverflowStrategy = OverflowStrategy.FALLBACK,
) {
    val blocks: List<CompiledPresentationBlock> = java.util.List.copyOf(blocks)
    val nameBefore: List<CompiledFragment> = java.util.List.copyOf(nameBefore)
    val nameAfter: List<CompiledFragment> = java.util.List.copyOf(nameAfter)

    /** Whether any block declares a summary, so rendering needs a summary-collecting pass. */
    val hasSummaries: Boolean = blocks.any(CompiledPresentationBlock::declaresSummary)

    /** Data component ids whose vanilla tooltip lines this item keeps visible. */
    val shownFlags: Set<ItemKey> = java.util.Collections.unmodifiableSet(java.util.TreeSet(shownFlags))
}

sealed interface CompiledPresentationBlock {
    val style: String?
    val anchor: String?
    val weight: HidingWeight? get() = null
    val summary: CompiledSummary? get() = null

    data class Text(
        val data: DataKey,
        override val style: String?,
        override val anchor: String?,
        val wrapping: String?,
        val unbreakable: Boolean,
        val missingPolicy: MissingDataPolicy,
        override val weight: HidingWeight? = null,
        override val summary: CompiledSummary? = null,
    ) : CompiledPresentationBlock

    data class Field(
        val labelMessage: String,
        val data: DataKey,
        val format: ItemKey?,
        val icon: String?,
        override val style: String?,
        override val anchor: String?,
        val wrapping: String?,
        val missingPolicy: MissingDataPolicy,
        val separator: FieldSeparatorSource? = null,
        val partStyles: FieldPartStyles? = null,
        override val weight: HidingWeight? = null,
        override val summary: CompiledSummary? = null,
    ) : CompiledPresentationBlock

    data class Description(
        val message: String,
        override val style: String?,
        override val anchor: String?,
        val wrapping: String?,
        override val weight: HidingWeight? = null,
        override val summary: CompiledSummary? = null,
    ) : CompiledPresentationBlock

    class Conditional(
        val condition: CompiledCondition,
        thenBlocks: Collection<CompiledPresentationBlock>,
        otherwiseBlocks: Collection<CompiledPresentationBlock>,
        override val style: String?,
        override val anchor: String?,
        override val weight: HidingWeight? = null,
    ) : CompiledPresentationBlock {
        val thenBlocks: List<CompiledPresentationBlock> = java.util.List.copyOf(thenBlocks)
        val otherwiseBlocks: List<CompiledPresentationBlock> = java.util.List.copyOf(otherwiseBlocks)
    }

    data class Repeat(
        val data: DataKey,
        val maximumElements: Int,
        val template: CompiledCompoundFieldTemplate,
        override val style: String?,
        override val anchor: String?,
        val missingPolicy: MissingDataPolicy,
        override val weight: HidingWeight? = null,
        override val summary: CompiledSummary? = null,
    ) : CompiledPresentationBlock

    data class NestedItemList(
        override val style: String?,
        override val anchor: String?,
        override val weight: HidingWeight? = null,
        override val summary: CompiledSummary? = null,
    ) : CompiledPresentationBlock

    class Group(
        val header: CompiledPresentationBlock?,
        children: Collection<CompiledPresentationBlock>,
        val marker: GroupMarker,
        val dividers: GroupDividers,
        val whenHeaderMissing: GroupHeaderMissingPolicy,
        val whenEmpty: GroupEmptyPolicy,
        val gapBeforeLines: Int,
        override val style: String?,
        override val anchor: String?,
        override val weight: HidingWeight? = null,
    ) : CompiledPresentationBlock {
        val children: List<CompiledPresentationBlock> = java.util.List.copyOf(children)
    }

    class Row(
        left: Collection<CompiledFragment>,
        right: Collection<CompiledFragment>,
        override val style: String?,
        override val anchor: String?,
        val wrapping: String?,
        override val weight: HidingWeight? = null,
        override val summary: CompiledSummary? = null,
    ) : CompiledPresentationBlock {
        val left: List<CompiledFragment> = java.util.List.copyOf(left)
        val right: List<CompiledFragment> = java.util.List.copyOf(right)
    }

    class Rule(
        title: Collection<CompiledFragment>,
        override val style: String?,
        override val anchor: String?,
        override val weight: HidingWeight? = null,
        override val summary: CompiledSummary? = null,
    ) : CompiledPresentationBlock {
        val title: List<CompiledFragment> = java.util.List.copyOf(title)
    }
}

internal fun CompiledPresentationBlock.declaresSummary(): Boolean = summary != null || when (this) {
    is CompiledPresentationBlock.Conditional -> thenBlocks.any { it.declaresSummary() } || otherwiseBlocks.any { it.declaresSummary() }
    is CompiledPresentationBlock.Group -> header?.declaresSummary() == true || children.any { it.declaresSummary() }
    else -> false
}

sealed interface CompiledFragment {
    val style: String?
    val condition: CompiledCondition?

    data class Message(val message: String, override val style: String?, override val condition: CompiledCondition?) : CompiledFragment

    data class Data(val data: DataKey, val format: ItemKey?, override val style: String?, override val condition: CompiledCondition?) : CompiledFragment

    data class Glyph(val glyph: String, override val style: String?, override val condition: CompiledCondition?) : CompiledFragment

    data class Literal(val text: String, override val style: String?, override val condition: CompiledCondition?) : CompiledFragment

    data class Slot(
        val id: String,
        val prefix: CompiledFragment?,
        val suffix: CompiledFragment?,
        val separator: CompiledFragment?,
        val maximumEntries: Int?,
        val overflowCountMessage: String?,
        override val style: String?,
        override val condition: CompiledCondition?,
    ) : CompiledFragment
}

/** A compiled summary: a static [piece], or the repeat element value at [valuePath]. */
data class CompiledSummary(
    val slot: String,
    val piece: CompiledFragment?,
    val valuePath: String?,
    val format: ItemKey?,
    val style: String?,
)

data class CompiledCompoundFieldTemplate(
    val labelMessage: String,
    val valuePath: String,
    val missingMessage: String,
    val icon: String?,
    val format: ItemKey?,
    val separator: FieldSeparatorSource? = null,
    val partStyles: FieldPartStyles? = null,
)

data class CompiledCondition(
    val operator: ConditionOperator,
    val left: CompiledValueReference,
    val right: CompiledValueReference?,
)

sealed interface CompiledValueReference {
    data class Data(val key: DataKey) : CompiledValueReference

    data class Fact(val key: ItemKey) : CompiledValueReference

    data class Literal(val value: ItemDataValue) : CompiledValueReference
}

data class CompiledSpacing(
    val font: ItemKey,
    val negative: SpacingRangeSource,
    val positive: SpacingRangeSource,
) {
    fun codePointFor(advance: Int): Int? {
        if (advance == 0) return null
        val range = if (advance < 0) negative else positive
        if (advance !in range.minimumAdvancePixels..range.maximumAdvancePixels) return null
        return range.firstCodePoint + (advance - range.minimumAdvancePixels)
    }
}

private fun <K : Comparable<K>, V> immutableSortedMap(source: Map<K, V>): Map<K, V> {
    val sorted = TreeMap<K, V>()
    sorted.putAll(source)
    return Collections.unmodifiableMap(sorted)
}
