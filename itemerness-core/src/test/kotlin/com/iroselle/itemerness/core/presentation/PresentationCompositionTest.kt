package com.iroselle.itemerness.core.presentation

import com.iroselle.itemerness.api.IntegerDataValue
import com.iroselle.itemerness.api.ItemKey
import com.iroselle.itemerness.core.presentation.PresentationItemFixture.data
import com.iroselle.itemerness.core.presentation.PresentationItemFixture.diagnostics
import com.iroselle.itemerness.core.presentation.PresentationItemFixture.display
import com.iroselle.itemerness.core.presentation.PresentationItemFixture.field
import com.iroselle.itemerness.core.presentation.PresentationItemFixture.item
import com.iroselle.itemerness.core.presentation.PresentationItemFixture.packViewer
import com.iroselle.itemerness.core.presentation.PresentationItemFixture.render
import com.iroselle.itemerness.core.presentation.PresentationItemFixture.source
import com.iroselle.itemerness.core.presentation.PresentationItemFixture.visible
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertInstanceOf
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class PresentationCompositionTest {
    private val gray = 0xAAAAAA
    private val white = 0xFFFFFF
    private val green = 0x55FF55

    @Test
    fun `field part styles color each part and absent parts keep the block style`() {
        val styled = PresentationBlockSource.Field(
            "data.charges.label", "example:charges", "itemerness:integer", style = "value",
            partStyles = FieldPartStyles(label = "label", value = "requirement-met"),
        )
        val unstyled = PresentationBlockSource.Field("data.required-level.label", "example:required-level", "itemerness:integer", style = "value")
        val lore = display(source(item(listOf(styled, unstyled)))).lore
        assertEquals(listOf("Charges: 3", "Required Level: 12"), lore.map(::visible))
        fun color(line: PresentationLine, text: String) = line.runs.first { it.text == text }.style.color
        assertEquals(gray, color(lore[0], "Charges"))
        // The separator has no override, so it keeps the block's own style.
        assertEquals(white, color(lore[0], ": "))
        assertEquals(green, color(lore[0], "3"))
        // Without overrides every part shares the block style, so the label and separator merge into one run.
        assertEquals(white, color(lore[1], "Required Level: "))
        assertEquals(white, color(lore[1], "12"))
    }

    @Test
    fun `a row composes independently styled fragments and right-aligns its right region`() {
        val tier = PresentationBlockSource.Row(
            left = listOf(
                FragmentSource.Data("example:custom-label", style = "requirement-met"),
                FragmentSource.Literal(" · "),
                FragmentSource.Message("row.type"),
            ),
        )
        val skill = PresentationBlockSource.Row(
            left = listOf(FragmentSource.Data("example:charges", "itemerness:integer", style = "requirement-unmet")),
            right = listOf(FragmentSource.Message("row.hint")),
        )
        val wide = field("data.required-level.label", PresentationFixtures.requiredLevel)
        val lore = display(source(item(listOf(tier, skill, wide)))).lore
        assertEquals("Satchel · Two-handed greatsword", visible(lore[0]))
        assertEquals(green, lore[0].runs.first { it.text == "Satchel" }.style.color)
        assertEquals(gray, lore[0].runs.first { it.text == "Two-handed greatsword" }.style.color)
        assertTrue(visible(lore[1]).startsWith("3") && visible(lore[1]).endsWith("[Hold RMB]"), visible(lore[1]))
        // Exact padding puts the right region on the content edge, the widest line's edge.
        assertEquals(lore.maxOf { it.logicalWidthPixels }, lore[1].logicalWidthPixels)
    }

    @Test
    fun `a row that cannot fit both regions wraps the left one and puts the right region on its own line`() {
        val row = PresentationBlockSource.Row(
            left = listOf(FragmentSource.Message("item.ember-blade.description")),
            right = listOf(FragmentSource.Message("row.hint")),
        )
        val lore = display(source(item(listOf(row)))).lore
        assertTrue(lore.size >= 3, lore.map(::visible).toString())
        assertEquals("[Hold RMB]", visible(lore.last()).trim())
        assertEquals(lore.dropLast(1).maxOf { it.logicalWidthPixels }.coerceAtLeast(lore.last().logicalWidthPixels), lore.last().logicalWidthPixels)
        assertTrue(lore.all { it.logicalWidthPixels <= 220 })
    }

    @Test
    fun `rows omit absent fragments and disappear when nothing remains`() {
        val absent = PresentationBlockSource.Row(
            left = listOf(
                FragmentSource.Data("example:quality", "itemerness:key-message"),
                FragmentSource.Message("row.type", condition = ConditionSource(ConditionOperator.EXISTS, ValueReferenceSource.Data("example:quality"))),
            ),
        )
        val partial = PresentationBlockSource.Row(
            left = listOf(FragmentSource.Data("example:region", "itemerness:key-message"), FragmentSource.Message("row.type")),
        )
        val lore = display(source(item(listOf(absent, partial, field("data.charges.label", PresentationFixtures.charges))))).lore
        assertEquals(listOf("Two-handed greatsword", "Charges: 3"), lore.map(::visible))
    }

    @Test
    fun `rules stretch to the content width and centre an optional title`() {
        val wide = field("data.required-level.label", PresentationFixtures.requiredLevel)
        val bare = PresentationBlockSource.Rule()
        val titled = PresentationBlockSource.Rule(listOf(FragmentSource.Message("rule.stats")))
        val lore = display(source(item(listOf(titled, wide, bare)))).lore
        val target = lore.maxOf { it.logicalWidthPixels }
        assertEquals(target, lore[0].logicalWidthPixels)
        assertEquals(target, lore[2].logicalWidthPixels)
        val title = visible(lore[0])
        assertTrue(title.contains("Equipment stats"), title)
        val (before, after) = title.split("Equipment stats")
        assertTrue(before.trimEnd().all { it == '─' } && before.isNotBlank(), title)
        assertTrue(after.trimStart().all { it == '─' } && after.isNotBlank(), title)
        assertTrue(visible(lore[2]).trimEnd().all { it == '─' })
        // Rule pieces default to their own muted role, independent of the title.
        assertEquals(0x555555, lore[2].runs.first { it.text.startsWith("─") }.style.color)
    }

    @Test
    fun `theme rule pieces replace the default fill and glyph pieces require a resource pack`() {
        val theme = PresentationFixtures.themes().first { it.id == "itemerness:default" }.copyWith(
            rules = RuleThemeSource(style = "label", fill = MarkerPieceSource.Text("="), left = MarkerPieceSource.Text("<"), right = MarkerPieceSource.Text(">")),
        )
        val lore = display(source(item(listOf(PresentationBlockSource.Rule(), field("data.required-level.label", PresentationFixtures.requiredLevel))), themes = listOf(theme))).lore
        val rule = visible(lore[0]).trimEnd()
        assertTrue(rule.startsWith("<=") && rule.endsWith("=>"), rule)
        assertEquals(gray, lore[0].runs.first().style.color)

        val glyph = theme.copyWith(rules = RuleThemeSource(fill = MarkerPieceSource.Glyph("icon.socket")))
        val diagnostics = diagnostics(source(item(listOf(PresentationBlockSource.Rule())), themes = listOf(glyph)))
        assertTrue(diagnostics.any { it.path.endsWith("rules.fill") }, diagnostics.toString())
    }

    @Test
    fun `name fragments compose around the name and the name inset pads both sides exactly`() {
        val plain = display(source(item(listOf(field("data.charges.label", PresentationFixtures.charges)))))
        val composed = display(
            source(
                item(
                    listOf(field("data.charges.label", PresentationFixtures.charges)),
                    nameBefore = listOf(FragmentSource.Literal("★ ", style = "requirement-met")),
                    nameAfter = listOf(FragmentSource.Literal(" "), FragmentSource.Data("example:required-level", "itemerness:integer", style = "label")),
                ),
            ),
        )
        assertEquals("★ Composed 12", visible(composed.displayName))
        assertEquals(green, composed.displayName.runs.first().style.color)

        val inset = PresentationFixtures.themes().first { it.id == "itemerness:default" }.copyWith(nameInsetPixels = 7)
        val insetSource = source(item(listOf(field("data.charges.label", PresentationFixtures.charges))), themes = listOf(inset))
        val padded = display(insetSource)
        assertEquals("Composed", visible(padded.displayName).trim())
        val measurer = PixelMeasurer(PresentationFixtures.compile(insetSource))
        val runs = padded.displayName.runs
        val nameIndex = runs.indexOfFirst { it.text == "Composed" }
        assertEquals(7, measurer.measure(runs.take(nameIndex)).logicalWidthPixels)
        // The trailing inset is at least seven pixels; the flow may widen the name further to its minimum width.
        assertTrue(measurer.measure(runs.drop(nameIndex + 1)).logicalWidthPixels >= 7)
        assertTrue(plain.displayName.logicalWidthPixels <= padded.displayName.logicalWidthPixels)
    }

    @Test
    fun `a fixed icon slot aligns labels after icons of different advances`() {
        val icon = field("data.charges.label", PresentationFixtures.charges, icon = "icon.charges")
        fun labelStart(slot: Int?): Int {
            val layout = (PresentationFixtures.layouts().first { it.id == "itemerness:equipment" } as LayoutSource.Flow).copyWith(fieldIconSlotPixels = slot)
            val source = source(item(listOf(icon), layout = "itemerness:equipment", theme = "itemerness:ember"), layouts = listOf(layout))
            val line = display(source, viewer = packViewer()).lore.single()
            val catalog = PresentationFixtures.compile(source)
            return PixelMeasurer(catalog).measure(line.runs.takeWhile { !it.text.startsWith("Charges") }).logicalWidthPixels
        }
        // The fixture icon advances 9 pixels, so a 14-pixel slot adds exactly 5.
        assertEquals(labelStart(null) + 5, labelStart(14))
        assertEquals(labelStart(null), labelStart(9))
    }

    @Test
    fun `a marker gap adds exact space after every marker piece`() {
        val group = PresentationBlockSource.Group(null, listOf(field("data.charges.label", PresentationFixtures.charges), field("data.required-level.label", PresentationFixtures.requiredLevel)), marker = GroupMarker.TREE)
        fun widths(gap: Int): List<Int> {
            val theme = PresentationFixtures.themes().first { it.id == "itemerness:default" }.copyWith(markers = MarkerThemeSource(gapPixels = gap))
            return display(source(item(listOf(group)), themes = listOf(theme))).lore.map { it.logicalWidthPixels }
        }
        assertEquals(widths(0).map { it + 3 }, widths(3))
    }

    @Test
    fun `a wrapping width narrower than the content no longer widens the tooltip`() {
        val layout = LayoutSource.Flow(
            "itemerness:narrow-description",
            40,
            220,
            wrapping = mapOf("body" to WrappingSource(maximumLines = 16), "narrow" to WrappingSource(widthPixels = 100, maximumLines = 16)),
        )
        val description = PresentationBlockSource.Description("item.ember-blade.description", wrapping = "narrow")
        val lore = display(source(item(listOf(description), layout = layout.id), layouts = listOf(layout))).lore
        assertTrue(lore.size > 2)
        assertTrue(lore.all { it.logicalWidthPixels <= 100 }, lore.map { it.logicalWidthPixels }.toString())
    }

    @Test
    fun `layout diagnostics name the authored block and the largest contributors`() {
        val layout = LayoutSource.Flow(
            "itemerness:strict",
            40,
            220,
            wrapping = mapOf("body" to WrappingSource(maximumLines = 1, overflow = OverflowPolicy.ERROR)),
        )
        val description = PresentationBlockSource.Description("item.ember-blade.description")
        val group = PresentationBlockSource.Group(null, listOf(field("data.charges.label", PresentationFixtures.charges), description))
        val rejected = assertInstanceOf(
            PresentationRenderResult.Rejected::class.java,
            render(source(item(listOf(group), layout = layout.id), layouts = listOf(layout))),
        )
        assertTrue("blocks[0].children[1]" in rejected.failure.message, rejected.failure.message)

        val many = List(8) { PresentationBlockSource.Description("item.ember-blade.description") }
        val tight = assertInstanceOf(
            PresentationRenderResult.Rejected::class.java,
            render(source(item(many)), budgets = PresentationBudgets(maximumLines = 20)),
        )
        assertTrue("largest: blocks[" in tight.failure.message, tight.failure.message)
    }

    @Test
    fun `acceptance layout keeps value edges, collapses empty sections and agrees with existing fields`() {
        val stats = PresentationBlockSource.Group(
            header = PresentationBlockSource.Rule(listOf(FragmentSource.Message("rule.stats"))),
            children = listOf(
                field("data.charges.label", PresentationFixtures.charges),
                field("data.quality.label", PresentationFixtures.quality, "itemerness:key-message"),
            ),
            whenHeaderMissing = GroupHeaderMissingPolicy.SHOW_CHILDREN,
            whenEmpty = GroupEmptyPolicy.HIDE,
        )
        val optional = PresentationBlockSource.Group(
            header = PresentationBlockSource.Rule(),
            children = listOf(field("data.region.label", PresentationFixtures.region, "itemerness:key-message")),
            whenEmpty = GroupEmptyPolicy.HIDE,
        )
        val layout = (PresentationFixtures.layouts().first { it.id == "itemerness:plain" } as LayoutSource.Flow)
            .copyWith(fieldValueAlignment = FieldValueAlignment.RIGHT)
        val lore = display(source(item(listOf(stats, optional), layout = layout.id, theme = "itemerness:ember"), layouts = listOf(layout)), viewer = packViewer()).lore
        // The optional section's rule disappears with its only child.
        assertEquals(2, lore.size, lore.map(::visible).toString())
        assertEquals(1, lore.map { it.logicalWidthPixels }.toSet().size)
        assertNotEquals(lore[0].plainText, lore[1].plainText)
    }

    @Test
    fun `invalid compositions are diagnosed at compile time`() {
        val empty = PresentationBlockSource.Row(emptyList())
        val longLiteral = PresentationBlockSource.Row(listOf(FragmentSource.Literal("x".repeat(65))))
        val canvasRow = diagnostics(source(item(listOf(PresentationBlockSource.Row(listOf(FragmentSource.Literal("x")))), layout = "itemerness:bitmap-canvas", theme = "itemerness:aurora-canvas")))
        assertTrue(canvasRow.any { it.message == "Rows and rules require a flow layout" }, canvasRow.toString())
        val invalid = diagnostics(source(item(listOf(empty, longLiteral))))
        assertTrue(invalid.any { it.message == "A row needs at least one fragment" }, invalid.toString())
        assertTrue(invalid.any { it.path.endsWith("literal") }, invalid.toString())
        val header = diagnostics(source(item(listOf(PresentationBlockSource.Group(PresentationBlockSource.Row(listOf(FragmentSource.Literal("x"))), listOf(field("data.charges.label", PresentationFixtures.charges)))))))
        assertTrue(header.isEmpty(), header.toString())
    }

    @Test
    fun `unused composition features keep data-only rendering unchanged`() {
        val fields = listOf(field("data.charges.label", PresentationFixtures.charges), field("data.required-level.label", PresentationFixtures.requiredLevel))
        val first = display(source(item(fields)))
        val second = display(source(item(fields)), data + (PresentationFixtures.attack to IntegerDataValue(1)))
        assertEquals(first.lore, second.lore)
        assertEquals(emptyList<String>(), first.hiddenElements.toList())
        assertEquals(ItemKey.parse("itemerness:default"), first.selectedTheme)
    }
}

private fun ThemeSource.copyWith(
    markers: MarkerThemeSource? = this.markers,
    rules: RuleThemeSource? = this.rules,
    nameInsetPixels: Int = this.nameInsetPixels,
) = ThemeSource(
    id, renderer, requiresResourcePack, requiredCapabilities, vanillaTooltipLines, fallback, fonts, styles, tooltipStyle,
    content, characterFrame, segmentedFrame, canvas, requireExactFontMetrics, markers, rules, nameInsetPixels,
)

private fun LayoutSource.Flow.copyWith(
    fieldIconSlotPixels: Int? = this.fieldIconSlotPixels,
    fieldValueAlignment: FieldValueAlignment = this.fieldValueAlignment,
) = LayoutSource.Flow(
    id, minimumWidthPixels, maximumWidthPixels, blockGapAfterPixels, fieldLeftPaddingPixels, fieldIconGapPixels, fieldValueAlignment,
    descriptionLeftPaddingPixels, descriptionRightPaddingPixels, descriptionGapBeforePixels, wrapping, fieldSeparator, fieldIconSlotPixels, overflow,
)
