package com.iroselle.itemerness.projection

import com.iroselle.itemerness.api.ItemKey
import java.util.UUID
import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test

class SnapshotImmutabilityTest {
    @Test
    fun `canonical fingerprint never exposes mutable bytes`() {
        val source = byteArrayOf(1, 2, 3)
        val fingerprint = CanonicalItemFingerprint(source)

        source[0] = 9
        val returned = fingerprint.copyBytes()
        returned[1] = 9

        assertArrayEquals(byteArrayOf(1, 2, 3), fingerprint.copyBytes())
    }

    @Test
    fun `viewer snapshot defensively copies facts and capabilities`() {
        val facts = mutableListOf(
            ViewerFact(ItemKey.parse("example:level"), IntegerProjectionValue(12)),
        )
        val capabilities = mutableListOf(ItemKey.parse("itemerness:bitmap_canvas"))
        val snapshot = ViewerProjectionSnapshot(
            viewerId = UUID.fromString("b3efd69a-ef71-4c1e-9e09-927f3d440311"),
            revision = 4,
            locale = LocaleId("zh_cn"),
            theme = ItemKey.parse("itemerness:default"),
            assetProfile = null,
            facts = facts,
            capabilities = capabilities,
        )

        facts.clear()
        capabilities.clear()

        assertEquals(IntegerProjectionValue(12), snapshot.fact(ItemKey.parse("example:level")))
        assertEquals(true, snapshot.hasCapability(ItemKey.parse("itemerness:bitmap_canvas")))
    }

    @Test
    fun `viewer snapshot rejects duplicate fact keys and capabilities`() {
        val key = ItemKey.parse("example:level")
        val capability = ItemKey.parse("itemerness:bitmap_canvas")

        assertThrows(IllegalArgumentException::class.java) {
            ViewerProjectionSnapshot(
                viewerId = UUID.randomUUID(),
                revision = 0,
                locale = LocaleId("en_us"),
                theme = ItemKey.parse("itemerness:default"),
                assetProfile = null,
                facts = listOf(
                    ViewerFact(key, IntegerProjectionValue(1)),
                    ViewerFact(key, IntegerProjectionValue(2)),
                ),
            )
        }
        assertThrows(IllegalArgumentException::class.java) {
            ViewerProjectionSnapshot(
                viewerId = UUID.randomUUID(),
                revision = 0,
                locale = LocaleId("en_us"),
                theme = ItemKey.parse("itemerness:default"),
                assetProfile = null,
                capabilities = listOf(capability, capability),
            )
        }
    }

    @Test
    fun `viewer snapshot equality follows fact and capability key semantics`() {
        val viewerId = UUID.randomUUID()
        val first = ViewerProjectionSnapshot(
            viewerId = viewerId,
            revision = 1,
            locale = LocaleId("en_us"),
            theme = ItemKey.parse("itemerness:default"),
            assetProfile = null,
            facts = listOf(
                ViewerFact(ItemKey.parse("example:z"), IntegerProjectionValue(1)),
                ViewerFact(ItemKey.parse("example:a"), IntegerProjectionValue(2)),
            ),
            capabilities = listOf(
                ItemKey.parse("itemerness:z"),
                ItemKey.parse("itemerness:a"),
            ),
        )
        val second = ViewerProjectionSnapshot(
            viewerId = viewerId,
            revision = 1,
            locale = LocaleId("en_us"),
            theme = ItemKey.parse("itemerness:default"),
            assetProfile = null,
            facts = first.facts.reversed(),
            capabilities = first.capabilities.reversed(),
        )

        assertEquals(first, second)
    }
}
