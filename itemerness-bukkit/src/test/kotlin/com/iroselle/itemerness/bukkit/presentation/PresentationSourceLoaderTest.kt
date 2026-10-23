package com.iroselle.itemerness.bukkit.presentation

import com.iroselle.itemerness.api.DataKey
import com.iroselle.itemerness.api.IntegerDataValue
import com.iroselle.itemerness.api.ItemKey
import com.iroselle.itemerness.bukkit.catalog.CatalogSourceLoader
import com.iroselle.itemerness.bukkit.config.StrictYamlException
import com.iroselle.itemerness.core.catalog.CatalogCompiler
import com.iroselle.itemerness.core.presentation.FieldSeparatorSource
import com.iroselle.itemerness.core.presentation.FragmentSource
import com.iroselle.itemerness.core.presentation.GroupMarker
import com.iroselle.itemerness.core.presentation.HidingWeight
import com.iroselle.itemerness.core.presentation.NestedItemPresentation
import com.iroselle.itemerness.core.presentation.PresentationBlockSource
import com.iroselle.itemerness.core.presentation.MissingDataPolicy
import com.iroselle.itemerness.core.presentation.PresentationDisplay
import com.iroselle.itemerness.core.presentation.PresentationDiagnosticCode
import com.iroselle.itemerness.core.presentation.PresentationEngine
import com.iroselle.itemerness.core.presentation.PresentationRenderRequest
import com.iroselle.itemerness.core.presentation.PresentationRenderResult
import com.iroselle.itemerness.core.presentation.PresentationViewer
import com.iroselle.itemerness.core.presentation.ResourcePackDelivery
import com.iroselle.itemerness.core.presentation.ThemeRenderer
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertInstanceOf
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption

class PresentationSourceLoaderTest {
    @TempDir
    lateinit var directory: Path

    @BeforeEach
    fun copyBundledResourcesFromIndex() {
        val paths = checkNotNull(javaClass.classLoader.getResourceAsStream("itemerness-resources.txt"))
            .bufferedReader()
            .useLines { lines ->
                lines.map(String::trim)
                    .filter { it.isNotEmpty() && !it.startsWith("#") }
                    .filter { it.endsWith(".yml") }
                    .toList()
            }
        paths.forEach(::copyResource)
    }

    @Test
    fun `complete bundled presentation resources compile`() {
        val loaded = load()

        assertTrue(loaded.compilation.successful, loaded.compilation.diagnostics.joinToString())
        assertEquals(setOf("en_us", "zh_cn"), loaded.locales)
        assertEquals(5, loaded.source.items.size)
        assertTrue(loaded.source.items.none { it.enabled })
        assertEquals(6, loaded.source.viewerFacts.size)
        assertEquals(1, loaded.source.resourcePackBindings.size)
        val snapshot = requireNotNull(loaded.compilation.catalog)
        assertEquals(0, snapshot.items.size, "Disabled examples must be validated but not published")
        assertEquals(setOf("en_us", "zh_cn"), snapshot.locales.keys)

        val byItem = loaded.source.items.associateBy { it.id }
        assertEquals(
            MissingDataPolicy.OMIT,
            (byItem.getValue("itemerness:travel-token").blocks[0] as com.iroselle.itemerness.core.presentation.PresentationBlockSource.Field)
                .missingPolicy,
        )
        assertEquals(
            MissingDataPolicy.OMIT,
            (byItem.getValue("itemerness:survey-codex").blocks[0] as com.iroselle.itemerness.core.presentation.PresentationBlockSource.Text)
                .missingPolicy,
        )
    }

    @Test
    fun `loader defaults missing policy to error and rejects unknown policies`() {
        replace("items/examples.yml", "          missing-policy: omit\n", "")
        val loaded = load()
        val travel = loaded.source.items.single { it.id == "itemerness:travel-token" }
        assertEquals(
            MissingDataPolicy.ERROR,
            (travel.blocks[0] as com.iroselle.itemerness.core.presentation.PresentationBlockSource.Field).missingPolicy,
        )

        copyBundledResources()
        replace("items/examples.yml", "missing-policy: omit", "missing-policy: ignore")
        assertThrows(StrictYamlException::class.java, ::load)
    }

    @Test
    fun `bundled font declarations resolve generated metrics instead of width approximations`() {
        val loaded = load()
        val fonts = loaded.source.fonts.associateBy { it.id }
        val classic = fonts.getValue("minecraft:default")
        val uniform = fonts.getValue("minecraft:uniform")

        assertEquals("builtin:minecraft-default-26.1.2", classic.metricsRevision)
        assertEquals("minecraft:uniform", classic.fallback)
        assertEquals(null, classic.fallbackAdvancePixels)
        assertEquals(2.0, classic.glyphs.getValue('i'.code).advancePixels)
        assertEquals(6.0, classic.glyphs.getValue('W'.code).advancePixels)
        assertEquals(false, classic.glyphs.getValue(' '.code).hasInk)
        assertEquals("builtin:minecraft-uniform-26.1.2", uniform.metricsRevision)
        assertEquals(null, uniform.fallback)
        assertEquals(null, uniform.fallbackAdvancePixels)
        assertEquals(9.0, uniform.glyphs.getValue('中'.code).advancePixels)
        assertEquals(0.5, uniform.glyphs.getValue('中'.code).boldExtraAdvancePixels)
        assertEquals(6.0, uniform.fallbackGlyph?.advancePixels)
    }

    @Test
    fun `server font selector resolves each supported client revision`() {
        listOf("1.21.11", "26.1.1", "26.1.2", "26.2", "26.3").forEach { version ->
            val fonts = load(clientVersion = version).source.fonts.associateBy { it.id }
            assertEquals(
                "builtin:minecraft-default-$version",
                fonts.getValue("minecraft:default").metricsRevision,
            )
            assertEquals(
                "builtin:minecraft-uniform-$version",
                fonts.getValue("minecraft:uniform").metricsRevision,
            )
        }
    }

    @Test
    fun `builtin metrics reject configured approximate fallback widths`() {
        replace(
            "assets/fonts.yml",
            "    metrics: builtin:minecraft-default",
            "    metrics: builtin:minecraft-default\n    fallback-advance-pixels: 6",
        )

        val exception = assertThrows(StrictYamlException::class.java, ::load)

        assertTrue(exception.message.orEmpty().contains("exact fallback policy"))
    }

    @Test
    fun `real bundled English and Chinese presentations render with generated vanilla metrics`() {
        enableNestedSatchel()
        val catalog = requireNotNull(load().compilation.catalog)
        val engine = PresentationEngine(catalog)

        val english = renderNested(engine, "en_us")
        val chinese = renderNested(engine, "zh_cn")

        assertEquals("Nested Satchel", english.displayName.plainText)
        assertEquals("叠层行囊", chinese.displayName.plainText)
        assertTrue(english.displayName.logicalWidthPixels > 0)
        assertEquals(36, chinese.displayName.logicalWidthPixels)
        assertTrue(english.lore.any { "projected" in it.plainText })
        assertTrue(chinese.lore.any { "递归" in it.plainText })
        assertTrue((english.lore + chinese.lore).all { it.logicalWidthPixels in 0..220 })
    }

    @Test
    fun `real presentation applies bitmap and unifont bold offsets per glyph`() {
        enableNestedSatchel()
        replace("locales/en_us.yml", "Nested Satchel", "i")
        replace("locales/zh_cn.yml", "叠层行囊", "中")
        replace(
            "themes/default.yml",
            "      item-name:\n        color: white",
            "      item-name:\n        color: white\n        bold: true",
        )
        val engine = PresentationEngine(requireNotNull(load().compilation.catalog))

        val english = renderNested(engine, "en_us")
        val chinese = renderNested(engine, "zh_cn")

        assertEquals(3, english.displayName.logicalWidthPixels, "bitmap i is 2px plus 1px bold offset")
        assertEquals(10, chinese.displayName.logicalWidthPixels, "unifont 中 is 9px plus 0.5px, rounded up")
    }

    @Test
    fun `all five bundled items render in both locales through their five configured theme paths`() {
        replace("items/examples.yml", "enabled: false", "enabled: true")
        val loadedCatalog = CatalogSourceLoader().load(directory)
        val domainCompilation = CatalogCompiler().compile(loadedCatalog.source)
        assertTrue(domainCompilation.successful, domainCompilation.diagnostics.joinToString())
        val domain = requireNotNull(domainCompilation.candidate).materialize(17)
        val loadedPresentation = load().compilation
        val presentation = loadedPresentation.catalog
        assertTrue(presentation != null, loadedPresentation.diagnostics.joinToString())
        val catalog = requireNotNull(presentation)
        val engine = PresentationEngine(catalog)
        val profile = catalog.assetProfiles.getValue(ItemKey.parse("itemerness:example-pack-v1"))
        val expected = linkedMapOf(
            ItemKey.parse("itemerness:travel-token") to ThemeRenderer.VANILLA_CHARACTER_FRAME,
            ItemKey.parse("itemerness:ember-blade") to ThemeRenderer.NATIVE_TOOLTIP_STYLE,
            ItemKey.parse("itemerness:survey-codex") to ThemeRenderer.BITMAP_CANVAS,
            ItemKey.parse("itemerness:nested-satchel") to ThemeRenderer.PLAIN,
            ItemKey.parse("itemerness:framed-relic") to ThemeRenderer.SEGMENTED_FRAME,
        )

        listOf("en_us", "zh_cn").forEach { locale ->
            expected.forEach { (itemKey, renderer) ->
                val instance = domain.createInstance(itemKey)
                val data = LinkedHashMap(instance.data)
                if (itemKey == ItemKey.parse("itemerness:ember-blade")) {
                    data[DataKey.parse("example:required-level")] = IntegerDataValue(12)
                }
                val nested = if (itemKey == ItemKey.parse("itemerness:nested-satchel")) {
                    listOf(
                        NestedItemPresentation(
                            ItemKey.parse("itemerness:travel-token"),
                            engine.itemDisplayName(ItemKey.parse("itemerness:travel-token"), locale).getOrThrow(),
                            2,
                        ),
                    )
                } else {
                    emptyList()
                }
                val viewer = PresentationViewer(
                    locale = locale,
                    assetProfile = profile.id,
                    capabilities = profile.capabilities,
                    metricsRevision = profile.metricsRevision,
                    facts = mapOf(ItemKey.parse("example:level") to IntegerDataValue(20)),
                    resourcePackLoaded = true,
                    managesVanillaTooltipLines = true,
                )
                val result = engine.render(PresentationRenderRequest(itemKey, data, viewer, nested))
                val display = assertInstanceOf(PresentationRenderResult.Rendered::class.java, result).display

                assertEquals(renderer, display.renderer, "$itemKey did not use its configured renderer in $locale")
                assertTrue(display.displayName.plainText.isNotBlank(), "$itemKey has an empty localized name in $locale")
                assertTrue((listOf(display.displayName) + display.lore).all { line ->
                    line.logicalWidthPixels in 0..220 &&
                        line.visualBounds.left >= 0.0 && line.visualBounds.right <= 220.0
                }, "$itemKey exceeded its horizontal presentation budget in $locale")
            }
        }
    }

    @Test
    fun `bundled nullable presentation values can be absent without rejecting the item`() {
        replace("items/examples.yml", "enabled: false", "enabled: true")
        val loadedCatalog = CatalogSourceLoader().load(directory)
        val domainCompilation = CatalogCompiler().compile(loadedCatalog.source)
        assertTrue(domainCompilation.successful, domainCompilation.diagnostics.joinToString())
        val domain = requireNotNull(domainCompilation.candidate).materialize(19)
        val catalog = requireNotNull(load().compilation.catalog)
        val engine = PresentationEngine(catalog)
        val profile = catalog.assetProfiles.getValue(ItemKey.parse("itemerness:example-pack-v1"))
        val missingByItem = linkedMapOf(
            ItemKey.parse("itemerness:travel-token") to setOf(DataKey.parse("example:region")),
            ItemKey.parse("itemerness:ember-blade") to setOf(DataKey.parse("example:quality")),
            ItemKey.parse("itemerness:survey-codex") to setOf(
                DataKey.parse("example:custom-label"),
                DataKey.parse("example:region"),
            ),
            ItemKey.parse("itemerness:framed-relic") to setOf(
                DataKey.parse("example:quality"),
                DataKey.parse("example:region"),
            ),
        )

        listOf("en_us", "zh_cn").forEach { locale ->
            missingByItem.forEach { (itemKey, missingKeys) ->
                val data = LinkedHashMap(domain.createInstance(itemKey).data)
                missingKeys.forEach(data::remove)
                if (itemKey == ItemKey.parse("itemerness:ember-blade")) {
                    data[DataKey.parse("example:required-level")] = IntegerDataValue(12)
                }
                val result = engine.render(
                    PresentationRenderRequest(
                        itemKey,
                        data,
                        PresentationViewer(
                            locale = locale,
                            assetProfile = profile.id,
                            capabilities = profile.capabilities,
                            metricsRevision = profile.metricsRevision,
                            facts = mapOf(ItemKey.parse("example:level") to IntegerDataValue(20)),
                            resourcePackLoaded = true,
                            managesVanillaTooltipLines = true,
                        ),
                    ),
                )

                assertInstanceOf(
                    PresentationRenderResult.Rendered::class.java,
                    result,
                    "$itemKey rejected nullable omissions in $locale",
                )
            }
        }
    }

    @Test
    fun `every bundled resource-pack theme has an atomic no-pack fallback`() {
        replace("items/examples.yml", "enabled: false", "enabled: true")
        val loadedCatalog = CatalogSourceLoader().load(directory)
        val domainCompilation = CatalogCompiler().compile(loadedCatalog.source)
        val domain = requireNotNull(domainCompilation.candidate).materialize(18)
        val catalog = requireNotNull(load().compilation.catalog)
        val engine = PresentationEngine(catalog)
        val resourcePackItems = listOf(
            ItemKey.parse("itemerness:ember-blade"),
            ItemKey.parse("itemerness:survey-codex"),
            ItemKey.parse("itemerness:framed-relic"),
        )

        resourcePackItems.forEach { itemKey ->
            val instance = domain.createInstance(itemKey)
            val data = LinkedHashMap(instance.data)
            if (itemKey == ItemKey.parse("itemerness:ember-blade")) {
                data[DataKey.parse("example:required-level")] = IntegerDataValue(12)
            }
            val result = engine.render(
                PresentationRenderRequest(
                    itemKey,
                    data,
                    PresentationViewer(
                        locale = "en_us",
                        facts = mapOf(ItemKey.parse("example:level") to IntegerDataValue(20)),
                    ),
                ),
            )
            val display = assertInstanceOf(PresentationRenderResult.Rendered::class.java, result).display
            assertTrue(
                display.renderer in setOf(ThemeRenderer.PLAIN, ThemeRenderer.VANILLA_CHARACTER_FRAME),
                "$itemKey did not reach a resource-free fallback: ${display.renderer}",
            )
            assertTrue(display.tooltipStyle == null)
            assertTrue(display.fallbackReasons.isNotEmpty())
        }
    }

    @Test
    fun `unknown scalar uses the exact client missing glyph metric`() {
        enableNestedSatchel()
        replace("locales/en_us.yml", "Nested Satchel", "A\uDBFF\uDFFF")
        val engine = PresentationEngine(requireNotNull(load().compilation.catalog))

        val display = renderNested(engine, "en_us")

        assertEquals(12, display.displayName.logicalWidthPixels)
        assertEquals(0.0, display.displayName.visualBounds.left)
        assertEquals(11.0, display.displayName.visualBounds.right)
    }

    @Test
    fun `unknown nested field is rejected`() {
        replace("formats/default.yml", "pattern: \"0\"", "pattern: \"0\"\n    unexpected: true")

        assertThrows(StrictYamlException::class.java, ::load)
    }

    @Test
    fun `missing presentation reference rejects the candidate`() {
        replace("items/examples.yml", "layout: itemerness:plain", "layout: itemerness:missing")

        val compilation = load().compilation

        assertTrue(!compilation.successful)
        assertTrue(compilation.diagnostics.any { it.code == PresentationDiagnosticCode.MISSING_REFERENCE })
    }

    @Test
    fun `configured presentation defaults fill omitted item layout and theme`() {
        replace(
            "items/examples.yml",
            "      layout: itemerness:plain\n      theme: itemerness:vanilla-frame\n",
            "",
        )

        val loaded = load(
            defaultLayout = ItemKey.parse("itemerness:plain"),
            defaultTheme = ItemKey.parse("itemerness:default"),
        )
        val item = loaded.source.items.single { it.id == "itemerness:travel-token" }

        assertEquals("itemerness:plain", item.layout)
        assertEquals("itemerness:default", item.theme)
        assertTrue(loaded.compilation.successful, loaded.compilation.diagnostics.joinToString())
    }

    @Test
    fun `shown flags load from YAML as an optional list of strings`() {
        assertEquals(emptyList<String>(), load().source.items.single { it.id == "itemerness:travel-token" }.shownFlags)

        replace(
            "items/examples.yml",
            "      layout: itemerness:plain\n      theme: itemerness:vanilla-frame\n",
            "      layout: itemerness:plain\n      theme: itemerness:vanilla-frame\n" +
                "      shown-flags:\n        - minecraft:enchantments\n        - minecraft:attribute_modifiers\n",
        )
        val loaded = load()

        assertTrue(loaded.compilation.successful, loaded.compilation.diagnostics.joinToString())
        assertEquals(
            listOf("minecraft:enchantments", "minecraft:attribute_modifiers"),
            loaded.source.items.single { it.id == "itemerness:travel-token" }.shownFlags,
        )
        assertEquals(
            setOf(ItemKey.parse("minecraft:attribute_modifiers"), ItemKey.parse("minecraft:enchantments")),
            requireNotNull(loaded.compilation.catalog).validationItems.getValue(ItemKey.parse("itemerness:travel-token")).shownFlags,
        )
    }

    @Test
    fun `shown flags YAML is strict and owned components are diagnosed`() {
        val original = Files.readString(directory.resolve("items/examples.yml"))
        val anchor = "      layout: itemerness:plain\n      theme: itemerness:vanilla-frame\n"
        fun withShownFlags(yaml: String) = Files.writeString(directory.resolve("items/examples.yml"), original.replace(anchor, anchor + yaml))

        withShownFlags("      shown-flags: minecraft:enchantments\n")
        assertThrows(StrictYamlException::class.java, ::load)
        withShownFlags("      shown-flags:\n        - 1\n")
        assertThrows(StrictYamlException::class.java, ::load)
        withShownFlags("      shown-flags:\n        - minecraft:lore\n")
        val diagnostics = load().compilation.diagnostics
        assertTrue(diagnostics.any { it.code == PresentationDiagnosticCode.INVALID_VALUE && it.path.endsWith("shown-flags[0]") }, "$diagnostics")
    }

    @Test
    fun `theme selectors load from YAML and choose a theme from instance data`() {
        Files.writeString(directory.resolve("themes/selectors.yml"), SELECTOR_YAML)
        replace("items/examples.yml", "theme: itemerness:vanilla-frame", "theme: example:charge-frame")

        val loaded = load()
        assertTrue(loaded.compilation.successful, loaded.compilation.diagnostics.joinToString())
        val selector = loaded.source.themeSelectors.single()
        assertEquals("example:charge-frame", selector.id)
        assertEquals("itemerness:default", selector.cases.single().theme)
        assertEquals("itemerness:vanilla-frame", selector.defaultTheme)

        replace("items/examples.yml", "  travel-token:\n    enabled: false", "  travel-token:\n    enabled: true")
        val engine = PresentationEngine(requireNotNull(load().compilation.catalog))
        fun selected(charges: Int): ItemKey {
            val result = engine.render(PresentationRenderRequest(
                ItemKey.parse("itemerness:travel-token"),
                mapOf(DataKey.parse("example:charges") to IntegerDataValue(charges)),
                PresentationViewer("en_us"),
            ))
            return assertInstanceOf(PresentationRenderResult.Rendered::class.java, result).display.selectedTheme
        }
        assertEquals(ItemKey.parse("itemerness:default"), selected(3))
        assertEquals(ItemKey.parse("itemerness:vanilla-frame"), selected(2))
    }

    @Test
    fun `theme selector YAML is strict`() {
        Files.writeString(directory.resolve("themes/selectors.yml"), SELECTOR_YAML.replace("    default:", "    unexpected: true\n    default:"))
        assertThrows(StrictYamlException::class.java, ::load)
        Files.writeString(directory.resolve("themes/selectors.yml"), SELECTOR_YAML.replace("        theme: itemerness:default", "        theme: itemerness:default\n        priority: 1"))
        assertThrows(StrictYamlException::class.java, ::load)
        Files.writeString(directory.resolve("themes/selectors.yml"), "schema-version: 1\n")
        assertThrows(StrictYamlException::class.java, ::load)
    }

    @Test
    fun `resource-pack bindings default to verified and parse assumed delivery strictly`() {
        assertEquals(ResourcePackDelivery.VERIFIED, load().source.resourcePackBindings.single().delivery)

        replace(
            "assets/bitmaps.yml",
            "    enabled: false\n    pack-id: 00000000-0000-0000-0000-000000000001\n    sha1: \"0000000000000000000000000000000000000001\"\n",
            "    enabled: true\n    delivery: assumed\n",
        )
        val loaded = load()
        assertTrue(loaded.compilation.successful, loaded.compilation.diagnostics.joinToString())
        val binding = loaded.source.resourcePackBindings.single()
        assertEquals(ResourcePackDelivery.ASSUMED, binding.delivery)
        assertEquals(null, binding.packId)
        assertEquals(
            ResourcePackDelivery.ASSUMED,
            requireNotNull(loaded.compilation.catalog).resourcePackBindings.values.single().delivery,
        )

        replace("assets/bitmaps.yml", "delivery: assumed", "delivery: proxy")
        assertThrows(StrictYamlException::class.java, ::load)
    }

    @Test
    fun `group YAML loads strictly and renders tree rows through the real loader`() {
        enableTravelToken()
        replace("items/examples.yml", TRAVEL_DESCRIPTION, GROUP_YAML)
        val loaded = load()
        assertTrue(loaded.compilation.successful, loaded.compilation.diagnostics.joinToString())
        val group = loaded.source.items.single { it.id == "itemerness:travel-token" }.blocks.last() as PresentationBlockSource.Group
        assertEquals(GroupMarker.TREE, group.marker)
        assertEquals(FieldSeparatorSource.None, (group.header as PresentationBlockSource.Field).separator)
        val display = renderTravelToken(PresentationEngine(requireNotNull(loaded.compilation.catalog)))
        val lines = display.lore.map { it.plainText }
        assertTrue(lines.any { "├─ " in it }, lines.toString())
        assertTrue(lines.any { "└─ " in it }, lines.toString())
        assertTrue(lines.any { "Charges3" in it }, lines.toString())
    }

    @Test
    fun `group separator and marker YAML is strict`() {
        enableTravelToken()
        val invalid = listOf(
            GROUP_YAML.replace("marker: tree", "marker: arrow"),
            GROUP_YAML.replace("marker: tree", "marker: tree\n          collapsed: true"),
            GROUP_YAML.replace("separator: none", "separator: colon"),
            GROUP_YAML.replace("separator: none", "separator:\n              text: \" = \""),
            GROUP_YAML.replace("when-empty: hide", "when-empty: collapse"),
        )
        invalid.forEach { yaml ->
            copyBundledResources()
            enableTravelToken()
            replace("items/examples.yml", TRAVEL_DESCRIPTION, yaml)
            assertThrows(StrictYamlException::class.java, { load() }, yaml)
        }
        copyBundledResources()
        replace("themes/default.yml", "    icons:\n", "    markers:\n      bullet: 3\n    icons:\n")
        assertThrows(StrictYamlException::class.java) { load() }
        copyBundledResources()
        replace("themes/default.yml", "    icons:\n", "    markers:\n      arrow: \"> \"\n    icons:\n")
        assertThrows(StrictYamlException::class.java) { load() }
        copyBundledResources()
        replace("themes/default.yml", "    icons:\n", "    markers:\n      bullet:\n        glyph: icon.region\n    icons:\n")
        val glyphWithoutPack = load().compilation.diagnostics
        assertTrue(glyphWithoutPack.any { it.path.endsWith("markers.bullet") && it.code == PresentationDiagnosticCode.INVALID_VALUE }, glyphWithoutPack.toString())
        copyBundledResources()
        enableTravelToken()
        replace("items/examples.yml", TRAVEL_DESCRIPTION, GROUP_YAML.replace("type: field\n            label: data.charges.label", "type: description\n            message: data.charges.label").replace("            data: example:charges\n            format: itemerness:integer\n            separator: none\n", ""))
        val badHeader = load().compilation.diagnostics
        assertTrue(badHeader.any { it.path.endsWith(".header") && it.code == PresentationDiagnosticCode.INVALID_VALUE }, badHeader.toString())
    }

    @Test
    fun `row rule fragment and hiding YAML loads and renders through the real loader`() {
        enableTravelToken()
        replace("items/examples.yml", TRAVEL_DESCRIPTION, COMPOSITION_YAML)
        val loaded = load()
        assertTrue(loaded.compilation.successful, loaded.compilation.diagnostics.joinToString())
        val blocks = loaded.source.items.single { it.id == "itemerness:travel-token" }.blocks
        val row = blocks.last() as PresentationBlockSource.Row
        assertEquals(HidingWeight.Ranked(2), row.weight)
        assertEquals(FragmentSource.Literal(" · "), row.left[1])
        assertEquals(HidingWeight.Never, (blocks[blocks.size - 2] as PresentationBlockSource.Rule).weight)
        val lines = renderTravelToken(PresentationEngine(requireNotNull(loaded.compilation.catalog))).lore.map { it.plainText.replace("\u200C", "") }
        assertTrue(lines.any { it.trimEnd().endsWith("Charges") && it.startsWith("3 · ") }, lines.toString())
    }

    @Test
    fun `row rule fragment and hiding YAML is strict`() {
        enableTravelToken()
        val invalid = listOf(
            COMPOSITION_YAML.replace("- literal: \" · \"", "- literal: \" · \"\n              message: data.charges.label"),
            COMPOSITION_YAML.replace("- literal: \" · \"", "- text: \" · \""),
            COMPOSITION_YAML.replace("weight: 2", "weight: low"),
            COMPOSITION_YAML.replace("weight: 2", "weight: 2\n          collapse: true"),
            COMPOSITION_YAML.replace("weight: never", "weight: never\n          summary:\n            slot: more\n            glyph: icon.region"),
        )
        invalid.forEach { yaml ->
            copyBundledResources()
            enableTravelToken()
            replace("items/examples.yml", TRAVEL_DESCRIPTION, yaml)
            assertThrows(StrictYamlException::class.java, { load() }, yaml)
        }
        copyBundledResources()
        replace("layouts/plain.yml", "        gap-after-pixels: 0\n", "        gap-after-pixels: 0\n    overflow: drop\n")
        assertThrows(StrictYamlException::class.java) { load() }
        copyBundledResources()
        replace("themes/default.yml", "    icons:\n", "    rules:\n      thickness: 2\n    icons:\n")
        assertThrows(StrictYamlException::class.java) { load() }
    }

    @Test
    fun `theme fallback cycle rejects the candidate`() {
        replace(
            "themes/vanilla-frame.yml",
            "fallback: itemerness:default",
            "fallback: itemerness:vanilla-frame",
        )

        val compilation = load().compilation

        assertTrue(!compilation.successful)
        assertTrue(compilation.diagnostics.any { it.code == PresentationDiagnosticCode.REFERENCE_CYCLE })
    }

    @Test
    fun `raw private-use glyph outside registry is rejected`() {
        replace("locales/en_us.yml", "Harbor Travel Token", "Harbor \uE000 Travel Token")

        assertThrows(StrictYamlException::class.java, ::load)
    }

    @Test
    fun `layout over hard pixel budget rejects the candidate`() {
        replace("layouts/plain.yml", "maximum-pixels: 220", "maximum-pixels: 221")

        val compilation = load().compilation

        assertTrue(!compilation.successful)
        assertTrue(compilation.diagnostics.any { it.code == PresentationDiagnosticCode.BUDGET_EXCEEDED })
    }

    @Test
    fun `duplicate identifier rejects the candidate`() {
        Files.copy(
            directory.resolve("formats/default.yml"),
            directory.resolve("formats/duplicate.yml"),
            StandardCopyOption.REPLACE_EXISTING,
        )

        val compilation = load().compilation

        assertTrue(!compilation.successful)
        assertTrue(compilation.diagnostics.any { it.code == PresentationDiagnosticCode.DUPLICATE_ID })
    }

    @Test
    fun `unsupported source schema version is rejected`() {
        replace("formats/default.yml", "schema-version: 1", "schema-version: 2")

        assertThrows(StrictYamlException::class.java, ::load)
    }

    private fun load(
        defaultLayout: ItemKey? = null,
        defaultTheme: ItemKey? = null,
        clientVersion: String = "26.1.2",
    ): LoadedPresentationSource {
        val catalog = CatalogSourceLoader().load(directory)
        return PresentationSourceLoader(BuiltinFontMetricsLoader.bundled(clientVersion)).loadAndCompile(
            root = directory,
            catalog = catalog,
            defaultLocale = "en_us",
            defaultLayout = defaultLayout,
            defaultTheme = defaultTheme,
            revision = 7,
        )
    }

    private fun replace(path: String, old: String, new: String) {
        val destination = directory.resolve(path)
        val original = Files.readString(destination)
        check(old in original) { "Fixture text not found in $path: $old" }
        Files.writeString(destination, original.replace(old, new))
    }

    private fun enableTravelToken() {
        replace("items/examples.yml", "  travel-token:\n    enabled: false", "  travel-token:\n    enabled: true")
    }

    private fun renderTravelToken(engine: PresentationEngine): PresentationDisplay {
        val result = engine.render(
            PresentationRenderRequest(
                itemKey = ItemKey.parse("itemerness:travel-token"),
                data = mapOf(DataKey.parse("example:charges") to IntegerDataValue(3)),
                viewer = PresentationViewer("en_us", requestedTheme = ItemKey.parse("itemerness:default")),
            ),
        )
        return assertInstanceOf(PresentationRenderResult.Rendered::class.java, result).display
    }

    private fun copyBundledResources() = copyBundledResourcesFromIndex()

    private fun enableNestedSatchel() {
        replace(
            "items/examples.yml",
            "  nested-satchel:\n    enabled: false",
            "  nested-satchel:\n    enabled: true",
        )
    }

    private fun renderNested(engine: PresentationEngine, locale: String): PresentationDisplay {
        val result = engine.render(
            PresentationRenderRequest(
                itemKey = ItemKey.parse("itemerness:nested-satchel"),
                data = emptyMap(),
                viewer = PresentationViewer(locale),
            ),
        )
        return assertInstanceOf(PresentationRenderResult.Rendered::class.java, result).display
    }

    private fun copyResource(path: String) {
        val destination = directory.resolve(path)
        Files.createDirectories(destination.parent)
        checkNotNull(javaClass.classLoader.getResourceAsStream(path)).use { input ->
            Files.copy(input, destination, StandardCopyOption.REPLACE_EXISTING)
        }
    }

    private companion object {
        const val TRAVEL_DESCRIPTION = "        - type: description\n          message: item.travel-token.description\n"
        val GROUP_YAML = """
        - type: group
          header:
            type: field
            label: data.charges.label
            data: example:charges
            format: itemerness:integer
            separator: none
          marker: tree
          when-empty: hide
          children:
            - type: description
              message: item.travel-token.description
            - type: field
              label: data.charges.label
              data: example:charges
              format: itemerness:integer
""".trimStart('\n')
        val COMPOSITION_YAML = """
        - type: rule
          weight: never
          title:
            - message: data.charges.label
        - type: row
          weight: 2
          left:
            - data: example:charges
              format: itemerness:integer
            - literal: " · "
          right:
            - message: data.charges.label
""".trimStart('\n')
        val SELECTOR_YAML = """
            schema-version: 1
            theme-selectors:
              example:charge-frame:
                cases:
                  - when:
                      operator: greater-than-or-equal
                      left:
                        data: example:charges
                      right:
                        literal: 3
                    theme: itemerness:default
                default: itemerness:vanilla-frame
        """.trimIndent() + "\n"
    }
}
