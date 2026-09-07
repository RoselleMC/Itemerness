package com.iroselle.itemerness.bukkit.config

import com.iroselle.itemerness.api.ItemKey
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import java.io.InputStreamReader

class ItemernessSettingsTest {
    private fun validDocument(): Map<String, Any?> {
        val resource = checkNotNull(javaClass.classLoader.getResourceAsStream("config.yml"))
        return resource.use { InputStreamReader(it, Charsets.UTF_8).use { reader -> StrictYaml.load(reader, "config.yml") } }
    }

    private fun editor(vararg overrides: Pair<String, Any?>): Map<String, Any?> = mapOf(
        "enabled" to true, "bind-host" to "127.0.0.1", "port" to 18087,
        "token" to "a".repeat(48), "allowed-origins" to emptyList<String>(),
    ) + overrides

    private fun load(editor: Map<String, Any?>) = ItemernessSettings.from(validDocument() + ("editor" to editor), "config.yml")

    @Test
    fun `bundled settings keep the listener disabled`() {
        val settings = ItemernessSettings.from(validDocument(), "config.yml")
        assertNull(settings.editor)
        assertEquals("itemerness", settings.defaultNamespace)
        assertEquals("[example:blade]", settings.pendingName(ItemKey.parse("example:blade")))
        assertEquals("dark_gray", settings.pendingNameColor)
        assertEquals("en_us", settings.defaultLocale)
        assertEquals(ItemKey.parse("itemerness:plain"), settings.defaultLayout)
        assertEquals(ItemKey.parse("itemerness:default"), settings.defaultTheme)
    }

    @Test
    fun `listener accepts explicit bind port token and exact browser origins`() {
        val settings = load(editor("allowed-origins" to listOf("http://127.0.0.1:5173", "https://editor.example.com")))
        assertEquals("127.0.0.1", settings.editor?.bindHost)
        assertEquals(18087, settings.editor?.port)
        assertEquals(2, settings.editor?.allowedOrigins?.size)
        assertFalse(settings.toString().contains("a".repeat(48)))
        assertTrue(settings.toString().contains("redacted"))
    }

    @Test
    fun `legacy disabled configurations remain valid but outbound pairing requires migration`() {
        assertNull(load(mapOf("url" to "", "token" to "")).editor)
        for (old in listOf(mapOf("url" to "https://example.com", "token" to "secret"), mapOf("url" to "", "token" to "secret"))) {
            val error = assertThrows(StrictYamlException::class.java) { load(old) }
            assertTrue(error.message!!.contains("migrate"))
        }
    }

    @Test
    fun `invalid listener settings fail closed`() {
        for (invalid in listOf(
            editor("token" to "short"), editor("token" to "a".repeat(40) + "\n" + "b"),
            editor("port" to 0), editor("port" to 65536), editor("bind-host" to "http://localhost"),
            editor("allowed-origins" to listOf("*")), editor("allowed-origins" to listOf("https://example.com/path")),
            editor("allowed-origins" to listOf("https://user@example.com")),
            editor("token" to "\${ITEMERNESS_TOKEN_THAT_IS_NOT_SET}"),
            editor("url" to "https://example.com"),
        )) assertThrows(StrictYamlException::class.java) { load(invalid) }
    }

    @Test
    fun `disabled listener does not require a credential environment variable`() {
        assertNull(load(editor("enabled" to false, "token" to "\${ITEMERNESS_TOKEN_THAT_IS_NOT_SET}")).editor)
    }

    @Test
    fun `an enabled listener accepts an empty token as an explicit unauthenticated API`() {
        val settings = load(editor("token" to ""))
        assertNotNull(settings.editor)
        assertEquals("", settings.editor?.token)
        assertEquals("127.0.0.1", settings.editor?.bindHost)
    }

    @Test
    fun `unknown settings and missing pending-name marker are rejected`() {
        assertThrows(StrictYamlException::class.java) {
            ItemernessSettings.from(validDocument() + ("diagnostics" to emptyMap<String, Any?>()), "config.yml")
        }
        assertThrows(StrictYamlException::class.java) {
            ItemernessSettings.from(validDocument() + ("canonical-item" to mapOf("pending-name" to mapOf("text" to "pending", "color" to "dark_gray"))), "config.yml")
        }
    }
}
