package com.iroselle.itemerness.editor.protocol

import com.iroselle.itemerness.core.catalog.CompoundFieldSource
import com.iroselle.itemerness.core.catalog.DataConstraintsSource
import com.iroselle.itemerness.core.catalog.DataType
import com.iroselle.itemerness.core.catalog.SourceDataValue
import com.iroselle.itemerness.api.IntegerDataValue
import com.iroselle.itemerness.core.presentation.ConditionOperator
import com.iroselle.itemerness.core.presentation.ConditionSource
import com.iroselle.itemerness.core.presentation.GlyphMetricSource
import com.iroselle.itemerness.core.presentation.ItemPresentationSource
import com.iroselle.itemerness.core.presentation.PresentationSource
import com.iroselle.itemerness.core.presentation.ResourcePackDelivery
import com.iroselle.itemerness.core.presentation.ThemeSelectorCaseSource
import com.iroselle.itemerness.core.presentation.ThemeSelectorSource
import com.iroselle.itemerness.core.presentation.ValueReferenceSource
import com.iroselle.itemerness.editor.protocol.DocumentEncoding.obj
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.math.BigDecimal
import java.nio.file.Files
import java.nio.file.Path
import java.util.UUID

class ProjectDocumentEncoderTest {
    private val documentId = UUID.fromString("00000000-0000-4000-8000-000000000001")
    private val encoder = ProjectDocumentEncoder(documentId)
    private val fixture by lazy { JsonObject.parse(Files.readString(Path.of(System.getProperty("itemerness.editorFixtures"), "baseline.json")), "fixture") }
    private val metrics = BuiltinFontMetrics { revision ->
        val id = if (revision.contains("uniform")) "minecraft:uniform" else "minecraft:default"
        BuiltinFontTable(id, "builtin:$revision", null, GlyphMetricSource(6.0), mapOf(65 to GlyphMetricSource(6.0)))
    }
    private val assets by lazy { JsonObject.of(obj(
        "measurement" to obj("boldExtraAdvancePixels" to 1.0), "fonts" to fixture.raw("fonts"),
        "bitmaps" to fixture.raw("bitmaps"), "tooltipStyles" to fixture.raw("tooltipStyles"),
    ), "assets") }
    private val policies by lazy { fixture.requiredObjects("dataSchemas").flatMap { it.requiredObjects("keys") }.associate { key ->
        val definition = key.requiredString("scope") == "DEFINITION"
        key.requiredString("id") to obj(
            "readSources" to listOf(obj("kind" to if (definition) "catalogDefinition" else "canonicalNbt")),
            "access" to obj("read" to "PUBLIC", "write" to listOf(if (definition) "definition" else "internal")),
            "placeholderApi" to obj("exposed" to false, "formatter" to null),
        )
    } }

    private fun withSelector(presentation: PresentationSource, selector: ThemeSelectorSource): PresentationSource = PresentationSource(
        formats = presentation.formats, locales = presentation.locales, fonts = presentation.fonts, glyphs = presentation.glyphs,
        bitmaps = presentation.bitmaps, assetProfiles = presentation.assetProfiles, viewerFacts = presentation.viewerFacts,
        resourcePackBindings = presentation.resourcePackBindings, layouts = presentation.layouts, themes = presentation.themes,
        items = presentation.items, spacing = presentation.spacing, tooltipStyles = presentation.tooltipStyles,
        themeSelectors = listOf(selector),
    )

    @Test
    fun `theme selectors encode, decode and re-encode, and stay absent when there are none`() {
        val original = ProjectDocumentCodec.decode(fixture, metrics)
        val selector = ThemeSelectorSource(
            "example:charge-frame",
            listOf(
                ThemeSelectorCaseSource(
                    ConditionSource(ConditionOperator.EQUALS, ValueReferenceSource.Data("example:charges"), ValueReferenceSource.Literal(IntegerDataValue(3))),
                    "itemerness:vanilla-frame",
                ),
                ThemeSelectorCaseSource(ConditionSource(ConditionOperator.EXISTS, ValueReferenceSource.Fact("example:class")), "itemerness:ember"),
            ),
            "itemerness:default",
        )
        val presentation = withSelector(original.presentation, selector)
        val encoded = encoder.encode(original.namespace, original.defaultLocale, original.catalog, presentation, assets, policies)
        val root = JsonObject.of(encoded, "encoded")
        val node = root.requiredObjects("themeSelectors").single()
        assertEquals(setOf("uuid", "id", "cases", "defaultTheme"), node.keys)
        val decoded = ProjectDocumentCodec.decode(root, metrics)
        val restored = decoded.presentation.themeSelectors.single()
        assertEquals(selector.id, restored.id)
        assertEquals(selector.cases, restored.cases)
        assertEquals(selector.defaultTheme, restored.defaultTheme)
        val repeated = encoder.encode(decoded.namespace, decoded.defaultLocale, decoded.catalog, decoded.presentation, assets, policies)
        assertEquals(Json.canonicalize(encoded), Json.canonicalize(repeated))

        val plain = encoder.encode(original.namespace, original.defaultLocale, original.catalog, original.presentation, assets, policies)
        assertTrue("themeSelectors" !in plain.entries)

        fun mutated(transform: (String) -> String) = JsonObject.parse(transform(Json.canonicalize(encoded)), "document")
        assertThrows(JsonException::class.java) {
            ProjectDocumentCodec.decode(mutated { it.replace("\"defaultTheme\":\"itemerness:default\"", "\"defaultTheme\":\"itemerness:default\",\"priority\":1") }, metrics)
        }
        assertThrows(JsonException::class.java) {
            ProjectDocumentCodec.decode(mutated { it.replace("\"theme\":\"itemerness:ember\"", "\"theme\":\"itemerness:ember\",\"weight\":1") }, metrics)
        }
        val defaulted = JsonObject.of(JsonValue.Obj(encoded.entries + ("defaultTheme" to JsonValue.Text("example:charge-frame")) +
            ("defaultLayout" to JsonValue.Text("itemerness:plain"))), "document")
        assertEquals("example:charge-frame", ProjectDocumentCodec.decode(defaulted, metrics).defaultTheme)
    }

    @Test
    fun `shown flags are written only when present and malformed values are rejected`() {
        val original = ProjectDocumentCodec.decode(fixture, metrics)
        val plain = encoder.encode(original.namespace, original.defaultLocale, original.catalog, original.presentation, assets, policies)
        val plainItems = JsonObject.of(plain, "plain").requiredObjects("items")
        assertTrue(plainItems.isNotEmpty())
        assertTrue(plainItems.all { "shownFlags" !in it.requiredObject("presentation").keys })

        val presentation = original.presentation
        val target = presentation.items.first()
        val shown = PresentationSource(
            formats = presentation.formats, locales = presentation.locales, fonts = presentation.fonts, glyphs = presentation.glyphs,
            bitmaps = presentation.bitmaps, assetProfiles = presentation.assetProfiles, viewerFacts = presentation.viewerFacts,
            resourcePackBindings = presentation.resourcePackBindings, layouts = presentation.layouts, themes = presentation.themes,
            items = presentation.items.map { item ->
                if (item !== target) item else ItemPresentationSource(
                    item.id, item.layout, item.theme, item.nameMessage, item.blocks, item.enabled,
                    shownFlags = listOf("minecraft:enchantments", "example:future_component"),
                )
            },
            spacing = presentation.spacing, tooltipStyles = presentation.tooltipStyles, themeSelectors = presentation.themeSelectors,
        )
        val encoded = encoder.encode(original.namespace, original.defaultLocale, original.catalog, shown, assets, policies)
        val node = JsonObject.of(encoded, "encoded").requiredObjects("items").single { it.requiredString("id") == target.id }
        assertEquals(listOf("minecraft:enchantments", "example:future_component"), node.requiredObject("presentation").requiredStrings("shownFlags"))
        val decoded = ProjectDocumentCodec.decode(JsonObject.of(encoded, "encoded"), metrics)
        assertEquals(listOf("minecraft:enchantments", "example:future_component"), decoded.presentation.items.single { it.id == target.id }.shownFlags)
        val repeated = encoder.encode(decoded.namespace, decoded.defaultLocale, decoded.catalog, decoded.presentation, assets, policies)
        assertEquals(Json.canonicalize(encoded), Json.canonicalize(repeated))

        val canonical = Json.canonicalize(encoded)
        listOf("\"minecraft:enchantments\"" to "1", "[\"minecraft:enchantments\",\"example:future_component\"]" to "\"minecraft:enchantments\"")
            .forEach { (from, to) ->
                assertThrows(JsonException::class.java) {
                    ProjectDocumentCodec.decode(JsonObject.parse(canonical.replace(from, to), "document"), metrics)
                }
            }
        // An explicit empty list decodes to the same source as an absent field.
        val emptied = ProjectDocumentCodec.decode(
            JsonObject.parse(canonical.replace("[\"minecraft:enchantments\",\"example:future_component\"]", "[]"), "document"),
            metrics,
        )
        assertEquals(emptyList<String>(), emptied.presentation.items.single { it.id == target.id }.shownFlags)
    }

    @Test
    fun `resource-pack delivery is written only when assumed and unknown values are rejected`() {
        val original = ProjectDocumentCodec.decode(fixture, metrics)
        val plain = JsonObject.of(
            encoder.encode(original.namespace, original.defaultLocale, original.catalog, original.presentation, assets, policies),
            "plain",
        )
        assertTrue(plain.requiredObjects("resourcePackBindings").isNotEmpty())
        assertTrue(plain.requiredObjects("resourcePackBindings").all { "delivery" !in it.keys })

        val presentation = original.presentation
        val assumed = PresentationSource(
            formats = presentation.formats, locales = presentation.locales, fonts = presentation.fonts, glyphs = presentation.glyphs,
            bitmaps = presentation.bitmaps, assetProfiles = presentation.assetProfiles, viewerFacts = presentation.viewerFacts,
            resourcePackBindings = presentation.resourcePackBindings.map { binding ->
                binding.copy(delivery = ResourcePackDelivery.ASSUMED, packId = null, sha1 = null)
            },
            layouts = presentation.layouts, themes = presentation.themes,
            items = presentation.items, spacing = presentation.spacing, tooltipStyles = presentation.tooltipStyles,
            themeSelectors = presentation.themeSelectors,
        )
        val encoded = encoder.encode(original.namespace, original.defaultLocale, original.catalog, assumed, assets, policies)
        val root = JsonObject.of(encoded, "encoded")
        assertTrue(root.requiredObjects("resourcePackBindings").all { it.requiredString("delivery") == "ASSUMED" })
        val decoded = ProjectDocumentCodec.decode(root, metrics)
        assertEquals(assumed.resourcePackBindings, decoded.presentation.resourcePackBindings)
        val repeated = encoder.encode(decoded.namespace, decoded.defaultLocale, decoded.catalog, decoded.presentation, assets, policies)
        assertEquals(Json.canonicalize(encoded), Json.canonicalize(repeated))

        assertThrows(JsonException::class.java) {
            ProjectDocumentCodec.decode(JsonObject.parse(Json.canonicalize(encoded).replace("\"ASSUMED\"", "\"PROXY\""), "document"), metrics)
        }
    }

    @Test
    fun `all baseline configuration domains survive stable source document round trips`() {
        val original = ProjectDocumentCodec.decode(fixture, metrics)
        val encoded = encoder.encode(original.namespace, original.defaultLocale, original.catalog, original.presentation, assets, policies)
        val root = JsonObject.of(encoded, "encoded")
        val decoded = ProjectDocumentCodec.decode(root, metrics)
        val repeated = encoder.encode(decoded.namespace, decoded.defaultLocale, decoded.catalog, decoded.presentation, assets, policies)
        assertEquals(Json.canonicalize(encoded), Json.canonicalize(repeated))
        assertEquals(original.catalog.items.map { it.id }, decoded.catalog.items.map { it.id })
        assertEquals(original.presentation.themes.map { it.renderer }, decoded.presentation.themes.map { it.renderer })
        assertEquals(original.presentation.layouts.map { it.id }, decoded.presentation.layouts.map { it.id })
        assertEquals(original.presentation.glyphs, decoded.presentation.glyphs)
        assertEquals(original.presentation.spacing, decoded.presentation.spacing)
        assertEquals(original.presentation.resourcePackBindings, decoded.presentation.resourcePackBindings)
        for (domain in listOf("formats", "locales", "fonts", "glyphs", "bitmaps", "tooltipStyles", "assetProfiles", "viewerFacts", "layouts", "themes", "dataSchemas", "items")) {
            assertEquals(fixture.requiredArray(domain).size, root.requiredArray(domain).size, domain)
        }
        assertTrue(root.requiredObjects("items").all { it.requiredString("id").contains(':') })
        assertTrue(root.requiredObjects("items").all { it.requiredArray("previewData").isEmpty() })
        assertTrue(root.requiredObjects("viewerFacts").all { it.raw("previewValue") == JsonValue.Null })
        assertNotEquals(fixture.requiredObjects("items")[0].requiredString("uuid"), root.requiredObjects("items")[0].requiredString("uuid"))
    }

    @Test
    fun `source identities are repeatable without sharing identities across schema keys and blocks`() {
        val original = ProjectDocumentCodec.decode(fixture, metrics)
        val first = encoder.encode(original.namespace, original.defaultLocale, original.catalog, original.presentation, assets, policies)
        val second = encoder.encode(original.namespace, original.defaultLocale, original.catalog, original.presentation, assets, policies)
        assertEquals(first, second)
        val ids = ArrayList<String>()
        fun collect(value: JsonValue) {
            when (value) {
                is JsonValue.Obj -> { (value.entries["uuid"] as? JsonValue.Text)?.let { ids += it.value }; value.entries.values.forEach(::collect) }
                is JsonValue.Arr -> value.values.forEach(::collect)
                else -> Unit
            }
        }
        collect(first)
        assertTrue(ids.size > 50)
        assertEquals(ids.size, ids.toSet().size)
    }

    @Test
    fun `base component clears and enchantment levels retain their exact source shapes`() {
        val components = listOf(
            obj("id" to "minecraft:attribute_modifiers", "value" to obj("kind" to "list", "values" to emptyList<JsonValue>())),
            obj("id" to "minecraft:enchantments", "value" to obj("kind" to "compound", "entries" to emptyMap<String, JsonValue>())),
            obj("id" to "minecraft:stored_enchantments", "value" to obj("kind" to "compound", "entries" to mapOf("custom:skill/one" to obj("kind" to "integer", "value" to "255")))),
        )
        val source = JsonValue.Obj(fixture.keys.associateWith { requireNotNull(fixture.raw(it)) })
        val items = source.entries.getValue("items") as JsonValue.Arr
        val first = items.values.first() as JsonValue.Obj
        val definition = first.entries.getValue("definition") as JsonValue.Obj
        val candidate = JsonValue.Obj(source.entries + ("items" to JsonValue.Arr(listOf(
            JsonValue.Obj(first.entries + ("definition" to JsonValue.Obj(definition.entries + ("baseComponents" to JsonValue.Arr(components))))),
        ) + items.values.drop(1))))
        val decoded = ProjectDocumentCodec.decode(JsonObject.of(candidate, "document"), metrics)
        val encoded = encoder.encode(decoded.namespace, decoded.defaultLocale, decoded.catalog, decoded.presentation, assets, policies)
        val roundTrip = ProjectDocumentCodec.decode(JsonObject.of(encoded, "document"), metrics)
        assertEquals(decoded.catalog.items.first().baseComponents, roundTrip.catalog.items.first().baseComponents)
        assertEquals(3, roundTrip.catalog.items.first().baseComponents.size)
        assertTrue(roundTrip.catalog.items.drop(1).all { item -> item.baseComponents.none { it.id == "minecraft:attribute_modifiers" } })
    }

    @Test
    fun `missing integration policies are refused instead of fabricating access rules`() {
        val original = ProjectDocumentCodec.decode(fixture, metrics)
        assertThrows(IllegalArgumentException::class.java) {
            encoder.encode(original.namespace, original.defaultLocale, original.catalog, original.presentation, assets, emptyMap())
        }
    }

    @Test
    fun `typed source values preserve long identity and exact decimal and nullable container values`() {
        assertEquals(obj("kind" to "long"), DocumentEncoding.type(DataType.LongType))
        assertEquals(obj("kind" to "integer", "value" to Long.MAX_VALUE.toString()), DocumentEncoding.sourceValue(SourceDataValue.IntegerValue(Long.MAX_VALUE)))
        assertEquals(obj("kind" to "integer", "value" to "1"), DocumentEncoding.sourceValue(SourceDataValue.IntegerValue(1)))
        assertEquals(obj("kind" to "decimal", "value" to "1.234567890123456789"), DocumentEncoding.sourceValue(SourceDataValue.DecimalValue("1.234567890123456789".toBigDecimal())))
        val compound = SourceDataValue.CompoundValue(mapOf("long" to SourceDataValue.IntegerValue(1), "absent" to SourceDataValue.NullValue))
        assertEquals(obj("kind" to "compound", "entries" to mapOf("long" to obj("kind" to "integer", "value" to "1"), "absent" to obj("kind" to "null"))), DocumentEncoding.sourceValue(compound))
    }

    @Test
    fun `compound field constraints are emitted only when declared`() {
        val plain = DataType.CompoundType(listOf(CompoundFieldSource("name", DataType.StringType)))
        assertEquals(
            obj("kind" to "compound", "fields" to listOf(obj("name" to "name", "type" to obj("kind" to "string"), "nullable" to false))),
            DocumentEncoding.type(plain),
        )
        val constrained = DataType.CompoundType(
            listOf(CompoundFieldSource("level", DataType.IntegerType, constraints = DataConstraintsSource(minimum = BigDecimal.ONE))),
        )
        val field = (DocumentEncoding.type(constrained) as JsonValue.Obj).entries.getValue("fields").let { (it as JsonValue.Arr).values.single() as JsonValue.Obj }
        assertEquals(DocumentEncoding.constraints(DataConstraintsSource(minimum = BigDecimal.ONE)), field.entries["constraints"])
    }
}
