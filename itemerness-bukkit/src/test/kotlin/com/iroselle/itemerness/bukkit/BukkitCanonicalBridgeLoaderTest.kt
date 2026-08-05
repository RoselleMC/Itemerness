package com.iroselle.itemerness.bukkit

import com.iroselle.itemerness.api.ItemKey
import com.iroselle.itemerness.bukkit.spi.BukkitCanonicalBridgeDescriptor
import com.iroselle.itemerness.bukkit.spi.BukkitCanonicalItemBridge
import com.iroselle.itemerness.bukkit.spi.BukkitCanonicalItemBridgeFactory
import com.iroselle.itemerness.projection.MinecraftVersion
import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test

class BukkitCanonicalBridgeLoaderTest {
    @Test
    fun `selects exactly one bridge for the server ABI`() {
        val old = factory("26.1.1")
        val exact = factory("26.1.2")

        assertSame(
            exact,
            BukkitCanonicalBridgeLoader.select(listOf(old, exact), MinecraftVersion("26.1.2")),
        )
    }

    @Test
    fun `fails closed for missing or ambiguous ABI bridges`() {
        val version = MinecraftVersion("26.1.2")

        assertThrows(IllegalStateException::class.java) {
            BukkitCanonicalBridgeLoader.select(emptyList(), version)
        }
        assertThrows(IllegalStateException::class.java) {
            BukkitCanonicalBridgeLoader.select(listOf(factory("26.1.2"), factory("26.1.2")), version)
        }
    }

    private fun factory(version: String): BukkitCanonicalItemBridgeFactory =
        object : BukkitCanonicalItemBridgeFactory {
            override val descriptor = BukkitCanonicalBridgeDescriptor(
                ItemKey.parse("itemerness:test-${version.replace('.', '-')}") ,
                MinecraftVersion(version),
            )

            override fun create(): BukkitCanonicalItemBridge = error("Selection tests must not create bridges")
        }
}
