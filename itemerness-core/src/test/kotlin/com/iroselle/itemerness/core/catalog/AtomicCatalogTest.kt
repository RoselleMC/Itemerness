package com.iroselle.itemerness.core.catalog

import com.iroselle.itemerness.api.ItemKey
import com.iroselle.itemerness.core.DefaultItemRegistry
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class AtomicCatalogTest {
    @Test
    fun `rejected compilation preserves the exact active snapshot`() {
        val registry = DefaultItemRegistry()
        val published = registry.compileAndPublish(validCatalog()) as CatalogUpdate.Published
        val active = published.snapshot
        val invalid = CatalogSource(
            schemas = emptyList(),
            items = validCatalog().items,
        )

        val result = registry.compileAndPublish(invalid)

        assertTrue(result is CatalogUpdate.Rejected)
        assertSame(active, result.snapshot)
        assertSame(active, registry.snapshot())
        assertEquals(1, registry.catalogRevision)
    }

    @Test
    fun `snapshots and their collections are immutable`() {
        val compilation = CatalogCompiler().compile(validCatalog())
        val candidate = compilation.candidate!!
        val snapshot = AtomicCatalog().publish(candidate)

        assertThrows(UnsupportedOperationException::class.java) {
            (candidate.items as MutableMap).clear()
        }
        assertThrows(UnsupportedOperationException::class.java) {
            (snapshot.items as MutableMap).clear()
        }
    }

    @Test
    fun `concurrent readers observe only complete old or new snapshots`() {
        val compiler = CatalogCompiler()
        val first = compiler.compile(validCatalog("itemerness:first")).candidate!!
        val second = compiler.compile(validCatalog("itemerness:second")).candidate!!
        val catalog = AtomicCatalog()
        catalog.publish(first)
        val failures = ConcurrentLinkedQueue<String>()
        val executor = Executors.newFixedThreadPool(4)

        repeat(3) {
            executor.submit {
                repeat(10_000) {
                    val keys = catalog.snapshot().items.keys
                    if (keys != setOf(ItemKey.parse("itemerness:first")) &&
                        keys != setOf(ItemKey.parse("itemerness:second"))
                    ) {
                        failures += keys.toString()
                    }
                }
            }
        }
        executor.submit {
            repeat(2_000) { index -> catalog.publish(if (index % 2 == 0) second else first) }
        }
        executor.shutdown()
        assertTrue(executor.awaitTermination(20, TimeUnit.SECONDS))
        assertTrue(failures.isEmpty(), failures.firstOrNull())
    }
}
