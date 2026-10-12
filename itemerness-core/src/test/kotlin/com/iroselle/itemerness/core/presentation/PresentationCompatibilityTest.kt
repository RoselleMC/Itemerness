package com.iroselle.itemerness.core.presentation

import com.iroselle.itemerness.api.CompoundDataValue
import com.iroselle.itemerness.api.DecimalDataValue
import com.iroselle.itemerness.api.IntegerDataValue
import com.iroselle.itemerness.api.ItemKey
import com.iroselle.itemerness.api.ListDataValue
import com.iroselle.itemerness.api.NamespacedKeyDataValue
import com.iroselle.itemerness.api.StringDataValue
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.nio.file.Files
import java.nio.file.Path
import java.security.MessageDigest
import java.util.HexFormat

/**
 * Proves that every engine fixture keeps rendering byte-identically.
 *
 * The digests were captured from the engine before recursive groups and configurable field
 * separators existed. Set ITEMERNESS_UPDATE_PRESENTATION_COMPATIBILITY=1 only when an intentional
 * rendering change is reviewed.
 */
class PresentationCompatibilityTest {
    @Test
    fun `engine fixtures render byte-identically to the captured engine output`() {
        val actual = LinkedHashMap<String, String>()
        val layoutVariants = mapOf(
            "base" to PresentationFixtures.layouts(),
            "gapped" to PresentationFixtures.layouts().map { layout ->
                if (layout !is LayoutSource.Flow) layout else LayoutSource.Flow(
                    layout.id,
                    layout.minimumWidthPixels,
                    layout.maximumWidthPixels,
                    blockGapAfterPixels = 10,
                    fieldLeftPaddingPixels = layout.fieldLeftPaddingPixels,
                    fieldIconGapPixels = layout.fieldIconGapPixels,
                    fieldValueAlignment = FieldValueAlignment.RIGHT,
                    descriptionLeftPaddingPixels = layout.descriptionLeftPaddingPixels,
                    descriptionRightPaddingPixels = layout.descriptionRightPaddingPixels,
                    descriptionGapBeforePixels = 20,
                    wrapping = mapOf("body" to WrappingSource(maximumLines = 16, continuationIndentPixels = 6)),
                )
            },
        )
        layoutVariants.forEach { (variant, layouts) ->
            val base = PresentationFixtures.source()
            val catalog = PresentationFixtures.compile(
                PresentationSource(
                    formats = base.formats,
                    locales = base.locales,
                    fonts = base.fonts,
                    glyphs = base.glyphs,
                    bitmaps = base.bitmaps,
                    assetProfiles = base.assetProfiles,
                    viewerFacts = base.viewerFacts,
                    resourcePackBindings = base.resourcePackBindings,
                    layouts = layouts,
                    themes = base.themes,
                    items = base.items,
                    spacing = base.spacing,
                    tooltipStyles = base.tooltipStyles,
                    themeSelectors = base.themeSelectors,
                ),
            )
            render(variant, catalog, actual)
        }
        val baseline = Path.of("src/test/resources/presentation-compatibility/engine-fixtures.txt")
        if (System.getenv("ITEMERNESS_UPDATE_PRESENTATION_COMPATIBILITY") == "1") {
            Files.createDirectories(baseline.parent)
            Files.writeString(baseline, actual.entries.joinToString("\n", postfix = "\n") { (key, digest) -> "$key $digest" })
        }
        val expected = Files.readAllLines(baseline).filter(String::isNotBlank).associate { line ->
            line.substringBeforeLast(' ') to line.substringAfterLast(' ')
        }
        assertEquals(expected.keys, actual.keys, "Compatibility case set changed")
        val changed = expected.keys.filter { expected[it] != actual[it] }
        assertTrue(changed.isEmpty(), "Rendering changed for ${changed.size} cases, first: ${changed.take(5)}")
    }

    private fun render(variant: String, catalog: PresentationCatalogSnapshot, output: MutableMap<String, String>) {
        val engine = PresentationEngine(catalog)
        val full = mapOf(
            PresentationFixtures.region to NamespacedKeyDataValue(ItemKey.parse("example:harbor")),
            PresentationFixtures.charges to IntegerDataValue(3),
            PresentationFixtures.attack to DecimalDataValue(38.4),
            PresentationFixtures.quality to NamespacedKeyDataValue(ItemKey.parse("example:rare")),
            PresentationFixtures.requiredLevel to IntegerDataValue(12),
            PresentationFixtures.customLabel to StringDataValue("Expedition 7"),
            PresentationFixtures.sockets to ListDataValue(
                listOf(
                    CompoundDataValue(emptyMap()),
                    CompoundDataValue(mapOf("inserted" to NamespacedKeyDataValue(ItemKey.parse("example:fire-gem")))),
                ),
            ),
        )
        val sparse = full - setOf(PresentationFixtures.region, PresentationFixtures.quality, PresentationFixtures.customLabel) +
            (PresentationFixtures.sockets to ListDataValue(emptyList()))
        val nested = listOf(
            NestedItemPresentation(ItemKey.parse("itemerness:travel-token"), "Harbor Travel Token", 2),
            NestedItemPresentation(ItemKey.parse("itemerness:ember-blade"), "Ember Blade", 1),
        )
        val profile = catalog.assetProfiles.getValue(ItemKey.parse("itemerness:example-pack-v1"))
        val themes = listOf<ItemKey?>(null) + catalog.themes.keys
        catalog.items.keys.forEach { item ->
            catalog.locales.keys.forEach { locale ->
                themes.forEach { theme ->
                    val viewers = mapOf(
                        "pack" to PresentationViewer(
                            locale = locale,
                            requestedTheme = theme,
                            assetProfile = profile.id,
                            capabilities = profile.capabilities,
                            metricsRevision = profile.metricsRevision,
                            facts = mapOf(ItemKey.parse("example:level") to IntegerDataValue(20)),
                            resourcePackLoaded = true,
                            managesVanillaTooltipLines = true,
                        ),
                        "vanilla" to PresentationViewer(
                            locale = locale,
                            requestedTheme = theme,
                            facts = mapOf(ItemKey.parse("example:level") to IntegerDataValue(5)),
                        ),
                    )
                    viewers.forEach { (viewerName, viewer) ->
                        mapOf("full" to full, "sparse" to sparse).forEach { (dataName, data) ->
                            val result = engine.render(PresentationRenderRequest(item, data, viewer, nested))
                            output["$variant|$item|$locale|${theme ?: "item"}|$viewerName|$dataName"] = digest(describe(result))
                        }
                    }
                }
            }
        }
    }

    private fun describe(result: PresentationRenderResult): String = when (result) {
        is PresentationRenderResult.Rejected -> "rejected ${result.failure.code} ${result.failure.message}"
        is PresentationRenderResult.Rendered -> buildString {
            val display = result.display
            append("renderer=").append(display.renderer).append('\n')
            append("selected=").append(display.selectedTheme).append(" requested=").append(display.requestedTheme).append('\n')
            append("tooltip=").append(display.tooltipStyle).append('\n')
            display.fallbackReasons.forEach { append("fallback=").append(it).append('\n') }
            append("name=").append(display.displayName).append('\n')
            display.lore.forEach { append("lore=").append(it).append('\n') }
        }
    }

    private fun digest(value: String): String =
        HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value.toByteArray(Charsets.UTF_8)))
}
