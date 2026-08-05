package com.iroselle.itemerness.projection

import com.iroselle.itemerness.api.ItemKey

data class RgbColor(
    val value: Int,
) {
    init {
        require(value in 0..0xFFFFFF) { "RGB color must be between 0x000000 and 0xFFFFFF" }
    }
}

data class TextDecorations(
    val bold: Boolean = false,
    val italic: Boolean = false,
    val underlined: Boolean = false,
    val strikethrough: Boolean = false,
    val obfuscated: Boolean = false,
)

data class RenderedTextRun(
    val text: String,
    val color: RgbColor? = null,
    val font: ItemKey? = null,
    val decorations: TextDecorations = TextDecorations(),
) {
    init {
        require('\n' !in text && '\r' !in text) {
            "Rendered text runs must not contain line separators"
        }
        require(text.length <= MAX_TEXT_LENGTH) {
            "Rendered text runs must not exceed $MAX_TEXT_LENGTH characters"
        }
    }

    companion object {
        private const val MAX_TEXT_LENGTH = 8_192
    }
}

/** A pre-rendered single tooltip line represented without platform component types. */
class RenderedText(runs: Collection<RenderedTextRun>) {
    val runs: List<RenderedTextRun> = java.util.List.copyOf(runs)

    init {
        require(this.runs.size <= MAX_RUNS) {
            "Rendered text must not exceed $MAX_RUNS runs"
        }
        require(this.runs.sumOf { run -> run.text.length } <= MAX_TEXT_LENGTH) {
            "Rendered text must not exceed $MAX_TEXT_LENGTH characters"
        }
    }

    override fun equals(other: Any?): Boolean =
        this === other || other is RenderedText && runs == other.runs

    override fun hashCode(): Int = runs.hashCode()

    override fun toString(): String = "RenderedText(runs=$runs)"

    companion object {
        private const val MAX_RUNS = 256
        private const val MAX_TEXT_LENGTH = 8_192

        @JvmStatic
        fun plain(text: String): RenderedText = RenderedText(listOf(RenderedTextRun(text)))
    }
}

/** Display-only components that an exact-version adapter may replace on an item copy. */
class RenderedDisplay(
    val displayName: RenderedText,
    lore: Collection<RenderedText> = emptyList(),
    val tooltipStyle: ItemKey? = null,
    val itemModel: ItemKey? = null,
) {
    val lore: List<RenderedText> = java.util.List.copyOf(lore)

    init {
        require(this.lore.size <= MAX_LORE_LINES) {
            "Rendered display must not exceed $MAX_LORE_LINES lore lines"
        }
        require(
            displayName.runs.size + this.lore.sumOf { line -> line.runs.size } <= MAX_TOTAL_RUNS,
        ) {
            "Rendered display must not exceed $MAX_TOTAL_RUNS text runs"
        }
        require(
            displayName.runs.sumOf { run -> run.text.length } +
                this.lore.sumOf { line -> line.runs.sumOf { run -> run.text.length } } <=
                MAX_TOTAL_TEXT_LENGTH,
        ) {
            "Rendered display must not exceed $MAX_TOTAL_TEXT_LENGTH characters"
        }
    }

    override fun equals(other: Any?): Boolean =
        this === other ||
            other is RenderedDisplay &&
            displayName == other.displayName &&
            lore == other.lore &&
            tooltipStyle == other.tooltipStyle &&
            itemModel == other.itemModel

    override fun hashCode(): Int {
        var result = displayName.hashCode()
        result = 31 * result + lore.hashCode()
        result = 31 * result + (tooltipStyle?.hashCode() ?: 0)
        result = 31 * result + (itemModel?.hashCode() ?: 0)
        return result
    }

    override fun toString(): String =
        "RenderedDisplay(displayName=$displayName, lore=$lore, tooltipStyle=$tooltipStyle, " +
            "itemModel=$itemModel)"

    private companion object {
        const val MAX_LORE_LINES = 256
        const val MAX_TOTAL_RUNS = 4_096
        const val MAX_TOTAL_TEXT_LENGTH = 131_072
    }
}
