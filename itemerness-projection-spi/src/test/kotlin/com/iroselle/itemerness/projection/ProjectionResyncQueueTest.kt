package com.iroselle.itemerness.projection

import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class ProjectionResyncQueueTest {
    @Test
    fun `retry ready is idempotent and retains only pending viewers`() {
        val viewerId = UUID.randomUUID()
        val queue = BoundedProjectionResyncQueue(maxConnections = 2)
        assertTrue(
            queue.offer(
                ProjectionResyncRequest(viewerId, connectionGeneration = 1, slot = 4, fullInventory = false),
            ),
        )
        assertEquals(listOf(viewerId), queue.pollReadyViewers())

        assertTrue(queue.retryReady(viewerId))
        assertTrue(queue.retryReady(viewerId))
        assertEquals(listOf(viewerId), queue.pollReadyViewers())
        assertTrue(queue.pollReadyViewers().isEmpty())

        assertNotNull(queue.drain(viewerId, 1))
        assertFalse(queue.retryReady(viewerId))
        assertTrue(queue.pollReadyViewers().isEmpty())
    }

    @Test
    fun `requests are isolated by connection generation and duplicate slots coalesce`() {
        val queue = BoundedProjectionResyncQueue(maxConnections = 2, maxSlotsPerConnection = 3)
        val viewer = UUID.randomUUID()

        assertTrue(queue.offer(request(viewer, 1, 4)))
        assertTrue(queue.offer(request(viewer, 1, 4)))
        assertTrue(queue.offer(request(viewer, 2, 9)))

        assertEquals(setOf(4), queue.drain(viewer, 1L)?.slots)
        assertEquals(setOf(9), queue.drain(viewer, 2L)?.slots)
        assertNull(queue.drain(viewer, 1L))
    }

    @Test
    fun `per connection overflow coalesces to a full inventory refresh`() {
        val queue = BoundedProjectionResyncQueue(maxConnections = 1, maxSlotsPerConnection = 2)
        val viewer = UUID.randomUUID()

        assertTrue(queue.offer(request(viewer, 7, 1)))
        assertTrue(queue.offer(request(viewer, 7, 2)))
        assertTrue(queue.offer(request(viewer, 7, 3)))

        val batch = queue.drain(viewer, 7L)!!
        assertTrue(batch.fullInventory)
        assertTrue(batch.slots.isEmpty())
    }

    @Test
    fun `connection capacity is hard bounded and disconnect discards pending state`() {
        val queue = BoundedProjectionResyncQueue(maxConnections = 1, maxSlotsPerConnection = 2)
        val first = UUID.randomUUID()
        val second = UUID.randomUUID()

        assertTrue(queue.offer(request(first, 1, 1)))
        assertFalse(queue.offer(request(second, 1, 1)))
        queue.discard(first, 1)
        assertEquals(0, queue.pendingConnectionCount())
        assertTrue(queue.offer(request(second, 1, 1)))
    }

    @Test
    fun `viewer drain orders old generations and leaves other viewers isolated`() {
        val queue = BoundedProjectionResyncQueue(maxConnections = 8, maxSlotsPerConnection = 4)
        val viewer = UUID.randomUUID()
        val other = UUID.randomUUID()
        assertTrue(queue.offer(request(viewer, 3, 3)))
        assertTrue(queue.offer(request(viewer, 1, 1)))
        assertTrue(queue.offer(request(other, 2, 8)))
        assertTrue(queue.offer(request(viewer, 2, 2)))

        val batches = queue.drain(viewer)

        assertEquals(listOf(1L, 2L, 3L), batches.map { it.connectionGeneration })
        assertEquals(setOf(8), queue.drain(other).single().slots)
        assertEquals(0, queue.pendingConnectionCount())
    }

    @Test
    fun `viewer drain has a hard batch limit and coalesces discarded old generations`() {
        val queue = BoundedProjectionResyncQueue(maxConnections = 8, maxSlotsPerConnection = 4)
        val viewer = UUID.randomUUID()
        repeat(4) { generation ->
            assertTrue(queue.offer(request(viewer, generation.toLong(), generation)))
        }

        val batches = queue.drain(viewer, maxBatches = 2)

        assertEquals(listOf(2L, 3L), batches.map { it.connectionGeneration })
        assertTrue(batches.first().fullInventory)
        assertEquals(0, queue.pendingConnectionCount())
    }

    @Test
    fun `ready viewer polling is bounded and coalesced across generations`() {
        val queue = BoundedProjectionResyncQueue(maxConnections = 8, maxSlotsPerConnection = 4)
        val first = UUID.randomUUID()
        val second = UUID.randomUUID()
        assertTrue(queue.offer(request(first, 1, 1)))
        assertTrue(queue.offer(request(first, 2, 2)))
        assertTrue(queue.offer(request(second, 1, 3)))

        assertEquals(listOf(first), queue.pollReadyViewers(maxViewers = 1))
        assertEquals(listOf(second), queue.pollReadyViewers(maxViewers = 1))
        assertTrue(queue.pollReadyViewers().isEmpty())
        assertEquals(listOf(1L, 2L), queue.drain(first).map { it.connectionGeneration })
        assertEquals(setOf(3), queue.drain(second).single().slots)
    }

    @Test
    fun `a request accepted after polling makes the viewer ready again`() {
        val queue = BoundedProjectionResyncQueue(maxConnections = 2, maxSlotsPerConnection = 4)
        val viewer = UUID.randomUUID()
        assertTrue(queue.offer(request(viewer, 1, 1)))
        assertEquals(listOf(viewer), queue.pollReadyViewers())

        assertTrue(queue.offer(request(viewer, 1, 2)))
        assertEquals(listOf(viewer), queue.pollReadyViewers())
        assertEquals(setOf(1, 2), queue.drain(viewer).single().slots)
        assertTrue(queue.pollReadyViewers().isEmpty())
    }

    @Test
    fun `discarded readiness is harmless and does not hide a later request`() {
        val queue = BoundedProjectionResyncQueue(maxConnections = 1, maxSlotsPerConnection = 4)
        val viewer = UUID.randomUUID()
        assertTrue(queue.offer(request(viewer, 1, 1)))
        queue.discard(viewer, 1)
        assertTrue(queue.offer(request(viewer, 2, 2)))

        assertEquals(listOf(viewer), queue.pollReadyViewers())
        assertEquals(setOf(2), queue.drain(viewer).single().slots)
    }

    @Test
    fun `concurrent producers coalesce safely and exact old generation drain preserves the new one`() {
        val queue = BoundedProjectionResyncQueue(maxConnections = 2, maxSlotsPerConnection = 8)
        val viewer = UUID.randomUUID()
        val ready = CountDownLatch(8)
        val start = CountDownLatch(1)
        val pool = Executors.newFixedThreadPool(8)
        repeat(8) { worker ->
            pool.submit {
                ready.countDown()
                start.await()
                repeat(32) { index ->
                    queue.offer(request(viewer, 7, (worker + index) % 4))
                }
            }
        }
        ready.await()
        start.countDown()
        pool.shutdown()
        assertTrue(pool.awaitTermination(10, java.util.concurrent.TimeUnit.SECONDS))
        assertTrue(queue.offer(request(viewer, 8, 9)))

        assertEquals(setOf(0, 1, 2, 3), queue.drain(viewer, 7L)?.slots)
        assertEquals(setOf(9), queue.drain(viewer).single().slots)
        assertEquals(listOf(viewer), queue.pollReadyViewers())
        assertTrue(queue.pollReadyViewers().isEmpty())
    }

    private fun request(viewer: UUID, generation: Long, slot: Int) = ProjectionResyncRequest(
        viewerId = viewer,
        connectionGeneration = generation,
        slot = slot,
        fullInventory = false,
    )
}
