package com.iroselle.itemerness.core.presentation

import com.iroselle.itemerness.api.CompoundDataValue
import com.iroselle.itemerness.api.DataKey
import com.iroselle.itemerness.api.IntegerDataValue
import com.iroselle.itemerness.api.ItemDataValue
import com.iroselle.itemerness.api.ItemKey
import com.iroselle.itemerness.api.ListDataValue
import com.iroselle.itemerness.api.NamespacedKeyDataValue
import com.iroselle.itemerness.api.StringDataValue
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertInstanceOf
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class PresentationAdversarialTest {
    private val catalog = PresentationFixtures.compile()
    private val engine = PresentationEngine(catalog)

    @Test
    fun `RTL character frame falls back as a whole to plain`() {
        val result = engine.render(
            PresentationRenderRequest(
                ItemKey.parse("itemerness:travel-token"),
                PresentationFixtures.travelData(),
                PresentationViewer("en_us", direction = TextDirection.RIGHT_TO_LEFT),
            ),
        )
        val display = assertInstanceOf(PresentationRenderResult.Rendered::class.java, result).display

        assertEquals(ThemeRenderer.PLAIN, display.renderer)
        assertTrue(display.fallbackReasons.any { it.code == ThemeFallbackCode.UNSUPPORTED_DIRECTION })
        assertTrue(display.lore.none { it.plainText.contains('┌') })
    }

    @Test
    fun `resource-pack renderer cannot leak custom glyphs while the pack is unavailable`() {
        val result = engine.render(
            PresentationRenderRequest(
                ItemKey.parse("itemerness:ember-blade"),
                emberData(),
                PresentationViewer("en_us"),
            ),
        )
        val display = assertInstanceOf(PresentationRenderResult.Rendered::class.java, result).display

        assertTrue(display.renderer in setOf(ThemeRenderer.VANILLA_CHARACTER_FRAME, ThemeRenderer.PLAIN))
        assertTrue(display.fallbackReasons.any { it.code == ThemeFallbackCode.RESOURCE_PACK_UNAVAILABLE })
        assertTrue(display.lore.flatMap(PresentationLine::runs).none {
            it.kind in setOf(PresentationRunKind.ICON, PresentationRunKind.BITMAP, PresentationRunKind.SPACING)
        })
    }

    @Test
    fun `malicious instance strings are rejected before constructing packet-sized runs`() {
        val result = engine.render(
            PresentationRenderRequest(
                ItemKey.parse("itemerness:survey-codex"),
                mapOf(
                    PresentationFixtures.customLabel to StringDataValue("x".repeat(20_000)),
                    PresentationFixtures.region to NamespacedKeyDataValue(ItemKey.parse("example:aurora-expanse")),
                ),
                PresentationViewer("en_us"),
            ),
        )

        val rejected = assertInstanceOf(PresentationRenderResult.Rejected::class.java, result)
        assertEquals(PresentationRenderFailureCode.OUTPUT_BUDGET_EXCEEDED, rejected.failure.code)
    }

    @Test
    fun `repeat expansion rejects excess values instead of truncating silently`() {
        val tooManySockets = ListDataValue(List(9) { CompoundDataValue(emptyMap()) })
        val result = engine.render(
            PresentationRenderRequest(
                ItemKey.parse("itemerness:ember-blade"),
                emberData() + (PresentationFixtures.sockets to tooManySockets),
                PresentationViewer("en_us"),
            ),
        )

        val rejected = assertInstanceOf(PresentationRenderResult.Rejected::class.java, result)
        assertEquals(PresentationRenderFailureCode.OUTPUT_BUDGET_EXCEEDED, rejected.failure.code)
    }

    @Test
    fun `render requests detach from caller-owned mutable maps`() {
        val mutable = PresentationFixtures.travelData().toMutableMap()
        val request = PresentationRenderRequest(
            ItemKey.parse("itemerness:travel-token"),
            mutable,
            PresentationViewer("en_us", requestedTheme = ItemKey.parse("itemerness:default")),
        )
        mutable[PresentationFixtures.charges] = IntegerDataValue(999)

        val display = assertInstanceOf(PresentationRenderResult.Rendered::class.java, engine.render(request)).display

        assertTrue(display.lore.any { "3" in it.plainText })
        assertTrue(display.lore.none { "999" in it.plainText })
    }

    @Test
    fun `viewer fact values are checked against their compiled type`() {
        val result = engine.render(
            PresentationRenderRequest(
                ItemKey.parse("itemerness:ember-blade"),
                emberData(),
                PresentationViewer(
                    "en_us",
                    facts = mapOf(ItemKey.parse("example:level") to StringDataValue("not-an-integer")),
                ),
            ),
        )

        val rejected = assertInstanceOf(PresentationRenderResult.Rejected::class.java, result)
        assertEquals(PresentationRenderFailureCode.INVALID_RUNTIME_VALUE, rejected.failure.code)
    }

    private fun emberData(): Map<DataKey, ItemDataValue> = mapOf(
        PresentationFixtures.attack to com.iroselle.itemerness.api.DecimalDataValue(36.0),
        PresentationFixtures.quality to NamespacedKeyDataValue(ItemKey.parse("example:rare")),
        PresentationFixtures.requiredLevel to IntegerDataValue(12),
        PresentationFixtures.sockets to ListDataValue(emptyList()),
    )
}
