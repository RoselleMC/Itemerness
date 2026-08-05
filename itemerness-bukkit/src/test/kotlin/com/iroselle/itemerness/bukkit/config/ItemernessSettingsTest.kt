package com.iroselle.itemerness.bukkit.config

import com.iroselle.itemerness.api.ItemKey
import org.junit.jupiter.api.Assertions.assertEquals
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
    fun `rejects a configured editor endpoint`() {
        val document = validDocument().toMutableMap()
        document["editor"] = mapOf("url" to "https://editor.invalid", "token" to "secret")

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
