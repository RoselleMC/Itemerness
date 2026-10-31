package com.iroselle.itemerness.bukkit.editor

import com.iroselle.itemerness.api.ItemKey
import com.iroselle.itemerness.bukkit.catalog.MaterialProperties
import com.iroselle.itemerness.bukkit.catalog.RuntimeCatalogValidator
import com.iroselle.itemerness.bukkit.presentation.BuiltinFontMetricsLoader
import com.iroselle.itemerness.editor.agent.CatalogTransferException
import com.iroselle.itemerness.editor.agent.CompilerBridge
import com.iroselle.itemerness.editor.protocol.Json
import com.iroselle.itemerness.editor.protocol.JsonObject
import com.iroselle.itemerness.editor.protocol.JsonValue
import com.iroselle.itemerness.editor.protocol.ProjectDocumentCodec
import com.iroselle.itemerness.editor.protocol.ProjectDocumentEncoder
import com.iroselle.itemerness.core.presentation.PresentationBudgets
import java.nio.file.Files
import java.nio.file.Path
import java.util.UUID
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir

class EditorCatalogReaderTest {
    @TempDir lateinit var directory: Path
    private val metrics = BuiltinFontMetricsLoader.bundled("26.1.2")
    private val validator = RuntimeCatalogValidator(enchantmentProvider = { setOf(ItemKey.parse("custom:skill/one")) }) { mapOf(
        ItemKey.parse("minecraft:paper") to MaterialProperties(64, null),
        ItemKey.parse("minecraft:netherite_sword") to MaterialProperties(1, 2031),
        ItemKey.parse("minecraft:book") to MaterialProperties(64, null),
        ItemKey.parse("minecraft:bundle") to MaterialProperties(1, null),
        ItemKey.parse("minecraft:echo_shard") to MaterialProperties(64, null),
    ) }

    @Test
    fun `all supported client metrics import export and preview the same YAML catalog`() {
        fixture()
        val items = directory.resolve("items/examples.yml")
        Files.writeString(items, Files.readString(items).replace("enabled: false", "enabled: true"))
        val before = EditorCatalogFiles.capture(directory).digest
        val digests = mutableSetOf<String>()
        for (version in listOf("1.21.11", "26.1.1", "26.1.2", "26.2", "26.3")) {
            val artifact = BuiltinFontMetricsLoader.bundled(version)
            val metrics = BundledBuiltinFontMetrics(artifact)
            val bridge = CompilerBridge(metrics, "test")
            digests.add(bridge.compilerDigest())
            val response = JsonObject.of(EditorCatalogReader(directory, artifact, "test", validator).read(), "catalog")
            val document = requireNotNull(response.raw("document"))
            val text = Json.canonicalize(document)
            assertTrue(bridge.validateDocument(document).isEmpty(), version)
            assertTrue(ProjectDocumentCodec.decode(text, metrics).presentation.fonts.any {
                it.metricsRevision == "builtin:minecraft-default-$version"
            }, version)
            val result = bridge.compilePreview(text, CompilerBridge.PreviewContext(
                itemId = "itemerness:ember-blade", locale = "en_us", requestedTheme = null,
                assetProfile = null, capabilities = emptyList(), metricsRevision = null,
                resourcePackLoaded = false, managesVanillaTooltipLines = false,
                snapshotHash = com.iroselle.itemerness.editor.agent.EditorDraftStore.digest(text),
            ))
            assertTrue(result is CompilerBridge.Outcome.Rendered, "$version: $result")
            val preview = JsonObject.parse((result as CompilerBridge.Outcome.Rendered).json, "preview")
            assertEquals(JsonValue.Null, preview.raw("failure"), version)
            assertTrue(preview.requiredObject("display").requiredObject("displayName").requiredInt("logicalWidthPixels") > 0, version)
            val exported = JsonObject.of(EditorCatalogExporter(artifact, bridge).export(document), "export")
            assertTrue(exported.requiredObjects("files").isNotEmpty(), version)
            assertEquals(before, EditorCatalogFiles.capture(directory).digest)
            assertFalse(Files.exists(directory.resolve("editor")))
        }
        assertEquals(5, digests.size)
    }

    @Test
    fun `the complete bundled YAML imports through actual loaders without creating a draft`() {
        fixture()
        val config = directory.resolve("config.yml")
        Files.writeString(config, Files.readString(config).replace("token: \"\"", "token: \"unused-sensitive-token\""))
        val before = EditorCatalogFiles.capture(directory).digest
        val response = read()
        val document = requireNotNull(response.raw("document"))
        val decoded = ProjectDocumentCodec.decode(Json.canonicalize(document), BundledBuiltinFontMetrics(metrics))
        assertEquals(5, decoded.catalog.items.size)
        assertEquals(7, decoded.presentation.fonts.size)
        assertEquals(2, decoded.presentation.tooltipStyles.size)
        assertTrue(decoded.previewData.values.all { it.isEmpty() })
        assertTrue(JsonObject.of(document, "document").requiredObjects("viewerFacts").all { it.raw("previewValue") == JsonValue.Null })
        assertTrue(response.requiredString("sourceHash").matches(Regex("sha256:[0-9a-f]{64}")))
        assertEquals(before, EditorCatalogFiles.capture(directory).digest)
        assertFalse(Files.exists(directory.resolve("editor")))
        val text = Json.canonicalize(document)
        assertFalse(text.contains("unused-sensitive-token"))
        assertFalse(JsonObject.of(document, "document").keys.contains("editor"))
        assertEquals("itemerness:plain", decoded.defaultLayout)
    }

    @Test
    fun `actual YAML import has a shared strict browser wire fixture`() {
        fixture()
        val document = requireNotNull(read().raw("document"))
        fun stable(node: JsonValue, path: String): JsonValue = when (node) {
            is JsonValue.Obj -> JsonValue.Obj(node.entries.mapValues { (key, value) ->
                if ((key == "uuid" || key == "documentId") && value is JsonValue.Text) {
                    JsonValue.Text(UUID.nameUUIDFromBytes("$path/$key".toByteArray(Charsets.UTF_8)).toString())
                } else stable(value, "$path/$key")
            })
            is JsonValue.Arr -> JsonValue.Arr(node.values.mapIndexed { index, value -> stable(value, "$path/$index") })
            else -> node
        }
        val actual = stable(document, "")
        val golden = Path.of(requireNotNull(System.getProperty("itemerness.editorFixtures"))).resolve("catalog-import-golden.json")
        if (System.getenv("ITEMERNESS_UPDATE_CATALOG_GOLDEN") == "1") Files.writeString(golden, Json.canonicalize(actual) + "\n")
        assertEquals(Json.parse(Files.readString(golden)), actual)
        assertTrue(JsonObject.of(actual, "document").requiredObjects("tooltipStyles").all { !it.contains("componentValue") })
    }

    @Test
    fun `theme selectors import export and verify losslessly through the YAML loaders`() {
        fixture()
        Files.writeString(directory.resolve("themes/selectors.yml"), """
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
                  - when:
                      operator: exists
                      left:
                        fact: example:class
                    theme: itemerness:ember
                default: itemerness:vanilla-frame
        """.trimIndent() + "\n")
        val items = directory.resolve("items/examples.yml")
        Files.writeString(items, Files.readString(items).replace("theme: itemerness:vanilla-frame", "theme: example:charge-frame"))
        val config = directory.resolve("config.yml")
        Files.writeString(config, Files.readString(config).replace("default-theme: itemerness:default", "default-theme: example:charge-frame"))

        val document = requireNotNull(read().raw("document"))
        val root = JsonObject.of(document, "document")
        assertEquals("example:charge-frame", root.requiredString("defaultTheme"))
        val selector = root.requiredObjects("themeSelectors").single()
        assertEquals("example:charge-frame", selector.requiredString("id"))
        assertEquals(listOf("itemerness:default", "itemerness:ember"), selector.requiredObjects("cases").map { it.requiredString("theme") })
        val decoded = ProjectDocumentCodec.decode(Json.canonicalize(document), BundledBuiltinFontMetrics(metrics))
        assertEquals("itemerness:vanilla-frame", decoded.presentation.themeSelectors.single().defaultTheme)

        val exported = export(document)
        val themes = exported.requiredObjects("files").single { it.requiredString("path") == "themes/editor.yml" }.requiredString("content")
        assertTrue(themes.contains("theme-selectors:"), themes)
        assertTrue(themes.contains("example:charge-frame:"), themes)
        assertTrue(exported.requiredString("settingsPatch").contains("default-theme: example:charge-frame"))
    }

    @Test
    fun `documents without theme selectors keep the field absent`() {
        fixture()
        val document = read().requiredObject("document")
        assertFalse(document.keys.contains("themeSelectors"))
        val themes = export(JsonValue.Obj(document.keys.associateWith { requireNotNull(document.raw(it)) }))
            .requiredObjects("files").single { it.requiredString("path") == "themes/editor.yml" }.requiredString("content")
        assertFalse(themes.contains("theme-selectors"))
    }

    @Test
    fun `shown flags import export and verify losslessly through the YAML loaders`() {
        fixture()
        val items = directory.resolve("items/examples.yml")
        Files.writeString(items, Files.readString(items).replace(
            "      layout: itemerness:plain\n      theme: itemerness:vanilla-frame\n",
            "      layout: itemerness:plain\n      theme: itemerness:vanilla-frame\n" +
                "      shown-flags: [minecraft:enchantments, example:future_component]\n",
        ))

        val document = requireNotNull(read().raw("document"))
        val items0 = JsonObject.of(document, "document").requiredObjects("items")
        val token = items0.single { it.requiredString("id") == "itemerness:travel-token" }
        assertEquals(
            listOf("minecraft:enchantments", "example:future_component"),
            token.requiredObject("presentation").requiredStrings("shownFlags"),
        )
        assertTrue(items0.filter { it !== token }.none { it.requiredObject("presentation").keys.contains("shownFlags") })

        val files = export(document).requiredObjects("files").map { it.requiredString("content") }
        val exported = files.single { it.contains("travel-token:") && it.contains("shown-flags:") }
        assertTrue(exported.contains("- minecraft:enchantments"), exported)
        assertTrue(exported.contains("- example:future_component"), exported)
        assertEquals(1, files.sumOf { content -> Regex("shown-flags:").findAll(content).count() })
    }

    @Test
    fun `groups separators and markers import export and verify losslessly through the YAML loaders`() {
        fixture()
        val items = directory.resolve("items/examples.yml")
        val group = """
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
                - type: group
                  marker: bullet
                  dividers: between-children
                  when-header-missing: show-children
                  gap-before-lines: 1
                  children:
                    - type: field
                      label: data.region.label
                      data: example:region
                      missing-policy: omit
                      format: itemerness:key-message
                      separator:
                        message: data.charges.label
        """.trimIndent().prependIndent("        ") + "\n"
        Files.writeString(items, Files.readString(items)
            .replace("        - type: description\n          message: item.travel-token.description\n", group)
            .replace(
                "      layout: itemerness:plain\n      theme: itemerness:vanilla-frame\n",
                "      layout: itemerness:plain\n      theme: itemerness:vanilla-frame\n      marker: bullet\n      dividers: none\n",
            ))
        val layout = directory.resolve("layouts/plain.yml")
        Files.writeString(layout, Files.readString(layout).replace(
            "        gap-after-pixels: 0\n",
            "        gap-after-pixels: 0\n    sections:\n      field:\n        separator:\n          message: data.region.label\n",
        ))
        val theme = directory.resolve("themes/default.yml")
        Files.writeString(theme, Files.readString(theme).replace(
            "    icons:\n",
            "    markers:\n      style: label\n      bullet: \"* \"\n      tree:\n        last: \"+- \"\n    icons:\n",
        ))

        val document = requireNotNull(read().raw("document"))
        val root = JsonObject.of(document, "document")
        val token = root.requiredObjects("items").single { it.requiredString("id") == "itemerness:travel-token" }.requiredObject("presentation")
        assertEquals("BULLET", token.requiredString("marker"))
        assertEquals("NONE", token.requiredString("dividers"))
        val node = token.requiredObjects("blocks").last()
        assertEquals("group", node.requiredString("type"))
        assertEquals("TREE", node.requiredString("marker"))
        assertEquals("HIDE", node.requiredString("whenEmpty"))
        assertFalse(node.keys.contains("dividers"))
        assertEquals(JsonValue.Obj(mapOf("kind" to JsonValue.Text("none"))), node.requiredObject("header").raw("separator"))
        val nested = node.requiredObjects("children").last()
        assertEquals(1, nested.requiredInt("gapBeforeLines"))
        assertEquals("SHOW_CHILDREN", nested.requiredString("whenHeaderMissing"))
        val plain = root.requiredObjects("layouts").single { it.requiredString("id") == "itemerness:plain" }
        assertEquals("data.region.label", plain.requiredObject("fieldSeparator").requiredString("message"))
        val markers = root.requiredObjects("themes").single { it.requiredString("id") == "itemerness:default" }.requiredObject("markers")
        assertEquals("* ", markers.requiredObject("bullet").requiredString("text"))
        assertTrue(root.requiredObjects("items").filter { it.requiredString("id") != "itemerness:travel-token" }.none { "marker" in it.requiredObject("presentation").keys })

        // Export re-reads the written YAML through the real loaders and refuses any difference.
        val files = export(document).requiredObjects("files").associate { it.requiredString("path") to it.requiredString("content") }
        val exported = files.values.single { it.contains("travel-token:") }
        listOf("type: group", "marker: tree", "when-empty: hide", "separator: none", "gap-before-lines: 1", "when-header-missing: show-children",
            "dividers: between-children", "marker: bullet", "dividers: none").forEach { assertTrue(exported.contains(it), "$it\n$exported") }
        assertFalse(exported.contains("when-header-missing: hide"), exported)
        assertFalse(exported.contains("gap-before-lines: 0"), exported)
        assertTrue(files.values.single { it.contains("itemerness:plain:") }.contains("message: data.region.label"))
        assertTrue(files.values.single { it.contains("itemerness:default:") }.contains("markers:"))
    }

    @Test
    fun `rows rules fragments weights and summaries import export and verify losslessly through the YAML loaders`() {
        fixture()
        val items = directory.resolve("items/examples.yml")
        val composed = """
            - type: row
              weight: 3
              summary:
                slot: more
                piece:
                  literal: "T"
              left:
                - data: example:charges
                  format: itemerness:integer
                  style: value
                  when:
                    operator: exists
                    left:
                      data: example:charges
                - literal: " · "
              right:
                - message: data.charges.label
                  style: label
            - type: rule
              weight: never
              title:
                - message: data.charges.label
            - type: field
              label: data.charges.label
              data: example:charges
              format: itemerness:integer
              styles:
                label: label
                value: value
              weight: 1
              summary:
                slot: more
                piece:
                  literal: "C"
            - type: row
              left:
                - slot: more
                  prefix:
                    literal: "["
                  separator:
                    literal: ","
                  maximum-entries: 2
                  overflow-count-message: data.charges.label
                  suffix:
                    literal: "]"
        """.trimIndent().prependIndent("        ") + "\n"
        Files.writeString(items, Files.readString(items)
            .replace("        - type: description\n          message: item.travel-token.description\n", composed)
            .replace(
                "      name:\n        message: item.travel-token.name\n",
                "      overflow: hide\n      name:\n        message: item.travel-token.name\n        before:\n          - literal: \"* \"\n        after:\n          - data: example:charges\n            format: itemerness:integer\n",
            ))
        val layout = directory.resolve("layouts/plain.yml")
        Files.writeString(layout, Files.readString(layout).replace(
            "        gap-after-pixels: 0\n",
            "        gap-after-pixels: 0\n    overflow: hide\n    sections:\n      field:\n        icon-slot-pixels: 12\n",
        ))
        val theme = directory.resolve("themes/default.yml")
        Files.writeString(theme, Files.readString(theme).replace(
            "    icons:\n",
            "    name-inset-pixels: 2\n    markers:\n      gap-pixels: 1\n    rules:\n      style: label\n      fill: \"=\"\n      title-gap-pixels: 6\n    icons:\n",
        ))

        val document = requireNotNull(read().raw("document"))
        val root = JsonObject.of(document, "document")
        val token = root.requiredObjects("items").single { it.requiredString("id") == "itemerness:travel-token" }.requiredObject("presentation")
        assertEquals("HIDE", token.requiredString("overflow"))
        assertEquals("* ", token.requiredObjects("nameBefore").single().requiredString("text"))
        val blocks = token.requiredObjects("blocks")
        val row = blocks.single { it.requiredString("type") == "row" && it.requiredObjects("right").isNotEmpty() }
        assertEquals(3, row.requiredInt("weight"))
        assertEquals("more", row.requiredObject("summary").requiredString("slot"))
        assertEquals("EXISTS", row.requiredObjects("left").first().requiredObject("condition").requiredString("operator"))
        assertEquals(JsonValue.Text("never"), blocks.single { it.requiredString("type") == "rule" }.raw("weight"))
        assertEquals("label", blocks.single { it.requiredString("type") == "field" && it.contains("partStyles") }.requiredObject("partStyles").requiredString("label"))
        assertEquals(2, blocks.last().requiredObjects("left").single().requiredInt("maximumEntries"))
        val plain = root.requiredObjects("layouts").single { it.requiredString("id") == "itemerness:plain" }
        assertEquals(12, plain.requiredInt("fieldIconSlotPixels"))
        assertEquals("HIDE", plain.requiredString("overflow"))
        val defaultTheme = root.requiredObjects("themes").single { it.requiredString("id") == "itemerness:default" }
        assertEquals(2, defaultTheme.requiredInt("nameInsetPixels"))
        assertEquals(1, defaultTheme.requiredObject("markers").requiredInt("gapPixels"))
        assertEquals(6, defaultTheme.requiredObject("rules").requiredInt("titleGapPixels"))

        // Export re-reads the written YAML through the real loaders and refuses any difference.
        val files = export(document).requiredObjects("files").associate { it.requiredString("path") to it.requiredString("content") }
        val exported = files.entries.single { it.key.startsWith("items/") && it.value.contains("travel-token:") }.value
        listOf("type: row", "type: rule", "weight: never", "weight: 3", "slot: more", "maximum-entries: 2", "overflow: hide",
            "literal: '* '", "styles:", "when:").forEach { assertTrue(exported.contains(it), "$it\n$exported") }
        assertTrue(files.any { it.key.startsWith("layouts/") && it.value.contains("icon-slot-pixels: 12") })
        assertTrue(files.any { it.key.startsWith("themes/") && it.value.contains("name-inset-pixels: 2") })
    }

    @Test
    fun `documents without composition keep its fields out of documents and exports`() {
        fixture()
        val document = requireNotNull(read().raw("document"))
        val text = Json.canonicalize(document)
        listOf("\"weight\"", "\"summary\"", "\"partStyles\"", "\"nameBefore\"", "\"nameAfter\"", "\"overflow\":\"HIDE\"", "\"overflow\":\"FALLBACK\"", "\"rules\"",
            "\"nameInsetPixels\"", "\"fieldIconSlotPixels\"", "\"gapPixels\"").forEach { assertFalse(text.contains(it), it) }
        val files = export(document).requiredObjects("files").map { it.requiredString("content") }
        val keys = Regex("(?m)^\\s+(weight|summary|rules|name-inset-pixels|icon-slot-pixels|gap-pixels):")
        assertTrue(files.none { keys.containsMatchIn(it) || it.contains("type: row") || it.contains("type: rule") })
    }

    @Test
    fun `documents without groups keep group fields out of documents and exports`() {
        fixture()
        val document = requireNotNull(read().raw("document"))
        val text = Json.canonicalize(document)
        listOf("\"marker\"", "\"dividers\"", "\"separator\"", "\"fieldSeparator\"", "\"markers\"", "\"group\"").forEach {
            assertFalse(text.contains(it), it)
        }
        val files = export(document).requiredObjects("files").map { it.requiredString("content") }
        val keys = Regex("(?m)^\\s+(marker|dividers|separator|markers):")
        assertTrue(files.none { keys.containsMatchIn(it) || it.contains("type: group") })
    }

    @Test
    fun `assumed resource-pack delivery imports exports and verifies losslessly`() {
        fixture()
        val assets = directory.resolve("assets/bitmaps.yml")
        Files.writeString(assets, Files.readString(assets).replace(
            "    enabled: false\n    pack-id: 00000000-0000-0000-0000-000000000001\n    sha1: \"0000000000000000000000000000000000000001\"\n",
            "    enabled: true\n    delivery: assumed\n",
        ))

        val document = requireNotNull(read().raw("document"))
        val binding = JsonObject.of(document, "document").requiredObjects("resourcePackBindings").single()
        assertEquals("ASSUMED", binding.requiredString("delivery"))
        assertEquals(JsonValue.Null, binding.raw("packId"))

        val files = export(document).requiredObjects("files").map { it.requiredString("content") }
        val exported = files.single { it.contains("resource-pack-bindings:") }
        assertTrue(exported.contains("delivery: assumed"), exported)
    }

    @Test
    fun `verified resource-pack delivery stays absent from documents and exports`() {
        fixture()
        val document = requireNotNull(read().raw("document"))
        val binding = JsonObject.of(document, "document").requiredObjects("resourcePackBindings").single()
        assertFalse(binding.keys.contains("delivery"))
        val files = export(document).requiredObjects("files").map { it.requiredString("content") }
        assertTrue(files.none { it.contains("delivery:") })
    }

    @Test
    fun `omitted item bindings remain inherited rather than being frozen on import`() {
        fixture()
        val path = directory.resolve("items/examples.yml")
        Files.writeString(path, Files.readString(path).replace("      layout: itemerness:plain\n", "").replace("      theme: itemerness:vanilla-frame\n", ""))
        val document = read().requiredObject("document")
        val item = document.requiredObjects("items").single { it.requiredString("id") == "itemerness:travel-token" }
        assertEquals(JsonValue.Null, item.requiredObject("presentation").raw("layout"))
        assertEquals(JsonValue.Null, item.requiredObject("presentation").raw("theme"))
    }

    @Test
    fun `invalid server settings never disclose YAML snippets or credentials`() {
        fixture()
        Files.writeString(directory.resolve("config.yml"), "editor: { token: 'sensitive-token'\n")
        val failure = assertThrows(CatalogTransferException::class.java) { reader().read() }
        assertEquals("CATALOG_SETTINGS_INVALID", failure.code)
        assertFalse(failure.toString().contains("sensitive-token"))
        assertNull(failure.cause)
    }

    @Test
    fun `unsupported YAML source versions cannot be normalized into valid document versions`() {
        fixture()
        val path = directory.resolve("items/examples.yml")
        Files.writeString(path, Files.readString(path).replace("schema-version: 1", "schema-version: 999"))
        val failure = assertThrows(CatalogTransferException::class.java) { reader().read() }
        assertEquals("CATALOG_INVALID", failure.code)
        assertTrue(failure.diagnostics.any {
            val diagnostic = JsonObject.of(it, "diagnostic")
            diagnostic.requiredString("code") == "CATALOG.INVALID_SCHEMA" && diagnostic.requiredObject("params").requiredString("path").endsWith(".source-format-version")
        })
        assertTrue(Files.readString(path).contains("schema-version: 999"))
        assertFalse(Files.exists(directory.resolve("editor")))
    }

    @Test
    fun `snapshots reject links traversal and non-catalog files and always remove temporary files`() {
        assertThrows(IllegalArgumentException::class.java) { EditorCatalogFiles.from(mapOf("items/../config.yml" to "x: y")) }
        assertThrows(IllegalArgumentException::class.java) { EditorCatalogFiles.from(mapOf("config.yml" to "x: y")) }
        assertThrows(IllegalArgumentException::class.java) { EditorCatalogFiles.from(mapOf("items/a.txt" to "x: y")) }
        var captured: Path? = null
        assertThrows(IllegalStateException::class.java) {
            EditorCatalogFiles.from(mapOf("items/nested/a.yml" to "x: y")).withDirectory {
                captured = it
                assertTrue(Files.exists(it.resolve("items/nested/a.yml")))
                error("cancelled")
            }
        }
        assertFalse(Files.exists(captured!!))
        fixture()
        Files.createSymbolicLink(directory.resolve("assets/linked.yml"), directory.resolve("config.yml"))
        assertThrows(IllegalArgumentException::class.java) { EditorCatalogFiles.capture(directory) }
    }

    @Test
    fun `all configuration domains export and pass the actual YAML loader round trip`() {
        fixture()
        val before = EditorCatalogFiles.capture(directory).digest
        val document = requireNotNull(read().raw("document"))
        val exported = export(document)
        val files = exported.requiredObjects("files")
        assertEquals(EditorCatalogFiles.DOMAINS, files.map { it.requiredString("path").substringBefore('/') }.toSet())
        assertFalse(files.any { it.requiredString("path") == "config.yml" })
        assertFalse(exported.requiredString("settingsPatch").contains("editor:"))
        assertEquals(before, EditorCatalogFiles.capture(directory).digest)
        assertFalse(Files.exists(directory.resolve("editor")))
    }

    @Test
    fun `explicit component clears and custom enchantments survive YAML document export and reload`() {
        fixture()
        val path = directory.resolve("items/examples.yml")
        val original = Files.readString(path)
        val material = "      material: minecraft:paper\n      components:"
        assertTrue(original.contains(material))
        Files.writeString(path, original.replaceFirst(material, """
            |      material: minecraft:paper
            |      components:
            |        minecraft:attribute_modifiers: []
            |        minecraft:enchantments: {}
            |        minecraft:stored_enchantments:
            |          custom:skill/one: 255
        """.trimMargin()))
        val document = requireNotNull(read().raw("document"))
        val decoded = ProjectDocumentCodec.decode(Json.canonicalize(document), BundledBuiltinFontMetrics(metrics))
        val target = decoded.catalog.items.single { it.id == "itemerness:travel-token" }
        val expected = target.baseComponents
        assertEquals(com.iroselle.itemerness.core.catalog.SourceDataValue.ListValue(emptyList()), expected.single { it.id == "minecraft:attribute_modifiers" }.value)
        assertEquals(com.iroselle.itemerness.core.catalog.SourceDataValue.CompoundValue(emptyMap()), expected.single { it.id == "minecraft:enchantments" }.value)
        val files = export(document).requiredObjects("files").associate { it.requiredString("path") to it.requiredString("content") }
        EditorCatalogFiles.from(files).withDirectory { root ->
            val source = com.iroselle.itemerness.bukkit.catalog.CatalogSourceLoader().load(root).source
            assertEquals(expected, source.items.single { it.id == target.id }.baseComponents)
            assertTrue(source.items.filter { it.id != target.id }.all { item -> item.baseComponents.none { it.id == "minecraft:attribute_modifiers" } })
            assertTrue(com.iroselle.itemerness.core.catalog.CatalogCompiler().compile(source).successful)
        }
    }

    @Test
    fun `export preserves omitted bindings and never exports viewer samples`() {
        fixture()
        val path = directory.resolve("items/examples.yml")
        Files.writeString(path, Files.readString(path).replace("      layout: itemerness:plain\n", ""))
        val document = requireNotNull(read().raw("document")) as JsonValue.Obj
        val facts = document.entries.getValue("viewerFacts") as JsonValue.Arr
        val edited = JsonValue.Obj(document.entries + ("viewerFacts" to JsonValue.Arr(facts.values.map { value ->
            val fact = value as JsonValue.Obj
            if (fact.entries["id"] == JsonValue.Text("example:level")) JsonValue.Obj(fact.entries + ("previewValue" to EditorAssetMetadata.obj("kind" to "integer", "value" to "123456"))) else fact
        })))
        val exported = export(edited)
        val files = exported.requiredObjects("files").associate { it.requiredString("path") to it.requiredString("content") }
        assertFalse(files.getValue("viewer-facts/editor.yml").contains("123456"))
        EditorCatalogFiles.from(files).withDirectory { root ->
            val source = com.iroselle.itemerness.bukkit.catalog.CatalogSourceLoader().load(root)
            val item = source.itemDocuments.getValue(ItemKey.parse("itemerness:travel-token"))
            @Suppress("UNCHECKED_CAST")
            assertFalse((item.getValue("presentation") as Map<String, Any?>).containsKey("layout"))
        }
    }

    @Test
    fun `legacy documents and missing authoring bitmap metadata refuse export`() {
        fixture()
        val document = requireNotNull(read().raw("document")) as JsonValue.Obj
        val legacy = JsonValue.Obj(document.entries + ("schemaVersion" to JsonValue.Num(1.0)))
        assertEquals("CATALOG_UPGRADE_REQUIRED", assertThrows(CatalogTransferException::class.java) { exporter().export(legacy) }.code)
        val bitmaps = document.entries.getValue("bitmaps") as JsonValue.Arr
        val broken = JsonValue.Obj(document.entries + ("bitmaps" to JsonValue.Arr(bitmaps.values.map { value ->
            JsonValue.Obj((value as JsonValue.Obj).entries + ("texture" to JsonValue.Null))
        })))
        assertEquals("CATALOG_ASSET_METADATA_MISSING", assertThrows(CatalogTransferException::class.java) { exporter().export(broken) }.code)
    }

    @Test
    fun `source identity includes public settings but is independent of credentials`() {
        fixture()
        val initial = read().requiredString("sourceHash")
        val config = directory.resolve("config.yml")
        Files.writeString(config, Files.readString(config).replace("default-namespace: itemerness", "default-namespace: another"))
        val changed = read().requiredString("sourceHash")
        assertNotEquals(initial, changed)
        Files.writeString(config, Files.readString(config).replace("token: \"\"", "token: \"unused-sensitive-token\""))
        assertEquals(changed, read().requiredString("sourceHash"))
    }

    @Test
    fun `editor-only asset extensions are excluded without blocking a runtime export`() {
        fixture()
        var document = requireNotNull(read().raw("document")) as JsonValue.Obj
        for (domain in listOf("fonts", "bitmaps", "tooltipStyles")) {
            val values = document.entries.getValue(domain) as JsonValue.Arr
            document = JsonValue.Obj(document.entries + (domain to JsonValue.Arr(values.values.map { value ->
                JsonValue.Obj((value as JsonValue.Obj).entries + ("extensions" to EditorAssetMetadata.obj("note" to "editor-only-metadata")))
            })))
        }
        assertFalse(Json.canonicalize(exporter().export(document)).contains("editor-only-metadata"))
    }

    @Test
    fun `an empty catalog imports without examples and remains exportable`() {
        fixture()
        Files.delete(directory.resolve("items/examples.yml"))
        val document = requireNotNull(read().raw("document"))
        assertTrue(JsonObject.of(document, "document").requiredObjects("items").isEmpty())
        export(document)
    }

    @Test
    fun `exports require explicit defaults and reject unsupported active theme settings`() {
        fixture()
        val document = requireNotNull(read().raw("document")) as JsonValue.Obj
        val withoutDefaults = JsonValue.Obj(document.entries - "defaultLayout" - "defaultTheme")
        assertEquals("CATALOG_DEFAULTS_REQUIRED", assertThrows(CatalogTransferException::class.java) { exporter().export(withoutDefaults) }.code)
        val themes = document.entries.getValue("themes") as JsonValue.Arr
        val invalid = JsonValue.Obj(document.entries + ("themes" to JsonValue.Arr(themes.values.map { value ->
            val theme = value as JsonValue.Obj
            if (theme.entries["renderer"] == JsonValue.Text("PLAIN")) JsonValue.Obj(theme.entries + ("requireExactFontMetrics" to JsonValue.Bool(true))) else theme
        })))
        assertEquals("CATALOG_INVALID", assertThrows(CatalogTransferException::class.java) { exporter().export(invalid) }.code)
        assertNotNull(ProjectDocumentCodec.decode(Json.canonicalize(invalid), BundledBuiltinFontMetrics(metrics)))
    }

    @Test
    fun `long constraints and defaults retain all sixty four bits through YAML`() {
        fixture()
        val document = requireNotNull(read().raw("document")) as JsonValue.Obj
        val modified = updateKey(document, "itemerness:created-at") { key -> JsonValue.Obj(key.entries + mapOf(
            "defaultValue" to EditorAssetMetadata.obj("kind" to "integer", "value" to Long.MAX_VALUE.toString()),
            "constraints" to JsonValue.Obj((key.entries.getValue("constraints") as JsonValue.Obj).entries + mapOf(
                "minimum" to JsonValue.Text(Long.MIN_VALUE.toString()), "maximum" to JsonValue.Text(Long.MAX_VALUE.toString()),
            )),
        )) }
        val exported = export(modified)
        val files = exported.requiredObjects("files").associate { it.requiredString("path") to it.requiredString("content") }
        EditorCatalogFiles.from(files).withDirectory { root ->
            val source = com.iroselle.itemerness.bukkit.catalog.CatalogSourceLoader().load(root)
            val key = source.source.schemas.single().keys.single { it.id == "itemerness:created-at" }
            assertEquals(Long.MIN_VALUE.toBigDecimal(), key.constraints.minimum)
            assertEquals(Long.MAX_VALUE.toBigDecimal(), key.constraints.maximum)
            assertEquals(com.iroselle.itemerness.core.catalog.SourceDataValue.IntegerValue(Long.MAX_VALUE), key.defaultValue)
        }
    }

    @Test
    fun `precision unavailable in YAML is refused without a lossy tolerance`() {
        fixture()
        val document = requireNotNull(read().raw("document")) as JsonValue.Obj
        val modified = updateKey(document, "example:attack-damage") { key -> JsonValue.Obj(key.entries +
            ("constraints" to JsonValue.Obj((key.entries.getValue("constraints") as JsonValue.Obj).entries +
                ("maximum" to JsonValue.Text("1000000.0000000000001"))))) }
        val failure = assertThrows(CatalogTransferException::class.java) { exporter().export(modified) }
        assertEquals("CATALOG_EXPORT_LOSSY", failure.code)
        assertTrue(failure.diagnostics.any { JsonObject.of(it, "diagnostic").optionalString("pointer")?.endsWith("/constraints/maximum") == true })
    }

    @Test
    fun `exports write imported objects back to their own files`() {
        fixture()
        Files.createDirectories(directory.resolve("items/armory"))
        Files.move(directory.resolve("items/examples.yml"), directory.resolve("items/armory/examples.yml"))
        val original = EditorCatalogFiles.DOMAINS.flatMap { domain ->
            Files.walk(directory.resolve(domain)).use { paths ->
                paths.filter(Files::isRegularFile).map { directory.relativize(it).toString().replace('\\', '/') }.toList()
            }
        }.toSet()

        val plain = requireNotNull(read().raw("document")) as JsonValue.Obj
        assertFalse("sourceLayout" in plain.entries, "Layout is only sent to clients that ask for it")
        val document = requireNotNull(JsonObject.of(reader().read(includeLayout = true), "response").raw("document")) as JsonValue.Obj
        val layout = JsonObject.of(document.entries.getValue("sourceLayout"), "layout")
        assertEquals(reader().currentSourceHash(), layout.requiredString("sourceHash"))

        val exported = JsonObject.of(exporter { reader().currentSourceHash() }.export(document), "export")
        assertEquals(original, exported.requiredObjects("files").map { it.requiredString("path") }.toSet())
        assertTrue(exported.requiredArray("diagnostics").isEmpty())

        val copy = (document.entries.getValue("items") as JsonValue.Arr).values.first() as JsonValue.Obj
        val added = JsonValue.Obj(copy.entries + mapOf(
            "uuid" to JsonValue.Text(UUID.randomUUID().toString()),
            "id" to JsonValue.Text("example:added-later"),
        ))
        val grown = JsonValue.Obj(document.entries + ("items" to JsonValue.Arr((document.entries.getValue("items") as JsonValue.Arr).values + added)))
        val paths = export(grown).requiredObjects("files").associate { it.requiredString("path") to it.requiredString("content") }
        assertTrue(paths.getValue("items/editor.yml").contains("added-later"), "Objects without a recorded file use the default file")
        assertFalse(paths.getValue("items/armory/examples.yml").contains("added-later"))
    }

    @Test
    fun `authored string literals compare with namespaced key data only when they parse`() {
        fixture()
        val items = directory.resolve("items/examples.yml")
        val original = Files.readString(items)
        val condition = """
            operator: less-than
            left:
              fact: example:level
            right:
              data: example:required-level
        """.trimIndent().prependIndent("            ")
        assertTrue(original.contains(condition))
        fun withLiteral(literal: String) = Files.writeString(items, original.replace(condition, """
            operator: equals
            left:
              data: example:quality
            right:
              literal: $literal
        """.trimIndent().prependIndent("            ")))

        withLiteral("example:rare")
        read()
        withLiteral("'not a key'")
        val failure = assertThrows(CatalogTransferException::class.java) { reader().read() }
        assertTrue(Json.canonicalize(JsonValue.Arr(failure.diagnostics)).contains("not comparable"))
    }

    @Test
    fun `theme selectors keep their own file through the source layout`() {
        fixture()
        Files.writeString(directory.resolve("themes/selectors.yml"), """
            schema-version: 1
            theme-selectors:
              example:locale-frame:
                cases:
                  - when: { operator: exists, left: { fact: itemerness:locale } }
                    theme: itemerness:default
                default: itemerness:default
        """.trimIndent())
        val document = requireNotNull(JsonObject.of(reader().read(includeLayout = true), "response").raw("document"))
        val files = export(document).requiredObjects("files").associate { it.requiredString("path") to it.requiredString("content") }
        assertTrue(files.getValue("themes/selectors.yml").contains("example:locale-frame"))
        assertTrue(files.filterKeys { it != "themes/selectors.yml" }.values.none { it.contains("example:locale-frame") })
        assertFalse("themes/editor.yml" in files)
    }

    @Test
    fun `source layout paths cannot leave their domain and changed sources warn on export`() {
        fixture()
        val document = requireNotNull(JsonObject.of(reader().read(includeLayout = true), "response").raw("document")) as JsonValue.Obj
        val layout = document.entries.getValue("sourceLayout") as JsonValue.Obj
        val files = layout.entries.getValue("files") as JsonValue.Obj
        val itemUuid = ((document.entries.getValue("items") as JsonValue.Arr).values.first() as JsonValue.Obj).entries.getValue("uuid") as JsonValue.Text
        listOf("items/../config.yml", "themes/stolen.yml", "/items/absolute.yml", "items/examples.txt").forEach { path ->
            val unsafe = JsonValue.Obj(document.entries + ("sourceLayout" to JsonValue.Obj(layout.entries +
                ("files" to JsonValue.Obj(files.entries + (itemUuid.value to JsonValue.Text(path)))))))
            val failure = assertThrows(CatalogTransferException::class.java) { exporter().export(unsafe) }
            assertTrue(Json.canonicalize(JsonValue.Arr(failure.diagnostics)).contains("SOURCE_PATH_INVALID"), path)
        }

        val stale = JsonObject.of(exporter { "sha256:" + "f".repeat(64) }.export(document), "export")
        assertEquals(
            "CATALOG.SOURCE_CHANGED_SINCE_IMPORT",
            stale.requiredObjects("diagnostics").single().requiredString("code"),
        )
    }

    @Test
    fun `catalog status follows the YAML on disk and reports unreadable sources as diagnostics`() {
        fixture()
        val baseline = JsonObject.of(reader().read(includeLayout = true), "response").requiredString("sourceHash")
        assertEquals(baseline, reader().status())
        val items = directory.resolve("items/examples.yml")
        Files.writeString(items, Files.readString(items) + "\n# edited on the server\n")
        assertNotEquals(baseline, reader().status())
        Files.createSymbolicLink(directory.resolve("items/linked.yml"), items)
        val failure = assertThrows(CatalogTransferException::class.java) { reader().status() }
        assertEquals("CATALOG_INVALID", failure.code)
        assertTrue(Json.canonicalize(JsonValue.Arr(failure.diagnostics)).contains("CATALOG.SOURCE_INVALID"))
    }

    @Test
    fun `the catalog directory budget bounds reads and verified exports`() {
        fixture()
        val document = requireNotNull(JsonObject.of(reader().read(), "response").raw("document"))
        // An export larger than the server's budget would not load once installed, so it is refused.
        val failure = assertThrows(CatalogTransferException::class.java) {
            EditorCatalogExporter(metrics, CompilerBridge(BundledBuiltinFontMetrics(metrics), "test"), directoryBytes = { 1024 }).export(document)
        }
        assertEquals("CATALOG_EXPORT_INVALID", failure.code)
        val detail = Json.canonicalize(JsonValue.Arr(failure.diagnostics))
        assertTrue(detail.contains("bytes of YAML; the limit is 1,024 bytes"), detail)
        assertTrue(detail.contains("catalog.maximum-directory-mebibytes"), detail)

        val config = directory.resolve("config.yml")
        Files.writeString(config, Files.readString(config).replace("maximum-directory-mebibytes: 16", "maximum-directory-mebibytes: 32"))
        assertEquals(reader().currentSourceHash(), reader().status())
        read()
    }

    @Test
    fun `a configured tooltip height limit reaches documents previews and exports`() {
        fixture()
        val config = directory.resolve("config.yml")
        Files.writeString(config, Files.readString(config).replace("maximum-height-pixels: 180", "maximum-height-pixels: 320"))
        val items = directory.resolve("items/examples.yml")
        val rows = """        - type: field
          label: data.charges.label
          data: example:charges
          format: itemerness:integer
""".repeat(20)
        Files.writeString(items, Files.readString(items).replace(
            "          message: item.travel-token.description\n",
            "          message: item.travel-token.description\n$rows",
        ).replace("  travel-token:\n    enabled: false", "  travel-token:\n    enabled: true"))
        val document = requireNotNull(read().raw("document"))
        val text = Json.canonicalize(document)
        val decoded = ProjectDocumentCodec.decode(text, BundledBuiltinFontMetrics(metrics))
        assertEquals(PresentationBudgets(maximumHeightPixels = 320), decoded.budgets)

        val raised = CompilerBridge(BundledBuiltinFontMetrics(metrics), "test", { PresentationBudgets(maximumHeightPixels = 320) })
        assertTrue(raised.validateDocument(document).isEmpty())
        fun reasons(bridge: CompilerBridge, documentText: String): String {
            val result = bridge.compilePreview(documentText, CompilerBridge.PreviewContext(
                itemId = "itemerness:travel-token", locale = "en_us", requestedTheme = "itemerness:default",
                assetProfile = null, capabilities = emptyList(), metricsRevision = null,
                resourcePackLoaded = false, managesVanillaTooltipLines = true,
                snapshotHash = com.iroselle.itemerness.editor.agent.EditorDraftStore.digest(documentText),
            ))
            return (result as? CompilerBridge.Outcome.Rendered)?.json ?: (result as CompilerBridge.Outcome.Rejected).json
        }
        // The raised limit fits the tall item; the default one does not.
        val fitted = JsonObject.parse(reasons(raised, text), "preview")
        assertEquals(JsonValue.Null, fitted.raw("failure"))
        // More Lore lines than a 180-pixel tooltip can hold.
        assertTrue(fitted.requiredObject("display").requiredObjects("lore").size > 17)
        assertFalse("Display height budget exceeded" in Json.canonicalize(requireNotNull(fitted.raw("display"))))
        val defaults = JsonValue.Obj((document as JsonValue.Obj).entries + ("budgets" to ProjectDocumentEncoder.budgetsJson(PresentationBudgets())))
        val defaultText = Json.canonicalize(defaults)
        val fallback = reasons(CompilerBridge(BundledBuiltinFontMetrics(metrics), "test"), defaultText)
        assertTrue("Display height budget exceeded" in fallback, fallback.take(3000))
        // A server compiles only documents made under its own limits.
        assertTrue(Json.canonicalize(JsonValue.Arr(raised.validateDocument(defaults))).contains("runtime_budgets_mismatch"))
        assertTrue(Json.canonicalize(JsonValue.Arr(CompilerBridge(BundledBuiltinFontMetrics(metrics), "test").validateDocument(document))).contains("runtime_budgets_mismatch"))

        val exported = JsonObject.of(EditorCatalogExporter(metrics, raised).export(document), "export")
        assertTrue("maximum-height-pixels: 320" in exported.requiredString("settingsPatch"), exported.requiredString("settingsPatch"))
        val unchanged = JsonObject.of(exporter().export(requireNotNull(JsonObject.of(reader().read(), "r").raw("document")).let {
            JsonValue.Obj((it as JsonValue.Obj).entries + ("budgets" to ProjectDocumentEncoder.budgetsJson(PresentationBudgets())))
        }), "export")
        assertFalse("maximum-height-pixels" in unchanged.requiredString("settingsPatch"))
    }

    private fun updateKey(document: JsonValue.Obj, id: String, update: (JsonValue.Obj) -> JsonValue.Obj): JsonValue.Obj =
        JsonValue.Obj(document.entries + ("dataSchemas" to JsonValue.Arr((document.entries.getValue("dataSchemas") as JsonValue.Arr).values.map { value ->
            val schema = value as JsonValue.Obj
            JsonValue.Obj(schema.entries + ("keys" to JsonValue.Arr((schema.entries.getValue("keys") as JsonValue.Arr).values.map { key ->
                if ((key as JsonValue.Obj).entries["id"] == JsonValue.Text(id)) update(key) else key
            })))
        })))

    private fun exporter(currentSourceHash: () -> String = { error("No source hash is available") }) =
        EditorCatalogExporter(metrics, CompilerBridge(BundledBuiltinFontMetrics(metrics), "test"), currentSourceHash)
    private fun export(document: JsonValue): JsonObject = try {
        JsonObject.of(exporter().export(document), "export")
    } catch (failure: CatalogTransferException) {
        throw AssertionError(failure.code + ": " + Json.canonicalize(JsonValue.Arr(failure.diagnostics)))
    }

    private fun reader() = EditorCatalogReader(directory, metrics, "test", validator)
    private fun read(): JsonObject = try {
        JsonObject.of(reader().read(), "response")
    } catch (failure: CatalogTransferException) {
        throw AssertionError(failure.code + ": " + Json.canonicalize(JsonValue.Arr(failure.diagnostics)))
    }
    private fun fixture() {
        val resources = Path.of("src/main/resources")
        (EditorCatalogFiles.DOMAINS + "config.yml").forEach { name ->
            val source = resources.resolve(name)
            if (Files.isDirectory(source)) {
                Files.walk(source).use { paths -> paths.forEach { path ->
                    val target = directory.resolve(resources.relativize(path))
                    if (Files.isDirectory(path)) Files.createDirectories(target) else Files.copy(path, target)
                } }
            } else Files.copy(source, directory.resolve(name))
        }
    }
}
