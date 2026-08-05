package com.iroselle.itemerness.core.presentation

import com.iroselle.itemerness.api.ItemKey
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class TextLayoutTest {
    private val catalog = PresentationFixtures.compile()
    private val measurer = PixelMeasurer(catalog)
    private val layouter = PixelTextLayouter(measurer)
    private val style = PresentationTextStyle(font = ItemKey.parse("minecraft:default"))

    @Test
    fun `wraps English at spaces and CJK at legal grapheme boundaries`() {
        val english = layouter.wrap(
            listOf(PresentationTextRun("alpha beta gamma", style)),
            widthPixels = 38,
            maximumLines = 8,
            overflow = OverflowPolicy.ERROR,
        )
        val chinese = layouter.wrap(
            listOf(PresentationTextRun("记录地标、路线。", style)),
            widthPixels = 31,
            maximumLines = 8,
            overflow = OverflowPolicy.ERROR,
        )

        assertEquals(listOf("alpha", "beta", "gamma"), english.map(PresentationLine::plainText))
        assertTrue(chinese.size >= 3)
        assertTrue(chinese.none { it.plainText.startsWith("、") || it.plainText.startsWith("。") })
        assertEquals("记录地标、路线。", chinese.joinToString("") { it.plainText })
        assertTrue((english + chinese).all { it.logicalWidthPixels <= 38 })
    }

    @Test
    fun `keeps emoji joiner sequences intact`() {
        val family = "👩‍👩‍👧‍👦"
        val lines = layouter.wrap(
            listOf(PresentationTextRun("A$family B", style)),
            widthPixels = 200,
            maximumLines = 4,
            overflow = OverflowPolicy.ERROR,
        )

        assertEquals("A$family B", lines.single().plainText)
        assertEquals(1, lines.single().plainText.windowed(family.length).count { it == family })
    }

    @Test
    fun `ellipsizes an overwide unbreakable token at glyph boundaries`() {
        val lines = layouter.wrap(
            listOf(PresentationTextRun("https://example.invalid/a/very/long/path", style, unbreakable = true)),
            widthPixels = 24,
            maximumLines = 1,
            overflow = OverflowPolicy.ELLIPSIS,
        )

        assertEquals("…", lines.single().plainText)
        assertTrue(lines.single().logicalWidthPixels <= 24)
    }

    @Test
    fun `bold contributes per visible glyph while italic only affects style`() {
        val normal = measurer.measure(listOf(PresentationTextRun("Test", style)))
        val bold = measurer.measure(listOf(PresentationTextRun("Test", style.copy(bold = true))))
        val italic = measurer.measure(listOf(PresentationTextRun("Test", style.copy(italic = true))))

        assertEquals(normal.logicalWidthPixels + 4, bold.logicalWidthPixels)
        assertEquals(normal.logicalWidthPixels, italic.logicalWidthPixels)
    }

    @Test
    fun `maximum line budget cannot be bypassed with forced long input`() {
        val lines = layouter.wrap(
            listOf(PresentationTextRun("one two three four five six", style)),
            widthPixels = 25,
            maximumLines = 2,
            overflow = OverflowPolicy.ELLIPSIS,
        )

        assertEquals(2, lines.size)
        assertTrue(lines.last().plainText.endsWith("…"))
    }
}
