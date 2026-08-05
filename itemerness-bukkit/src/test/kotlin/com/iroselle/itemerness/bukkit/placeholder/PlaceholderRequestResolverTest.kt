package com.iroselle.itemerness.bukkit.placeholder

import com.iroselle.itemerness.api.DataKey
import com.iroselle.itemerness.api.ItemKey
import com.iroselle.itemerness.projection.LocaleId
import org.junit.jupiter.api.Assertions.assertAll
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test
import java.time.Clock
import java.time.Duration
import java.time.Instant
import java.time.ZoneId
import java.time.ZoneOffset
import java.util.UUID
import java.util.concurrent.atomic.AtomicInteger

class PlaceholderRequestResolverTest {
    @Test
    fun `catalog revision resolves without a player snapshot`() {
        val resolver = PlaceholderRequestResolver(
            snapshots = PlaceholderSnapshotLookup { null },
            catalogRevision = { 91 },
        )

        assertEquals("91", resolver.resolve(null, "catalog_revision"))
    }

    @Test
    fun `resolves every fixed snapshot parameter`() {
        val viewerId = UUID.fromString("f0e5ec0c-e52f-48ce-be23-67ffc7fc26ef")
        val instanceId = UUID.fromString("3132f3ae-5efc-4c62-a89c-eb0c150509ad")
        val snapshot = PlaceholderViewerSnapshot(
            viewerId = viewerId,
            catalogRevision = 42,
            locale = LocaleId("zh_cn"),
            theme = ItemKey.parse("itemerness:ember"),
            assetProfile = ItemKey.parse("itemerness:example-pack"),
            mainHand = PlaceholderItemSnapshot(
                present = true,
                id = ItemKey.parse("example:hammer"),
                instanceId = instanceId,
                namePlain = "Forgemaster Hammer",
                exposedData = mapOf(
                    DataKey.parse("example:quality") to "epic",
                    DataKey.parse("example:attack-damage") to "12.5",
                ),
            ),
            offHand = PlaceholderItemSnapshot(
                present = true,
                id = ItemKey.parse("example:shield"),
                instanceId = null,
                namePlain = "Shield",
                exposedData = mapOf(DataKey.parse("example:quality") to "rare"),
            ),
        )
        val resolver = PlaceholderRequestResolver(
            PlaceholderSnapshotLookup { requestedId -> snapshot.takeIf { requestedId == viewerId } },
        )

        assertAll(
            { assertEquals("42", resolver.resolve(viewerId, "catalog_revision")) },
            { assertEquals("zh_cn", resolver.resolve(viewerId, "locale")) },
            { assertEquals("itemerness:ember", resolver.resolve(viewerId, "theme")) },
            { assertEquals("itemerness:example-pack", resolver.resolve(viewerId, "asset_profile")) },
            { assertEquals("true", resolver.resolve(viewerId, "mainhand_present")) },
            { assertEquals("example:hammer", resolver.resolve(viewerId, "mainhand_id")) },
            { assertEquals(instanceId.toString(), resolver.resolve(viewerId, "mainhand_instance_id")) },
            { assertEquals("Forgemaster Hammer", resolver.resolve(viewerId, "mainhand_name_plain")) },
            { assertEquals("epic", resolver.resolve(viewerId, "mainhand_data_example:quality")) },
            {
                assertEquals(
                    "12.5",
                    resolver.resolve(viewerId, "mainhand_data_example:attack-damage"),
                )
            },
            { assertEquals("true", resolver.resolve(viewerId, "offhand_present")) },
            { assertEquals("example:shield", resolver.resolve(viewerId, "offhand_id")) },
            { assertEquals("rare", resolver.resolve(viewerId, "offhand_data_example:quality")) },
        )
    }

    @Test
    fun `returns empty strings for known missing values`() {
        val viewerId = UUID.fromString("95c5338b-0dde-4978-8789-b13b97f36a2e")
        val snapshot = PlaceholderViewerSnapshot(
            viewerId = viewerId,
            catalogRevision = 1,
            locale = LocaleId("en_us"),
            theme = ItemKey.parse("itemerness:default"),
            assetProfile = null,
            mainHand = PlaceholderItemSnapshot.absent(),
            offHand = PlaceholderItemSnapshot.absent(),
        )
        val resolver = PlaceholderRequestResolver(
            PlaceholderSnapshotLookup { requestedId -> snapshot.takeIf { requestedId == viewerId } },
        )

        assertAll(
            { assertEquals("", resolver.resolve(null, "catalog_revision")) },
            { assertEquals("", resolver.resolve(UUID.randomUUID(), "mainhand_id")) },
            { assertEquals("", resolver.resolve(viewerId, "asset_profile")) },
            { assertEquals("false", resolver.resolve(viewerId, "mainhand_present")) },
            { assertEquals("", resolver.resolve(viewerId, "mainhand_id")) },
            { assertEquals("", resolver.resolve(viewerId, "mainhand_instance_id")) },
            { assertEquals("", resolver.resolve(viewerId, "mainhand_name_plain")) },
            { assertEquals("", resolver.resolve(viewerId, "mainhand_data_example:missing")) },
            { assertEquals("false", resolver.resolve(viewerId, "offhand_present")) },
            { assertEquals("", resolver.resolve(viewerId, "offhand_id")) },
            { assertEquals("", resolver.resolve(viewerId, "offhand_data_example:missing")) },
        )
    }

    @Test
    fun `returns null for unknown or malformed parameters`() {
        val resolver = PlaceholderRequestResolver(PlaceholderSnapshotLookup { null })

        assertAll(
            { assertNull(resolver.resolve(null, "")) },
            { assertNull(resolver.resolve(null, "unknown")) },
            { assertNull(resolver.resolve(null, "offhand_instance_id")) },
            { assertNull(resolver.resolve(null, "mainhand_data_")) },
            { assertNull(resolver.resolve(null, "mainhand_data_missing-namespace")) },
            { assertNull(resolver.resolve(null, "offhand_data_example:bad:key")) },
        )
    }

    @Test
    fun `viewer placeholders remain one complete old tuple across a catalog publication gap`() {
        val viewerId = UUID.fromString("95c5338b-0dde-4978-8789-b13b97f36a2e")
        val snapshot = PlaceholderViewerSnapshot(
            viewerId = viewerId,
            catalogRevision = 1,
            locale = LocaleId("en_us"),
            theme = ItemKey.parse("itemerness:default"),
            assetProfile = null,
            mainHand = PlaceholderItemSnapshot.absent(),
            offHand = PlaceholderItemSnapshot.absent(),
        )
        val resolver = PlaceholderRequestResolver(
            snapshots = PlaceholderSnapshotLookup { snapshot },
            catalogRevision = { 2 },
        )

        assertEquals("1", resolver.resolve(viewerId, "catalog_revision"))
        assertEquals("en_us", resolver.resolve(viewerId, "locale"))
        assertEquals("false", resolver.resolve(viewerId, "mainhand_present"))
        assertEquals("2", resolver.resolve(null, "catalog_revision"))
    }

    @Test
    fun `item snapshot defensively copies exposed data`() {
        val data = linkedMapOf(DataKey.parse("example:value") to "before")
        val snapshot = PlaceholderItemSnapshot(
            present = true,
            id = ItemKey.parse("example:item"),
            instanceId = null,
            namePlain = null,
            exposedData = data,
        )
        data[DataKey.parse("example:value")] = "after"

        assertEquals("before", snapshot[DataKey.parse("example:value")])
        @Suppress("UNCHECKED_CAST")
        val exposed = snapshot.exposedData as MutableMap<DataKey, String>
        assertThrows(UnsupportedOperationException::class.java) {
            exposed[DataKey.parse("example:added")] = "value"
        }
    }

    @Test
    fun `snapshot store expires stale values without waiting`() {
        val viewerId = UUID.fromString("7bbb9a82-d0ab-4475-8332-4e52df32d839")
        val clock = MutableClock(Instant.parse("2026-08-06T00:00:00Z"))
        val store = PlaceholderSnapshotStore(Duration.ofSeconds(30), clock)
        val snapshot = PlaceholderViewerSnapshot(
            viewerId = viewerId,
            catalogRevision = 2,
            locale = LocaleId("en_us"),
            theme = ItemKey.parse("itemerness:default"),
            assetProfile = null,
            mainHand = PlaceholderItemSnapshot.absent(),
            offHand = PlaceholderItemSnapshot.absent(),
        )

        store.publish(snapshot)
        clock.advance(Duration.ofSeconds(30))
        assertEquals(snapshot, store.find(viewerId))

        clock.advance(Duration.ofNanos(1))
        assertNull(store.find(viewerId))
    }

    @Test
    fun `registration lifecycle quietly skips absence and remains idempotent`() {
        var available = false
        val registrations = AtomicInteger()
        val unregistrations = AtomicInteger()
        val lifecycle = PlaceholderRegistrationLifecycle(
            available = { available },
            registrar = PlaceholderRegistrar {
                registrations.incrementAndGet()
                PlaceholderRegistration(unregistrations::incrementAndGet)
            },
        )

        assertEquals(false, lifecycle.tryRegister())
        assertEquals(0, registrations.get())

        available = true
        assertEquals(true, lifecycle.tryRegister())
        assertEquals(true, lifecycle.tryRegister())
        assertEquals(1, registrations.get())

        lifecycle.close()
        lifecycle.close()
        assertEquals(1, unregistrations.get())
    }

    @Test
    fun `registration lifecycle invalidates on dependency disable and can re-register`() {
        val registrations = AtomicInteger()
        val unregistrations = AtomicInteger()
        val lifecycle = PlaceholderRegistrationLifecycle(
            available = { true },
            registrar = PlaceholderRegistrar {
                registrations.incrementAndGet()
                PlaceholderRegistration(unregistrations::incrementAndGet)
            },
        )

        assertEquals(true, lifecycle.tryRegister())
        lifecycle.invalidate()
        assertEquals(true, lifecycle.tryRegister())
        lifecycle.close()

        assertEquals(2, registrations.get())
        assertEquals(2, unregistrations.get())
    }

    private class MutableClock(
        private var current: Instant,
    ) : Clock() {
        override fun getZone(): ZoneId = ZoneOffset.UTC

        override fun withZone(zone: ZoneId): Clock = Clock.fixed(current, zone)

        override fun instant(): Instant = current

        fun advance(duration: Duration) {
            current = current.plus(duration)
        }
    }
}
