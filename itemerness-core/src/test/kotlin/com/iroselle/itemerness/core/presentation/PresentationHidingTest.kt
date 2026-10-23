package com.iroselle.itemerness.core.presentation

import com.iroselle.itemerness.api.CompoundDataValue
import com.iroselle.itemerness.api.IntegerDataValue
import com.iroselle.itemerness.api.ListDataValue
import com.iroselle.itemerness.api.NamespacedKeyDataValue
import com.iroselle.itemerness.api.ItemKey
import com.iroselle.itemerness.core.presentation.PresentationItemFixture.data
import com.iroselle.itemerness.core.presentation.PresentationItemFixture.diagnostics
import com.iroselle.itemerness.core.presentation.PresentationItemFixture.display
import com.iroselle.itemerness.core.presentation.PresentationItemFixture.field
import com.iroselle.itemerness.core.presentation.PresentationItemFixture.item
import com.iroselle.itemerness.core.presentation.PresentationItemFixture.render
import com.iroselle.itemerness.core.presentation.PresentationItemFixture.source
import com.iroselle.itemerness.core.presentation.PresentationItemFixture.visible
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertInstanceOf
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class PresentationHidingTest {
    private val charges = field("data.charges.label", PresentationFixtures.charges)
    private val level = field("data.required-level.label", PresentationFixtures.requiredLevel)
    private val label = PresentationBlockSource.Text("example:custom-label", missingPolicy = MissingDataPolicy.OMIT)

    /**
     * With these fixtures the 180-pixel height budget fits the name and 16 Lore lines: glyph ink
     * below the last baseline counts too. Never-hidden filler rows after
     * the blocks under test leave [capacity] lines for them without changing their paths.
     */
    private fun filled(blocks: List<PresentationBlockSource>, capacity: Int): List<PresentationBlockSource> =
        blocks + List(16 - capacity) { PresentationBlockSource.Text("example:custom-label", weight = HidingWeight.Never) }

    @Test
    fun `fallback stays the default strategy`() {
        val blocks = filled(listOf(charges, level, label, charges), 3)
        val rejected = assertInstanceOf(PresentationRenderResult.Rejected::class.java, render(source(item(blocks))))
        assertTrue("Display height budget exceeded" in rejected.failure.message, rejected.failure.message)
    }

    @Test
    fun `hiding removes the lowest weight first, then unweighted rows from the end`() {
        val blocks = listOf(
            field("data.charges.label", PresentationFixtures.charges, weight = HidingWeight.Ranked(5)),
            level,
            label,
            field("data.charges.label", PresentationFixtures.charges, weight = HidingWeight.Ranked(1)),
            field("data.required-level.label", PresentationFixtures.requiredLevel, weight = HidingWeight.Ranked(5)),
        )
        val one = display(source(item(filled(blocks, 4), overflow = OverflowStrategy.HIDE)))
        assertEquals(listOf("blocks[3]"), one.hiddenElements.toList())
        // Equal weights hide the later block first.
        val three = display(source(item(filled(blocks, 2), overflow = OverflowStrategy.HIDE)))
        assertEquals(listOf("blocks[3]", "blocks[4]", "blocks[0]"), three.hiddenElements.toList())
        assertEquals(listOf("Required Level: 12", "Satchel"), three.lore.take(2).map(::visible))
        // Unweighted rows go after every weighted row, from the last one.
        val four = display(source(item(filled(blocks, 1), overflow = OverflowStrategy.HIDE)))
        assertEquals(listOf("blocks[3]", "blocks[4]", "blocks[0]", "blocks[2]"), four.hiddenElements.toList())
    }

    @Test
    fun `the layout strategy applies unless the item overrides it`() {
        val layout = LayoutSource.Flow("itemerness:hiding", 40, 220, wrapping = mapOf("body" to WrappingSource()), overflow = OverflowStrategy.HIDE)
        val blocks = filled(listOf(charges, level, label, charges), 3)
        val hidden = display(source(item(blocks, layout = layout.id), layouts = listOf(layout)))
        assertEquals(listOf("blocks[3]"), hidden.hiddenElements.toList())
        val overridden = render(source(item(blocks, layout = layout.id, overflow = OverflowStrategy.FALLBACK), layouts = listOf(layout)))
        assertInstanceOf(PresentationRenderResult.Rejected::class.java, overridden)
    }

    @Test
    fun `never weights are kept and an unfittable item still falls back`() {
        val never = HidingWeight.Never
        val blocks = filled(
            listOf(
                field("data.charges.label", PresentationFixtures.charges, weight = never),
                field("data.required-level.label", PresentationFixtures.requiredLevel, weight = never),
                label,
            ),
            1,
        )
        val rejected = assertInstanceOf(PresentationRenderResult.Rejected::class.java, render(source(item(blocks, overflow = OverflowStrategy.HIDE))))
        assertTrue("hiding all 1 hideable rows did not fit" in rejected.failure.message, rejected.failure.message)
    }

    @Test
    fun `a container weight is inherited and repeat elements hide from the last`() {
        val group = PresentationBlockSource.Group(label, listOf(charges, level), marker = GroupMarker.TREE, weight = HidingWeight.Ranked(1))
        val repeat = PresentationBlockSource.Repeat(
            "example:sockets",
            4,
            CompoundFieldTemplateSource("data.socket.label", "inserted", "data.socket.empty", format = "itemerness:key-message"),
            weight = HidingWeight.Ranked(0),
        )
        val sockets = ListDataValue(
            listOf(
                CompoundDataValue(emptyMap()),
                CompoundDataValue(mapOf("inserted" to NamespacedKeyDataValue(ItemKey.parse("example:harbor")))),
            ),
        )
        val shown = display(
            source(item(filled(listOf(level, group, repeat), 3), overflow = OverflowStrategy.HIDE)),
            data + (PresentationFixtures.sockets to sockets),
        )
        assertEquals(listOf("blocks[2][#1]", "blocks[2][#0]", "blocks[1].children[1]"), shown.hiddenElements.toList())
        assertEquals(listOf("Required Level: 12", "Satchel", "└─ Charges: 3"), shown.lore.take(3).map(::visible))
    }

    @Test
    fun `hidden blocks leave their summaries in document order in a visible slot`() {
        val slot = FragmentSource.Slot(
            "more",
            prefix = FragmentSource.Literal("["),
            suffix = FragmentSource.Literal("]"),
            separator = FragmentSource.Literal(" "),
        )
        val host = PresentationBlockSource.Row(listOf(FragmentSource.Data("example:custom-label")), listOf(slot))
        val blocks = listOf(
            host,
            field("data.charges.label", PresentationFixtures.charges, weight = HidingWeight.Ranked(2), summary = SummarySource("more", FragmentSource.Literal("C"))),
            field("data.required-level.label", PresentationFixtures.requiredLevel, weight = HidingWeight.Ranked(1), summary = SummarySource("more", FragmentSource.Literal("L"))),
            field("data.charges.label", PresentationFixtures.charges, weight = HidingWeight.Ranked(3)),
        )
        val full = display(source(item(blocks, overflow = OverflowStrategy.HIDE)))
        assertEquals("Satchel", visible(full.lore[0]).trim())
        val hidden = display(source(item(filled(blocks, 2), overflow = OverflowStrategy.HIDE)))
        assertEquals(listOf("blocks[2]", "blocks[1]"), hidden.hiddenElements.toList())
        val row = visible(hidden.lore[0])
        assertTrue(row.startsWith("Satchel") && row.endsWith("[C L]"), row)
    }

    @Test
    fun `a slot limits its entries and counts the rest`() {
        val slot = FragmentSource.Slot("more", separator = FragmentSource.Literal(","), maximumEntries = 1, overflowCountMessage = "slot.more")
        val repeat = PresentationBlockSource.Repeat(
            "example:sockets",
            4,
            CompoundFieldTemplateSource("data.socket.label", "inserted", "data.socket.empty", format = "itemerness:key-message"),
            weight = HidingWeight.Ranked(0),
            summary = SummarySource("more", valuePath = "inserted", format = "itemerness:key-message"),
        )
        val sockets = ListDataValue(
            List(3) { CompoundDataValue(mapOf("inserted" to NamespacedKeyDataValue(ItemKey.parse("example:harbor")))) },
        )
        val shown = display(
            source(item(filled(listOf(level, repeat), 1), nameAfter = listOf(FragmentSource.Literal(" "), slot), overflow = OverflowStrategy.HIDE)),
            data + (PresentationFixtures.sockets to sockets),
        )
        assertEquals("Required Level: 12", visible(shown.lore.first()))
        assertEquals("Composed Harbor,+2", visible(shown.displayName).trim())
    }

    @Test
    fun `hiding settings are validated`() {
        val never = field("data.charges.label", PresentationFixtures.charges, weight = HidingWeight.Never, summary = SummarySource("more", FragmentSource.Literal("C")))
        val unknownSlot = field("data.required-level.label", PresentationFixtures.requiredLevel, summary = SummarySource("missing", FragmentSource.Literal("L")))
        val valuePath = field("data.charges.label", PresentationFixtures.charges, summary = SummarySource("more", valuePath = "inserted"))
        val slots = PresentationBlockSource.Row(listOf(FragmentSource.Slot("more"), FragmentSource.Slot("more")))
        val diagnostics = diagnostics(source(item(listOf(never, unknownSlot, valuePath, slots))))
        assertTrue(diagnostics.any { it.message == "A block that is never hidden cannot leave a summary" }, diagnostics.toString())
        assertTrue(diagnostics.any { it.message == "Unknown summary slot missing" }, diagnostics.toString())
        assertTrue(diagnostics.any { it.message == "Only repeat elements can summarize an element value" }, diagnostics.toString())
        assertTrue(diagnostics.any { it.message == "Duplicate summary slot more" }, diagnostics.toString())

        val ranged = diagnostics(source(item(listOf(field("data.charges.label", PresentationFixtures.charges, weight = HidingWeight.Ranked(-1))))))
        assertTrue(ranged.any { it.path.endsWith("weight") }, ranged.toString())
        val canvas = diagnostics(source(item(emptyList(), layout = "itemerness:bitmap-canvas", theme = "itemerness:aurora-canvas", overflow = OverflowStrategy.HIDE)))
        assertTrue(canvas.any { it.message == "Hiding on overflow requires a flow layout" }, canvas.toString())
    }

    @Test
    fun `hiding resolves only capacity failures and leaves other fallbacks alone`() {
        val strict = LayoutSource.Flow(
            "itemerness:strict-hiding",
            40,
            220,
            wrapping = mapOf("body" to WrappingSource(maximumLines = 1, overflow = OverflowPolicy.ERROR)),
            overflow = OverflowStrategy.HIDE,
        )
        val blocks = listOf(PresentationBlockSource.Description("item.ember-blade.description"), charges)
        val rejected = assertInstanceOf(PresentationRenderResult.Rejected::class.java, render(source(item(blocks, layout = strict.id), layouts = listOf(strict))))
        assertTrue("hiding" !in rejected.failure.message, rejected.failure.message)
        assertEquals(IntegerDataValue(3), data[PresentationFixtures.charges])
    }
}
