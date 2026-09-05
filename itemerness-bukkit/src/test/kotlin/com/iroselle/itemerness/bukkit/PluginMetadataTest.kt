package com.iroselle.itemerness.bukkit

import org.junit.jupiter.api.Assertions.assertEquals
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
    fun `packages storage metadata and projection policy`() {
        val configuration = resource("config.yml")
        val dataKeys = resource("data-keys/storage.yml")

        assertTrue("config-version: 3" in configuration)
        assertTrue("minecraft:custom_data.itemerness" in configuration)
        assertTrue("editor:" in configuration)
        assertTrue("itemerness:created-at" in dataKeys)
        assertTrue("placeholder-api:" in dataKeys)
        assertFalse("example:" in dataKeys)
    }

    @Test
    fun `indexes every first run resource without unsafe paths`() {
        val entries = BundledResources.parseIndex(resource(BundledResources.INDEX_PATH))

        assertTrue(entries.size >= 14)
        assertTrue("data-keys/storage.yml" in entries)
        assertTrue("viewer-facts/runtime.yml" in entries)
        assertFalse("items/examples.yml" in entries)
        assertTrue("themes/vanilla-frame.yml" in entries)
        assertTrue("themes/aurora-canvas.yml" in entries)
        assertTrue("assets/bitmaps.yml" in entries)
        assertTrue("access.yml" in entries)
        assertFalse("examples/canonical-items.snbt" in entries)
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
    fun `does not install an Itemerness gameplay catalog`() {
        val entries = BundledResources.parseIndex(resource(BundledResources.INDEX_PATH))

        assertFalse(entries.any { it.startsWith("items/") })
        assertFalse(entries.any { it.startsWith("examples/") })
    }

    @Test
    fun `keeps protocol surfaces internal and placeholder exposure on data keys`() {
        val entries = BundledResources.parseIndex(resource(BundledResources.INDEX_PATH))
        val dataKeys = resource("data-keys/storage.yml")

        assertFalse(entries.any { it.startsWith("internal/") })
        assertFalse(BundledResources.STATE_FILE_NAME in entries)
        assertTrue("exposed: false" in dataKeys)
        assertFalse("example:" in dataKeys)
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
        val yaml = strictYaml()
        val entries = BundledResources.parseIndex(resource(BundledResources.INDEX_PATH))
            .filter { it.endsWith(".yml") }
            .plus("config.yml")
            .plus("plugin.yml")
            .plus(NMS_SURFACE_PATHS.values)

        entries.forEach { path ->
            val document = yaml.load<Any>(resource(path))
            assertTrue(document is Map<*, *>, "$path must contain a YAML mapping")
        }
    }

    @Test
    fun `packages a strict surface manifest for every supported NMS ABI`() {
        val yaml = strictYaml()

        NMS_SURFACE_PATHS.forEach { (minecraftVersion, path) ->
            val document = yaml.load<Map<String, Any?>>(resource(path))
            assertEquals(1, document["schema-version"], path)
            assertEquals(minecraftVersion, document["minecraft-version"], path)
            assertEquals(
                "itemerness-nms-${minecraftVersion.replace('.', '_')}",
                document["adapter-module"],
                path,
            )
            assertEquals("release-ready-exact-version", document["coverage-status"], path)
            assertEquals(true, document["release-gate-enabled"], path)
        }
    }

    private fun strictYaml(): Yaml {
        val options = LoaderOptions().apply {
            isAllowDuplicateKeys = false
            maxAliasesForCollections = 0
        }
        return Yaml(SafeConstructor(options))
    }

    private fun resource(path: String): String =
        checkNotNull(javaClass.classLoader.getResource(path)) {
            "Missing test resource: $path"
        }.readText(Charsets.UTF_8)

    private fun isPrivateUseCodePoint(codePoint: Int): Boolean =
        codePoint in 0xE000..0xF8FF ||
            codePoint in 0xF0000..0xFFFFD ||
            codePoint in 0x100000..0x10FFFD

    private companion object {
        val NMS_SURFACE_PATHS = linkedMapOf(
            "1.21.11" to "META-INF/itemerness/nms/1.21.11/surfaces.yml",
            "26.1.1" to "META-INF/itemerness/nms/26.1.1/surfaces.yml",
            "26.1.2" to "META-INF/itemerness/nms/26.1.2/surfaces.yml",
            "26.2" to "META-INF/itemerness/nms/26.2/surfaces.yml",
        )
    }
}
