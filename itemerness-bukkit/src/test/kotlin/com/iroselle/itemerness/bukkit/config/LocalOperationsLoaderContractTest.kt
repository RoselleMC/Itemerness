package com.iroselle.itemerness.bukkit.config

import com.iroselle.itemerness.bukkit.access.AccessPolicyLoader
import com.iroselle.itemerness.editor.protocol.Json
import com.iroselle.itemerness.editor.protocol.JsonObject
import com.iroselle.itemerness.editor.protocol.JsonValue
import java.io.StringReader
import java.nio.file.Files
import java.nio.file.Path
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class LocalOperationsLoaderContractTest {
    @Test
    fun `token trimming retains significant BOM and matches Kotlin whitespace`() {
        val original = requireNotNull(javaClass.classLoader.getResourceAsStream("config.yml")).use { it.readAllBytes().toString(Charsets.UTF_8) }
        val base = StrictYaml.load(StringReader(original), "local-fixture.yml")
        val editor = base.getValue("editor") as Map<*, *>
        for (character in listOf('\u001c', '\u001f', '\u00a0', '\u2007', '\u202f', '\ufeff', '\u0085')) {
            val configured = base + ("editor" to editor + mapOf("enabled" to true, "token" to "$character${"a".repeat(32)}$character"))
            assertEquals(character !in listOf('\ufeff', '\u0085'), runCatching { ItemernessSettings.from(configured, "local-fixture.yml") }.isSuccess, character.code.toString())
        }
    }

    @Test
    fun `local operational YAML fixtures match the real strict loaders`() {
        val directory = Path.of(requireNotNull(System.getProperty("itemerness.editorFixtures")))
        val cases = Json.parse(Files.readString(directory.resolve("local-operations-cases.json"))) as JsonValue.Arr
        cases.values.forEachIndexed { index, value ->
            val case = JsonObject.parse(Json.canonicalize(value), "cases[$index]")
            val kind = case.requiredString("kind")
            val original = requireNotNull(javaClass.classLoader.getResourceAsStream("$kind.yml")).use { it.readAllBytes().toString(Charsets.UTF_8) }
            val from = case.optionalString("from")
            if (from != null) assertTrue(original.contains(from), case.requiredString("name"))
            val content = case.optionalString("prefix").orEmpty() +
                (if (from == null) original else original.replace(from, case.requiredString("to"))) + case.optionalString("suffix").orEmpty()
            val accepted = runCatching {
                val yaml = StrictYaml.load(StringReader(content), "local-fixture.yml")
                if (kind == "config") ItemernessSettings.from(yaml, "local-fixture.yml") else AccessPolicyLoader.from(yaml, "local-fixture.yml")
            }.isSuccess
            assertEquals(case.requiredBoolean("valid"), accepted, case.requiredString("name"))
        }
    }
}
