package com.iroselle.itemerness.core.presentation

import com.iroselle.itemerness.api.DataKey
import com.iroselle.itemerness.api.IntegerDataValue
import com.iroselle.itemerness.api.ItemDataValue
import com.iroselle.itemerness.api.ItemKey
import com.iroselle.itemerness.api.NamespacedKeyDataValue
import com.iroselle.itemerness.api.StringDataValue
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertInstanceOf
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class PresentationGroupTest {
    private val charges = PresentationBlockSource.Field("data.charges.label", "example:charges", "itemerness:integer")
    private val level = PresentationBlockSource.Field("data.required-level.label", "example:required-level", "itemerness:integer")
    private val quality = PresentationBlockSource.Field(
        "data.quality.label",
        "example:quality",
        "itemerness:key-message",
        missingPolicy = MissingDataPolicy.OMIT,
    )
    private val region = PresentationBlockSource.Field(
        "data.region.label",
        "example:region",
        "itemerness:key-message",
        missingPolicy = MissingDataPolicy.OMIT,
    )
    private val label = PresentationBlockSource.Text("example:custom-label", missingPolicy = MissingDataPolicy.OMIT)
    private val data: Map<DataKey, ItemDataValue> = mapOf(
        PresentationFixtures.charges to IntegerDataValue(3),
        PresentationFixtures.requiredLevel to IntegerDataValue(12),
        PresentationFixtures.customLabel to StringDataValue("Satchel"),
    )

    @Test
    fun `tree connectors follow only the children that render`() {
        val group = PresentationBlockSource.Group(charges, listOf(charges, region, level, quality), marker = GroupMarker.TREE)
        val sparse = lore(listOf(group))
        assertEquals(listOf("Charges: 3", "├─ Charges: 3", "└─ Required Level: 12"), sparse)

        val full = lore(listOf(group), data + (PresentationFixtures.quality to NamespacedKeyDataValue(ItemKey.parse("example:rare"))))
        assertEquals(listOf("Charges: 3", "├─ Charges: 3", "├─ Required Level: 12", "└─ Quality: Rare"), full)
    }

    @Test
    fun `nested groups compose tree bullet and undecorated levels outermost first`() {
        val inner = PresentationBlockSource.Group(label, listOf(charges, level))
        val middle = PresentationBlockSource.Group(charges, listOf(level, inner), marker = GroupMarker.BULLET)
        val outer = PresentationBlockSource.Group(label, listOf(level, middle, charges), marker = GroupMarker.TREE)
        val display = render(listOf(outer))
        val bulletBlank = "  "
        assertEquals(
            listOf(
                "Satchel",
                "├─ Required Level: 12",
                "├─ Charges: 3",
                "│  • Required Level: 12",
                "│  • Satchel",
                "│  ${bulletBlank}Charges: 3",
                "│  ${bulletBlank}Required Level: 12",
                "└─ Charges: 3",
            ),
            display.lore.map(::visible),
        )
        // Pieces of one kind are padded to one slot, so text at each depth starts at one x.
        val starts = display.lore.map(::contentStart)
        assertEquals(starts[1], starts[2])
        assertEquals(starts[1], starts[7])
        assertEquals(starts[3], starts[4])
        assertEquals(starts[5], starts[6])
        assertEquals(starts[3], starts[5])
        assertTrue(starts[3] > starts[1])
    }

    @Test
    fun `wrapped continuation lines carry the continuation prefix and narrower wrap width`() {
        val description = PresentationBlockSource.Description("item.ember-blade.description")
        val group = PresentationBlockSource.Group(null, listOf(description, description), marker = GroupMarker.TREE)
        val display = render(listOf(group), layout = narrowLayout())
        val lines = display.lore.map(::visible)
        val firstEnd = lines.indexOfFirst { it.startsWith("├─") }
        val lastStart = lines.indexOfFirst { it.startsWith("└─") }
        assertEquals(0, firstEnd)
        assertTrue(lastStart > 1, "the description must wrap: $lines")
        assertTrue(lines.subList(1, lastStart).all { it.startsWith("│  ") }, "$lines")
        assertTrue(lines.subList(lastStart + 1, lines.size).all { it.startsWith("   ") && !it.contains('│') }, "$lines")
        val starts = display.lore.map(::contentStart)
        assertEquals(1, starts.toSet().size, "every wrapped line starts its text at one x: $starts")
        assertTrue(display.lore.all { it.logicalWidthPixels <= 120 })
    }

    @Test
    fun `right aligned values keep one right edge at every level`() {
        val layout = narrowLayout(alignment = FieldValueAlignment.RIGHT, maximum = 220)
        val group = PresentationBlockSource.Group(null, listOf(charges, PresentationBlockSource.Group(null, listOf(level), marker = GroupMarker.BULLET)), marker = GroupMarker.TREE)
        // Exact signed spacing makes the right edge exact; space padding is only approximate.
        val display = render(listOf(charges, group), layout = layout, viewer = packViewer(), theme = "itemerness:ember")
        assertEquals("itemerness:ember", display.selectedTheme.toString())
        assertEquals(3, display.lore.size)
        assertEquals(1, display.lore.map { it.logicalWidthPixels }.toSet().size, display.lore.map(::visible).toString())
    }

    @Test
    fun `dividers follow each container's own setting`() {
        val nested = PresentationBlockSource.Group(label, listOf(charges, level), dividers = GroupDividers.BETWEEN_CHILDREN)
        val quiet = PresentationBlockSource.Group(label, listOf(charges, level))
        // Root default: a boundary before every root unit; the quiet group has none inside.
        assertEquals(2, teeRows(listOf(charges, quiet, level)))
        // The nested group draws its own boundary between its two children, but not after its header.
        assertEquals(3, teeRows(listOf(charges, nested, level)))
        // A root without dividers keeps only the nested group's own boundary.
        assertEquals(1, teeRows(listOf(charges, nested, level), rootDividers = GroupDividers.NONE))
        // Without groups the root setting reproduces the original boundary before every block.
        assertEquals(2, teeRows(listOf(charges, level, charges)))
    }

    @Test
    fun `visibility policies drop or keep the header and children`() {
        val missing = region
        fun group(header: PresentationBlockSource?, children: List<PresentationBlockSource>, headerPolicy: GroupHeaderMissingPolicy = GroupHeaderMissingPolicy.HIDE, empty: GroupEmptyPolicy = GroupEmptyPolicy.SHOW_HEADER) =
            PresentationBlockSource.Group(header, children, marker = GroupMarker.TREE, whenHeaderMissing = headerPolicy, whenEmpty = empty)

        assertEquals(listOf("Charges: 3"), lore(listOf(group(missing, listOf(level)), charges)))
        assertEquals(listOf("└─ Required Level: 12", "Charges: 3"), lore(listOf(group(missing, listOf(level), GroupHeaderMissingPolicy.SHOW_CHILDREN), charges)))
        assertEquals(listOf("Charges: 3"), lore(listOf(group(charges, listOf(missing)))))
        assertEquals(emptyList<String>(), lore(listOf(group(charges, listOf(missing), empty = GroupEmptyPolicy.HIDE))))
        assertEquals(emptyList<String>(), lore(listOf(group(null, listOf(missing)))))
        assertEquals(emptyList<String>(), lore(listOf(group(null, emptyList()))))
        // A hidden sibling group never consumes a connector.
        val parent = PresentationBlockSource.Group(null, listOf(level, group(missing, listOf(charges))), marker = GroupMarker.TREE)
        assertEquals(listOf("└─ Required Level: 12"), lore(listOf(parent)))
        // An unselected conditional branch is equally invisible to connector selection.
        val conditional = PresentationBlockSource.Conditional(
            ConditionSource(ConditionOperator.EXISTS, ValueReferenceSource.Data("example:region")),
            listOf(charges),
        )
        assertEquals(listOf("└─ Required Level: 12"), lore(listOf(PresentationBlockSource.Group(null, listOf(level, conditional), marker = GroupMarker.TREE))))
        assertEquals(
            listOf("├─ Required Level: 12", "└─ Charges: 3"),
            lore(listOf(PresentationBlockSource.Group(null, listOf(level, conditional), marker = GroupMarker.TREE)), data + (PresentationFixtures.region to NamespacedKeyDataValue(ItemKey.parse("example:harbor")))),
        )
    }

    @Test
    fun `gap lines keep ancestor connectors continuous`() {
        val gapped = PresentationBlockSource.Group(label, listOf(level), marker = GroupMarker.TREE, gapBeforeLines = 2)
        val lines = lore(listOf(PresentationBlockSource.Group(null, listOf(charges, gapped, charges), marker = GroupMarker.TREE)))
        assertEquals(
            listOf("├─ Charges: 3", "│", "│", "├─ Satchel", "│  └─ Required Level: 12", "└─ Charges: 3"),
            lines.map(String::trimEnd),
        )
        // The first rendered unit of a container gets no gap.
        assertEquals(listOf("└─ Satchel", "   └─ Required Level: 12"), lore(listOf(PresentationBlockSource.Group(null, listOf(gapped), marker = GroupMarker.TREE))))
        // Layout gaps inside a decorated container also carry the connector.
        val gappedLayout = narrowLayout(blockGap = 10)
        val inLayout = lore(listOf(PresentationBlockSource.Group(null, listOf(charges, level), marker = GroupMarker.TREE)), layout = gappedLayout)
        assertEquals(listOf("├─ Charges: 3", "│", "└─ Required Level: 12"), inLayout.map(String::trimEnd))
    }

    @Test
    fun `field separators resolve block then layout then the built-in colon`() {
        val equals = FieldSeparatorSource.Message("separator.equals")
        val blank = charges.copy(separator = FieldSeparatorSource.None)
        val custom = charges.copy(separator = FieldSeparatorSource.Message("separator.arrow"))
        assertEquals(listOf("Charges: 3", "Charges3", "Charges -> 3"), lore(listOf(charges, blank, custom)))
        assertEquals(listOf("Charges = 3", "Charges3", "Charges -> 3"), lore(listOf(charges, blank, custom), layout = narrowLayout(separator = equals)))
        val repeat = PresentationBlockSource.Repeat(
            "example:sockets",
            4,
            CompoundFieldTemplateSource("data.socket.label", "inserted", "data.socket.empty", separator = FieldSeparatorSource.None),
        )
        val sockets = data + (PresentationFixtures.sockets to com.iroselle.itemerness.api.ListDataValue(listOf(com.iroselle.itemerness.api.CompoundDataValue(emptyMap()))))
        assertEquals(listOf("SocketEmpty"), lore(listOf(repeat), sockets, layout = narrowLayout(separator = equals)))
        val compilation = PresentationCompiler().compile(source(listOf(charges.copy(separator = FieldSeparatorSource.Message("separator.missing")))))
        assertTrue(compilation.diagnostics.any { it.code == PresentationDiagnosticCode.MISSING_MESSAGE && it.path.endsWith(".separator") })
        val layoutMissing = PresentationCompiler().compile(source(listOf(charges), layout = narrowLayout(separator = FieldSeparatorSource.Message("separator.missing"))))
        assertTrue(layoutMissing.diagnostics.any { it.code == PresentationDiagnosticCode.MISSING_MESSAGE && it.path.endsWith("sections.field.separator") })
    }

    @Test
    fun `a decorated container replaces the nested item list's built-in bullet`() {
        val nested = listOf(NestedItemPresentation(ItemKey.parse("itemerness:travel-token"), "Harbor Travel Token", 2))
        val list = PresentationBlockSource.NestedItemList()
        assertEquals(listOf("• Harbor Travel Token ×2"), lore(listOf(list), nested = nested))
        assertEquals(
            listOf("Satchel", "• Harbor Travel Token ×2"),
            lore(listOf(PresentationBlockSource.Group(label, listOf(list), marker = GroupMarker.BULLET)), nested = nested),
        )
        assertEquals(
            listOf("Satchel", "• Harbor Travel Token ×2"),
            lore(listOf(PresentationBlockSource.Group(label, listOf(list))), nested = nested),
        )
        assertEquals(
            listOf("└─ Harbor Travel Token ×2"),
            lore(listOf(PresentationBlockSource.Group(null, listOf(list), marker = GroupMarker.TREE)), nested = nested),
        )
    }

    @Test
    fun `theme marker art replaces the defaults and glyph markers require a resource pack`() {
        val markers = MarkerThemeSource(style = "value", bullet = MarkerPieceSource.Text("- "), tree = TreeMarkerSource(last = MarkerPieceSource.Text("`- ")))
        val themed = PresentationFixtures.themes().map { theme ->
            if (theme.id != "itemerness:default") theme else ThemeSource(
                theme.id, theme.renderer, theme.requiresResourcePack, theme.requiredCapabilities, theme.vanillaTooltipLines,
                theme.fallback, theme.fonts, theme.styles, markers = markers,
            )
        }
        val group = PresentationBlockSource.Group(null, listOf(charges, PresentationBlockSource.Group(null, listOf(level), marker = GroupMarker.BULLET)), marker = GroupMarker.TREE)
        val lines = lore(listOf(group), themes = themed)
        // The wider custom last piece widens the whole tree slot, so the default branch is padded.
        assertEquals(listOf("├─  Charges: 3", "`- - Required Level: 12"), lines)

        val glyphTheme = ThemeSource(
            "itemerness:default", ThemeRenderer.PLAIN, false, vanillaTooltipLines = VanillaTooltipLinePolicy.PRESERVE,
            fonts = mapOf("text" to "minecraft:default"), markers = MarkerThemeSource(bullet = MarkerPieceSource.Glyph("icon.socket")),
        )
        val diagnostics = PresentationCompiler().compile(
            source(listOf(charges), themes = PresentationFixtures.themes().map { if (it.id == "itemerness:default") glyphTheme else it }),
        ).diagnostics
        assertTrue(diagnostics.any { it.path == "themes[0].markers.bullet" && it.code == PresentationDiagnosticCode.INVALID_VALUE }, diagnostics.toString())

        val packTheme = PresentationFixtures.themes().map { theme ->
            if (theme.id != "itemerness:ember") theme else ThemeSource(
                theme.id, theme.renderer, theme.requiresResourcePack, theme.requiredCapabilities, theme.vanillaTooltipLines,
                theme.fallback, theme.fonts, theme.styles, theme.tooltipStyle, theme.content,
                markers = MarkerThemeSource(bullet = MarkerPieceSource.Glyph("icon.socket")),
            )
        }
        val display = render(
            listOf(PresentationBlockSource.Group(null, listOf(charges), marker = GroupMarker.BULLET)),
            themes = packTheme,
            viewer = packViewer(),
            theme = "itemerness:ember",
        )
        assertEquals("itemerness:ember", display.selectedTheme.toString())
        assertTrue(display.lore.single().runs.any { it.text == String(Character.toChars(0xE001 + 4)) })
    }

    @Test
    fun `groups are rejected in canvas layouts and invalid group shapes are diagnosed`() {
        val group = PresentationBlockSource.Group(null, listOf(charges), marker = GroupMarker.TREE)
        val canvas = PresentationCompiler().compile(
            source(
                listOf(PresentationBlockSource.Conditional(ConditionSource(ConditionOperator.EXISTS, ValueReferenceSource.Data("example:charges")), listOf(group))),
                layoutId = "itemerness:bitmap-canvas",
                marker = GroupMarker.BULLET,
            ),
        ).diagnostics
        assertTrue(canvas.any { it.path == "items.itemerness:grouped.blocks[0].then[0]" && it.message == "Groups require a flow layout" }, canvas.toString())
        assertTrue(canvas.any { it.path == "items.itemerness:grouped.marker" }, canvas.toString())

        val invalid = PresentationCompiler().compile(
            source(
                listOf(
                    PresentationBlockSource.Group(PresentationBlockSource.Description("item.ember-blade.description"), listOf(charges)),
                    PresentationBlockSource.Group(null, listOf(charges), gapBeforeLines = -1),
                    PresentationBlockSource.Group(null, listOf(charges), gapBeforeLines = MAXIMUM_GROUP_GAP_LINES + 1),
                ),
            ),
        ).diagnostics
        assertTrue(invalid.any { it.path == "items[0].blocks[0].header" && it.code == PresentationDiagnosticCode.INVALID_VALUE }, invalid.toString())
        assertTrue(invalid.any { it.path == "items[0].blocks[1].gap-before-lines" }, invalid.toString())
        assertTrue(invalid.any { it.path == "items[0].blocks[2].gap-before-lines" }, invalid.toString())
    }

    @Test
    fun `group nesting headers and prefix runs count toward budgets`() {
        var nested: PresentationBlockSource = charges
        repeat(16) { nested = PresentationBlockSource.Group(null, listOf(nested), marker = GroupMarker.TREE) }
        val tooDeep = PresentationCompiler().compile(source(listOf(nested))).diagnostics
        assertTrue(tooDeep.any { it.code == PresentationDiagnosticCode.BUDGET_EXCEEDED && it.message.startsWith("Block nesting") }, tooDeep.toString())

        val headers = List(5) { PresentationBlockSource.Group(charges, listOf(level)) }
        val counted = PresentationCompiler(budgets = PresentationBudgets(maximumBlocksPerItem = 14)).compile(source(headers)).diagnostics
        assertTrue(counted.any { it.message == "Item has 15 blocks; maximum is 14" }, counted.toString())

        // Prefixes are measured runs: the deepest allowed nesting still wraps inside the width budget.
        var deep: PresentationBlockSource = PresentationBlockSource.Description("item.ember-blade.description")
        repeat(15) { deep = PresentationBlockSource.Group(null, listOf(deep), marker = GroupMarker.TREE) }
        val display = render(listOf(deep))
        assertTrue(display.lore.size > 1)
        assertTrue(visible(display.lore.first()).startsWith("└─ ".repeat(15)))
        assertTrue(display.lore.drop(1).all { visible(it).startsWith(" ".repeat(45)) })
        assertTrue(display.lore.all { it.logicalWidthPixels <= 220 })

        // Decorated rows still count against the line budget.
        val many = PresentationBlockSource.Group(null, List(17) { charges }, marker = GroupMarker.TREE)
        val catalog = PresentationFixtures.compile(source(listOf(many)), PresentationBudgets(maximumLines = 16))
        val rejected = assertInstanceOf(PresentationRenderResult.Rejected::class.java, PresentationEngine(catalog).render(request()))
        assertTrue("OUTPUT_BUDGET_EXCEEDED" in rejected.failure.message, rejected.failure.message)
        val fewer = PresentationBlockSource.Group(null, List(15) { charges }, marker = GroupMarker.TREE)
        val fits = PresentationEngine(PresentationFixtures.compile(source(listOf(fewer)), PresentationBudgets(maximumLines = 16))).render(request())
        assertEquals(15, assertInstanceOf(PresentationRenderResult.Rendered::class.java, fits).display.lore.size)
    }

    private fun teeRows(blocks: List<PresentationBlockSource>, rootDividers: GroupDividers = GroupDividers.BETWEEN_CHILDREN): Int {
        val display = render(blocks, theme = "itemerness:vanilla-frame", rootDividers = rootDividers)
        assertEquals("itemerness:vanilla-frame", display.selectedTheme.toString())
        return display.lore.count { line -> line.plainText.startsWith("├") && line.plainText.endsWith("┤") }
    }

    private fun lore(
        blocks: List<PresentationBlockSource>,
        data: Map<DataKey, ItemDataValue> = this.data,
        layout: LayoutSource.Flow? = null,
        themes: List<ThemeSource> = PresentationFixtures.themes(),
        nested: List<NestedItemPresentation> = emptyList(),
    ): List<String> = render(blocks, data, layout, themes, nested = nested).lore.map(::visible)

    private fun render(
        blocks: List<PresentationBlockSource>,
        data: Map<DataKey, ItemDataValue> = this.data,
        layout: LayoutSource.Flow? = null,
        themes: List<ThemeSource> = PresentationFixtures.themes(),
        viewer: PresentationViewer = PresentationViewer("en_us"),
        theme: String = "itemerness:default",
        rootDividers: GroupDividers = GroupDividers.BETWEEN_CHILDREN,
        nested: List<NestedItemPresentation> = emptyList(),
    ): PresentationDisplay {
        val catalog = PresentationFixtures.compile(source(blocks, layout, themes, theme = theme, dividers = rootDividers))
        val result = PresentationEngine(catalog).render(request(data, viewer, nested))
        return assertInstanceOf(PresentationRenderResult.Rendered::class.java, result, result.toString()).display
    }

    private fun request(
        data: Map<DataKey, ItemDataValue> = this.data,
        viewer: PresentationViewer = PresentationViewer("en_us"),
        nested: List<NestedItemPresentation> = emptyList(),
    ) = PresentationRenderRequest(ItemKey.parse("itemerness:grouped"), data, viewer, nested)

    private fun source(
        blocks: List<PresentationBlockSource>,
        layout: LayoutSource.Flow? = null,
        themes: List<ThemeSource> = PresentationFixtures.themes(),
        theme: String = "itemerness:default",
        layoutId: String = layout?.id ?: "itemerness:plain",
        marker: GroupMarker = GroupMarker.NONE,
        dividers: GroupDividers = GroupDividers.BETWEEN_CHILDREN,
    ): PresentationSource {
        val locales = PresentationFixtures.locales().map { locale ->
            LocaleSource(
                locale.locale,
                locale.fallback,
                locale.messages + mapOf(
                    "item.grouped.name" to "Grouped",
                    "separator.equals" to " = ",
                    "separator.arrow" to " -> ",
                ),
            )
        }
        val item = ItemPresentationSource("itemerness:grouped", layoutId, theme, "item.grouped.name", blocks, marker = marker, dividers = dividers)
        val layouts = PresentationFixtures.layouts().filter { it.id != layout?.id } + listOfNotNull(layout)
        val base = PresentationFixtures.source(localeSources = locales, themeSources = themes, itemSources = listOf(item))
        return PresentationSource(
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
        )
    }

    private fun narrowLayout(
        alignment: FieldValueAlignment = FieldValueAlignment.LEFT,
        separator: FieldSeparatorSource? = null,
        blockGap: Int = 0,
        maximum: Int = 120,
    ) = LayoutSource.Flow(
        "itemerness:narrow",
        40,
        maximum,
        blockGapAfterPixels = blockGap,
        fieldValueAlignment = alignment,
        wrapping = mapOf("body" to WrappingSource(maximumLines = 16)),
        fieldSeparator = separator,
    )

    private fun packViewer() = PresentationViewer(
        locale = "en_us",
        assetProfile = ItemKey.parse("itemerness:example-pack-v1"),
        capabilities = listOf("itemerness:native-tooltip-style-v1", "itemerness:segmented-frame-v1", "itemerness:signed-advance-v1").map(ItemKey::parse),
        metricsRevision = ItemKey.parse("itemerness:example-pack-v1"),
        resourcePackLoaded = true,
        managesVanillaTooltipLines = true,
    )

    private fun visible(line: PresentationLine): String = line.plainText.replace("\u200C", "")

    /** The pixel x where a line's text begins after its marker prefix and padding. */
    private fun contentStart(line: PresentationLine): Int {
        val prefix = line.runs.takeWhile { run -> run.text.none(Char::isLetterOrDigit) }
        var width = 0.0
        prefix.forEach { run ->
            run.text.codePoints().forEach { codePoint ->
                width += when {
                    codePoint == 0x200C -> if (run.style.bold) 1.0 else 0.0
                    Character.isWhitespace(codePoint) -> 4.0 + if (run.style.bold) 1.0 else 0.0
                    codePoint == '│'.code -> 1.0
                    codePoint in setOf('└'.code, '├'.code) -> 3.0
                    codePoint == '─'.code -> 5.0
                    else -> 6.0
                }
            }
        }
        return width.toInt()
    }
}
