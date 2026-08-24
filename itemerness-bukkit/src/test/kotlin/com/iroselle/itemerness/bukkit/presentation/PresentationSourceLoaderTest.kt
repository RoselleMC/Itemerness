package com.iroselle.itemerness.bukkit.presentation

import com.iroselle.itemerness.api.DataKey
import com.iroselle.itemerness.api.IntegerDataValue
import com.iroselle.itemerness.api.ItemKey
import com.iroselle.itemerness.bukkit.catalog.CatalogSourceLoader
import com.iroselle.itemerness.bukkit.config.StrictYamlException
import com.iroselle.itemerness.core.catalog.CatalogCompiler
import com.iroselle.itemerness.core.presentation.NestedItemPresentation
import com.iroselle.itemerness.core.presentation.MissingDataPolicy
import com.iroselle.itemerness.core.presentation.PresentationDisplay
import com.iroselle.itemerness.core.presentation.PresentationDiagnosticCode
import com.iroselle.itemerness.core.presentation.PresentationEngine
import com.iroselle.itemerness.core.presentation.PresentationRenderRequest
import com.iroselle.itemerness.core.presentation.PresentationRenderResult
import com.iroselle.itemerness.core.presentation.PresentationViewer
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
    fun copyBundledResources() {
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
        listOf("1.21.11", "26.1.1", "26.1.2", "26.2").forEach { version ->
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
}
