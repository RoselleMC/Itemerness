package com.iroselle.itemerness.core.presentation

import com.iroselle.itemerness.api.ItemKey
import java.text.BreakIterator
import java.util.Locale
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min

internal data class SemanticRun(
    val text: String,
    val role: String,
    val kind: PresentationRunKind = PresentationRunKind.TEXT,
    val unbreakable: Boolean = false,
    val assetId: String? = null,
    val fieldValue: Boolean = false,
)

internal data class SemanticBlock(
    val runs: List<SemanticRun>,
    val anchor: String?,
    val wrapping: String?,
    val sectionBoundaryBefore: Boolean = false,
    val kind: SemanticBlockKind = SemanticBlockKind.GENERIC,
)

internal enum class SemanticBlockKind {
    GENERIC,
    FIELD,
    DESCRIPTION,
}

internal data class StyledRun(
    val run: PresentationTextRun,
    val role: String,
    val assetId: String? = null,
    val fieldValue: Boolean = false,
)

internal class PixelMeasurer(private val catalog: PresentationCatalogSnapshot) {
    private val glyphsByFontAndCodePoint = catalog.glyphs.values.associateBy { it.font to it.codePoint }

    fun measure(runs: Collection<PresentationTextRun>): PresentationLine {
        var cursor = 0.0
        var minimumX = 0.0
        var maximumX = 0.0
        var minimumY = 0.0
        var maximumY = 0.0
        var hasInk = false
        runs.forEach { run ->
            val runStart = cursor
            var offset = 0
            while (offset < run.text.length) {
                val codePoint = run.text.codePointAt(offset)
                val metric = metric(run.style.font, codePoint, run.kind)
                if (metric.hasInk) {
                    val italicLeft = if (run.style.italic) {
                        min(italicShear(metric.bounds.top), italicShear(metric.bounds.bottom))
                    } else {
                        0.0
                    }
                    val italicRight = if (run.style.italic) {
                        max(italicShear(metric.bounds.top), italicShear(metric.bounds.bottom))
                    } else {
                        0.0
                    }
                    val boldThickness = if (run.style.bold) BOLD_RENDER_THICKNESS_PIXELS else 0.0
                    val boldCopyOffset = if (run.style.bold) metric.boldExtra else 0.0
                    minimumX = min(minimumX, cursor + metric.bounds.left + italicLeft - boldThickness)
                    maximumX = max(
                        maximumX,
                        cursor + metric.bounds.right + italicRight + boldCopyOffset + boldThickness,
                    )
                    minimumY = min(minimumY, metric.bounds.top - boldThickness)
                    maximumY = max(maximumY, metric.bounds.bottom + boldThickness)
                    hasInk = true
                }
                cursor += metric.advance + if (run.style.bold) metric.boldExtra else 0.0
                offset += Character.charCount(codePoint)
            }
            if (cursor > runStart && (run.style.underlined || run.style.strikethrough)) {
                minimumX = min(minimumX, runStart - EFFECT_LEADING_OVERHANG_PIXELS)
                maximumX = max(maximumX, cursor)
                if (run.style.strikethrough) {
                    minimumY = min(minimumY, STRIKETHROUGH_TOP_PIXELS)
                    maximumY = max(maximumY, STRIKETHROUGH_BOTTOM_PIXELS)
                }
                if (run.style.underlined) {
                    minimumY = min(minimumY, UNDERLINE_TOP_PIXELS)
                    maximumY = max(maximumY, UNDERLINE_BOTTOM_PIXELS)
                }
                hasInk = true
            }
        }
        if (cursor < 0) throw TextLayoutException(ThemeFallbackCode.LAYOUT_OVERFLOW, "A line has negative final advance")
        return PresentationLine(
            runs,
            ceil(cursor).toInt(),
            if (hasInk) {
                PresentationVisualBounds(minimumX, maximumX, minimumY, maximumY)
            } else {
                PresentationVisualBounds(0.0, max(0.0, cursor), 0.0, 0.0)
            },
        )
    }

    fun width(run: PresentationTextRun): Double = measure(listOf(run)).logicalWidthPixels.toDouble()

    private fun metric(fontId: ItemKey?, codePoint: Int, kind: PresentationRunKind): Metric {
        if (kind == PresentationRunKind.SPACING || kind == PresentationRunKind.WIDTH_ANCHOR) {
            spacingAdvance(codePoint)?.let {
                return Metric(it.toDouble(), VisualBoundsSource(0.0, 0.0, 0.0, 0.0), 0.0, false)
            }
        }
        if (fontId != null) {
            glyphsByFontAndCodePoint[fontId to codePoint]?.let {
                return Metric(it.advancePixels, it.visualBounds, 0.0, true)
            }
        }
        val visited = HashSet<ItemKey>()
        var current = fontId
        while (current != null && visited.add(current)) {
            val font = catalog.fonts[current] ?: break
            font.glyphs[codePoint]?.let {
                return Metric(
                    it.advancePixels,
                    it.visualBounds,
                    it.boldExtraAdvancePixels ?: font.boldExtraAdvancePixels,
                    it.hasInk,
                )
            }
            if (font.fallback != null) {
                current = font.fallback
                continue
            }
            font.fallbackGlyph?.let {
                return Metric(
                    it.advancePixels,
                    it.visualBounds,
                    it.boldExtraAdvancePixels ?: font.boldExtraAdvancePixels,
                    it.hasInk,
                )
            }
            font.fallbackAdvancePixels?.let {
                val ink = codePoint != ' '.code && !Character.isWhitespace(codePoint)
                return Metric(
                    it,
                    if (ink) VisualBoundsSource(0.0, max(0.0, it - 1.0), -8.0, 1.0) else VisualBoundsSource(0.0, 0.0, 0.0, 0.0),
                    font.boldExtraAdvancePixels,
                    ink,
                )
            }
            current = null
        }
        throw TextLayoutException(ThemeFallbackCode.MISSING_GLYPH, "No metric for U+${codePoint.toString(16).uppercase()} in font $fontId")
    }

    private fun spacingAdvance(codePoint: Int): Int? {
        val spacing = catalog.spacing ?: return null
        for (advance in spacing.negative.minimumAdvancePixels..spacing.negative.maximumAdvancePixels) {
            if (spacing.codePointFor(advance) == codePoint) return advance
        }
        for (advance in spacing.positive.minimumAdvancePixels..spacing.positive.maximumAdvancePixels) {
            if (spacing.codePointFor(advance) == codePoint) return advance
        }
        return null
    }

    private data class Metric(
        val advance: Double,
        val bounds: VisualBoundsSource,
        val boldExtra: Double,
        val hasInk: Boolean,
    )

    private companion object {
        // Client geometry audited for 1.21.11, 26.1.1, 26.1.2, and 26.2. Logical advance remains
        // a GlyphInfo concern; these constants account only for pixels emitted by style decoration.
        const val BOLD_RENDER_THICKNESS_PIXELS = 0.1
        const val EFFECT_LEADING_OVERHANG_PIXELS = 1.0
        const val STRIKETHROUGH_TOP_PIXELS = 3.5
        const val STRIKETHROUGH_BOTTOM_PIXELS = 4.5
        const val UNDERLINE_TOP_PIXELS = 8.0
        const val UNDERLINE_BOTTOM_PIXELS = 9.0

        fun italicShear(y: Double): Double = 1.0 - 0.25 * y
    }
}

internal class PixelTextLayouter(
    private val measurer: PixelMeasurer,
) {
    fun wrap(
        runs: Collection<PresentationTextRun>,
        widthPixels: Int,
        maximumLines: Int,
        overflow: OverflowPolicy,
        preserveExplicitLines: Boolean = true,
        continuationIndentPixels: Int = 0,
    ): List<PresentationLine> {
        require(widthPixels > 0)
        require(maximumLines > 0)
        require(continuationIndentPixels in 0 until widthPixels)
        val atoms = atomize(runs, preserveExplicitLines)
        if (atoms.isEmpty()) return emptyList()
        val output = ArrayList<PresentationLine>()
        var remaining = atoms
        while (remaining.isNotEmpty()) {
            val activeWidth = widthPixels - if (output.isEmpty()) 0 else continuationIndentPixels
            if (output.size == maximumLines) {
                when (overflow) {
                    OverflowPolicy.ERROR -> throw TextLayoutException(ThemeFallbackCode.LAYOUT_OVERFLOW, "Text exceeds $maximumLines lines")
                    OverflowPolicy.ALLOW_OVERFLOW -> Unit
                    OverflowPolicy.ELLIPSIS -> {
                        if (output.isEmpty()) {
                            output += ellipsize(emptyList(), remaining.first().run.style, activeWidth)
                        } else {
                            output[output.lastIndex] = ellipsize(
                                atomize(output.last().runs, preserveExplicitLines = false).filterNot(Atom::mandatoryBreak),
                                output.last().runs.lastOrNull()?.style ?: remaining.first().run.style,
                                activeWidth,
                            )
                        }
                        return output
                    }
                }
            }

            val forced = remaining.indexOfFirst(Atom::mandatoryBreak)
            val paragraphEnd = if (forced < 0) remaining.size else forced
            if (paragraphEnd == 0) {
                output += measurer.measure(emptyList())
                remaining = remaining.drop(1)
                continue
            }
            val paragraph = remaining.subList(0, paragraphEnd)
            val split = fitLine(paragraph, activeWidth, overflow)
            val fittedAtoms = trimTrailingWhitespace(paragraph.subList(0, split))
            val fittedRuns = mergeAtoms(fittedAtoms)
            val fittedLine = measurer.measure(fittedRuns)
            output += if (fittedLine.logicalWidthPixels > activeWidth && overflow == OverflowPolicy.ELLIPSIS) {
                ellipsize(fittedAtoms, fittedRuns.lastOrNull()?.style ?: paragraph.first().run.style, activeWidth)
            } else {
                fittedLine
            }
            var consumed = split
            while (consumed < paragraph.size && paragraph[consumed].whitespace) consumed++
            remaining = when {
                consumed < paragraph.size -> paragraph.drop(consumed) + remaining.drop(paragraphEnd)
                forced >= 0 -> remaining.drop(paragraphEnd + 1)
                else -> emptyList()
            }
        }
        if (output.size > maximumLines && overflow != OverflowPolicy.ALLOW_OVERFLOW) {
            throw TextLayoutException(ThemeFallbackCode.LAYOUT_OVERFLOW, "Text exceeds $maximumLines lines")
        }
        return output
    }

    fun ellipsizeLine(
        runs: Collection<PresentationTextRun>,
        widthPixels: Int,
    ): PresentationLine {
        val atoms = atomize(runs, false).filterNot(Atom::mandatoryBreak)
        if (measurer.measure(runs).logicalWidthPixels <= widthPixels) return measurer.measure(runs)
        return ellipsize(atoms, runs.lastOrNull()?.style ?: PresentationTextStyle(), widthPixels)
    }

    private fun fitLine(atoms: List<Atom>, widthPixels: Int, overflow: OverflowPolicy): Int {
        var lastBreak = -1
        var index = 0
        while (index < atoms.size) {
            val candidate = trimTrailingWhitespace(atoms.subList(0, index + 1))
            if (measurer.measure(mergeAtoms(candidate)).logicalWidthPixels <= widthPixels) {
                if (legalBreakAfter(atoms, index)) lastBreak = index + 1
                index++
                continue
            }
            if (index == 0) {
                return when (overflow) {
                    OverflowPolicy.ERROR -> throw TextLayoutException(ThemeFallbackCode.LAYOUT_OVERFLOW, "An atomic token exceeds $widthPixels pixels")
                    OverflowPolicy.ELLIPSIS -> 1
                    OverflowPolicy.ALLOW_OVERFLOW -> 1
                }
            }
            return if (lastBreak > 0) lastBreak else index
        }
        return atoms.size
    }

    private fun ellipsize(atoms: List<Atom>, style: PresentationTextStyle, widthPixels: Int): PresentationLine {
        val ellipsis = PresentationTextRun("…", style, PresentationRunKind.TEXT, unbreakable = true)
        if (measurer.measure(listOf(ellipsis)).logicalWidthPixels > widthPixels) {
            return measurer.measure(emptyList())
        }
        val retained = atoms.toMutableList()
        while (retained.isNotEmpty()) {
            val runs = mergeAtoms(trimTrailingWhitespace(retained)) + ellipsis
            if (measurer.measure(runs).logicalWidthPixels <= widthPixels) return measurer.measure(runs)
            retained.removeLast()
        }
        return measurer.measure(listOf(ellipsis))
    }

    private fun atomize(
        runs: Collection<PresentationTextRun>,
        preserveExplicitLines: Boolean,
    ): List<Atom> {
        val result = ArrayList<Atom>()
        runs.forEach { run ->
            if (run.unbreakable || run.kind != PresentationRunKind.TEXT) {
                result += Atom(run, whitespace = false, mandatoryBreak = false, firstCodePoint = run.text.codePointAtOrNull(0), lastCodePoint = run.text.codePointBeforeOrNull(run.text.length))
                return@forEach
            }
            var segmentStart = 0
            var index = 0
            while (index <= run.text.length) {
                if (index == run.text.length || run.text[index] == '\n') {
                    if (index > segmentStart) splitGraphemes(run.copy(text = run.text.substring(segmentStart, index)), result)
                    if (index < run.text.length && preserveExplicitLines) result += Atom.mandatory(run.style)
                    segmentStart = index + 1
                }
                index++
            }
        }
        return result
    }

    private fun splitGraphemes(run: PresentationTextRun, output: MutableList<Atom>) {
        val iterator = BreakIterator.getCharacterInstance(Locale.ROOT)
        iterator.setText(run.text)
        var start = iterator.first()
        var end = iterator.next()
        while (end != BreakIterator.DONE) {
            var clusterEnd = end
            while (clusterEnd < run.text.length) {
                val nextCodePoint = run.text.codePointAt(clusterEnd)
                val previousCodePoint = run.text.codePointBefore(clusterEnd)
                if (previousCodePoint != ZERO_WIDTH_JOINER && nextCodePoint != ZERO_WIDTH_JOINER &&
                    nextCodePoint !in VARIATION_SELECTORS && Character.getType(nextCodePoint) !in COMBINING_TYPES
                ) break
                val following = iterator.next()
                if (following == BreakIterator.DONE) {
                    clusterEnd = run.text.length
                    break
                }
                clusterEnd = following
            }
            val text = run.text.substring(start, clusterEnd)
            val first = text.codePointAt(0)
            val last = text.codePointBefore(text.length)
            output += Atom(
                run.copy(text = text),
                whitespace = text.codePoints().allMatch(Character::isWhitespace),
                mandatoryBreak = false,
                firstCodePoint = first,
                lastCodePoint = last,
            )
            start = clusterEnd
            end = if (clusterEnd == end) iterator.next() else clusterEnd
        }
    }

    private fun legalBreakAfter(atoms: List<Atom>, index: Int): Boolean {
        val current = atoms[index]
        if (current.mandatoryBreak || current.whitespace) return true
        if (current.lastCodePoint == '-'.code || current.lastCodePoint == 0x2010) return true
        val next = atoms.getOrNull(index + 1) ?: return true
        val left = current.lastCodePoint ?: return false
        val right = next.firstCodePoint ?: return false
        return isCjk(left) && isCjk(right) && left !in OPENING_PUNCTUATION && right !in CLOSING_PUNCTUATION
    }

    private fun trimTrailingWhitespace(atoms: List<Atom>): List<Atom> {
        var end = atoms.size
        while (end > 0 && atoms[end - 1].whitespace) end--
        return atoms.subList(0, end)
    }

    private fun mergeAtoms(atoms: List<Atom>): List<PresentationTextRun> {
        if (atoms.isEmpty()) return emptyList()
        val output = ArrayList<PresentationTextRun>()
        atoms.forEach { atom ->
            if (atom.mandatoryBreak) return@forEach
            val previous = output.lastOrNull()
            val run = atom.run
            if (previous != null && previous.style == run.style && previous.kind == run.kind &&
                previous.unbreakable == run.unbreakable && previous.text.length + run.text.length <= MAX_PRESENTATION_LINE_UTF16
            ) {
                output[output.lastIndex] = previous.copy(text = previous.text + run.text)
            } else {
                output += run
            }
        }
        return output
    }

    private data class Atom(
        val run: PresentationTextRun,
        val whitespace: Boolean,
        val mandatoryBreak: Boolean,
        val firstCodePoint: Int?,
        val lastCodePoint: Int?,
    ) {
        companion object {
            fun mandatory(style: PresentationTextStyle): Atom = Atom(
                PresentationTextRun("", style),
                whitespace = false,
                mandatoryBreak = true,
                firstCodePoint = null,
                lastCodePoint = null,
            )
        }
    }

    private companion object {
        const val ZERO_WIDTH_JOINER = 0x200D
        val VARIATION_SELECTORS = 0xFE00..0xFE0F
        val COMBINING_TYPES = setOf(
            Character.NON_SPACING_MARK.toInt(),
            Character.COMBINING_SPACING_MARK.toInt(),
            Character.ENCLOSING_MARK.toInt(),
        )
        val OPENING_PUNCTUATION = setOf(
            '('.code, '['.code, '{'.code, 0x2018, 0x201C, 0x3008, 0x300A, 0x300C, 0x300E, 0x3010,
        )
        val CLOSING_PUNCTUATION = setOf(
            ')'.code, ']'.code, '}'.code, ','.code, '.'.code, '!'.code, '?'.code, 0x3001, 0x3002,
            0xFF0C, 0xFF01, 0xFF1F, 0x2019, 0x201D, 0x3009, 0x300B, 0x300D, 0x300F, 0x3011,
        )

        fun isCjk(codePoint: Int): Boolean =
            codePoint in 0x2E80..0x9FFF || codePoint in 0xF900..0xFAFF || codePoint in 0x20000..0x323AF
    }
}

internal class TextLayoutException(
    val fallbackCode: ThemeFallbackCode,
    override val message: String,
) : RuntimeException(message)

private fun String.codePointAtOrNull(index: Int): Int? = if (isEmpty()) null else codePointAt(index)

private fun String.codePointBeforeOrNull(index: Int): Int? = if (isEmpty()) null else codePointBefore(index)
