package com.iroselle.itemerness.core.presentation

import com.iroselle.itemerness.api.DataKey
import com.iroselle.itemerness.api.BooleanDataValue
import com.iroselle.itemerness.api.IntegerDataValue
import com.iroselle.itemerness.api.ItemDataValue
import com.iroselle.itemerness.api.ItemKey
import com.iroselle.itemerness.api.NamespacedKeyDataValue
import com.iroselle.itemerness.api.StringDataValue
import java.util.UUID

internal object PresentationFixtures {
    val region = DataKey.parse("example:region")
    val charges = DataKey.parse("example:charges")
    val attack = DataKey.parse("example:attack-damage")
    val quality = DataKey.parse("example:quality")
    val requiredLevel = DataKey.parse("example:required-level")
    val sockets = DataKey.parse("example:sockets")
    val customLabel = DataKey.parse("example:custom-label")

    fun compile(
        source: PresentationSource = source(),
        budgets: PresentationBudgets = PresentationBudgets(),
    ): PresentationCatalogSnapshot = requireNotNull(PresentationCompiler(budgets = budgets).compile(source, revision = 7).catalog) {
        PresentationCompiler(budgets = budgets).compile(source, revision = 7).diagnostics.joinToString()
    }

    fun source(
        localeSources: List<LocaleSource> = locales(),
        themeSources: List<ThemeSource> = themes(),
        itemSources: List<ItemPresentationSource> = items(),
        viewerFactSources: List<ViewerFactSource> = viewerFacts(),
    ): PresentationSource = PresentationSource(
        formats = formats(),
        locales = localeSources,
        fonts = fonts(),
        glyphs = glyphs(),
        bitmaps = bitmaps(),
        assetProfiles = profiles(),
        viewerFacts = viewerFactSources,
        resourcePackBindings = resourcePackBindings(),
        layouts = layouts(),
        themes = themeSources,
        items = itemSources,
        spacing = SpacingSource(
            "itemerness:spacing",
            SpacingRangeSource(0xE300, 0xE3FF, -256, -1),
            SpacingRangeSource(0xE400, 0xE4FF, 1, 256),
        ),
        tooltipStyles = setOf("itemerness:ember", "itemerness:transparent-canvas"),
    )

    fun formats(): List<FormatSource> = listOf(
        FormatSource.IntegerFormat("itemerness:integer"),
        FormatSource.DecimalFormat("itemerness:decimal-one", "0.0"),
        FormatSource.DecimalFormat("itemerness:percent-one", "0.0", 100.0, "format.percent-suffix"),
        FormatSource.BooleanFormat("itemerness:boolean", "format.boolean.true", "format.boolean.false"),
        FormatSource.NamespacedKeyFormat(
            "itemerness:key-message",
            NamespacedKeyFormatMode.MESSAGE,
            "value.{namespace}.{path}",
            MissingKeyValue.PATH,
        ),
        FormatSource.ListFormat("itemerness:key-list", "itemerness:key-message", "format.list-separator"),
    )

    fun locales(): List<LocaleSource> = listOf(
        LocaleSource(
            "en_us",
            messages = mapOf(
                "item.travel-token.name" to "Harbor Travel Token",
                "item.travel-token.description" to "Consumed when travelling to the recorded region.",
                "item.ember-blade.name" to "Ember Blade",
                "item.ember-blade.description" to "A blade tempered in ember ash. Its settled attack roll remains unchanged when presentation files reload.",
                "item.survey-codex.name" to "Survey Codex",
                "item.survey-codex.description" to "Records landmarks, routes, and incomplete observations from the current expedition.",
                "item.nested-satchel.name" to "Nested Satchel",
                "item.nested-satchel.description" to "Its contained Itemerness items are projected recursively for the same viewer.",
                "item.framed-relic.name" to "Framed Relic",
                "item.framed-relic.description" to "A legacy segmented frame generated from measured content instead of manually padded Lore.",
                "data.region.label" to "Region",
                "data.charges.label" to "Charges",
                "data.attack-damage.label" to "Attack Damage",
                "data.quality.label" to "Quality",
                "data.required-level.label" to "Required Level",
                "data.socket.label" to "Socket",
                "data.socket.empty" to "Empty",
                "value.example.common" to "Common",
                "value.example.uncommon" to "Uncommon",
                "value.example.rare" to "Rare",
                "value.example.epic" to "Epic",
                "value.example.harbor" to "Harbor",
                "value.example.aurora-expanse" to "Aurora Expanse",
                "value.example.ancient-vault" to "Ancient Vault",
                "format.percent-suffix" to "%",
                "format.boolean.true" to "Yes",
                "format.boolean.false" to "No",
                "format.list-separator" to ", ",
            ),
        ),
        LocaleSource(
            "zh_cn",
            fallback = "en_us",
            messages = mapOf(
                "item.travel-token.name" to "港口旅行凭证",
                "item.travel-token.description" to "前往记录区域时消耗。",
                "item.ember-blade.name" to "余烬之刃",
                "item.ember-blade.description" to "以余烬灰反复淬炼的长刃。展示配置重载不会重新生成已经落定的攻击数值。",
                "item.survey-codex.name" to "勘探手册",
                "item.survey-codex.description" to "记录本次远征发现的地标、路线和尚未完成的观察。",
                "item.nested-satchel.name" to "叠层行囊",
                "item.nested-satchel.description" to "其中包含的 Itemerness 物品会为同一观察者递归生成展示。",
                "item.framed-relic.name" to "框饰遗物",
                "item.framed-relic.description" to "兼容传统分段外框，但由引擎按实测内容生成，不再手工填充 Lore。",
                "data.region.label" to "区域",
                "data.charges.label" to "次数",
                "data.attack-damage.label" to "攻击伤害",
                "data.quality.label" to "品质",
                "data.required-level.label" to "需求等级",
                "data.socket.label" to "插槽",
                "data.socket.empty" to "空",
                "value.example.common" to "普通",
                "value.example.uncommon" to "罕见",
                "value.example.rare" to "稀有",
                "value.example.epic" to "史诗",
                "value.example.harbor" to "港口",
                "value.example.aurora-expanse" to "极光荒原",
                "value.example.ancient-vault" to "远古秘库",
                "format.percent-suffix" to "%",
                "format.boolean.true" to "是",
                "format.boolean.false" to "否",
                "format.list-separator" to "、",
            ),
        ),
    )

    fun fonts(): List<FontSource> {
        val text = locales().flatMap { it.messages.values }.joinToString() + "─│┌┐└┘├┤═║╔╗╚╝╠╣+-[]•… ×:"
        val metrics = HashMap<Int, GlyphMetricSource>()
        text.codePoints().forEach { codePoint ->
            val advance = when {
                Character.isWhitespace(codePoint) -> 4.0
                codePoint == '│'.code || codePoint == '║'.code -> 1.0
                codePoint in setOf('┌'.code, '┐'.code, '└'.code, '┘'.code, '├'.code, '┤'.code) -> 3.0
                codePoint == '─'.code -> 5.0
                codePoint == '═'.code -> 6.0
                isCjk(codePoint) -> 10.0
                else -> 6.0
            }
            metrics[codePoint] = GlyphMetricSource(advance)
        }
        metrics[0x200C] = GlyphMetricSource(
            advancePixels = 0.0,
            visualBounds = VisualBoundsSource(0.0, 0.0, 0.0, 0.0),
            boldExtraAdvancePixels = 1.0,
            hasInk = false,
        )
        return listOf(
            FontSource("minecraft:default", "builtin:minecraft-default-26.1.2", metrics, fallbackAdvancePixels = 6.0),
            FontSource("minecraft:uniform", "builtin:minecraft-uniform-26.1.2", metrics, fallback = "minecraft:default"),
            FontSource("itemerness:body", "manifest:itemerness-body", metrics, fallback = "minecraft:default"),
            FontSource("itemerness:icons", "manifest:itemerness-icons", fallback = "minecraft:default"),
            FontSource("itemerness:frame", "manifest:itemerness-frame", fallback = "itemerness:icons"),
            FontSource("itemerness:canvas", "manifest:itemerness-canvas", fallback = "itemerness:icons"),
            FontSource("itemerness:spacing", "manifest:itemerness-spacing", fallbackAdvancePixels = 0.0),
        )
    }

    fun glyphs(): List<GlyphSource> = buildList {
        listOf("attack", "quality", "region", "charges", "socket").forEachIndexed { index, id ->
            add(glyph("icon.$id", "itemerness:icons", 0xE001 + index, 9.0, 0.0, 8.0))
        }
        val rows = listOf(
            "top-left", "top-fill", "top-right", "body-left", "body-fill", "body-right",
            "connector-left", "connector-fill", "connector-right", "bottom-left", "bottom-fill", "bottom-right",
        )
        rows.forEachIndexed { index, id ->
            add(glyph("frame.segment.$id", "itemerness:frame", 0xE101 + index, if (id.endsWith("fill")) 1.0 else 4.0, 0.0, if (id.endsWith("fill")) 1.0 else 4.0))
        }
        add(glyph("canvas.aurora.background", "itemerness:canvas", 0xE201, 176.0, 0.0, 176.0, "canvas.aurora.panel", -94.0, 2.0))
        add(glyph("canvas.aurora.horizontal-rule", "itemerness:canvas", 0xE202, 140.0, 0.0, 140.0, "canvas.aurora.horizontal-rule", -1.0, 1.0))
        add(glyph("canvas.aurora.emblem", "itemerness:canvas", 0xE203, 16.0, 0.0, 16.0, "canvas.aurora.emblem", -16.0, 0.0))
    }

    fun bitmaps(): List<BitmapSource> = listOf(
        BitmapSource("canvas.aurora.panel", "canvas.aurora.panel", 176, 96, 94, VisualBoundsSource(0.0, 176.0, -94.0, 2.0)),
        BitmapSource("canvas.aurora.horizontal-rule", "canvas.aurora.rule", 140, 2, 1, VisualBoundsSource(0.0, 140.0, -1.0, 1.0)),
        BitmapSource("canvas.aurora.emblem", "canvas.aurora.emblem", 16, 16, 16, VisualBoundsSource(0.0, 16.0, -16.0, 0.0)),
    )

    fun profiles(): List<AssetProfileSource> = listOf(
        AssetProfileSource("itemerness:vanilla", emptyList()),
        AssetProfileSource(
            "itemerness:example-pack-v1",
            listOf(
                "itemerness:native-tooltip-style-v1",
                "itemerness:segmented-frame-v1",
                "itemerness:signed-advance-v1",
                "itemerness:bitmap-canvas-v1",
            ),
            "itemerness:example-pack-v1",
            "itemerness:vanilla",
        ),
    )

    fun viewerFacts(): List<ViewerFactSource> = listOf(
        ViewerFactSource(
            "itemerness:locale",
            ViewerFactType.LOCALE,
            listOf("api", "player-override", "client"),
            StringDataValue("en_us"),
        ),
        ViewerFactSource(
            "itemerness:theme",
            ViewerFactType.NAMESPACED_KEY,
            listOf("api", "player-override"),
            nullable = true,
        ),
        ViewerFactSource(
            "itemerness:resource-pack-ready",
            ViewerFactType.BOOLEAN,
            listOf("bukkit-resource-pack-status"),
            BooleanDataValue(false),
        ),
        ViewerFactSource(
            "itemerness:asset-profile",
            ViewerFactType.NAMESPACED_KEY,
            listOf("api", "bukkit-resource-pack-status"),
            NamespacedKeyDataValue(ItemKey.parse("itemerness:vanilla")),
        ),
        ViewerFactSource("example:level", ViewerFactType.INTEGER, listOf("api"), IntegerDataValue(0)),
        ViewerFactSource("example:class", ViewerFactType.NAMESPACED_KEY, listOf("api"), nullable = true),
    )

    fun resourcePackBindings(): List<ResourcePackBindingSource> = listOf(
        ResourcePackBindingSource(
            "itemerness:example-pack-v1",
            false,
            UUID.fromString("00000000-0000-0000-0000-000000000001"),
            "0000000000000000000000000000000000000001",
            "itemerness:example-pack-v1",
        ),
    )

    fun layouts(): List<LayoutSource> = listOf(
        LayoutSource.Flow(
            "itemerness:plain",
            80,
            220,
            wrapping = mapOf("body" to WrappingSource(maximumLines = 16)),
        ),
        LayoutSource.Flow(
            "itemerness:equipment",
            140,
            220,
            fieldLeftPaddingPixels = 8,
            fieldIconGapPixels = 3,
            descriptionLeftPaddingPixels = 8,
            descriptionRightPaddingPixels = 8,
            wrapping = mapOf("body" to WrappingSource(maximumLines = 12)),
        ),
        LayoutSource.Canvas(
            "itemerness:bitmap-canvas",
            176,
            96,
            220,
            180,
            10,
            anchors = mapOf(
                "subtitle" to CanvasAnchorSource(18, 16, 140, 10, OverflowPolicy.ELLIPSIS),
                "region" to CanvasAnchorSource(18, 36, 140, 10, OverflowPolicy.ELLIPSIS),
                "body" to CanvasAnchorSource(18, 56, 140, 40, OverflowPolicy.ELLIPSIS),
            ),
            wrapping = mapOf("canvas-body" to WrappingSource(140, 4, OverflowPolicy.ELLIPSIS)),
        ),
    )

    fun themes(): List<ThemeSource> = listOf(
        ThemeSource(
            "itemerness:default",
            ThemeRenderer.PLAIN,
            false,
            vanillaTooltipLines = VanillaTooltipLinePolicy.PRESERVE,
            fonts = mapOf("text" to "minecraft:default"),
            styles = defaultStyles(),
        ),
        ThemeSource(
            "itemerness:vanilla-frame",
            ThemeRenderer.VANILLA_CHARACTER_FRAME,
            false,
            vanillaTooltipLines = VanillaTooltipLinePolicy.PRESERVE_OUTSIDE_FRAME,
            fallback = "itemerness:default",
            fonts = mapOf("text" to "minecraft:uniform", "frame" to "minecraft:uniform"),
            styles = mapOf("frame" to TextStyleSource("dark_gray")),
            characterFrame = CharacterFrameSource(CharacterFramePreset.UNICODE_SINGLE, 80, 220, 4, 4, 3, 16),
        ),
        ThemeSource(
            "itemerness:ember",
            ThemeRenderer.NATIVE_TOOLTIP_STYLE,
            true,
            listOf("itemerness:native-tooltip-style-v1"),
            VanillaTooltipLinePolicy.PRESERVE,
            "itemerness:vanilla-frame",
            mapOf("text" to "itemerness:body", "icons" to "itemerness:icons"),
            defaultStyles(),
            "itemerness:ember",
            ContentAreaSource(140, 220, 8, 8),
        ),
        ThemeSource(
            "itemerness:segmented",
            ThemeRenderer.SEGMENTED_FRAME,
            true,
            listOf("itemerness:segmented-frame-v1"),
            VanillaTooltipLinePolicy.REQUIRE_MANAGED,
            "itemerness:vanilla-frame",
            mapOf("text" to "itemerness:body", "icons" to "itemerness:icons", "frame" to "itemerness:frame"),
            defaultStyles(),
            segmentedFrame = SegmentedFrameSource(
                140,
                220,
                12,
                12,
                row("top"),
                row("body"),
                row("connector"),
                row("bottom"),
            ),
        ),
        ThemeSource(
            "itemerness:aurora-canvas",
            ThemeRenderer.BITMAP_CANVAS,
            true,
            listOf("itemerness:bitmap-canvas-v1", "itemerness:signed-advance-v1"),
            VanillaTooltipLinePolicy.REQUIRE_MANAGED,
            "itemerness:ember",
            mapOf(
                "text" to "itemerness:body",
                "icons" to "itemerness:icons",
                "canvas" to "itemerness:canvas",
                "spacing" to "itemerness:spacing",
            ),
            defaultStyles(),
            "itemerness:transparent-canvas",
            canvas = CanvasThemeSource(
                176,
                96,
                220,
                180,
                10,
                listOf(
                    CanvasLayerSource("canvas.aurora.background", CanvasLayerAnchor.TOP_LEFT, 0, 9, "canvas.aurora.panel", 0),
                    CanvasLayerSource("canvas.aurora.horizontal-rule", CanvasLayerAnchor.TOP_LEFT, 18, 4, "canvas.aurora.rule", 1),
                    CanvasLayerSource("canvas.aurora.emblem", CanvasLayerAnchor.TOP_RIGHT, -24, 2, "canvas.aurora.emblem", 2),
                ),
                176,
                176,
            ),
            requireExactFontMetrics = true,
        ),
    )

    fun items(): List<ItemPresentationSource> = listOf(
        ItemPresentationSource(
            "itemerness:travel-token",
            "itemerness:plain",
            "itemerness:vanilla-frame",
            "item.travel-token.name",
            listOf(
                PresentationBlockSource.Field(
                    "data.region.label",
                    "example:region",
                    "itemerness:key-message",
                    "icon.region",
                    missingPolicy = MissingDataPolicy.OMIT,
                ),
                PresentationBlockSource.Field("data.charges.label", "example:charges", "itemerness:integer", "icon.charges"),
                PresentationBlockSource.Description("item.travel-token.description"),
            ),
        ),
        ItemPresentationSource(
            "itemerness:ember-blade",
            "itemerness:equipment",
            "itemerness:ember",
            "item.ember-blade.name",
            listOf(
                PresentationBlockSource.Field("data.attack-damage.label", "example:attack-damage", "itemerness:decimal-one", "icon.attack"),
                PresentationBlockSource.Field(
                    "data.quality.label",
                    "example:quality",
                    "itemerness:key-message",
                    "icon.quality",
                    missingPolicy = MissingDataPolicy.OMIT,
                ),
                PresentationBlockSource.Conditional(
                    ConditionSource(
                        ConditionOperator.LESS_THAN,
                        ValueReferenceSource.Fact("example:level"),
                        ValueReferenceSource.Data("example:required-level"),
                    ),
                    listOf(PresentationBlockSource.Field("data.required-level.label", "example:required-level", "itemerness:integer", style = "requirement-unmet")),
                    listOf(PresentationBlockSource.Field("data.required-level.label", "example:required-level", "itemerness:integer", style = "requirement-met")),
                ),
                PresentationBlockSource.Repeat(
                    "example:sockets",
                    8,
                    CompoundFieldTemplateSource("data.socket.label", "inserted", "data.socket.empty", "icon.socket"),
                ),
                PresentationBlockSource.Description("item.ember-blade.description"),
            ),
        ),
        ItemPresentationSource(
            "itemerness:survey-codex",
            "itemerness:bitmap-canvas",
            "itemerness:aurora-canvas",
            "item.survey-codex.name",
            listOf(
                PresentationBlockSource.Text(
                    "example:custom-label",
                    anchor = "subtitle",
                    missingPolicy = MissingDataPolicy.OMIT,
                ),
                PresentationBlockSource.Field(
                    "data.region.label",
                    "example:region",
                    "itemerness:key-message",
                    "icon.region",
                    anchor = "region",
                    missingPolicy = MissingDataPolicy.OMIT,
                ),
                PresentationBlockSource.Description("item.survey-codex.description", anchor = "body", wrapping = "canvas-body"),
            ),
        ),
        ItemPresentationSource(
            "itemerness:nested-satchel",
            "itemerness:plain",
            "itemerness:default",
            "item.nested-satchel.name",
            listOf(
                PresentationBlockSource.NestedItemList(),
                PresentationBlockSource.Description("item.nested-satchel.description"),
            ),
        ),
        ItemPresentationSource(
            "itemerness:framed-relic",
            "itemerness:equipment",
            "itemerness:segmented",
            "item.framed-relic.name",
            listOf(
                PresentationBlockSource.Field(
                    "data.quality.label",
                    "example:quality",
                    "itemerness:key-message",
                    "icon.quality",
                    missingPolicy = MissingDataPolicy.OMIT,
                ),
                PresentationBlockSource.Field(
                    "data.region.label",
                    "example:region",
                    "itemerness:key-message",
                    "icon.region",
                    missingPolicy = MissingDataPolicy.OMIT,
                ),
                PresentationBlockSource.Description("item.framed-relic.description"),
            ),
        ),
    )

    fun travelData(): Map<DataKey, ItemDataValue> = mapOf(
        region to NamespacedKeyDataValue(ItemKey.parse("example:harbor")),
        charges to IntegerDataValue(3),
    )

    private fun defaultStyles(): Map<String, TextStyleSource> = mapOf(
        "item-name" to TextStyleSource("white"),
        "label" to TextStyleSource("gray"),
        "value" to TextStyleSource("white"),
        "requirement-met" to TextStyleSource("green"),
        "requirement-unmet" to TextStyleSource("red"),
        "description" to TextStyleSource("dark_gray"),
    )

    private fun row(name: String): FrameRowSource = FrameRowSource(
        "frame.segment.$name-left",
        "frame.segment.$name-fill",
        "frame.segment.$name-right",
    )

    private fun glyph(
        id: String,
        font: String,
        codePoint: Int,
        advance: Double,
        left: Double,
        right: Double,
        bitmap: String? = null,
        top: Double = -8.0,
        bottom: Double = 2.0,
    ): GlyphSource = GlyphSource(id, font, codePoint, advance, VisualBoundsSource(left, right, top, bottom), bitmap)

    private fun isCjk(codePoint: Int): Boolean = codePoint in 0x2E80..0x9FFF
}
