package com.iroselle.itemerness.core.presentation

import com.iroselle.itemerness.api.DataKey
import com.iroselle.itemerness.api.IntegerDataValue
import com.iroselle.itemerness.api.ItemDataValue
import com.iroselle.itemerness.api.ItemKey
import com.iroselle.itemerness.api.NamespacedKeyDataValue
import com.iroselle.itemerness.api.LongDataValue
import com.iroselle.itemerness.api.StringDataValue
import com.iroselle.itemerness.api.UuidDataValue
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertInstanceOf
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.util.UUID

class ThemeSelectorTest {
    private val selectorId = "example:quality-frame"
    private val itemId = "example:selected-token"

    private fun case(operator: ConditionOperator, left: ValueReferenceSource, right: ValueReferenceSource?, theme: String) =
        ThemeSelectorCaseSource(ConditionSource(operator, left, right), theme)

    private fun qualityIs(quality: String, theme: String) = case(
        ConditionOperator.EQUALS,
        ValueReferenceSource.Data(PresentationFixtures.quality.toString()),
        ValueReferenceSource.Literal(NamespacedKeyDataValue(ItemKey.parse(quality))),
        theme,
    )

    private fun selector(
        id: String = selectorId,
        cases: List<ThemeSelectorCaseSource> = listOf(
            qualityIs("example:rare", "itemerness:vanilla-frame"),
            case(
                ConditionOperator.GREATER_THAN_OR_EQUAL,
                ValueReferenceSource.Fact("example:level"),
                ValueReferenceSource.Literal(IntegerDataValue(10)),
                "itemerness:ember",
            ),
        ),
        defaultTheme: String = "itemerness:default",
    ) = ThemeSelectorSource(id, cases, defaultTheme)

    private fun item(theme: String = selectorId, layout: String = "itemerness:plain") = ItemPresentationSource(
        itemId,
        layout,
        theme,
        "item.travel-token.name",
        listOf(PresentationBlockSource.Description("item.travel-token.description")),
    )

    private fun source(
        selectors: List<ThemeSelectorSource> = listOf(selector()),
        items: List<ItemPresentationSource> = PresentationFixtures.items() + item(),
    ) = PresentationFixtures.source(itemSources = items, themeSelectorSources = selectors)

    private fun diagnostics(source: PresentationSource): List<PresentationDiagnostic> =
        PresentationCompiler().compile(source).diagnostics

    private fun render(
        data: Map<DataKey, ItemDataValue> = emptyMap(),
        viewer: PresentationViewer = PresentationViewer("en_us"),
    ): PresentationDisplay {
        val result = PresentationEngine(PresentationFixtures.compile(source())).render(
            PresentationRenderRequest(ItemKey.parse(itemId), data, viewer),
        )
        return assertInstanceOf(PresentationRenderResult.Rendered::class.java, result).display
    }

    @Test
    fun `instance data selects the first matching case`() {
        val display = render(mapOf(PresentationFixtures.quality to NamespacedKeyDataValue(ItemKey.parse("example:rare"))))
        assertEquals(ItemKey.parse("itemerness:vanilla-frame"), display.selectedTheme)
        assertEquals(ItemKey.parse("itemerness:vanilla-frame"), display.requestedTheme)
        assertTrue(display.fallbackReasons.isEmpty())
    }

    @Test
    fun `a viewer fact can select a theme and its fallback chain still applies`() {
        val display = render(viewer = PresentationViewer("en_us", facts = mapOf(ItemKey.parse("example:level") to IntegerDataValue(12))))
        // The ember theme requires a resource pack the viewer lacks, so its own fallback renders.
        assertEquals(ItemKey.parse("itemerness:ember"), display.requestedTheme)
        assertEquals(ItemKey.parse("itemerness:vanilla-frame"), display.selectedTheme)
        assertEquals(ThemeFallbackCode.RESOURCE_PACK_UNAVAILABLE, display.fallbackReasons.single().code)
    }

    @Test
    fun `earlier cases win and unmatched data uses the default theme`() {
        val both = render(
            mapOf(PresentationFixtures.quality to NamespacedKeyDataValue(ItemKey.parse("example:rare"))),
            PresentationViewer("en_us", facts = mapOf(ItemKey.parse("example:level") to IntegerDataValue(12))),
        )
        assertEquals(ItemKey.parse("itemerness:vanilla-frame"), both.requestedTheme)
        val common = render(mapOf(PresentationFixtures.quality to NamespacedKeyDataValue(ItemKey.parse("example:common"))))
        assertEquals(ItemKey.parse("itemerness:default"), common.selectedTheme)
        // The fact definition's default value (0) participates exactly like conditional blocks.
        assertEquals(ItemKey.parse("itemerness:default"), render().selectedTheme)
    }

    @Test
    fun `a viewer requested theme outranks the selector`() {
        val display = render(
            mapOf(PresentationFixtures.quality to NamespacedKeyDataValue(ItemKey.parse("example:rare"))),
            PresentationViewer("en_us", requestedTheme = ItemKey.parse("itemerness:default")),
        )
        assertEquals(ItemKey.parse("itemerness:default"), display.selectedTheme)
    }

    @Test
    fun `a viewer may request a selector, which is evaluated for the rendered item`() {
        val catalog = PresentationFixtures.compile(source())
        val result = PresentationEngine(catalog).render(
            PresentationRenderRequest(
                ItemKey.parse("itemerness:travel-token"),
                PresentationFixtures.travelData() + (PresentationFixtures.quality to NamespacedKeyDataValue(ItemKey.parse("example:rare"))),
                PresentationViewer("en_us", requestedTheme = ItemKey.parse(selectorId)),
            ),
        )
        val display = assertInstanceOf(PresentationRenderResult.Rendered::class.java, result).display
        assertEquals(ItemKey.parse("itemerness:vanilla-frame"), display.selectedTheme)
    }

    @Test
    fun `a valid selector compiles and is published with the catalog`() {
        val compilation = PresentationCompiler().compile(source())
        assertTrue(compilation.successful, compilation.diagnostics.joinToString())
        val compiled = compilation.catalog!!.themeSelectors.getValue(ItemKey.parse(selectorId))
        assertEquals(2, compiled.cases.size)
        assertEquals(
            setOf("itemerness:vanilla-frame", "itemerness:ember", "itemerness:default").map(ItemKey::parse).toSet(),
            compiled.reachableThemes,
        )
    }

    @Test
    fun `selector ids share the theme id space`() {
        val found = diagnostics(source(selectors = listOf(selector(id = "itemerness:default"))), )
        assertTrue(found.any { it.code == PresentationDiagnosticCode.DUPLICATE_ID && it.path == "theme-selectors[0]" }, found.joinToString())
        val duplicate = diagnostics(source(selectors = listOf(selector(), selector())))
        assertTrue(duplicate.any { it.code == PresentationDiagnosticCode.DUPLICATE_ID && it.path == "theme-selectors[1]" }, duplicate.joinToString())
    }

    @Test
    fun `selectors only choose concrete themes`() {
        val nested = selector(id = "example:outer", cases = listOf(qualityIs("example:rare", selectorId)), defaultTheme = selectorId)
        val found = diagnostics(source(selectors = listOf(selector(), nested)))
        assertTrue(found.any { it.code == PresentationDiagnosticCode.INVALID_VALUE && it.path == "theme-selectors[1].cases[0].theme" }, found.joinToString())
        assertTrue(found.any { it.code == PresentationDiagnosticCode.INVALID_VALUE && it.path == "theme-selectors[1].default" }, found.joinToString())
        val unknown = diagnostics(source(selectors = listOf(selector(cases = listOf(qualityIs("example:rare", "example:missing"))))))
        assertTrue(unknown.any { it.code == PresentationDiagnosticCode.MISSING_REFERENCE && it.path == "theme-selectors[0].cases[0].theme" }, unknown.joinToString())
    }

    @Test
    fun `selector facts must exist and participate in cache keys`() {
        val missingFact = case(
            ConditionOperator.EXISTS,
            ValueReferenceSource.Fact("example:undeclared"),
            null,
            "itemerness:default",
        )
        val found = diagnostics(source(selectors = listOf(selector(cases = listOf(missingFact)))))
        assertTrue(
            found.any { it.code == PresentationDiagnosticCode.MISSING_REFERENCE && it.path == "theme-selectors.$selectorId.cases[0].when" },
            found.joinToString(),
        )
        val uncached = PresentationFixtures.viewerFacts().map {
            if (it.id == "example:level") ViewerFactSource(it.id, it.type, it.providers, it.defaultValue, cacheKey = false) else it
        }
        val withUncached = PresentationFixtures.source(
            itemSources = PresentationFixtures.items() + item(),
            viewerFactSources = uncached,
            themeSelectorSources = listOf(selector()),
        )
        val uncachedDiagnostics = PresentationCompiler().compile(withUncached).diagnostics
        assertTrue(
            uncachedDiagnostics.any { it.code == PresentationDiagnosticCode.INVALID_VALUE && it.path == "theme-selectors.$selectorId.cases[1].when" },
            uncachedDiagnostics.joinToString(),
        )
    }

    @Test
    fun `selector case count is bounded`() {
        val cases = List(MAXIMUM_THEME_SELECTOR_CASES + 1) { qualityIs("example:rare", "itemerness:default") }
        val found = diagnostics(source(selectors = listOf(selector(cases = cases))))
        assertTrue(found.any { it.code == PresentationDiagnosticCode.BUDGET_EXCEEDED && it.path == "theme-selectors[0].cases" }, found.joinToString())
        val bounded = diagnostics(source(selectors = listOf(selector(cases = cases.drop(1)))))
        assertFalse(bounded.any { it.code == PresentationDiagnosticCode.BUDGET_EXCEEDED }, bounded.joinToString())
    }

    @Test
    fun `items must reference a declared theme or selector`() {
        val found = diagnostics(source(items = PresentationFixtures.items() + item(theme = "example:unknown")))
        assertTrue(found.any { it.code == PresentationDiagnosticCode.MISSING_REFERENCE && it.path.endsWith(".theme") }, found.joinToString())
    }

    @Test
    fun `layout contracts apply to every theme a selector can reach`() {
        val canvasCase = qualityIs("example:epic", "itemerness:aurora-canvas")
        val found = diagnostics(source(selectors = listOf(selector(cases = listOf(canvasCase)))))
        val diagnostic = found.singleOrNull { it.path == "items.$itemId.layout" }
        assertEquals(PresentationDiagnosticCode.INVALID_VALUE, diagnostic?.code, found.joinToString())
        assertTrue(diagnostic!!.message.contains("itemerness:aurora-canvas"))
        assertNull(diagnostics(source()).firstOrNull { it.path == "items.$itemId.layout" })
    }

    @Test
    fun `an authored string literal selects namespaced key data`() {
        val authored = selector(cases = listOf(case(
            ConditionOperator.EQUALS,
            ValueReferenceSource.Data(PresentationFixtures.quality.toString()),
            ValueReferenceSource.Literal(StringDataValue("example:rare")),
            "itemerness:vanilla-frame",
        )))
        val engine = PresentationEngine(PresentationFixtures.compile(source(selectors = listOf(authored))))
        val result = engine.render(PresentationRenderRequest(
            ItemKey.parse(itemId),
            mapOf(PresentationFixtures.quality to NamespacedKeyDataValue(ItemKey.parse("example:rare"))),
            PresentationViewer("en_us"),
        ))
        val display = assertInstanceOf(PresentationRenderResult.Rendered::class.java, result).display
        assertEquals(ItemKey.parse("itemerness:vanilla-frame"), display.selectedTheme)
    }

    @Test
    fun `condition equality compares numbers by value and keys or uuids by text`() {
        assertTrue(presentationValuesEqual(LongDataValue(3), IntegerDataValue(3)))
        assertTrue(presentationValuesEqual(StringDataValue("example:rare"), NamespacedKeyDataValue(ItemKey.parse("example:rare"))))
        assertFalse(presentationValuesEqual(StringDataValue("example:common"), NamespacedKeyDataValue(ItemKey.parse("example:rare"))))
        val uuid = UUID.fromString("00000000-0000-4000-8000-000000000001")
        assertTrue(presentationValuesEqual(UuidDataValue(uuid), StringDataValue(uuid.toString())))
        assertFalse(presentationValuesEqual(StringDataValue("3"), IntegerDataValue(3)))
    }
}
