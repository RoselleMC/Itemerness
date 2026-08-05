package com.iroselle.itemerness.core.presentation

import com.iroselle.itemerness.api.BooleanDataValue
import com.iroselle.itemerness.api.IntegerDataValue
import com.iroselle.itemerness.api.ItemKey
import com.iroselle.itemerness.api.NamespacedKeyDataValue
import com.iroselle.itemerness.api.StringDataValue
import java.util.UUID
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertInstanceOf
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class ViewerFactStoreTest {
    private val catalog = PresentationFixtures.compile()
    private val viewerId = UUID.fromString("00000000-0000-4000-8000-000000000042")
    private val level = ItemKey.parse("example:level")

    @Test
    fun `latest publisher wins and clearing it reveals the prior contribution`() {
        val store = ViewerFactStore()
        val changes = ArrayList<UUID>()
        store.listen(changes::add)

        val first = store.publish("First", viewerId, level, IntegerDataValue(4), catalog).applied()
        val second = store.publish("Second", viewerId, level, IntegerDataValue(9), catalog).applied()
        val fallback = store.clear("Second", viewerId, level, catalog).applied()

        assertEquals(IntegerDataValue(4), first.snapshot[level])
        assertEquals(IntegerDataValue(9), second.snapshot[level])
        assertEquals(IntegerDataValue(4), fallback.snapshot[level])
        assertEquals(listOf(1L, 2L, 3L), listOf(first, second, fallback).map { it.snapshot.revision })
        assertEquals(listOf(viewerId, viewerId, viewerId), changes)
    }

    @Test
    fun `ownership changes with an equal value do not advance semantic revision`() {
        val store = ViewerFactStore()
        val notifications = ArrayList<UUID>()
        store.listen(notifications::add)

        val first = store.publish("First", viewerId, level, IntegerDataValue(4), catalog).applied()
        val takeover = store.publish("Second", viewerId, level, IntegerDataValue(4), catalog).applied()
        val fallback = store.clear("Second", viewerId, level, catalog).applied()

        assertTrue(first.semanticChanged)
        assertFalse(takeover.semanticChanged)
        assertFalse(fallback.semanticChanged)
        assertEquals(1L, fallback.snapshot.revision)
        assertEquals(listOf(viewerId), notifications)
    }

    @Test
    fun `retiring an owner updates every affected viewer and preserves other owners`() {
        val otherViewer = UUID.fromString("00000000-0000-4000-8000-000000000043")
        val store = ViewerFactStore()
        store.publish("Fallback", viewerId, level, IntegerDataValue(1), catalog)
        store.publish("Retiring", viewerId, level, IntegerDataValue(2), catalog)
        store.publish("Retiring", otherViewer, level, IntegerDataValue(3), catalog)

        val changed = store.clearOwner("Retiring").associateBy(ApiViewerFactSnapshot::viewerId)

        assertEquals(IntegerDataValue(1), changed.getValue(viewerId)[level])
        assertTrue(changed.getValue(otherViewer).values.isEmpty())
        assertEquals(3L, changed.getValue(viewerId).revision)
        assertEquals(2L, changed.getValue(otherViewer).revision)
    }

    @Test
    fun `retiring a viewer drops contributions and revision history`() {
        val store = ViewerFactStore()
        store.publish("Example", viewerId, level, IntegerDataValue(4), catalog).applied()

        store.clearViewer(viewerId)

        assertTrue(store.snapshot(viewerId).values.isEmpty())
        assertEquals(0L, store.snapshot(viewerId).revision)
        assertTrue(store.clearOwner("Example").isEmpty())
    }

    @Test
    fun `unknown bukkit-only wrong-type and constrained values are rejected`() {
        val store = ViewerFactStore()
        val unknown = store.publish(
            "Example",
            viewerId,
            ItemKey.parse("example:missing"),
            IntegerDataValue(1),
            catalog,
        ).rejected()
        val bukkitOnly = store.publish(
            "Example",
            viewerId,
            ItemKey.parse("itemerness:resource-pack-ready"),
            BooleanDataValue(true),
            catalog,
        ).rejected()
        val wrongType = store.publish("Example", viewerId, level, StringDataValue("4"), catalog).rejected()
        val unknownLocale = store.publish(
            "Example",
            viewerId,
            ItemKey.parse("itemerness:locale"),
            StringDataValue("missing_locale"),
            catalog,
        ).rejected()
        val unknownTheme = store.publish(
            "Example",
            viewerId,
            ItemKey.parse("itemerness:theme"),
            NamespacedKeyDataValue(ItemKey.parse("example:missing")),
            catalog,
        ).rejected()
        val oversizedTextCatalog = PresentationFixtures.compile(
            PresentationFixtures.source(
                viewerFactSources = PresentationFixtures.viewerFacts() +
                    ViewerFactSource(
                        "example:text",
                        ViewerFactType.STRING,
                        listOf("api"),
                        StringDataValue(""),
                    ),
            ),
            budgets = PresentationBudgets(maximumTextCodePoints = 16_384),
        ).withRevision(catalog.revision + 1)
        store.reconcile(oversizedTextCatalog)
        val oversizedText = store.publish(
            "Example",
            viewerId,
            ItemKey.parse("example:text"),
            StringDataValue("a".repeat(8_193)),
            oversizedTextCatalog,
        ).rejected()

        assertEquals(ViewerFactValidationCode.UNKNOWN_FACT, unknown.failure.code)
        assertEquals(ViewerFactValidationCode.PROVIDER_NOT_ALLOWED, bukkitOnly.failure.code)
        assertEquals(ViewerFactValidationCode.TYPE_MISMATCH, wrongType.failure.code)
        assertEquals(ViewerFactValidationCode.CONSTRAINT_VIOLATION, unknownLocale.failure.code)
        assertEquals(ViewerFactValidationCode.CONSTRAINT_VIOLATION, unknownTheme.failure.code)
        assertEquals(ViewerFactValidationCode.CONSTRAINT_VIOLATION, oversizedText.failure.code)
        assertTrue(store.snapshot(viewerId).values.isEmpty())
    }

    @Test
    fun `locale publications are normalized before compiled-locale validation`() {
        val store = ViewerFactStore()
        val locale = ItemKey.parse("itemerness:locale")

        val result = store.publish("Example", viewerId, locale, StringDataValue("ZH-CN"), catalog).applied()

        assertEquals(StringDataValue("zh_cn"), result.snapshot[locale])
    }

    @Test
    fun `retained viewer state is hard bounded until a viewer retires`() {
        val store = ViewerFactStore(viewerCapacity = 1)
        val otherViewer = UUID.fromString("00000000-0000-4000-8000-000000000043")
        store.publish("Example", viewerId, level, IntegerDataValue(4), catalog).applied()

        val rejected = store.publish(
            "Example",
            otherViewer,
            level,
            IntegerDataValue(5),
            catalog,
        ).rejected()
        store.clearViewer(viewerId)
        val accepted = store.publish(
            "Example",
            otherViewer,
            level,
            IntegerDataValue(5),
            catalog,
        ).applied()

        assertEquals(ViewerFactValidationCode.CONSTRAINT_VIOLATION, rejected.failure.code)
        assertEquals(IntegerDataValue(5), accepted.snapshot[level])
    }

    @Test
    fun `availability is rechecked under the mutation lock`() {
        val store = ViewerFactStore()

        val publish = store.publish(
            "Example",
            viewerId,
            level,
            IntegerDataValue(4),
            catalog,
            stillAvailable = { false },
        ).rejected()
        val clear = store.clear(
            "Example",
            viewerId,
            level,
            catalog,
            stillAvailable = { false },
        ).rejected()

        assertEquals(ViewerFactValidationCode.CONSTRAINT_VIOLATION, publish.failure.code)
        assertEquals(ViewerFactValidationCode.CONSTRAINT_VIOLATION, clear.failure.code)
        assertTrue(store.snapshot(viewerId).values.isEmpty())
    }

    @Test
    fun `retired plugin lifecycle lease cannot republish after owner cleanup`() {
        val store = ViewerFactStore()
        val identity = Any()
        val lease = store.bindOwner("Example", identity)
        store.publish(
            "Example",
            viewerId,
            level,
            IntegerDataValue(4),
            catalog,
            ownerLease = lease,
        ).applied()

        store.clearOwner("Example", identity)
        val replay = store.publish(
            "Example",
            viewerId,
            level,
            IntegerDataValue(5),
            catalog,
            ownerLease = lease,
        ).rejected()

        assertEquals(ViewerFactValidationCode.OWNER_NOT_ACTIVE, replay.failure.code)
        assertTrue(store.snapshot(viewerId).values.isEmpty())
        assertTrue(store.bindOwner("Example", identity) === lease)
    }

    @Test
    fun `same plugin object receives a fresh lease only after explicit reactivation`() {
        val store = ViewerFactStore()
        val identity = Any()
        val first = store.bindOwner("Example", identity)
        store.clearOwner("Example", identity)

        val duringDisable = store.bindOwner("Example", identity)
        val reenabled = store.activateOwner("Example", identity)

        assertTrue(duringDisable === first)
        assertFalse(store.isOwnerActive(first))
        assertTrue(reenabled !== first)
        assertTrue(store.isOwnerActive(reenabled))
    }

    @Test
    fun `publication validated against a retired catalog cannot survive reconciliation`() {
        val store = ViewerFactStore()
        val newer = PresentationFixtures.compile().withRevision(catalog.revision + 1)
        store.reconcile(newer)

        val stale = store.publish("Example", viewerId, level, IntegerDataValue(4), catalog).rejected()

        assertEquals(ViewerFactValidationCode.STALE_CATALOG, stale.failure.code)
        assertTrue(store.snapshot(viewerId).values.isEmpty())
    }

    @Test
    fun `resolver follows configured provider precedence and then defaults`() {
        val apiLocale = StringDataValue("zh_cn")
        val resolved = ViewerFactResolver.resolve(
            catalog,
            mapOf(
                "api" to mapOf(ItemKey.parse("itemerness:locale") to apiLocale),
                "client" to mapOf(ItemKey.parse("itemerness:locale") to StringDataValue("en_us")),
                "bukkit-resource-pack-status" to mapOf(
                    ItemKey.parse("itemerness:resource-pack-ready") to BooleanDataValue(true),
                ),
            ),
        )

        assertEquals(apiLocale, resolved[ItemKey.parse("itemerness:locale")])
        assertEquals(BooleanDataValue(true), resolved[ItemKey.parse("itemerness:resource-pack-ready")])
        assertEquals(IntegerDataValue(0), resolved[level])
        assertFalse(ItemKey.parse("example:class") in resolved)
        assertThrows(UnsupportedOperationException::class.java) {
            @Suppress("UNCHECKED_CAST")
            (resolved as MutableMap<ItemKey, Any>)[level] = IntegerDataValue(3)
        }
    }

    @Test
    fun `api-capable theme and asset profile override their lower providers`() {
        val theme = ItemKey.parse("itemerness:segmented")
        val packedProfile = ItemKey.parse("itemerness:example-pack-v1")
        val resolved = ViewerFactResolver.resolve(
            catalog,
            mapOf(
                "api" to mapOf(
                    ItemKey.parse("itemerness:theme") to NamespacedKeyDataValue(theme),
                    ItemKey.parse("itemerness:asset-profile") to NamespacedKeyDataValue(packedProfile),
                ),
                "bukkit-resource-pack-status" to mapOf(
                    ItemKey.parse("itemerness:asset-profile") to
                        NamespacedKeyDataValue(ItemKey.parse("itemerness:vanilla")),
                ),
            ),
        )

        assertEquals(NamespacedKeyDataValue(theme), resolved[ItemKey.parse("itemerness:theme")])
        assertEquals(
            NamespacedKeyDataValue(packedProfile),
            resolved[ItemKey.parse("itemerness:asset-profile")],
        )
    }

    @Test
    fun `stale theme and asset overrides fall through at capture resolution`() {
        val themeKey = ItemKey.parse("itemerness:theme")
        val profileKey = ItemKey.parse("itemerness:asset-profile")
        val defaultTheme = ItemKey.parse("itemerness:default")
        val vanillaProfile = ItemKey.parse("itemerness:vanilla")
        val resolved = ViewerFactResolver.resolve(
            catalog,
            mapOf(
                "api" to mapOf(
                    themeKey to NamespacedKeyDataValue(ItemKey.parse("missing:theme")),
                    profileKey to NamespacedKeyDataValue(ItemKey.parse("missing:profile")),
                ),
                "player-override" to mapOf(themeKey to NamespacedKeyDataValue(defaultTheme)),
                "bukkit-resource-pack-status" to
                    mapOf(profileKey to NamespacedKeyDataValue(vanillaProfile)),
            ),
        )

        assertEquals(NamespacedKeyDataValue(defaultTheme), resolved[themeKey])
        assertEquals(NamespacedKeyDataValue(vanillaProfile), resolved[profileKey])
    }

    @Test
    fun `catalog reconciliation retires contributions whose api provider was removed`() {
        val store = ViewerFactStore()
        store.publish("Example", viewerId, level, IntegerDataValue(4), catalog).applied()
        val restricted = PresentationFixtures.compile(
            PresentationFixtures.source(
                viewerFactSources = PresentationFixtures.viewerFacts().map { source ->
                    if (source.id == level.toString()) {
                        ViewerFactSource(
                            source.id,
                            source.type,
                            listOf("bukkit"),
                            source.defaultValue,
                            source.nullable,
                            source.cacheKey,
                        )
                    } else {
                        source
                    }
                },
            ),
        ).withRevision(catalog.revision + 1)

        val changed = store.reconcile(restricted)

        assertEquals(1, changed.size)
        assertTrue(changed.single().values.isEmpty())
        assertEquals(2L, changed.single().revision)
    }

    @Test
    fun `prepared reconciliation is invisible and listener failure occurs only after coherent commit`() {
        val store = ViewerFactStore()
        store.publish("Example", viewerId, level, IntegerDataValue(4), catalog).applied()
        val restricted = PresentationFixtures.compile(
            PresentationFixtures.source(
                viewerFactSources = PresentationFixtures.viewerFacts().map { source ->
                    if (source.id == level.toString()) {
                        ViewerFactSource(
                            source.id,
                            source.type,
                            listOf("bukkit"),
                            source.defaultValue,
                            source.nullable,
                            source.cacheKey,
                        )
                    } else {
                        source
                    }
                },
            ),
        ).withRevision(catalog.revision + 1)
        var notifications = 0
        store.listen {
            notifications++
            error("deterministic listener failure")
        }

        val discarded = store.prepareReconcile(restricted)
        assertEquals(IntegerDataValue(4), store.snapshot(viewerId)[level])
        discarded.rollback()
        discarded.rollback()
        assertEquals(IntegerDataValue(4), store.snapshot(viewerId)[level])
        assertThrows(IllegalStateException::class.java, discarded::commit)

        val prepared = store.prepareReconcile(restricted)
        val changed = prepared.commit()
        assertEquals(changed, prepared.commit(), "Commit must be idempotent for its owning transaction")
        assertTrue(store.snapshot(viewerId).values.isEmpty())
        assertEquals(0, notifications, "Listeners belong to the post-commit completion phase")

        val failures = prepared.complete()
        assertEquals(1, failures.size)
        assertEquals("deterministic listener failure", failures.single().message)
        assertEquals(failures, prepared.complete())
        assertEquals(1, notifications)
        assertThrows(IllegalStateException::class.java, prepared::rollback)
        assertEquals(
            ViewerFactValidationCode.STALE_CATALOG,
            store.publish("Example", viewerId, level, IntegerDataValue(5), catalog).rejected().failure.code,
        )
    }

    @Test
    fun `reconciliation removes revoked owners and reveals an authorized fallback atomically`() {
        val store = ViewerFactStore()
        store.publish("Allowed", viewerId, level, IntegerDataValue(4), catalog).applied()
        store.publish("Revoked", viewerId, level, IntegerDataValue(9), catalog).applied()
        val nextCatalog = catalog.withRevision(catalog.revision + 1)
        val notifications = ArrayList<UUID>()
        store.listen(notifications::add)

        val prepared = store.prepareReconcile(nextCatalog) { owner, key ->
            owner == "Allowed" && key == level
        }

        assertEquals(IntegerDataValue(9), store.snapshot(viewerId)[level])
        assertTrue(notifications.isEmpty())
        val changed = prepared.commit()
        assertEquals(IntegerDataValue(4), changed.single()[level])
        assertEquals(IntegerDataValue(4), store.snapshot(viewerId)[level])
        assertTrue(notifications.isEmpty())

        assertTrue(prepared.complete().isEmpty())
        assertEquals(listOf(viewerId), notifications)
    }

    @Test
    fun `concurrent publications remain coherent and revisions reflect semantic changes only`() {
        val store = ViewerFactStore()
        val failures = ConcurrentLinkedQueue<Throwable>()
        val workers = 8
        val iterations = 250
        val ready = CountDownLatch(workers)
        val start = CountDownLatch(1)
        val pool = Executors.newFixedThreadPool(workers)
        repeat(workers) { worker ->
            pool.submit {
                try {
                    ready.countDown()
                    start.await()
                    repeat(iterations) { iteration ->
                        store.publish(
                            "Plugin$worker",
                            viewerId,
                            level,
                            IntegerDataValue(worker * iterations + iteration),
                            catalog,
                        ).applied()
                    }
                } catch (failure: Throwable) {
                    failures += failure
                }
            }
        }
        assertTrue(ready.await(5, TimeUnit.SECONDS))
        start.countDown()
        pool.shutdown()
        assertTrue(pool.awaitTermination(20, TimeUnit.SECONDS))

        assertTrue(failures.isEmpty(), failures.joinToString())
        val snapshot = store.snapshot(viewerId)
        assertInstanceOf(IntegerDataValue::class.java, snapshot[level])
        assertTrue(snapshot.revision in 1..(workers * iterations).toLong())
        assertEquals(1, snapshot.values.size)
    }

    private fun ViewerFactMutationResult.applied(): ViewerFactMutationResult.Applied =
        assertInstanceOf(ViewerFactMutationResult.Applied::class.java, this)

    private fun ViewerFactMutationResult.rejected(): ViewerFactMutationResult.Rejected =
        assertInstanceOf(ViewerFactMutationResult.Rejected::class.java, this)
}
