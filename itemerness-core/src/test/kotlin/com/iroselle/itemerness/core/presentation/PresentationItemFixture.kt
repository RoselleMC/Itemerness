package com.iroselle.itemerness.core.presentation

import com.iroselle.itemerness.api.DataKey
import com.iroselle.itemerness.api.IntegerDataValue
import com.iroselle.itemerness.api.ItemDataValue
import com.iroselle.itemerness.api.ItemKey
import com.iroselle.itemerness.api.StringDataValue
import org.junit.jupiter.api.Assertions.assertInstanceOf

/** One configurable test item on top of the shared presentation fixtures. */
internal object PresentationItemFixture {
    val itemKey: ItemKey = ItemKey.parse("itemerness:composed")

    val data: Map<DataKey, ItemDataValue> = mapOf(
        PresentationFixtures.charges to IntegerDataValue(3),
        PresentationFixtures.requiredLevel to IntegerDataValue(12),
        PresentationFixtures.customLabel to StringDataValue("Satchel"),
    )

    val messages: Map<String, String> = mapOf(
        "item.composed.name" to "Composed",
        "row.type" to "Two-handed greatsword",
        "row.hint" to "[Hold RMB]",
        "rule.stats" to "Equipment stats",
        "slot.more" to "+{count}",
    )

    fun item(
        blocks: List<PresentationBlockSource>,
        layout: String = "itemerness:plain",
        theme: String = "itemerness:default",
        nameBefore: List<FragmentSource> = emptyList(),
        nameAfter: List<FragmentSource> = emptyList(),
        overflow: OverflowStrategy? = null,
        marker: GroupMarker = GroupMarker.NONE,
    ) = ItemPresentationSource(
        itemKey.toString(),
        layout,
        theme,
        "item.composed.name",
        blocks,
        marker = marker,
        nameBefore = nameBefore,
        nameAfter = nameAfter,
        overflow = overflow,
    )

    fun source(
        item: ItemPresentationSource,
        layouts: List<LayoutSource> = emptyList(),
        themes: List<ThemeSource> = emptyList(),
    ): PresentationSource {
        val locales = PresentationFixtures.locales().map { locale ->
            LocaleSource(locale.locale, locale.fallback, locale.messages + messages)
        }
        val base = PresentationFixtures.source(localeSources = locales, itemSources = listOf(item))
        return PresentationSource(
            formats = base.formats,
            locales = base.locales,
            fonts = base.fonts,
            glyphs = base.glyphs,
            bitmaps = base.bitmaps,
            assetProfiles = base.assetProfiles,
            viewerFacts = base.viewerFacts,
            resourcePackBindings = base.resourcePackBindings,
            layouts = base.layouts.filter { existing -> layouts.none { it.id == existing.id } } + layouts,
            themes = base.themes.filter { existing -> themes.none { it.id == existing.id } } + themes,
            items = base.items,
            spacing = base.spacing,
            tooltipStyles = base.tooltipStyles,
        )
    }

    fun render(
        source: PresentationSource,
        data: Map<DataKey, ItemDataValue> = this.data,
        viewer: PresentationViewer = PresentationViewer("en_us"),
        budgets: PresentationBudgets = PresentationBudgets(),
    ): PresentationRenderResult = PresentationEngine(PresentationFixtures.compile(source, budgets))
        .render(PresentationRenderRequest(itemKey, data, viewer))

    fun display(
        source: PresentationSource,
        data: Map<DataKey, ItemDataValue> = this.data,
        viewer: PresentationViewer = PresentationViewer("en_us"),
        budgets: PresentationBudgets = PresentationBudgets(),
    ): PresentationDisplay {
        val result = render(source, data, viewer, budgets)
        return assertInstanceOf(PresentationRenderResult.Rendered::class.java, result, result.toString()).display
    }

    fun diagnostics(source: PresentationSource): List<PresentationDiagnostic> = PresentationCompiler().compile(source).diagnostics

    fun packViewer() = PresentationViewer(
        locale = "en_us",
        assetProfile = ItemKey.parse("itemerness:example-pack-v1"),
        capabilities = listOf("itemerness:native-tooltip-style-v1", "itemerness:segmented-frame-v1", "itemerness:signed-advance-v1").map(ItemKey::parse),
        metricsRevision = ItemKey.parse("itemerness:example-pack-v1"),
        resourcePackLoaded = true,
        managesVanillaTooltipLines = true,
    )

    /** Visible text without width anchors or exact padding. */
    fun visible(line: PresentationLine): String = line.plainText.replace("\u200C", "")

    fun field(label: String, data: DataKey, format: String = "itemerness:integer", icon: String? = null, weight: HidingWeight? = null, summary: SummarySource? = null) =
        PresentationBlockSource.Field(label, data.toString(), format, icon, missingPolicy = MissingDataPolicy.OMIT, weight = weight, summary = summary)
}
