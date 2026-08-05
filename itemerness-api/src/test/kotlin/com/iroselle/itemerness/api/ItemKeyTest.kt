package com.iroselle.itemerness.api

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test

class ItemKeyTest {
    @Test
    fun `parses a namespaced item key`() {
        val key = ItemKey.parse("itemerness:weapons/frost_blade")

        assertEquals("itemerness", key.namespace)
        assertEquals("weapons/frost_blade", key.value)
        assertEquals("itemerness:weapons/frost_blade", key.toString())
    }

    @Test
    fun `rejects malformed item keys`() {
        listOf(
            "missing_namespace",
            ":value",
            "namespace:",
            "UPPER:value",
            "a:b:c",
            "n".repeat(65) + ":value",
            "namespace:" + "v".repeat(247),
        ).forEach { input ->
            assertThrows(IllegalArgumentException::class.java) {
                ItemKey.parse(input)
            }
        }
    }
}
