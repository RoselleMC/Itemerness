package com.iroselle.itemerness.bukkit.presentation

import com.iroselle.itemerness.api.DataKey
import com.iroselle.itemerness.api.DecimalDataValue
import com.iroselle.itemerness.api.IntegerDataValue
import com.iroselle.itemerness.api.LongDataValue
import com.iroselle.itemerness.api.ItemKey
import com.iroselle.itemerness.bukkit.catalog.CatalogSourceLoader
import com.iroselle.itemerness.core.catalog.CatalogCompiler
import com.iroselle.itemerness.core.presentation.NestedItemPresentation
import com.iroselle.itemerness.core.presentation.PresentationLine
import com.iroselle.itemerness.core.presentation.PresentationRenderRequest
import com.iroselle.itemerness.core.presentation.PresentationRenderResult
import com.iroselle.itemerness.core.presentation.PresentationViewer
import com.iroselle.itemerness.core.presentation.PresentationEngine
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import java.util.HexFormat

/**
 * Proves that presentation changes keep every bundled example byte-identical.
 *
 * The digests were captured from the engine before recursive groups and configurable field
 * separators existed. Configurations that do not use those features must keep rendering the exact
 * same runs, widths and bounds for every supported client metric revision, theme path, locale,
 * viewer shape, and data shape. Set ITEMERNESS_UPDATE_PRESENTATION_COMPATIBILITY=1 only when an
 * intentional rendering change is reviewed.
 */
class PresentationCompatibilityTest {
    @TempDir
    lateinit var directory: Path

    @Test
    fun `bundled examples render byte-identically to the captured engine output`() {
        copyBundledResources()
        replace("items/examples.yml", "enabled: false", "enabled: true")
        val actual = LinkedHashMap<String, String>()
        CLIENT_VERSIONS.forEach { version -> renderVersion(version, version, actual) }
        // Vertical gaps exercise the empty-line paths between every block.
        replace("layouts/plain.yml", "gap-after-pixels: 0", "gap-after-pixels: 10")
        replace("layouts/equipment.yml", "gap-after-pixels: 0", "gap-after-pixels: 20")
        renderVersion("26.1.2", "gapped-26.1.2", actual)
        assertTrue(actual.size > 1_000, "Too few compatibility cases: ${actual.size}")
        val baseline = Path.of("src/test/resources/presentation-compatibility/bundled-examples.txt")
        val encoded = actual.entries.joinToString("\n", postfix = "\n") { (key, digest) -> "$key $digest" }
        if (System.getenv("ITEMERNESS_UPDATE_PRESENTATION_COMPATIBILITY") == "1") {
            Files.createDirectories(baseline.parent)
            Files.writeString(baseline, encoded)
        }
        val expected = Files.readAllLines(baseline).filter(String::isNotBlank).associate { line ->
            line.substringBeforeLast(' ') to line.substringAfterLast(' ')
        }
        assertEquals(expected.keys, actual.keys, "Compatibility case set changed")
        val changed = expected.keys.filter { expected[it] != actual[it] }
        assertTrue(changed.isEmpty(), "Rendering changed for ${changed.size} cases, first: ${changed.take(5)}")
    }

    private fun renderVersion(version: String, label: String, output: MutableMap<String, String>) {
        val loadedCatalog = CatalogSourceLoader().load(directory)
        val domainCompilation = CatalogCompiler().compile(loadedCatalog.source)
        assertTrue(domainCompilation.successful, domainCompilation.diagnostics.joinToString())
        val domain = requireNotNull(domainCompilation.candidate).materialize(17)
        val loaded = PresentationSourceLoader(BuiltinFontMetricsLoader.bundled(version)).loadAndCompile(
            root = directory,
            catalog = loadedCatalog,
            defaultLocale = "en_us",
            revision = 7,
        )
        val catalog = requireNotNull(loaded.compilation.catalog) { loaded.compilation.diagnostics.joinToString() }
        val engine = PresentationEngine(catalog)
        val profile = catalog.assetProfiles.getValue(ItemKey.parse("itemerness:example-pack-v1"))
        val requestedThemes = listOf<ItemKey?>(null) + catalog.themes.keys + catalog.themeSelectors.keys
        catalog.items.keys.forEach { itemKey ->
            val full = LinkedHashMap(domain.createInstance(itemKey).data)
            full[DataKey.parse("example:required-level")] = IntegerDataValue(12)
            // Generated instance values would make the captured output nondeterministic.
            full.replaceAll { key, value ->
                when (key) {
                    DataKey.parse("example:attack-damage") -> DecimalDataValue(38.4)
                    DataKey.parse("itemerness:created-at") -> LongDataValue(1_700_000_000_000)
                    else -> value
                }
            }
            val sparse = LinkedHashMap(full).apply {
                OPTIONAL_DATA.forEach(::remove)
            }
            listOf("en_us", "zh_cn").forEach { locale ->
                val nested = if (itemKey == ItemKey.parse("itemerness:nested-satchel")) {
                    listOf(
                        NestedItemPresentation(
                            ItemKey.parse("itemerness:travel-token"),
                            engine.itemDisplayName(ItemKey.parse("itemerness:travel-token"), locale).getOrThrow(),
                            2,
                        ),
                        NestedItemPresentation(
                            ItemKey.parse("itemerness:ember-blade"),
                            engine.itemDisplayName(ItemKey.parse("itemerness:ember-blade"), locale).getOrThrow(),
                            1,
                        ),
                    )
                } else {
                    emptyList()
                }
                requestedThemes.forEach { theme ->
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
                        "unmanaged" to PresentationViewer(
                            locale = locale,
                            requestedTheme = theme,
                            assetProfile = profile.id,
                            capabilities = profile.capabilities,
                            metricsRevision = profile.metricsRevision,
                            facts = mapOf(ItemKey.parse("example:level") to IntegerDataValue(5)),
                            resourcePackLoaded = true,
                        ),
                        "vanilla" to PresentationViewer(
                            locale = locale,
                            requestedTheme = theme,
                            facts = mapOf(ItemKey.parse("example:level") to IntegerDataValue(20)),
                        ),
                    )
                    viewers.forEach { (viewerName, viewer) ->
                        mapOf("full" to full, "sparse" to sparse).forEach { (dataName, data) ->
                            val result = engine.render(PresentationRenderRequest(itemKey, data, viewer, nested))
                            output["$label|$itemKey|$locale|${theme ?: "item"}|$viewerName|$dataName"] = digest(describe(result))
                        }
                    }
                }
            }
        }
    }

    private fun copyBundledResources() {
        val paths = checkNotNull(javaClass.classLoader.getResourceAsStream("itemerness-resources.txt"))
            .bufferedReader()
            .useLines { lines ->
                lines.map(String::trim)
                    .filter { it.isNotEmpty() && !it.startsWith("#") }
                    .filter { it.endsWith(".yml") }
                    .toList()
            }
        paths.forEach { path ->
            val destination = directory.resolve(path)
            Files.createDirectories(destination.parent)
            checkNotNull(javaClass.classLoader.getResourceAsStream(path)).use { input ->
                Files.copy(input, destination, StandardCopyOption.REPLACE_EXISTING)
            }
        }
    }

    private fun replace(path: String, old: String, new: String) {
        val destination = directory.resolve(path)
        val original = Files.readString(destination)
        check(old in original) { "Fixture text not found in $path: $old" }
        Files.writeString(destination, original.replace(old, new))
    }

    companion object {
        private val CLIENT_VERSIONS = listOf("1.21.11", "26.1.1", "26.1.2", "26.2", "26.3")
        private val OPTIONAL_DATA = listOf(
            DataKey.parse("example:region"),
            DataKey.parse("example:quality"),
            DataKey.parse("example:custom-label"),
        )

        /** A canonical, exhaustive text form of a render result: every run, width, and bound. */
        fun describe(result: PresentationRenderResult): String = when (result) {
            is PresentationRenderResult.Rejected -> "rejected ${result.failure.code} ${result.failure.message}"
            is PresentationRenderResult.Rendered -> buildString {
                val display = result.display
                append("renderer=").append(display.renderer).append('\n')
                append("selected=").append(display.selectedTheme).append(" requested=").append(display.requestedTheme).append('\n')
                append("tooltip=").append(display.tooltipStyle).append('\n')
                display.fallbackReasons.forEach { append("fallback=").append(it).append('\n') }
                append("name=").append(line(display.displayName)).append('\n')
                display.lore.forEach { append("lore=").append(line(it)).append('\n') }
            }
        }

        private fun line(line: PresentationLine): String = line.toString()

        fun digest(value: String): String =
            HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value.toByteArray(Charsets.UTF_8)))
    }
}
