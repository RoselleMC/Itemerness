package com.iroselle.itemerness.core.presentation

import com.iroselle.itemerness.api.BooleanDataValue
import com.iroselle.itemerness.api.DecimalDataValue
import com.iroselle.itemerness.api.ItemKey
import com.iroselle.itemerness.api.ListDataValue
import com.iroselle.itemerness.api.NamespacedKeyDataValue
import com.iroselle.itemerness.api.StringDataValue
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class FormattingTest {
    private val catalog = PresentationFixtures.compile()

    @Test
    fun `formatters are typed locale-aware and recursively bounded by the compiled graph`() {
        val chinese = ValueFormatter(catalog, MessageResolver(catalog, "zh_cn"))

        assertEquals("62.5%", chinese.format(DecimalDataValue(0.625), ItemKey.parse("itemerness:percent-one")).getOrThrow())
        assertEquals("是", chinese.format(BooleanDataValue(true), ItemKey.parse("itemerness:boolean")).getOrThrow())
        assertEquals(
            "稀有、史诗",
            chinese.format(
                ListDataValue(
                    listOf(
                        NamespacedKeyDataValue(ItemKey.parse("example:rare")),
                        NamespacedKeyDataValue(ItemKey.parse("example:epic")),
                    ),
                ),
                ItemKey.parse("itemerness:key-list"),
            ).getOrThrow(),
        )
        assertTrue(chinese.format(StringDataValue("wrong"), ItemKey.parse("itemerness:integer")).isFailure)
    }

    @Test
    fun `missing localized messages follow the declared locale chain`() {
        val locales = PresentationFixtures.locales().map { locale ->
            if (locale.locale == "zh_cn") LocaleSource("zh_cn", "en_us", locale.messages - "item.travel-token.description") else locale
        }
        val engine = PresentationEngine(PresentationFixtures.compile(PresentationFixtures.source(localeSources = locales)))
        val result = engine.render(
            PresentationRenderRequest(
                ItemKey.parse("itemerness:travel-token"),
                PresentationFixtures.travelData(),
                PresentationViewer("zh_cn", requestedTheme = ItemKey.parse("itemerness:default")),
            ),
        ) as PresentationRenderResult.Rendered

        assertEquals("港口旅行凭证", result.display.displayName.plainText)
        assertTrue(result.display.lore.any { "Consumed when travelling" in it.plainText })
    }
}
