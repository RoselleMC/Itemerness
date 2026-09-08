package com.iroselle.itemerness.editor.agent

import com.iroselle.itemerness.core.presentation.GlyphMetricSource
import com.iroselle.itemerness.editor.protocol.BuiltinFontMetrics
import com.iroselle.itemerness.editor.protocol.BuiltinFontTable
import com.iroselle.itemerness.editor.protocol.Json
import com.iroselle.itemerness.editor.protocol.JsonException
import com.iroselle.itemerness.editor.protocol.JsonValue
import com.iroselle.itemerness.editor.protocol.ProjectDocumentCodec
import java.nio.file.Files
import java.nio.file.Path
import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir

class EditorDraftVersionTest {
    @TempDir
    lateinit var directory: Path

    private val metrics = BuiltinFontMetrics { revision ->
        BuiltinFontTable(
            if (revision.contains("uniform")) "minecraft:uniform" else "minecraft:default",
            "builtin:$revision", null, GlyphMetricSource(6.0), emptyMap(),
        )
    }

    @Test
    fun `reading a real legacy draft never changes its bytes hash or revision`() {
        val fixturePath = Path.of(requireNotNull(System.getProperty("itemerness.editorFixtures")))
        val document = Json.parse(Files.readString(fixturePath.resolve("baseline.json")))
        val expectedHash = Files.readString(fixturePath.resolve("baseline.sha256")).trim()
        val path = directory.resolve("draft.json")
        val envelope = EditorDraftStore.Snapshot(document, expectedHash, 54)
        Files.writeString(path, Json.canonicalize(envelope.json()))
        val before = Files.readAllBytes(path)
        val store = store(path)
        assertEquals(envelope, store.read())
        assertEquals(envelope, store.save(document, expectedHash))
        assertArrayEquals(before, Files.readAllBytes(path))
        assertEquals(envelope, store(path).read())
    }

    @Test
    fun `an explicit version upgrade creates one CAS revision and rejects stale writers`() {
        val path = directory.resolve("draft.json")
        val store = store(path)
        val legacy = Json.parse("""{"schemaVersion":1,"documentId":"00000000-0000-4000-8000-000000000001","namespace":"example","defaultLocale":"en_us","extensions":{"exact":{"future":true}}}""") as JsonValue.Obj
        val first = store.save(legacy, "")
        val upgraded = JsonValue.Obj(legacy.entries + mapOf(
            "schemaVersion" to JsonValue.Num(2.0),
            "measurement" to JsonValue.Obj(mapOf("boldExtraAdvancePixels" to JsonValue.Num(1.0))),
        ))
        val second = store.save(upgraded, first.snapshotHash)
        assertEquals(2, second.revision)
        assertEquals(upgraded, second.document)
        assertEquals(second, store(path).read())
        assertThrows(EditorDraftStore.Conflict::class.java) { store.save(legacy, first.snapshotHash) }
        assertEquals(second, store.read())
    }

    @Test
    fun `unknown fields are rejected without replacing the existing draft`() {
        val path = directory.resolve("draft.json")
        val store = store(path)
        val legacy = Json.parse("""{"schemaVersion":1,"documentId":"00000000-0000-4000-8000-000000000001","namespace":"example","defaultLocale":"en_us"}""") as JsonValue.Obj
        val first = store.save(legacy, "")
        val before = Files.readAllBytes(path)
        val unknown = JsonValue.Obj(legacy.entries + ("future" to JsonValue.Bool(true)))
        assertThrows(JsonException::class.java) { store.save(unknown, first.snapshotHash) }
        assertEquals(first, store.read())
        assertArrayEquals(before, Files.readAllBytes(path))
    }

    private fun store(path: Path) = EditorDraftStore(path) { ProjectDocumentCodec.decode(it, metrics) }
}
