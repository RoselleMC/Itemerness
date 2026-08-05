package com.iroselle.itemerness.bukkit.spi

import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test

class BukkitCanonicalItemBridgeTest {
    @Test
    fun `pending names enforce bounded visible fallback data`() {
        assertThrows(IllegalArgumentException::class.java) { PendingItemName("", 0) }
        assertThrows(IllegalArgumentException::class.java) { PendingItemName("pending", -1) }
        assertThrows(IllegalArgumentException::class.java) { PendingItemName("pending", 0x1000000) }
    }
}
