package com.iroselle.itemerness.bukkit.event

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test

class ItemernessCatalogPublishedEventTest {
    @Test
    fun `exposes committed revision and shared handler list`() {
        val event = ItemernessCatalogPublishedEvent(42)

        assertEquals(42, event.catalogRevision)
        assertSame(ItemernessCatalogPublishedEvent.handlerList, event.handlers)
    }

    @Test
    fun `rejects negative revisions`() {
        assertThrows(IllegalArgumentException::class.java) {
            ItemernessCatalogPublishedEvent(-1)
        }
    }
}
