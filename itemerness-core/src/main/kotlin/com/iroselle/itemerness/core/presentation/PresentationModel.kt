package com.iroselle.itemerness.core.presentation

import com.iroselle.itemerness.api.DataKey
import com.iroselle.itemerness.api.ItemDataValue
import com.iroselle.itemerness.api.ItemKey
import java.util.Collections
import java.util.TreeMap

data class PresentationTextStyle(
    val color: Int? = null,
    val font: ItemKey? = null,
    val bold: Boolean = false,
    val italic: Boolean = false,
    val underlined: Boolean = false,
    val strikethrough: Boolean = false,
)

enum class PresentationRunKind {
    TEXT,
    ICON,
    FRAME,
    BITMAP,
    SPACING,
    WIDTH_ANCHOR,
    HEIGHT_ANCHOR,
}

data class PresentationTextRun(
    val text: String,
    val style: PresentationTextStyle,
    val kind: PresentationRunKind = PresentationRunKind.TEXT,
    val unbreakable: Boolean = false,
) {
    init {
        require('\n' !in text && '\r' !in text) { "Presentation runs must not contain line separators" }
        require(text.length <= MAX_PRESENTATION_LINE_UTF16) { "Presentation run is too large" }
    }
}

/** Kept identical to projection-spi's per-line serialization limit. */
internal const val MAX_PRESENTATION_LINE_UTF16 = 8_192

data class PresentationVisualBounds(
    val left: Double,
    val right: Double,
    val top: Double,
    val bottom: Double,
) {
    init {
        require(listOf(left, right, top, bottom).all(Double::isFinite))
        require(right >= left)
        require(bottom >= top)
    }
}

class PresentationLine(
    runs: Collection<PresentationTextRun>,
    val logicalWidthPixels: Int,
    val visualBounds: PresentationVisualBounds,
) {
    val runs: List<PresentationTextRun> = java.util.List.copyOf(runs)

    init {
        require(logicalWidthPixels >= 0) { "Logical line width must not be negative" }
    }

    val plainText: String by lazy(LazyThreadSafetyMode.PUBLICATION) {
        buildString { this@PresentationLine.runs.forEach { append(it.text) } }
    }

    override fun equals(other: Any?): Boolean =
        this === other || other is PresentationLine &&
            runs == other.runs && logicalWidthPixels == other.logicalWidthPixels && visualBounds == other.visualBounds

    override fun hashCode(): Int {
        var result = runs.hashCode()
        result = 31 * result + logicalWidthPixels
        result = 31 * result + visualBounds.hashCode()
        return result
    }

    override fun toString(): String = "PresentationLine(runs=$runs, logicalWidthPixels=$logicalWidthPixels, visualBounds=$visualBounds)"
}

class PresentationDisplay(
    val displayName: PresentationLine,
    lore: Collection<PresentationLine>,
    val tooltipStyle: ItemKey?,
    val renderer: ThemeRenderer,
    val selectedTheme: ItemKey,
    val requestedTheme: ItemKey,
    val catalogRevision: Long,
    fallbackReasons: Collection<ThemeFallbackReason> = emptyList(),
) {
    val lore: List<PresentationLine> = java.util.List.copyOf(lore)
    val fallbackReasons: List<ThemeFallbackReason> = java.util.List.copyOf(fallbackReasons)

    override fun equals(other: Any?): Boolean =
        this === other || other is PresentationDisplay &&
            displayName == other.displayName && lore == other.lore && tooltipStyle == other.tooltipStyle &&
            renderer == other.renderer && selectedTheme == other.selectedTheme && requestedTheme == other.requestedTheme &&
            catalogRevision == other.catalogRevision && fallbackReasons == other.fallbackReasons

    override fun hashCode(): Int {
        var result = displayName.hashCode()
        result = 31 * result + lore.hashCode()
        result = 31 * result + (tooltipStyle?.hashCode() ?: 0)
        result = 31 * result + renderer.hashCode()
        result = 31 * result + selectedTheme.hashCode()
        result = 31 * result + requestedTheme.hashCode()
        result = 31 * result + catalogRevision.hashCode()
        result = 31 * result + fallbackReasons.hashCode()
        return result
    }
}

data class ThemeFallbackReason(
    val theme: ItemKey,
    val code: ThemeFallbackCode,
    val detail: String,
)

enum class ThemeFallbackCode {
    RESOURCE_PACK_UNAVAILABLE,
    CAPABILITY_MISSING,
    METRICS_MISMATCH,
    UNMANAGED_TOOLTIP_LINES,
    UNSUPPORTED_DIRECTION,
    MISSING_GLYPH,
    LAYOUT_OVERFLOW,
    OUTPUT_BUDGET_EXCEEDED,
    RENDER_FAILURE,
}

enum class TextDirection {
    LEFT_TO_RIGHT,
    RIGHT_TO_LEFT,
    COMPLEX,
}

class PresentationViewer(
    val locale: String,
    val requestedTheme: ItemKey? = null,
    val assetProfile: ItemKey? = null,
    capabilities: Collection<ItemKey> = emptyList(),
    val metricsRevision: ItemKey? = null,
    facts: Map<ItemKey, ItemDataValue> = emptyMap(),
    val factRevision: Long = 0,
    val resourcePackLoaded: Boolean = false,
    val managesVanillaTooltipLines: Boolean = false,
    val direction: TextDirection = TextDirection.LEFT_TO_RIGHT,
) {
    init {
        require(factRevision >= 0) { "Viewer fact revision must not be negative" }
    }

    val capabilities: Set<ItemKey> = Collections.unmodifiableSet(java.util.TreeSet(capabilities))
    val facts: Map<ItemKey, ItemDataValue> = immutableDataMap(facts)
}

class PresentationRenderRequest(
    val itemKey: ItemKey,
    data: Map<DataKey, ItemDataValue>,
    val viewer: PresentationViewer,
    nestedItems: Collection<NestedItemPresentation> = emptyList(),
) {
    val data: Map<DataKey, ItemDataValue> = immutableDataMap(data)
    val nestedItems: List<NestedItemPresentation> = java.util.List.copyOf(nestedItems)
}

data class NestedItemPresentation(
    val itemKey: ItemKey,
    val displayName: String,
    val amount: Int = 1,
) {
    init {
        require(amount > 0) { "Nested item amount must be positive" }
        require(displayName.codePointCount(0, displayName.length) <= 1024) { "Nested item name is too large" }
    }
}

sealed interface PresentationRenderResult {
    data class Rendered(val display: PresentationDisplay) : PresentationRenderResult

    data class Rejected(val failure: PresentationRenderFailure) : PresentationRenderResult
}

data class PresentationRenderFailure(
    val code: PresentationRenderFailureCode,
    val message: String,
)

enum class PresentationRenderFailureCode {
    UNKNOWN_ITEM,
    MISSING_DATA,
    MISSING_MESSAGE,
    NO_SAFE_THEME,
    OUTPUT_BUDGET_EXCEEDED,
    INVALID_RUNTIME_VALUE,
}

private fun <K : Comparable<K>, V> immutableDataMap(source: Map<K, V>): Map<K, V> {
    val sorted = TreeMap<K, V>()
    sorted.putAll(source)
    return Collections.unmodifiableMap(sorted)
}
