package com.iroselle.itemerness.bukkit.editor

import com.iroselle.itemerness.api.ItemKey
import com.iroselle.itemerness.bukkit.catalog.MaterialProperties
import com.iroselle.itemerness.bukkit.catalog.RuntimeCatalogValidator
import com.iroselle.itemerness.bukkit.presentation.BuiltinFontMetricsLoader
import com.iroselle.itemerness.editor.agent.CatalogTransferException
import com.iroselle.itemerness.editor.agent.CompilerBridge
import com.iroselle.itemerness.editor.agent.EditorDraftStore
import com.iroselle.itemerness.editor.protocol.Json
import com.iroselle.itemerness.editor.protocol.JsonObject
import com.iroselle.itemerness.editor.protocol.JsonValue
import java.nio.file.Files
import java.nio.file.Path
import java.util.UUID
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir

/** A production-sized catalog (#12) travels through import, draft storage, preview and export intact. */
class LargeCatalogTransferTest {
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
    fun `a catalog above three megabytes imports saves previews and exports every definition`() {
        fixture()
        val bridge = CompilerBridge(BundledBuiltinFontMetrics(metrics), "test")
        val seed = document(reader().read(includeLayout = true))
        val grown = grow(seed, ITEMS)
        val exporter = EditorCatalogExporter(metrics, bridge, currentSourceHash = { reader().currentSourceHash() })
        val files = JsonObject.of(exportOrFail(exporter, grown), "export").requiredObjects("files")
        write(files)

        val started = System.nanoTime()
        val imported = try { document(reader().read(includeLayout = true)) } catch (failure: CatalogTransferException) {
            throw AssertionError(failure.code + ": " + Json.canonicalize(JsonValue.Arr(failure.diagnostics)))
        }
        val readMillis = (System.nanoTime() - started) / 1_000_000
        val text = Json.canonicalize(imported)
        val bytes = text.toByteArray(Charsets.UTF_8).size
        assertTrue(bytes >= 3_250_000, "document has $bytes bytes")
        assertEquals(ITEMS, (imported.entries.getValue("items") as JsonValue.Arr).values.size)

        val store = EditorDraftStore(directory.resolve("draft.json")) { Json.parse(it) }
        val saved = store.save(imported, "")
        assertEquals(saved, EditorDraftStore(directory.resolve("draft.json")) { Json.parse(it) }.read())

        val compilationsBefore = bridge.compilationCount
        val previews = (0 until 3).map {
            val begin = System.nanoTime()
            val outcome = bridge.compilePreview(text, CompilerBridge.PreviewContext(
                itemId = "itemerness:ember-blade-copy-${ITEMS - 1 - it}", locale = "en_us", requestedTheme = null,
                assetProfile = null, capabilities = emptyList(), metricsRevision = null,
                resourcePackLoaded = false, managesVanillaTooltipLines = false, snapshotHash = saved.snapshotHash,
            ))
            assertTrue(outcome is CompilerBridge.Outcome.Rendered, outcome.toString())
            assertEquals(JsonValue.Null, JsonObject.parse((outcome as CompilerBridge.Outcome.Rendered).json, "artifact").raw("failure"))
            (System.nanoTime() - begin) / 1_000_000
        }
        assertEquals(1, bridge.compilationCount - compilationsBefore, "previews of one document share its compilation")
        val exportStarted = System.nanoTime()
        val exported = JsonObject.of(exportOrFail(exporter, imported), "export")
        val exportMillis = (System.nanoTime() - exportStarted) / 1_000_000
        // The exporter verifies its own output; reading it back from disk proves no definition was dropped.
        write(exported.requiredObjects("files"))
        assertEquals(ITEMS, (document(reader().read()).entries.getValue("items") as JsonValue.Arr).values.size)
        println("large catalog: $bytes bytes, read ${readMillis}ms, previews $previews ms, export ${exportMillis}ms")
    }

    @Test
    fun `an exported file above the loader's per-file limits is split into parts that reload`() {
        fixture()
        val bridge = CompilerBridge(BundledBuiltinFontMetrics(metrics), "test")
        val exporter = EditorCatalogExporter(metrics, bridge, currentSourceHash = { reader().currentSourceHash() })
        // Every copy assigned to one file, as a hand-written catalog with anchors might be.
        val grown = grow(document(reader().read(includeLayout = true)), ITEMS) { "items/weapons.yml" }
        val files = JsonObject.of(exportOrFail(exporter, grown), "export").requiredObjects("files")
        val parts = files.filter { it.requiredString("path").startsWith("items/weapons") }
        assertTrue(parts.size > 1, parts.map { it.requiredString("path") }.toString())
        assertEquals(parts.indices.map { "items/weapons-part-${(it + 1).toString().padStart(2, '0')}.yml" }, parts.map { it.requiredString("path") })
        parts.forEach { part ->
            val content = part.requiredString("content")
            assertTrue(content.codePointCount(0, content.length) <= com.iroselle.itemerness.bukkit.config.StrictYaml.MAX_CODE_POINTS)
        }
        write(files)
        val reread = document(reader().read(includeLayout = true))
        assertEquals(ITEMS, (reread.entries.getValue("items") as JsonValue.Arr).values.size)
        // The next import records each object's part, so a later export keeps the same split.
        val layout = ((reread.entries.getValue("sourceLayout") as JsonValue.Obj).entries.getValue("files") as JsonValue.Obj).entries.values
            .map { (it as JsonValue.Text).value }.toSet()
        assertTrue(parts.all { it.requiredString("path") in layout })
    }

    @Test
    fun `files that cannot be split are all reported with their sizes`() {
        fixture()
        val bridge = CompilerBridge(BundledBuiltinFontMetrics(metrics), "test")
        val seed = document(reader().read(includeLayout = true))
        val padded = JsonValue.Obj(seed.entries + ("locales" to JsonValue.Arr((seed.entries.getValue("locales") as JsonValue.Arr).values.map { value ->
            val locale = value as JsonValue.Obj
            val messages = locale.entries.getValue("messages") as JsonValue.Obj
            JsonValue.Obj(locale.entries + ("messages" to JsonValue.Obj(messages.entries + (0 until 70).associate { "item.padding-$it.lore" to JsonValue.Text("x".repeat(16_000)) })))
        })))
        val failure = assertThrows(CatalogTransferException::class.java) { EditorCatalogExporter(metrics, bridge).export(padded) }
        assertEquals("CATALOG_EXPORT_INVALID", failure.code)
        val reported = failure.diagnostics.map { JsonObject.of(it, "diagnostic") }
        assertEquals((seed.entries.getValue("locales") as JsonValue.Arr).values.size, reported.size, "every oversized locale file is listed")
        reported.forEach { diagnostic ->
            assertEquals("CATALOG.EXPORT_FILE_TOO_LARGE", diagnostic.requiredString("code"))
            val params = diagnostic.requiredObject("params")
            assertTrue(params.requiredString("path").startsWith("locales/"))
            assertTrue(params.requiredString("codePoints").toInt() > params.requiredString("limit").toInt())
        }
    }

    private fun exportOrFail(exporter: EditorCatalogExporter, document: JsonValue): JsonValue = try { exporter.export(document) } catch (failure: CatalogTransferException) {
        throw AssertionError(failure.code + ": " + Json.canonicalize(JsonValue.Arr(failure.diagnostics)).take(3000))
    }

    private fun document(response: JsonValue): JsonValue.Obj = JsonObject.of(response, "response").raw("document") as JsonValue.Obj

    /** Repeats the enabled bundled items with fresh identities and longer content until [count] items exist. */
    private fun grow(source: JsonValue.Obj, count: Int, file: (Int) -> String = { "items/generated-${it / 50}.yml" }): JsonValue.Obj {
        val originals = (source.entries.getValue("items") as JsonValue.Arr).values.map { it as JsonValue.Obj }
        val template = originals.single { (it.entries.getValue("id") as JsonValue.Text).value.endsWith("ember-blade") }
        var next = 0
        fun fresh(value: JsonValue): JsonValue = when (value) {
            is JsonValue.Obj -> JsonValue.Obj(value.entries.mapValues { (key, child) ->
                if (key == "uuid" && child is JsonValue.Text) JsonValue.Text(UUID.nameUUIDFromBytes("large-${next++}".toByteArray()).toString()) else fresh(child)
            })
            is JsonValue.Arr -> JsonValue.Arr(value.values.map(::fresh))
            else -> value
        }
        val copies = (originals.size until count).map { index ->
            val item = fresh(template) as JsonValue.Obj
            val presentation = item.entries.getValue("presentation") as JsonValue.Obj
            val blocks = (presentation.entries.getValue("blocks") as JsonValue.Arr).values
            JsonValue.Obj(item.entries + mapOf(
                "id" to JsonValue.Text("itemerness:ember-blade-copy-$index"),
                "enabled" to JsonValue.Bool(true),
                "presentation" to JsonValue.Obj(presentation.entries + mapOf(
                    "blocks" to JsonValue.Arr(blocks + blocks.map(::fresh) + blocks.map(::fresh)),
                    "overflow" to JsonValue.Text("HIDE"),
                )),
            ))
        }
        // Like a real catalog, the copies are spread over files below the loader's per-file limit.
        val layout = source.entries.getValue("sourceLayout") as JsonValue.Obj
        val files = layout.entries.getValue("files") as JsonValue.Obj
        val placed = copies.mapIndexed { index, item ->
            (item.entries.getValue("uuid") as JsonValue.Text).value to JsonValue.Text(file(index))
        }
        // Each copy also carries its own translated text, as production items do.
        val locales = (source.entries.getValue("locales") as JsonValue.Arr).values.map { value ->
            val locale = value as JsonValue.Obj
            val messages = locale.entries.getValue("messages") as JsonValue.Obj
            JsonValue.Obj(locale.entries + ("messages" to JsonValue.Obj(messages.entries + copies.indices.associate { index ->
                "item.copy-$index.lore" to JsonValue.Text("Copy $index keeps a translated paragraph of flavor text. ".repeat(10))
            })))
        }
        return JsonValue.Obj(source.entries + mapOf(
            "items" to JsonValue.Arr(originals + copies),
            "locales" to JsonValue.Arr(locales),
            "sourceLayout" to JsonValue.Obj(layout.entries + ("files" to JsonValue.Obj(files.entries + placed))),
        ))
    }

    private fun write(files: List<JsonObject>) = files.forEach { file ->
        val path = directory.resolve(file.requiredString("path"))
        Files.createDirectories(path.parent)
        Files.writeString(path, file.requiredString("content"))
    }

    private fun reader() = EditorCatalogReader(directory, metrics, "test", validator)

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

    private companion object {
        const val ITEMS = 425
    }
}
