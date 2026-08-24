package com.iroselle.itemerness.bukkit.config

import com.iroselle.itemerness.api.ItemKey
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test
import java.io.InputStreamReader

class ItemernessSettingsTest {
    @Test
    fun `loads the bundled settings and expands the diagnostic pending name`() {
        val resource = checkNotNull(javaClass.classLoader.getResourceAsStream("config.yml"))
        val document = resource.use { input ->
            InputStreamReader(input, Charsets.UTF_8).use { reader ->
                StrictYaml.load(reader, "config.yml")
            }
        }

        val settings = ItemernessSettings.from(document, "config.yml")

        assertEquals("itemerness", settings.defaultNamespace)
        assertEquals("[example:blade]", settings.pendingName(ItemKey.parse("example:blade")))
        assertEquals("dark_gray", settings.pendingNameColor)
        assertEquals("en_us", settings.defaultLocale)
        assertEquals(ItemKey.parse("itemerness:plain"), settings.defaultLayout)
        assertEquals(ItemKey.parse("itemerness:default"), settings.defaultTheme)
    }

    @Test
    fun `an unconfigured editor endpoint keeps the catalog local`() {
        val settings = ItemernessSettings.from(validDocument(), "config.yml")

        assertNull(settings.editor)
    }

    @Test
    fun `a configured editor endpoint enables outbound pairing`() {
        val document = validDocument().toMutableMap()
        document["editor"] = mapOf("url" to "https://items.example.com/", "token" to "secret")

        val settings = ItemernessSettings.from(document, "config.yml")

        // The trailing slash is dropped so the derived API and WebSocket paths are unambiguous.
        assertEquals("https://items.example.com", settings.editor?.url)
    }

    @Test
    fun `the token never appears in a rendered settings value`() {
        val document = validDocument().toMutableMap()
        document["editor"] = mapOf("url" to "https://items.example.com", "token" to "super-secret-token")

        val rendered = ItemernessSettings.from(document, "config.yml").toString()

        // Settings end up in debug output and bug reports; a token that survives toString is a
        // credential leak waiting for someone to paste a log.
        assertFalse(rendered.contains("super-secret-token"), rendered)
        assertTrue(rendered.contains("redacted"), rendered)
    }

    @Test
    fun `half a pairing is a configuration error rather than a silent local fallback`() {
        for (editor in listOf(
            mapOf("url" to "https://items.example.com", "token" to ""),
            mapOf("url" to "", "token" to "secret"),
        )) {
            val document = validDocument().toMutableMap()
            document["editor"] = editor
            assertThrows(StrictYamlException::class.java) {
                ItemernessSettings.from(document, "config.yml")
            }
        }
    }

    @Test
    fun `a plaintext editor endpoint is rejected so a token is never sent in the clear`() {
        val document = validDocument().toMutableMap()
        document["editor"] = mapOf("url" to "http://items.example.com", "token" to "secret")

        assertThrows(StrictYamlException::class.java) {
            ItemernessSettings.from(document, "config.yml")
        }
    }

    @Test
    fun `plaintext editor endpoints accept only explicit loopback hosts`() {
        for (url in listOf("http://localhost:8080", "http://127.0.0.1:8080", "http://[::1]:8080")) {
            val document = validDocument().toMutableMap()
            document["editor"] = mapOf("url" to url, "token" to "secret")

            assertEquals(url, ItemernessSettings.from(document, "config.yml").editor?.url)
        }
    }

    @Test
    fun `deceptive or structurally ambiguous editor endpoints are rejected`() {
        for (url in listOf(
            "http://localhost.example.com",
            "https://",
            "https://items.example.com?target=other",
            "https://items.example.com#fragment",
            "https://user@items.example.com",
        )) {
            val document = validDocument().toMutableMap()
            document["editor"] = mapOf("url" to url, "token" to "secret")

            assertThrows(StrictYamlException::class.java) {
                ItemernessSettings.from(document, "config.yml")
            }
        }
    }

    @Test
    fun `an unset environment reference fails instead of pairing with an empty token`() {
        val document = validDocument().toMutableMap()
        document["editor"] = mapOf(
            "url" to "https://items.example.com",
            "token" to "\${ITEMERNESS_TOKEN_THAT_IS_NOT_SET}",
        )

        assertThrows(StrictYamlException::class.java) {
            ItemernessSettings.from(document, "config.yml")
        }
    }

    @Test
    fun `rejects unknown settings`() {
        val document = validDocument().toMutableMap()
        document["diagnostics"] = emptyMap<String, Any?>()

        assertThrows(StrictYamlException::class.java) {
            ItemernessSettings.from(document, "config.yml")
        }
    }

    @Test
    fun `requires one item id marker in the pending name`() {
        val document = validDocument().toMutableMap()
        document["canonical-item"] = mapOf(
            "pending-name" to mapOf("text" to "pending", "color" to "dark_gray"),
        )

        assertThrows(StrictYamlException::class.java) {
            ItemernessSettings.from(document, "config.yml")
        }
    }

    private fun validDocument(): Map<String, Any?> = mapOf(
        "config-version" to 3,
        "catalog" to mapOf("default-namespace" to "itemerness"),
        "editor" to mapOf("url" to "", "token" to ""),
        "canonical-item" to mapOf(
            "pending-name" to mapOf("text" to "[{item-id}]", "color" to "dark_gray"),
        ),
        "locale" to mapOf("default" to "en_us"),
        "presentation" to mapOf(
            "default-layout" to "itemerness:plain",
            "default-theme" to "itemerness:default",
        ),
    )
}
