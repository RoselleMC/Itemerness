package com.iroselle.itemerness.bukkit.config

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test
import java.io.StringReader

class StrictYamlTest {
    @Test
    fun `loads a deeply immutable mapping`() {
        val document = StrictYaml.load(
            StringReader(
                """
                root:
                  list:
                    - one
                    - two
                """.trimIndent(),
            ),
            "memory.yml",
        )

        @Suppress("UNCHECKED_CAST")
        val root = document.getValue("root") as MutableMap<String, Any?>
        @Suppress("UNCHECKED_CAST")
        val list = root.getValue("list") as MutableList<Any?>

        assertEquals(listOf("one", "two"), list)
        assertThrows(UnsupportedOperationException::class.java) { root["added"] = true }
        assertThrows(UnsupportedOperationException::class.java) { list += "three" }
    }

    @Test
    fun `rejects duplicate keys`() {
        assertThrows(StrictYamlException::class.java) {
            StrictYaml.load(StringReader("key: one\nkey: two\n"), "duplicate.yml")
        }
    }

    @Test
    fun `rejects aliases`() {
        assertThrows(StrictYamlException::class.java) {
            StrictYaml.load(
                StringReader("base: &base [one]\ncopy: *base\n"),
                "alias.yml",
            )
        }
    }

    @Test
    fun `rejects non-string mapping keys`() {
        assertThrows(StrictYamlException::class.java) {
            StrictYaml.load(StringReader("1: value\n"), "number-key.yml")
        }
    }

    @Test
    fun `rejects non-mapping roots`() {
        assertThrows(StrictYamlException::class.java) {
            StrictYaml.load(StringReader("- value\n"), "sequence.yml")
        }
    }

    @Test
    fun `rejects unsafe tags`() {
        assertThrows(StrictYamlException::class.java) {
            StrictYaml.load(
                StringReader("value: !!java.net.URL ['https://example.invalid']\n"),
                "tag.yml",
            )
        }
    }
}
