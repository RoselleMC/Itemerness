package com.iroselle.itemerness.core

import com.iroselle.itemerness.api.ItemDefinition
import com.iroselle.itemerness.api.ItemKey
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test

class DefaultItemRegistryTest {
    @Test
    fun `registers and removes definitions`() {
        val registry = DefaultItemRegistry()
        val definition = TestDefinition(ItemKey.parse("itemerness:test_item"))

        registry.register(definition)

        assertEquals(definition, registry.findItem(definition.key))
        assertEquals(listOf(definition), registry.items())
        assertEquals(definition, registry.unregister(definition.key))
        assertNull(registry.findItem(definition.key))
    }

    @Test
    fun `rejects duplicate keys`() {
        val registry = DefaultItemRegistry()
        val key = ItemKey.parse("itemerness:duplicate")
        registry.register(TestDefinition(key))

        assertThrows(IllegalArgumentException::class.java) {
            registry.register(TestDefinition(key))
        }
    }

    private data class TestDefinition(
        override val key: ItemKey,
    ) : ItemDefinition
}
