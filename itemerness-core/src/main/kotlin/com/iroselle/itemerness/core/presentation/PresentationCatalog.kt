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

class CompiledItemPresentation internal constructor(
    val key: ItemKey,
    val enabled: Boolean,
    val layout: ItemKey,
    val theme: ItemKey,
    val nameMessage: String,
    blocks: Collection<CompiledPresentationBlock>,
) {
    val blocks: List<CompiledPresentationBlock> = java.util.List.copyOf(blocks)
}

sealed interface CompiledPresentationBlock {
    val style: String?
    val anchor: String?

    data class Text(
        val data: DataKey,
        override val style: String?,
        override val anchor: String?,
        val wrapping: String?,
        val unbreakable: Boolean,
        val missingPolicy: MissingDataPolicy,
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
    ) : CompiledPresentationBlock

    data class Description(
        val message: String,
        override val style: String?,
        override val anchor: String?,
        val wrapping: String?,
    ) : CompiledPresentationBlock

    class Conditional(
        val condition: CompiledCondition,
        thenBlocks: Collection<CompiledPresentationBlock>,
        otherwiseBlocks: Collection<CompiledPresentationBlock>,
        override val style: String?,
        override val anchor: String?,
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
    ) : CompiledPresentationBlock

    data class NestedItemList(
        override val style: String?,
        override val anchor: String?,
    ) : CompiledPresentationBlock
}

data class CompiledCompoundFieldTemplate(
    val labelMessage: String,
    val valuePath: String,
    val missingMessage: String,
    val icon: String?,
    val format: ItemKey?,
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
