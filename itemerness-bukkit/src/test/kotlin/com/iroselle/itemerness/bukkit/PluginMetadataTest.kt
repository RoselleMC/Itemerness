package com.iroselle.itemerness.bukkit

import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.yaml.snakeyaml.LoaderOptions
import org.yaml.snakeyaml.Yaml
import org.yaml.snakeyaml.constructor.SafeConstructor

class PluginMetadataTest {
    @Test
    fun `declares the common Folia Canvas and PlaceholderAPI contract`() {
        val metadata = resource("plugin.yml")

        assertTrue("folia-supported: true" in metadata)
        assertTrue("PlaceholderAPI" in metadata)
        assertTrue(Regex("(?m)^api-version: '[^']+'$").containsMatchIn(metadata))
        assertFalse(Regex("(?m)^commands:").containsMatchIn(metadata))
        assertFalse("${'$'}{" in metadata)
    }

    @Test
    fun `packages canonical NBT and projection policy`() {
        val configuration = resource("config.yml")
        val dataKeys = resource("data-keys/common.yml")

        assertTrue("config-version: 3" in configuration)
        assertTrue("minecraft:custom_data.itemerness" in configuration)
        assertTrue("editor:" in configuration)
        assertTrue("mode: fallback-read-only" in dataKeys)
        assertTrue("placeholder-api:" in dataKeys)
    }

    @Test
    fun `indexes every first run resource without unsafe paths`() {
        val entries = BundledResources.parseIndex(resource(BundledResources.INDEX_PATH))

        assertTrue(entries.size >= 17)
        assertTrue("items/examples.yml" in entries)
        assertTrue("themes/vanilla-frame.yml" in entries)
        assertTrue("themes/aurora-canvas.yml" in entries)
        assertTrue("assets/bitmaps.yml" in entries)
        assertTrue("access.yml" in entries)
        assertTrue("examples/canonical-items.snbt" in entries)
        assertFalse("projection.yml" in entries)
        assertFalse("placeholders.yml" in entries)
        assertFalse("commands.yml" in entries)
        assertFalse("validation.yml" in entries)
        assertFalse("diagnostics.yml" in entries)
        entries.forEach { path ->
            assertNotNull(javaClass.classLoader.getResource(path), path)
        }
    }

    @Test
    fun `keeps the global configuration intentionally small`() {
        val configuration = resource("config.yml")

        assertFalse("sources:" in configuration)
        assertFalse("compatibility-readers:" in configuration)
        assertFalse("limits:" in configuration)
        assertFalse("refresh:" in configuration)
        assertFalse("fallback:" in configuration)
    }

    @Test
    fun `persists installed resource paths without changing their order`() {
        val paths = listOf("themes/default.yml", "examples/canonical-items.snbt")
        val rendered = BundledResources.renderState(paths)

        assertTrue(rendered.startsWith("# Paths already installed"))
        assertTrue(paths == BundledResources.parseState(rendered))
    }

    @Test
    fun `packages examples for every presentation path without canonical lore`() {
        val items = resource("items/examples.yml")
        val canonicalItems = resource("examples/canonical-items.snbt")

        assertTrue("mode: fungible" in items)
        assertTrue("mode: unique" in items)
        assertTrue("type: conditional" in items)
        assertTrue("type: repeat" in items)
        assertTrue("nested-items: recursive" in items)
        assertTrue("theme: itemerness:default" in items)
        assertTrue("theme: itemerness:vanilla-frame" in items)
        assertTrue("theme: itemerness:ember" in items)
        assertTrue("theme: itemerness:segmented" in items)
        assertTrue("theme: itemerness:aurora-canvas" in items)
        assertTrue("minecraft:custom_data" in canonicalItems)
        assertFalse("minecraft:lore" in canonicalItems)
        assertFalse("PublicBukkitValues" in canonicalItems)
    }

    @Test
    fun `keeps protocol surfaces internal and placeholder exposure on data keys`() {
        val entries = BundledResources.parseIndex(resource(BundledResources.INDEX_PATH))
        val dataKeys = resource("data-keys/common.yml")

        assertFalse(entries.any { it.startsWith("internal/") })
        assertFalse(BundledResources.STATE_FILE_NAME in entries)
        assertTrue("exposed: false" in dataKeys)
        assertTrue("exposed: true" in dataKeys)
    }

    @Test
    fun `keeps raw private use glyphs out of authored content`() {
        val authoredPaths = BundledResources.parseIndex(resource(BundledResources.INDEX_PATH))
            .filter { path ->
                path.startsWith("items/") ||
                    path.startsWith("layouts/") ||
                    path.startsWith("themes/") ||
                    path.startsWith("locales/")
            }

        authoredPaths.forEach { path ->
            val content = resource(path)
            assertFalse("<font:" in content, "$path contains a raw MiniMessage font tag")
            assertFalse(
                content.codePoints().anyMatch(::isPrivateUseCodePoint),
                "$path contains a raw private-use code point",
            )
        }
    }

    @Test
    fun `parses every bundled YAML document in strict mode`() {
        val options = LoaderOptions().apply {
            isAllowDuplicateKeys = false
            maxAliasesForCollections = 0
        }
        val yaml = Yaml(SafeConstructor(options))
        val entries = BundledResources.parseIndex(resource(BundledResources.INDEX_PATH))
            .filter { it.endsWith(".yml") }
            .plus("config.yml")
            .plus("plugin.yml")
            .plus("META-INF/itemerness/nms/26.1.2/surfaces.yml")

        entries.forEach { path ->
            val document = yaml.load<Any>(resource(path))
            assertTrue(document is Map<*, *>, "$path must contain a YAML mapping")
        }
    }

    private fun resource(path: String): String =
        checkNotNull(javaClass.classLoader.getResource(path)) {
            "Missing test resource: $path"
        }.readText(Charsets.UTF_8)

    private fun isPrivateUseCodePoint(codePoint: Int): Boolean =
        codePoint in 0xE000..0xF8FF ||
            codePoint in 0xF0000..0xFFFFD ||
            codePoint in 0x100000..0x10FFFD
}
