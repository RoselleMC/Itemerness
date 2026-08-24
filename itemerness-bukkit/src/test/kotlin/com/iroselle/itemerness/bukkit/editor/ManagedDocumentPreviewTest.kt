package com.iroselle.itemerness.bukkit.editor

import com.iroselle.itemerness.bukkit.presentation.BuiltinFontMetricsLoader
import com.iroselle.itemerness.editor.agent.CompilerBridge
import com.iroselle.itemerness.editor.protocol.Json
import com.iroselle.itemerness.editor.protocol.JsonObject
import com.iroselle.itemerness.editor.protocol.JsonValue
import java.nio.file.Files
import java.nio.file.Path
import java.security.MessageDigest
import java.util.HexFormat
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/**
 * The managed authoring path, end to end, with nothing stubbed.
 *
 * The golden document the browser edits is decoded into the platform-neutral compiler inputs,
 * compiled by `PresentationCompiler` and `CatalogCompiler`, and rendered by `PresentationEngine`
 * using the real vanilla metrics artifact this module ships. That is the same sequence the plugin
 * runs when projecting an item to a player, which is what allows a preview produced this way to be
 * labelled `server-verified` rather than `local`.
 *
 * This is a compile-and-render proof, not runtime proof. It says nothing about Folia scheduling,
 * packet projection, or what a client actually draws; those need the craftr runtime matrix.
 */
class ManagedDocumentPreviewTest {
    private val fixtureDirectory: Path by lazy {
        Path.of(
            requireNotNull(System.getProperty("itemerness.editorFixtures")) {
                "itemerness.editorFixtures is not set; see itemerness-bukkit/build.gradle.kts"
            },
        )
    }

    private val documentJson: String by lazy {
        Files.readString(fixtureDirectory.resolve("baseline.json"))
    }

    private val snapshotHash: String by lazy {
        Files.readString(fixtureDirectory.resolve("baseline.sha256")).trim()
    }

    private val bridge = CompilerBridge(
        BundledBuiltinFontMetrics(BuiltinFontMetricsLoader.bundled("26.1.2")),
        agentVersion = "test",
    )

    private fun context(
        itemId: String,
        locale: String = "en_us",
        withPack: Boolean = true,
        hash: String = snapshotHash,
    ) = CompilerBridge.PreviewContext(
        itemId = itemId,
        locale = locale,
        requestedTheme = null,
        assetProfile = if (withPack) "itemerness:example-pack-v1" else "itemerness:vanilla",
        capabilities = if (withPack) {
            listOf(
                "itemerness:native-tooltip-style-v1",
                "itemerness:segmented-frame-v1",
                "itemerness:signed-advance-v1",
                "itemerness:bitmap-canvas-v1",
            )
        } else {
            emptyList()
        },
        metricsRevision = if (withPack) "itemerness:example-pack-v1" else null,
        resourcePackLoaded = withPack,
        managesVanillaTooltipLines = withPack,
        snapshotHash = hash,
    )

    private fun render(itemId: String, locale: String = "en_us", withPack: Boolean = true): JsonObject {
        return compile(documentJson, context(itemId, locale, withPack))
    }

    private fun compile(document: String, context: CompilerBridge.PreviewContext): JsonObject {
        val outcome = bridge.compilePreview(document, context)
        val json = when (outcome) {
            is CompilerBridge.Outcome.Rendered -> outcome.json
            is CompilerBridge.Outcome.Rejected -> outcome.json
        }
        return JsonObject.of(Json.parse(json), "artifact")
    }

    private fun lineText(line: JsonObject): String =
        line.requiredObjects("runs").joinToString("") { it.requiredString("text") }

    @Test
    fun `renders the ember blade with formatted values through the production compiler`() {
        val artifact = render("itemerness:ember-blade")
        assertEquals("agent", artifact.requiredString("origin"))
        val display = artifact.requiredObject("display")
        assertEquals("Ember Blade", lineText(display.requiredObject("displayName")))

        val lore = display.requiredObjects("lore").map(::lineText)
        assertTrue(lore.any { it.contains("Attack Damage") && it.contains("38.5") }, "lore was $lore")
        assertTrue(lore.any { it.contains("Quality") && it.contains("Rare") }, "lore was $lore")
        // example:level is 8 and the item requires 12, so the conditional takes the unmet branch.
        assertTrue(lore.any { it.contains("Required Level") && it.contains("12") }, "lore was $lore")
        // The repeat block expands once per socket, including the empty one.
        assertEquals(2, lore.count { it.contains("Socket") }, "lore was $lore")
    }

    @Test
    fun `measures every line with the shipped font metrics`() {
        val display = render("itemerness:ember-blade").requiredObject("display")
        val lines = listOf(display.requiredObject("displayName")) + display.requiredObjects("lore")
        for (line in lines) {
            val width = line.requiredInt("logicalWidthPixels")
            // The equipment layout emits blank spacer lines before the description block, so a
            // zero-width line is correct as long as it is genuinely empty.
            if (lineText(line).isEmpty()) {
                assertEquals(0, width, "an empty line measured $width pixels")
            } else {
                assertTrue(width > 0, "a rendered line measured $width pixels: ${lineText(line)}")
            }
            assertTrue(width <= 220, "a rendered line exceeded the budget at $width pixels")
        }
        assertTrue(lines.any { lineText(it).isNotEmpty() }, "every line was empty")
        // "Ember Blade" in the default font is 61 pixels; the browser engine measures the same
        // value from the same artifact, which is what makes the two previews comparable.
        assertEquals(61, display.requiredObject("displayName").requiredInt("logicalWidthPixels"))
    }

    @Test
    fun `renders the same item in another language without touching the document`() {
        val english = render("itemerness:ember-blade", locale = "en_us")
        val chinese = render("itemerness:ember-blade", locale = "zh_cn")
        assertEquals("Ember Blade", lineText(english.requiredObject("display").requiredObject("displayName")))
        assertEquals("余烬之刃", lineText(chinese.requiredObject("display").requiredObject("displayName")))
        assertTrue(
            chinese.requiredObject("display").requiredObject("displayName").requiredInt("logicalWidthPixels") > 0,
        )
    }

    @Test
    fun `renders nested item names and amounts in the viewer locale`() {
        val englishLore = render("itemerness:nested-satchel", locale = "en_us")
            .requiredObject("display")
            .requiredObjects("lore")
            .map(::lineText)
        val chineseLore = render("itemerness:nested-satchel", locale = "zh_cn")
            .requiredObject("display")
            .requiredObjects("lore")
            .map(::lineText)

        assertTrue(englishLore.any { "Harbor Travel Token ×2" in it }, "lore was $englishLore")
        assertTrue(chineseLore.any { "港口旅行凭证 ×2" in it }, "lore was $chineseLore")
    }

    @Test
    fun `falls back and records why when the viewer has no resource pack`() {
        val artifact = render("itemerness:survey-codex", withPack = false)
        val display = artifact.requiredObject("display")
        assertEquals("itemerness:aurora-canvas", display.requiredString("requestedTheme"))
        assertFalse(display.requiredString("selectedTheme") == "itemerness:aurora-canvas")
        val reasons = display.requiredObjects("fallbackReasons").map { it.requiredString("code") }
        assertTrue(reasons.contains("RESOURCE_PACK_UNAVAILABLE"), "reasons were $reasons")
    }

    @Test
    fun `anchors the bitmap canvas to its declared width when the pack is present`() {
        val display = render("itemerness:survey-codex", withPack = true).requiredObject("display")
        assertEquals("itemerness:aurora-canvas", display.requiredString("selectedTheme"))
        assertEquals("BITMAP_CANVAS", display.requiredString("renderer"))
        assertEquals("itemerness:transparent-canvas", display.requiredString("tooltipStyle"))
        val widths = display.requiredObjects("lore").map { it.requiredInt("logicalWidthPixels") }
        // Without the width anchor the negative spacing would leave the tooltip measuring nothing.
        assertTrue(widths.any { it == 176 }, "no line anchored the canvas width; widths were $widths")
    }

    @Test
    fun `reports an unknown item as a structured failure rather than an exception`() {
        val artifact = render("itemerness:not-in-this-project")
        assertEquals("UNKNOWN_ITEM", artifact.requiredObject("failure").requiredString("code"))
        // Diagnostics carry a key and parameters so the browser renders them in its own language.
        assertNotNull(artifact.requiredObject("failure").requiredString("messageKey"))
    }

    @Test
    fun `carries the digests the control plane fences preview responses with`() {
        val digests = render("itemerness:travel-token").requiredObject("digests")
        assertEquals(snapshotHash, digests.requiredString("snapshot"))
        assertTrue(digests.requiredString("compiler").matches(Regex("sha256:[0-9a-f]{64}")))
        assertEquals("schema-1", digests.requiredString("documentSchema"))
    }

    @Test
    fun `rejects a document that claims another snapshot hash`() {
        val outcome = bridge.compilePreview(
            documentJson,
            CompilerBridge.PreviewContext(
                itemId = "itemerness:travel-token",
                locale = "en_us",
                requestedTheme = null,
                assetProfile = "itemerness:vanilla",
                capabilities = emptyList(),
                metricsRevision = null,
                resourcePackLoaded = false,
                managesVanillaTooltipLines = false,
                snapshotHash = "sha256:not-the-document",
            ),
        )
        val json = when (outcome) {
            is CompilerBridge.Outcome.Rendered -> outcome.json
            is CompilerBridge.Outcome.Rejected -> outcome.json
        }
        val artifact = JsonObject.of(Json.parse(json), "artifact")

        assertEquals("SNAPSHOT_MISMATCH", artifact.requiredObject("failure").requiredString("code"))
        assertEquals(snapshotHash, artifact.requiredObject("digests").requiredString("snapshot"))
    }

    @Test
    fun `rejects an invalid catalog without returning a display`() {
        val invalidDocument = mutateItem("travel-token") { item ->
            val definition = item.objectValue("definition")
            item.with("definition", definition.with("material", JsonValue.Text("INVALID MATERIAL")))
        }
        val artifact = compile(
            invalidDocument,
            context("itemerness:travel-token", hash = documentHash(invalidDocument)),
        )

        assertEquals("DOCUMENT_INVALID", artifact.requiredObject("failure").requiredString("code"))
        assertEquals(JsonValue.Null, artifact.raw("display"))
        assertTrue(
            artifact.requiredObjects("diagnostics").any { it.requiredString("code") == "CATALOG.INVALID_ID" },
        )
    }

    @Test
    fun `rejects preview data that violates the compiled schema constraints`() {
        val invalidDocument = mutateItem("travel-token") { item ->
            val previewData = item.arrayValue("previewData")
            item.with(
                "previewData",
                JsonValue.Arr(
                    previewData.values.map { rawAssignment ->
                        val assignment = rawAssignment.objectValue()
                        if (assignment.textValue("key") == "example:charges") {
                            assignment.with(
                                "value",
                                JsonValue.Obj(
                                    linkedMapOf(
                                        "kind" to JsonValue.Text("integer"),
                                        "value" to JsonValue.Text("10000"),
                                    ),
                                ),
                            )
                        } else {
                            assignment
                        }
                    },
                ),
            )
        }
        val artifact = compile(
            invalidDocument,
            context("itemerness:travel-token", hash = documentHash(invalidDocument)),
        )

        assertEquals("DOCUMENT_INVALID", artifact.requiredObject("failure").requiredString("code"))
        assertEquals(JsonValue.Null, artifact.raw("display"))
        assertTrue(
            artifact.requiredObject("failure").requiredString("messageKey")
                .endsWith("preview_data_invalid"),
        )
    }

    @Test
    fun `rejects preview data for a definition-scoped key`() {
        val invalidDocument = mutateItem("ember-blade") { item ->
            val previewData = item.arrayValue("previewData")
            val definitionOverride = JsonValue.Obj(
                linkedMapOf(
                    "key" to JsonValue.Text("example:required-level"),
                    "value" to JsonValue.Obj(
                        linkedMapOf(
                            "kind" to JsonValue.Text("integer"),
                            "value" to JsonValue.Text("99"),
                        ),
                    ),
                ),
            )
            item.with("previewData", JsonValue.Arr(previewData.values + definitionOverride))
        }
        val artifact = compile(
            invalidDocument,
            context("itemerness:ember-blade", hash = documentHash(invalidDocument)),
        )

        assertEquals("DOCUMENT_INVALID", artifact.requiredObject("failure").requiredString("code"))
        assertEquals(JsonValue.Null, artifact.raw("display"))
        assertTrue(
            artifact.requiredObject("failure").requiredObject("params").requiredString("detail")
                .contains("not instance-scoped"),
        )
    }

    private fun mutateItem(itemId: String, transform: (JsonValue.Obj) -> JsonValue.Obj): String {
        val root = Json.parse(documentJson).objectValue()
        val items = root.arrayValue("items")
        var matched = false
        val updated = items.values.map { rawItem ->
            val item = rawItem.objectValue()
            if (item.textValue("id") == itemId) {
                matched = true
                transform(item)
            } else {
                item
            }
        }
        check(matched) { "Fixture item $itemId was not found" }
        return Json.canonicalize(root.with("items", JsonValue.Arr(updated)))
    }

    private fun documentHash(document: String): String {
        val canonical = Json.canonicalize(Json.parse(document))
        val digest = MessageDigest.getInstance("SHA-256").digest(canonical.toByteArray(Charsets.UTF_8))
        return "sha256:${HexFormat.of().formatHex(digest)}"
    }

    private fun JsonValue.objectValue(): JsonValue.Obj =
        requireNotNull(this as? JsonValue.Obj) { "Expected an object in the fixture" }

    private fun JsonValue.Obj.objectValue(key: String): JsonValue.Obj =
        requireNotNull(entries[key] as? JsonValue.Obj) { "Expected object field $key in the fixture" }

    private fun JsonValue.Obj.arrayValue(key: String): JsonValue.Arr =
        requireNotNull(entries[key] as? JsonValue.Arr) { "Expected array field $key in the fixture" }

    private fun JsonValue.Obj.textValue(key: String): String =
        requireNotNull((entries[key] as? JsonValue.Text)?.value) { "Expected text field $key in the fixture" }

    private fun JsonValue.Obj.with(key: String, value: JsonValue): JsonValue.Obj =
        JsonValue.Obj(LinkedHashMap(entries).apply { put(key, value) })
}
