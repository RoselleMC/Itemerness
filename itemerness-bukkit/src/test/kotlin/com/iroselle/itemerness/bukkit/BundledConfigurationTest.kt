package com.iroselle.itemerness.bukkit

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.yaml.snakeyaml.LoaderOptions
import org.yaml.snakeyaml.Yaml
import org.yaml.snakeyaml.constructor.SafeConstructor

class BundledConfigurationTest {
    private val yaml = Yaml(
        SafeConstructor(
            LoaderOptions().apply {
                isAllowDuplicateKeys = false
                maxAliasesForCollections = 0
            },
        ),
    )

    @Test
    fun `cross references the internal protocol item fixture`() {
        val dataKeyDocument = document("data-keys/common.yml")
        val dataKeys = mapping(dataKeyDocument["keys"], "data keys")
        val schemaId = requiredString(dataKeyDocument, "id", "data-key schema")
        val viewerFacts = mapping(
            document("viewer-facts/common.yml")["facts"],
            "fixture viewer facts",
        )
        val formats = mergedSection("formats/", "formats")
        val layouts = mergedSection("layouts/", "layouts")
        val themes = mergedSection("themes/", "themes")
        val fonts = mergedSection("assets/fonts.yml", "fonts")
        val glyphs = mergedSection("assets/glyphs.yml", "glyphs")
        val bitmaps = mergedSection("assets/bitmaps.yml", "bitmaps")
        val assetProfiles = mergedSection("assets/bitmaps.yml", "asset-profiles")
        val localeMessages = localeMessages()
        val itemDocument = document("items/examples.yml")
        val namespace = requiredString(itemDocument, "namespace", "item namespace")
        val items = mapping(itemDocument["items"], "items")
        val definedItemIds = items.keys.mapTo(mutableSetOf()) { key -> "$namespace:$key" }
        val references = References()

        assertEquals(5, items.size)
        items.forEach { (path, rawItem) ->
            val item = mapping(rawItem, "item $path")
            assertFalse(item["enabled"] as? Boolean ?: true, "$path must remain disabled")

            val instance = mapping(item["instance"], "$path instance")
            strings(instance["schemas"], "$path schemas").forEach { schema ->
                assertEquals(schemaId, schema.substringBefore('@'), "$path schema")
            }
            mappingOrEmpty(instance["defaults"]).keys.forEach(references.dataKeys::add)
            mappingOrEmpty(instance["generate-on-create"]).keys.forEach(references.dataKeys::add)
            mappingOrEmpty(item["definition-data"]).keys.forEach(references.dataKeys::add)

            val presentation = mapping(item["presentation"], "$path presentation")
            references.layouts += requiredString(presentation, "layout", "$path layout")
            references.themes += requiredString(presentation, "theme", "$path theme")
            collectReferences(presentation, references)

            listOrEmpty(item["contents"]).forEach { rawContent ->
                val content = mapping(rawContent, "$path content")
                val referencedItem = requiredString(content, "item", "$path content item")
                assertTrue(referencedItem in definedItemIds, "$path references $referencedItem")
            }
        }

        collectFormatMessages(formats, references.messages)
        assertTrue(dataKeys.keys.containsAll(references.dataKeys), missing("data keys", references.dataKeys, dataKeys.keys))
        assertTrue(viewerFacts.keys.containsAll(references.viewerFacts), missing("viewer facts", references.viewerFacts, viewerFacts.keys))
        assertTrue(formats.keys.containsAll(references.formats), missing("formats", references.formats, formats.keys))
        assertTrue(layouts.keys.containsAll(references.layouts), missing("layouts", references.layouts, layouts.keys))
        assertTrue(themes.keys.containsAll(references.themes), missing("themes", references.themes, themes.keys))
        assertTrue(glyphs.keys.containsAll(references.glyphs), missing("glyphs", references.glyphs, glyphs.keys))

        localeMessages.forEach { (locale, messages) ->
            assertTrue(messages.keys.containsAll(references.messages), missing("$locale messages", references.messages, messages.keys))
        }

        validateDataSources(dataKeys)
        validatePlaceholderExposure(dataKeys, formats)
        validateLocalizedNamespacedValues(items, dataKeys, localeMessages)
        validateViewerFacts(viewerFacts)
        validateThemes(themes, fonts, glyphs, bitmaps, assetProfiles)
        validateResourceFreeFrame(themes)
        validateDefaults(layouts, themes)
    }

    @Test
    fun `production resources contain storage and rendering context but no ITN RPG content`() {
        val entries = resourcePaths()
        val storage = mapping(document("data-keys/storage.yml")["keys"], "storage keys")
        val runtimeFacts = mapping(
            document("viewer-facts/runtime.yml")["facts"],
            "runtime facts",
        )

        assertTrue(storage.keys.all { it.startsWith("itemerness:") })
        assertTrue(runtimeFacts.keys.all { it.startsWith("itemerness:") })
        assertFalse(entries.any { it == "items/examples.yml" })
        assertFalse(entries.any { it == "data-keys/common.yml" })
        assertFalse(entries.any { it == "viewer-facts/common.yml" })
        assertFalse(entries.any { it.startsWith("examples/") })
    }

    private fun validateViewerFacts(viewerFacts: Map<String, Any?>) {
        val theme = mapping(viewerFacts["itemerness:theme"], "viewer theme fact")
        assertEquals(true, theme["nullable"], "absence must preserve each item's configured theme")
        assertFalse("default" in theme, "a viewer theme default would override every item theme")

        val resourcePack = mapping(
            viewerFacts["itemerness:resource-pack-ready"],
            "resource pack readiness fact",
        )
        assertFalse("api" in strings(resourcePack["providers"], "resource pack providers"))
    }

    private fun validateDataSources(dataKeys: Map<String, Any?>) {
        dataKeys.forEach { (id, rawDefinition) ->
            val definition = mapping(rawDefinition, "data key $id")
            val scope = requiredString(definition, "scope", "$id scope")
            val sources = listOrEmpty(definition["read-sources"])
            val expectedFirst = if (scope == "definition") "catalog-definition" else "canonical-nbt"
            assertEquals(expectedFirst, sources.firstOrNull(), "$id read source precedence")
            if (sources.drop(1).any { source -> source is Map<*, *> && "pdc" in source }) {
                assertEquals("canonical-nbt", sources.first(), "$id PDC must be fallback-only")
            }
        }
    }

    private fun validatePlaceholderExposure(
        dataKeys: Map<String, Any?>,
        formats: Map<String, Any?>,
    ) {
        val scalarTypes = setOf("boolean", "integer", "long", "decimal", "string", "uuid", "namespaced-key")
        dataKeys.forEach { (id, rawDefinition) ->
            val definition = mapping(rawDefinition, "data key $id")
            val placeholder = mapping(definition["placeholder-api"], "$id placeholder exposure")
            if (placeholder["exposed"] == true) {
                assertTrue(definition["type"] in scalarTypes, "$id exposes a complex placeholder value")
                (placeholder["formatter"] as? String)?.let { formatter ->
                    assertTrue(formatter in formats, "$id placeholder formatter $formatter")
                }
            }
        }
    }

    private fun validateLocalizedNamespacedValues(
        items: Map<String, Any?>,
        dataKeys: Map<String, Any?>,
        localeMessages: Map<String, Map<String, Any?>>,
    ) {
        val values = mutableSetOf<String>()
        dataKeys.forEach { (_, rawDefinition) ->
            val definition = mapping(rawDefinition, "data key")
            if (definition["type"] == "namespaced-key") {
                (definition["default"] as? String)?.let(values::add)
                val constraints = mappingOrEmpty(definition["constraints"])
                listOrEmpty(constraints["allowed"]).filterIsInstance<String>().forEach(values::add)
            }
        }
        items.values.forEach { rawItem ->
            val item = mapping(rawItem, "item")
            val defaults = mappingOrEmpty(mapping(item["instance"], "instance")["defaults"])
            defaults.forEach { (dataKey, value) ->
                val definition = mapping(dataKeys[dataKey], "data key $dataKey")
                if (definition["type"] == "namespaced-key" && value is String) {
                    values += value
                }
            }
        }

        val requiredMessages = values.mapTo(mutableSetOf()) { value ->
            val (namespace, path) = value.split(':', limit = 2)
            "value.$namespace.$path"
        }
        localeMessages.forEach { (locale, messages) ->
            assertTrue(messages.keys.containsAll(requiredMessages), missing("$locale localized values", requiredMessages, messages.keys))
        }
    }

    private fun validateThemes(
        themes: Map<String, Any?>,
        fonts: Map<String, Any?>,
        glyphs: Map<String, Any?>,
        bitmaps: Map<String, Any?>,
        assetProfiles: Map<String, Any?>,
    ) {
        val capabilities = assetProfiles.values.flatMapTo(mutableSetOf()) { rawProfile ->
            strings(mapping(rawProfile, "asset profile")["capabilities"], "profile capabilities")
        }

        themes.forEach { (id, rawTheme) ->
            val theme = mapping(rawTheme, "theme $id")
            (theme["fallback"] as? String)?.let { fallback ->
                assertTrue(fallback in themes, "$id fallback $fallback")
            }
            stringsOrEmpty(theme["requires-capabilities"]).forEach { capability ->
                assertTrue(capability in capabilities, "$id capability $capability")
            }
            mappingOrEmpty(theme["fonts"]).forEach { (role, font) ->
                assertTrue(font in fonts, "$id $role font $font")
            }

            collectStrings(theme).filter { value -> value.startsWith("frame.segment.") }.forEach { glyph ->
                assertTrue(glyph in glyphs, "$id frame glyph $glyph")
            }

            val layers = listOrEmpty(mappingOrEmpty(theme["canvas"])["layers"])
            layers.forEach { rawLayer ->
                val layer = mapping(rawLayer, "$id canvas layer")
                val glyphId = requiredString(layer, "asset", "$id layer asset")
                val glyph = mapping(glyphs[glyphId], "glyph $glyphId")
                val bitmapId = requiredString(glyph, "bitmap", "$glyphId bitmap")
                val bitmap = mapping(bitmaps[bitmapId], "bitmap $bitmapId")
                assertEquals(bitmap["baseline-variant"], layer["baseline-variant"], "$id layer baseline")
            }
        }

        glyphs.forEach { (id, rawGlyph) ->
            val glyph = mapping(rawGlyph, "glyph $id")
            (glyph["bitmap"] as? String)?.let { bitmap ->
                assertTrue(bitmap in bitmaps, "$id bitmap $bitmap")
            }
        }

        val bindings = mergedSection("assets/bitmaps.yml", "resource-pack-bindings")
        bindings.forEach { (id, rawBinding) ->
            val binding = mapping(rawBinding, "resource-pack binding $id")
            assertFalse(binding["enabled"] as? Boolean ?: true, "$id example binding must be disabled")
            assertTrue(requiredString(binding, "sha1", "$id sha1").matches(Regex("[0-9a-f]{40}")), "$id sha1")
            assertTrue(requiredString(binding, "asset-profile", "$id profile") in assetProfiles, "$id asset profile")
        }

        themes.keys.forEach { start ->
            val visited = mutableSetOf<String>()
            var current = start
            while (true) {
                assertTrue(visited.add(current), "$start has a fallback cycle at $current")
                val theme = mapping(themes[current], "theme $current")
                val fallback = theme["fallback"] as? String
                if (fallback == null) {
                    assertEquals("plain", theme["renderer"], "$start fallback must terminate at plain")
                    break
                }
                assertTrue(fallback in themes, "$current fallback $fallback")
                current = fallback
            }
        }
    }

    private fun validateResourceFreeFrame(themes: Map<String, Any?>) {
        val theme = mapping(themes["itemerness:vanilla-frame"], "vanilla character frame")
        assertEquals("vanilla-character-frame", theme["renderer"])
        assertFalse(theme["requires-resource-pack"] as? Boolean ?: true)
        assertTrue(stringsOrEmpty(theme["requires-capabilities"]).isEmpty())
        assertEquals("preserve-outside-frame", theme["vanilla-tooltip-lines"])

        val frame = mapping(theme["frame"], "vanilla character frame")
        assertEquals("unicode-single", frame["preset"])
        assertEquals("managed-lore", frame["scope"])
        assertEquals(3, frame["alignment-tolerance-pixels"])

        val fonts = mapping(theme["fonts"], "vanilla character fonts")
        assertEquals("minecraft:uniform", fonts["text"])
        assertEquals("minecraft:uniform", fonts["frame"])
        assertFalse(collectStrings(theme).any { value -> value.codePoints().anyMatch(::isPrivateUseCodePoint) })
    }

    private fun validateDefaults(
        layouts: Map<String, Any?>,
        themes: Map<String, Any?>,
    ) {
        val configuration = document("config.yml")
        val presentation = mapping(configuration["presentation"], "default presentation")
        assertTrue(requiredString(presentation, "default-layout", "default layout") in layouts)
        assertTrue(requiredString(presentation, "default-theme", "default theme") in themes)

        val editor = mapping(configuration["editor"], "editor pairing")
        assertEquals("", requiredString(editor, "url", "editor URL"))
        assertEquals("", requiredString(editor, "token", "editor token"))

        val access = mapping(document("access.yml")["api"], "API access")
        assertTrue(listOrEmpty(access["grants"]).isEmpty(), "default API grants must be empty")
    }

    private fun collectFormatMessages(formats: Map<String, Any?>, messages: MutableSet<String>) {
        val messageKeys = setOf("suffix-message", "true-message", "false-message", "separator-message")
        formats.values.forEach { rawFormat ->
            mapping(rawFormat, "format").forEach { (key, value) ->
                if (key in messageKeys && value is String) messages += value
            }
        }
    }

    private fun collectReferences(value: Any?, references: References) {
        when (value) {
            is Map<*, *> -> value.forEach { (rawKey, child) ->
                val key = rawKey as? String ?: return@forEach
                when {
                    key == "data" && child is String -> references.dataKeys += child
                    key == "fact" && child is String -> references.viewerFacts += child
                    key == "format" && child is String -> references.formats += child
                    key == "icon" && child is String -> references.glyphs += child
                    key == "message" && child is String -> references.messages += child
                    key == "label" && child is String -> references.messages += child
                    key == "missing-message" && child is String -> references.messages += child
                }
                collectReferences(child, references)
            }
            is Iterable<*> -> value.forEach { child -> collectReferences(child, references) }
        }
    }

    private fun collectStrings(value: Any?): List<String> = when (value) {
        is String -> listOf(value)
        is Map<*, *> -> value.values.flatMap(::collectStrings)
        is Iterable<*> -> value.flatMap(::collectStrings)
        else -> emptyList()
    }

    private fun localeMessages(): Map<String, Map<String, Any?>> = resourcePaths()
        .filter { path -> path.startsWith("locales/") && path.endsWith(".yml") }
        .associate { path ->
            val document = document(path)
            requiredString(document, "locale", path) to mapping(document["messages"], "$path messages")
        }

    private fun mergedSection(prefix: String, section: String): Map<String, Any?> {
        val paths = if (prefix.endsWith(".yml")) listOf(prefix) else resourcePaths().filter { path -> path.startsWith(prefix) }
        return buildMap {
            paths.forEach { path ->
                mapping(document(path)[section], "$path $section").forEach { (key, value) ->
                    check(put(key, value) == null) { "Duplicate $section id: $key" }
                }
            }
        }
    }

    private fun document(path: String): Map<String, Any?> =
        mapping(yaml.load<Any>(resource(path)), path)

    private fun resourcePaths(): List<String> =
        BundledResources.parseIndex(resource(BundledResources.INDEX_PATH))

    private fun mapping(value: Any?, label: String): Map<String, Any?> {
        val raw = value as? Map<*, *> ?: error("$label must be a mapping")
        return raw.entries.associate { (key, child) ->
            (key as? String ?: error("$label contains a non-string key")) to child
        }
    }

    private fun mappingOrEmpty(value: Any?): Map<String, Any?> =
        if (value == null) emptyMap() else mapping(value, "optional mapping")

    private fun listOrEmpty(value: Any?): List<Any?> = when (value) {
        null -> emptyList()
        is List<*> -> value
        else -> error("Expected a list: $value")
    }

    private fun strings(value: Any?, label: String): List<String> =
        listOrEmpty(value).map { element -> element as? String ?: error("$label contains a non-string value") }

    private fun stringsOrEmpty(value: Any?): List<String> =
        if (value == null) emptyList() else strings(value, "string list")

    private fun requiredString(mapping: Map<String, Any?>, key: String, label: String): String =
        mapping[key] as? String ?: error("$label is missing $key")

    private fun missing(label: String, expected: Set<String>, actual: Set<String>): String =
        "Missing $label: ${expected - actual}"

    private fun isPrivateUseCodePoint(codePoint: Int): Boolean =
        codePoint in 0xE000..0xF8FF ||
            codePoint in 0xF0000..0xFFFFD ||
            codePoint in 0x100000..0x10FFFD

    private fun resource(path: String): String =
        checkNotNull(javaClass.classLoader.getResource(path)) {
            "Missing test resource: $path"
        }.readText(Charsets.UTF_8)

    private data class References(
        val dataKeys: MutableSet<String> = mutableSetOf(),
        val viewerFacts: MutableSet<String> = mutableSetOf(),
        val formats: MutableSet<String> = mutableSetOf(),
        val layouts: MutableSet<String> = mutableSetOf(),
        val themes: MutableSet<String> = mutableSetOf(),
        val glyphs: MutableSet<String> = mutableSetOf(),
        val messages: MutableSet<String> = mutableSetOf(),
    )
}
