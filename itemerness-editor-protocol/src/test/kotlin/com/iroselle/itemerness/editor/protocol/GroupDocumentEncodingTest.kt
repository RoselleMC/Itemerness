package com.iroselle.itemerness.editor.protocol

import com.iroselle.itemerness.core.presentation.FieldSeparatorSource
import com.iroselle.itemerness.core.presentation.GlyphMetricSource
import com.iroselle.itemerness.core.presentation.GroupDividers
import com.iroselle.itemerness.core.presentation.GroupEmptyPolicy
import com.iroselle.itemerness.core.presentation.GroupHeaderMissingPolicy
import com.iroselle.itemerness.core.presentation.GroupMarker
import com.iroselle.itemerness.core.presentation.ItemPresentationSource
import com.iroselle.itemerness.core.presentation.LayoutSource
import com.iroselle.itemerness.core.presentation.MarkerPieceSource
import com.iroselle.itemerness.core.presentation.MarkerThemeSource
import com.iroselle.itemerness.core.presentation.PresentationBlockSource
import com.iroselle.itemerness.core.presentation.PresentationSource
import com.iroselle.itemerness.core.presentation.ThemeSource
import com.iroselle.itemerness.core.presentation.TreeMarkerSource
import com.iroselle.itemerness.editor.protocol.DocumentEncoding.obj
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.nio.file.Files
import java.nio.file.Path
import java.security.MessageDigest
import java.util.HexFormat
import java.util.UUID

class GroupDocumentEncodingTest {
    private val encoder = ProjectDocumentEncoder(UUID.fromString("00000000-0000-4000-8000-000000000001"))
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

    @Test
    fun `existing documents keep the canonical hash captured before groups existed`() {
        val decoded = ProjectDocumentCodec.decode(fixture, metrics)
        val encoded = encoder.encode(decoded.namespace, decoded.defaultLocale, decoded.catalog, decoded.presentation, assets, policies)
        // Captured from the encoder at the commit before groups, separators and markers.
        assertEquals(BASELINE_ENCODED_DIGEST, digest(Json.canonicalize(encoded)))
        val text = Json.canonicalize(encoded)
        listOf("\"separator\"", "\"fieldSeparator\"", "\"markers\"", "\"marker\"", "\"dividers\"").forEach {
            assertFalse(it in text, "$it must stay absent from documents that do not use it")
        }
    }

    @Test
    fun `groups separators root decoration and theme markers round trip with defaults absent`() {
        val original = ProjectDocumentCodec.decode(fixture, metrics)
        val presentation = original.presentation
        val target = presentation.items.first()
        val field = target.blocks.filterIsInstance<PresentationBlockSource.Field>().first()
        val group = PresentationBlockSource.Group(
            header = field.copy(separator = FieldSeparatorSource.None),
            children = listOf(
                PresentationBlockSource.Group(null, listOf(field.copy(separator = FieldSeparatorSource.Message(field.labelMessage)))),
                PresentationBlockSource.Group(
                    null,
                    listOf(field),
                    marker = GroupMarker.BULLET,
                    dividers = GroupDividers.BETWEEN_CHILDREN,
                    whenHeaderMissing = GroupHeaderMissingPolicy.SHOW_CHILDREN,
                    whenEmpty = GroupEmptyPolicy.HIDE,
                    gapBeforeLines = 2,
                ),
            ),
            marker = GroupMarker.TREE,
        )
        val source = PresentationSource(
            formats = presentation.formats, locales = presentation.locales, fonts = presentation.fonts, glyphs = presentation.glyphs,
            bitmaps = presentation.bitmaps, assetProfiles = presentation.assetProfiles, viewerFacts = presentation.viewerFacts,
            resourcePackBindings = presentation.resourcePackBindings,
            layouts = presentation.layouts.map { layout ->
                if (layout !is LayoutSource.Flow) layout else LayoutSource.Flow(
                    layout.id, layout.minimumWidthPixels, layout.maximumWidthPixels, layout.blockGapAfterPixels,
                    layout.fieldLeftPaddingPixels, layout.fieldIconGapPixels, layout.fieldValueAlignment,
                    layout.descriptionLeftPaddingPixels, layout.descriptionRightPaddingPixels, layout.descriptionGapBeforePixels,
                    layout.wrapping, FieldSeparatorSource.None,
                )
            },
            themes = presentation.themes.map { theme ->
                ThemeSource(
                    theme.id, theme.renderer, theme.requiresResourcePack, theme.requiredCapabilities, theme.vanillaTooltipLines,
                    theme.fallback, theme.fonts, theme.styles, theme.tooltipStyle, theme.content, theme.characterFrame,
                    theme.segmentedFrame, theme.canvas, theme.requireExactFontMetrics,
                    MarkerThemeSource(style = "label", bullet = MarkerPieceSource.Text("* "), tree = TreeMarkerSource(last = MarkerPieceSource.Glyph("icon.region"))),
                )
            },
            items = presentation.items.map { item ->
                if (item !== target) item else ItemPresentationSource(
                    item.id, item.layout, item.theme, item.nameMessage, item.blocks + group, item.enabled, item.shownFlags,
                    GroupMarker.BULLET, GroupDividers.NONE,
                )
            },
            spacing = presentation.spacing, tooltipStyles = presentation.tooltipStyles, themeSelectors = presentation.themeSelectors,
        )
        val encoded = encoder.encode(original.namespace, original.defaultLocale, original.catalog, source, assets, policies)
        val root = JsonObject.of(encoded, "encoded")
        val item = root.requiredObjects("items").single { it.requiredString("id") == target.id }.requiredObject("presentation")
        assertEquals("BULLET", item.requiredString("marker"))
        assertEquals("NONE", item.requiredString("dividers"))
        val groupNode = item.requiredObjects("blocks").last()
        assertEquals("group", groupNode.requiredString("type"))
        assertEquals("TREE", groupNode.requiredString("marker"))
        assertEquals(setOf("uuid", "type", "header", "children", "marker", "style", "anchor"), groupNode.keys)
        assertEquals(obj("kind" to "none"), groupNode.requiredObject("header").raw("separator"))
        val (plain, decorated) = groupNode.requiredObjects("children")
        assertEquals(setOf("uuid", "type", "children", "style", "anchor"), plain.keys)
        assertEquals(obj("kind" to "message", "message" to field.labelMessage), plain.requiredObjects("children").single().raw("separator"))
        assertEquals("SHOW_CHILDREN", decorated.requiredString("whenHeaderMissing"))
        assertEquals("HIDE", decorated.requiredString("whenEmpty"))
        assertEquals(2, decorated.requiredInt("gapBeforeLines"))
        assertEquals("BETWEEN_CHILDREN", decorated.requiredString("dividers"))
        assertTrue(root.requiredObjects("layouts").filter { it.requiredString("kind") == "flow" }.all { it.raw("fieldSeparator") == obj("kind" to "none") })
        val markers = root.requiredObjects("themes").first().requiredObject("markers")
        assertEquals(obj("kind" to "text", "text" to "* "), markers.raw("bullet"))
        assertEquals(obj("last" to obj("kind" to "glyph", "glyph" to "icon.region")), markers.raw("tree"))

        val decoded = ProjectDocumentCodec.decode(root, metrics)
        val repeated = encoder.encode(decoded.namespace, decoded.defaultLocale, decoded.catalog, decoded.presentation, assets, policies)
        assertEquals(Json.canonicalize(encoded), Json.canonicalize(repeated))
        val restored = decoded.presentation.items.single { it.id == target.id }
        assertEquals(GroupMarker.BULLET, restored.marker)
        assertEquals(GroupDividers.NONE, restored.dividers)
        val restoredGroup = restored.blocks.last() as PresentationBlockSource.Group
        assertEquals(GroupMarker.TREE, restoredGroup.marker)
        assertEquals(GroupEmptyPolicy.HIDE, (restoredGroup.children[1] as PresentationBlockSource.Group).whenEmpty)

        val canonical = Json.canonicalize(encoded)
        listOf(
            "\"marker\":\"TREE\"" to "\"marker\":\"ARROW\"",
            "{\"kind\":\"none\"}" to "{\"kind\":\"colon\"}",
            "\"whenEmpty\":\"HIDE\"" to "\"whenEmpty\":\"HIDE\",\"collapsed\":true",
        ).forEach { (from, to) ->
            assertTrue(from in canonical, from)
            assertThrows(JsonException::class.java) {
                ProjectDocumentCodec.decode(JsonObject.parse(canonical.replace(from, to), "document"), metrics)
            }
        }
    }

    private fun digest(value: String): String =
        "sha256:" + HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value.toByteArray(Charsets.UTF_8)))

    private companion object {
        const val BASELINE_ENCODED_DIGEST = "sha256:7faa9b0ea930b2734205f378a1c2ac35486cc20b1689245d783fd3f1dc94656f"
    }
}
