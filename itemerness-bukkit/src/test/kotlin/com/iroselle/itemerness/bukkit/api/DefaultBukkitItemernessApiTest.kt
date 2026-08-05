package com.iroselle.itemerness.bukkit.api

import com.iroselle.itemerness.api.ApiAction
import com.iroselle.itemerness.api.ApiCallResult
import com.iroselle.itemerness.api.ApiDenialReason
import com.iroselle.itemerness.api.DataKey
import com.iroselle.itemerness.api.ItemInstanceMode
import com.iroselle.itemerness.api.ItemDataMutation
import com.iroselle.itemerness.api.IntegerDataValue
import com.iroselle.itemerness.api.BooleanDataValue
import com.iroselle.itemerness.api.StringDataValue
import com.iroselle.itemerness.api.ItemKey
import com.iroselle.itemerness.api.RefreshRequest
import com.iroselle.itemerness.bukkit.access.AccessDecision
import com.iroselle.itemerness.bukkit.access.AccessPolicy
import com.iroselle.itemerness.core.DefaultItemRegistry
import com.iroselle.itemerness.core.catalog.CatalogSource
import com.iroselle.itemerness.core.catalog.ItemDefinitionSource
import com.iroselle.itemerness.core.catalog.ItemInstanceSource
import com.iroselle.itemerness.core.presentation.AssetProfileSource
import com.iroselle.itemerness.core.presentation.LocaleSource
import com.iroselle.itemerness.core.presentation.PresentationCatalogSnapshot
import com.iroselle.itemerness.core.presentation.PresentationCompiler
import com.iroselle.itemerness.core.presentation.PresentationSource
import com.iroselle.itemerness.core.presentation.ViewerFactSource
import com.iroselle.itemerness.core.presentation.ViewerFactStore
import com.iroselle.itemerness.core.presentation.ViewerFactType
import org.bukkit.plugin.Plugin
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotSame
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class DefaultBukkitItemernessApiTest {
    @Test
    fun `caller origin verifier rejects a real plugin object borrowed by another caller`() {
        val owner = FakePlugin("Itemerness")
        val consumer = FakePlugin("ExampleConsumer")
        val service = DefaultBukkitItemernessApi(
            ownerPlugin = owner.instance,
            registry = registryWithItem(),
            accessPolicy = policy(),
            activePlugins = listOf(owner.instance, consumer.instance),
            callerOriginVerifier = CallerOriginVerifier { false },
        )

        val result = service.forPlugin(consumer.instance)

        assertSame(ApiDenialReason.CALLER_NOT_ACTIVE, (result as ApiCallResult.Denied).reason)
    }

    @Test
    fun `bound facade reads catalog creates domain instance and dispatches refresh`() {
        val owner = FakePlugin("Itemerness")
        val consumer = FakePlugin("ExampleConsumer")
        val registrations = linkedMapOf(
            owner.instance.name to owner.instance,
            consumer.instance.name to consumer.instance,
        )
        val registry = registryWithItem()
        val dispatched = ArrayList<RefreshRequest>()
        val service = DefaultBukkitItemernessApi(
            ownerPlugin = owner.instance,
            registry = registry,
            accessPolicy = policy(),
            activePlugins = registrations.values,
            refreshDispatcher = RefreshRequestDispatcher { request -> dispatched.add(request) },
        )
        val facade = (service.forPlugin(consumer.instance) as ApiCallResult.Success).value
        val key = ItemKey.parse("itemerness:test")

        assertEquals("ExampleConsumer", facade.callerPluginName)
        assertTrue((facade.findItem(key) as ApiCallResult.Success).value != null)
        assertEquals(listOf(key), (facade.items() as ApiCallResult.Success).value.map { it.key })

        val created = (facade.createDomainInstance(key) as ApiCallResult.Success).value
        assertEquals(key, created.itemKey)
        assertEquals(registry.catalogRevision, created.createdAgainstRevision)
        assertEquals(0, created.instanceRevision)

        val request = RefreshRequest(
            UUID.fromString("00000000-0000-4000-8000-000000000042"),
            key,
        )
        val receipt = (facade.requestRefresh(request) as ApiCallResult.Success).value
        assertEquals(listOf(request), dispatched)
        assertEquals(request.playerId, receipt.playerId)
        assertEquals(registry.catalogRevision, receipt.catalogRevision)
    }

    @Test
    fun `same-name impostor is denied and a disabled bound caller loses access`() {
        val owner = FakePlugin("Itemerness")
        val consumer = FakePlugin("ExampleConsumer")
        val impostor = FakePlugin("ExampleConsumer")
        val registrations = linkedMapOf(
            owner.instance.name to owner.instance,
            consumer.instance.name to consumer.instance,
        )
        val service = DefaultBukkitItemernessApi(
            ownerPlugin = owner.instance,
            registry = registryWithItem(),
            accessPolicy = policy(),
            activePlugins = registrations.values,
        )

        assertSame(
            ApiDenialReason.CALLER_NOT_ACTIVE,
            (service.forPlugin(impostor.instance) as ApiCallResult.Denied).reason,
        )

        val facade = (service.forPlugin(consumer.instance) as ApiCallResult.Success).value
        service.retireCaller(consumer.instance)
        assertSame(
            ApiDenialReason.CALLER_NOT_ACTIVE,
            (facade.findItem(ItemKey.parse("itemerness:test")) as ApiCallResult.Denied).reason,
        )
    }

    @Test
    fun `same plugin object must rebind after a new lifecycle generation`() {
        val owner = FakePlugin("Itemerness")
        val consumer = FakePlugin("ExampleConsumer")
        val service = DefaultBukkitItemernessApi(
            ownerPlugin = owner.instance,
            registry = registryWithItem(),
            accessPolicy = policy(),
            activePlugins = listOf(owner.instance, consumer.instance),
        )
        val key = ItemKey.parse("itemerness:test")
        val retired = (service.forPlugin(consumer.instance) as ApiCallResult.Success).value
        val retiredHandle = (retired.createDomainInstance(key) as ApiCallResult.Success).value

        assertSame(
            retired,
            (service.forPlugin(consumer.instance) as ApiCallResult.Success).value,
            "One active lifecycle generation must share one caller-bound capability table",
        )

        service.retireCaller(consumer.instance)
        assertSame(
            ApiDenialReason.CALLER_NOT_ACTIVE,
            (retired.findItem(key) as ApiCallResult.Denied).reason,
        )
        assertSame(
            ApiDenialReason.CALLER_NOT_ACTIVE,
            (service.forPlugin(consumer.instance) as ApiCallResult.Denied).reason,
        )

        service.activateCaller(consumer.instance)
        assertSame(
            ApiDenialReason.CALLER_NOT_ACTIVE,
            (retired.findItem(key) as ApiCallResult.Denied).reason,
        )
        val rebound = (service.forPlugin(consumer.instance) as ApiCallResult.Success).value
        assertNotSame(retired, rebound)
        assertTrue(rebound.findItem(key) is ApiCallResult.Success)
        assertSame(
            ApiDenialReason.INVALID_MANAGED_ITEM,
            (
                rebound.readData(
                    retiredHandle,
                    DataKey.parse("example:value"),
                ) as ApiCallResult.Denied
                ).reason,
            "Opaque handles must not survive their issuing plugin lifecycle generation",
        )
    }

    @Test
    fun `disable event retires the old generation before an immediate re-enable`() {
        val owner = FakePlugin("Itemerness")
        val consumer = FakePlugin("ExampleConsumer")
        val service = DefaultBukkitItemernessApi(
            ownerPlugin = owner.instance,
            registry = registryWithItem(),
            accessPolicy = policy(),
            activePlugins = listOf(owner.instance, consumer.instance),
            pluginRegistrationVerifier = { it === consumer.instance },
        )
        val key = ItemKey.parse("itemerness:test")
        val oldFacade = (service.forPlugin(consumer.instance) as ApiCallResult.Success).value

        service.handlePluginDisable(consumer.instance)
        consumer.setEnabled(false)
        consumer.setEnabled(true)
        service.handlePluginEnable(consumer.instance)

        assertSame(
            ApiDenialReason.CALLER_NOT_ACTIVE,
            (oldFacade.findItem(key) as ApiCallResult.Denied).reason,
        )
        val rebound = (service.forPlugin(consumer.instance) as ApiCallResult.Success).value
        assertNotSame(oldFacade, rebound)
        assertTrue(rebound.findItem(key) is ApiCallResult.Success)
    }

    @Test
    fun `retirement waits for an accepted facade operation and rejects every later operation`() {
        val owner = FakePlugin("Itemerness")
        val consumer = FakePlugin("ExampleConsumer")
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val service = DefaultBukkitItemernessApi(
            ownerPlugin = owner.instance,
            registry = registryWithItem(),
            accessPolicy = policy(),
            activePlugins = listOf(owner.instance, consumer.instance),
            refreshDispatcher = RefreshRequestDispatcher {
                entered.countDown()
                check(release.await(5, TimeUnit.SECONDS))
                true
            },
        )
        val facade = (service.forPlugin(consumer.instance) as ApiCallResult.Success).value
        val executor = Executors.newFixedThreadPool(2)
        try {
            val operation = executor.submit<ApiCallResult<*>> {
                facade.requestRefresh(
                    RefreshRequest(
                        UUID.fromString("00000000-0000-4000-8000-000000000042"),
                        ItemKey.parse("itemerness:test"),
                    ),
                )
            }
            assertTrue(entered.await(5, TimeUnit.SECONDS))
            val retirement = executor.submit { service.retireCaller(consumer.instance) }

            Thread.sleep(50)
            assertFalse(retirement.isDone, "Retirement must serialize with the in-flight facade operation")
            release.countDown()

            assertTrue(operation.get(5, TimeUnit.SECONDS) is ApiCallResult.Success)
            retirement.get(5, TimeUnit.SECONDS)
            assertSame(
                ApiDenialReason.CALLER_NOT_ACTIVE,
                (facade.findItem(ItemKey.parse("itemerness:test")) as ApiCallResult.Denied).reason,
            )
        } finally {
            release.countDown()
            executor.shutdownNow()
        }
    }

    @Test
    fun `service close permanently invalidates facades and rejects rebinding`() {
        val owner = FakePlugin("Itemerness")
        val consumer = FakePlugin("ExampleConsumer")
        val service = DefaultBukkitItemernessApi(
            ownerPlugin = owner.instance,
            registry = registryWithItem(),
            accessPolicy = policy(),
            activePlugins = listOf(owner.instance, consumer.instance),
        )
        val facade = (service.forPlugin(consumer.instance) as ApiCallResult.Success).value

        service.close()
        service.activateCaller(consumer.instance)

        assertSame(
            ApiDenialReason.CALLER_NOT_ACTIVE,
            (facade.findItem(ItemKey.parse("itemerness:test")) as ApiCallResult.Denied).reason,
        )
        assertSame(
            ApiDenialReason.CALLER_NOT_ACTIVE,
            (service.forPlugin(consumer.instance) as ApiCallResult.Denied).reason,
        )
    }

    @Test
    fun `refresh dispatcher rejection is a typed unavailable result`() {
        val owner = FakePlugin("Itemerness")
        val consumer = FakePlugin("ExampleConsumer")
        var dispatches = 0
        val service = DefaultBukkitItemernessApi(
            ownerPlugin = owner.instance,
            registry = registryWithItem(),
            accessPolicy = policy(),
            activePlugins = listOf(owner.instance, consumer.instance),
            refreshDispatcher = RefreshRequestDispatcher {
                dispatches += 1
                false
            },
        )
        val facade = (service.forPlugin(consumer.instance) as ApiCallResult.Success).value

        val result = facade.requestRefresh(
            RefreshRequest(
                UUID.fromString("00000000-0000-4000-8000-000000000042"),
                ItemKey.parse("itemerness:test"),
            ),
        )

        assertEquals(1, dispatches)
        assertSame(ApiDenialReason.REFRESH_UNAVAILABLE, (result as ApiCallResult.Denied).reason)
    }

    @Test
    fun `viewer fact is not committed when its immediate refresh cannot be scheduled`() {
        val owner = FakePlugin("Itemerness")
        val consumer = FakePlugin("ExampleConsumer")
        val facts = ViewerFactStore()
        val viewerId = UUID.fromString("00000000-0000-4000-8000-000000000042")
        val service = DefaultBukkitItemernessApi(
            ownerPlugin = owner.instance,
            registry = registryWithItem(),
            accessPolicy = policy(),
            activePlugins = listOf(owner.instance, consumer.instance),
            viewerFacts = facts,
            presentation = presentationCatalog(),
            viewerAvailable = { it == viewerId },
            viewerRefreshDispatcher = ViewerRefreshDispatcher { false },
        )
        val facade = (service.forPlugin(consumer.instance) as ApiCallResult.Success).value
        val level = ItemKey.parse("example:level")

        val result = facade.publishViewerFact(viewerId, level, IntegerDataValue(7))

        assertSame(ApiDenialReason.REFRESH_UNAVAILABLE, (result as ApiCallResult.Denied).reason)
        assertEquals(null, facts.snapshot(viewerId)[level])
    }

    @Test
    fun `fatal viewer refresh failure is rethrown after fact rollback`() {
        val owner = FakePlugin("Itemerness")
        val consumer = FakePlugin("ExampleConsumer")
        val facts = ViewerFactStore()
        val viewerId = UUID.fromString("00000000-0000-4000-8000-000000000042")
        val fatal = object : VirtualMachineError("fatal viewer refresh") {}
        val service = DefaultBukkitItemernessApi(
            ownerPlugin = owner.instance,
            registry = registryWithItem(),
            accessPolicy = policy(),
            activePlugins = listOf(owner.instance, consumer.instance),
            viewerFacts = facts,
            presentation = presentationCatalog(),
            viewerAvailable = { it == viewerId },
            viewerRefreshDispatcher = ViewerRefreshDispatcher { throw fatal },
        )
        val facade = (service.forPlugin(consumer.instance) as ApiCallResult.Success).value
        val level = ItemKey.parse("example:level")

        val thrown = assertThrows(VirtualMachineError::class.java) {
            facade.publishViewerFact(viewerId, level, IntegerDataValue(7))
        }

        assertSame(fatal, thrown)
        assertEquals(null, facts.snapshot(viewerId)[level])
    }

    @Test
    fun `viewer facts require an explicit access action and denied calls never dispatch`() {
        val owner = FakePlugin("Itemerness")
        val consumer = FakePlugin("ExampleConsumer")
        val viewerId = UUID.fromString("00000000-0000-4000-8000-000000000042")
        var dispatches = 0
        val defaults = ApiAction.entries.associateWith { action ->
            if (action == ApiAction.WRITE_VIEWER_FACT) AccessDecision.DENY else AccessDecision.ALLOW
        }
        val service = DefaultBukkitItemernessApi(
            ownerPlugin = owner.instance,
            registry = registryWithItem(),
            accessPolicy = AccessPolicy(defaults, emptyList()),
            activePlugins = listOf(owner.instance, consumer.instance),
            presentation = presentationCatalog(),
            viewerAvailable = { it == viewerId },
            viewerRefreshDispatcher = ViewerRefreshDispatcher { dispatches += 1; true },
        )
        val facade = (service.forPlugin(consumer.instance) as ApiCallResult.Success).value

        val denied = facade.publishViewerFact(
            viewerId,
            ItemKey.parse("example:level"),
            IntegerDataValue(7),
        ) as ApiCallResult.Denied

        assertSame(ApiDenialReason.VIEWER_FACT_WRITE_DENIED, denied.reason)
        assertEquals(0, dispatches)
    }

    @Test
    fun `invalid and semantic no-op viewer fact mutations do not dispatch refresh`() {
        val owner = FakePlugin("Itemerness")
        val consumer = FakePlugin("ExampleConsumer")
        val viewerId = UUID.fromString("00000000-0000-4000-8000-000000000042")
        var dispatches = 0
        val service = DefaultBukkitItemernessApi(
            ownerPlugin = owner.instance,
            registry = registryWithItem(),
            accessPolicy = policy(),
            activePlugins = listOf(owner.instance, consumer.instance),
            presentation = presentationCatalog(),
            viewerAvailable = { it == viewerId },
            viewerRefreshDispatcher = ViewerRefreshDispatcher { dispatches += 1; true },
        )
        val facade = (service.forPlugin(consumer.instance) as ApiCallResult.Success).value
        val level = ItemKey.parse("example:level")

        assertTrue(
            facade.publishViewerFact(viewerId, ItemKey.parse("example:missing"), IntegerDataValue(1))
                is ApiCallResult.Denied,
        )
        assertEquals(0, dispatches)
        assertTrue(facade.publishViewerFact(viewerId, level, IntegerDataValue(7)) is ApiCallResult.Success)
        assertEquals(1, dispatches)
        val noOp = (facade.publishViewerFact(viewerId, level, IntegerDataValue(7)) as ApiCallResult.Success).value
        assertFalse(noOp.semanticChanged)
        assertEquals(1, dispatches)
        assertTrue(facade.clearViewerFact(viewerId, level) is ApiCallResult.Success)
        assertEquals(2, dispatches)
        val clearNoOp = (facade.clearViewerFact(viewerId, level) as ApiCallResult.Success).value
        assertFalse(clearNoOp.semanticChanged)
        assertEquals(2, dispatches)
    }

    @Test
    fun `domain data keys must belong to the handled item schema`() {
        val owner = FakePlugin("Itemerness")
        val consumer = FakePlugin("ExampleConsumer")
        val service = DefaultBukkitItemernessApi(
            ownerPlugin = owner.instance,
            registry = registryWithItem(),
            accessPolicy = policy(),
            activePlugins = listOf(owner.instance, consumer.instance),
        )
        val facade = (service.forPlugin(consumer.instance) as ApiCallResult.Success).value
        val handle = (
            facade.createDomainInstance(ItemKey.parse("itemerness:test")) as ApiCallResult.Success
            ).value
        val unrelated = DataKey.parse("example:unrelated")

        assertSame(
            ApiDenialReason.DATA_KEY_NOT_FOUND,
            (facade.readData(handle, unrelated) as ApiCallResult.Denied).reason,
        )
        assertSame(
            ApiDenialReason.DATA_KEY_NOT_FOUND,
            (
                facade.editDomainInstance(
                    handle,
                    listOf(ItemDataMutation.Set(unrelated, IntegerDataValue(1))),
                ) as ApiCallResult.Denied
                ).reason,
        )
    }

    @Test
    fun `action denial and unavailable refresh are typed outcomes`() {
        val owner = FakePlugin("Itemerness")
        val consumer = FakePlugin("ExampleConsumer")
        val registrations = mapOf(
            owner.instance.name to owner.instance,
            consumer.instance.name to consumer.instance,
        )
        val deniedDefaults = policy().defaults.toMutableMap().also {
            it[ApiAction.CREATE] = AccessDecision.DENY
        }
        val service = DefaultBukkitItemernessApi(
            ownerPlugin = owner.instance,
            registry = registryWithItem(),
            accessPolicy = AccessPolicy(deniedDefaults, emptyList()),
            activePlugins = registrations.values,
        )
        val facade = (service.forPlugin(consumer.instance) as ApiCallResult.Success).value
        val key = ItemKey.parse("itemerness:test")

        assertSame(
            ApiDenialReason.ACTION_DENIED,
            (facade.createDomainInstance(key) as ApiCallResult.Denied).reason,
        )
        assertSame(
            ApiDenialReason.REFRESH_UNAVAILABLE,
            (
                facade.requestRefresh(
                    RefreshRequest(UUID.fromString("00000000-0000-4000-8000-000000000042"), key),
                ) as ApiCallResult.Denied
                ).reason,
        )
    }

    @Test
    fun `service refuses an unregistered owner plugin`() {
        val owner = FakePlugin("Itemerness")

        assertThrows(IllegalArgumentException::class.java) {
            DefaultBukkitItemernessApi(
                ownerPlugin = owner.instance,
                registry = DefaultItemRegistry(),
                accessPolicy = policy(),
                activePlugins = emptyList(),
            )
        }
    }

    @Test
    fun `bound plugins own validated viewer facts with deterministic fallback`() {
        val owner = FakePlugin("Itemerness")
        val first = FakePlugin("FirstConsumer")
        val second = FakePlugin("SecondConsumer")
        val registrations = linkedMapOf(
            owner.instance.name to owner.instance,
            first.instance.name to first.instance,
            second.instance.name to second.instance,
        )
        val facts = ViewerFactStore()
        val viewerId = UUID.fromString("00000000-0000-4000-8000-000000000042")
        val service = DefaultBukkitItemernessApi(
            ownerPlugin = owner.instance,
            registry = registryWithItem(),
            accessPolicy = policy(),
            activePlugins = registrations.values,
            viewerFacts = facts,
            presentation = presentationCatalog(),
            viewerAvailable = { candidate -> candidate == viewerId },
        )
        val firstApi = (service.forPlugin(first.instance) as ApiCallResult.Success).value
        val secondApi = (service.forPlugin(second.instance) as ApiCallResult.Success).value
        val level = ItemKey.parse("example:level")

        val firstReceipt = (
            firstApi.publishViewerFact(viewerId, level, IntegerDataValue(4)) as ApiCallResult.Success
            ).value
        val secondReceipt = (
            secondApi.publishViewerFact(viewerId, level, IntegerDataValue(9)) as ApiCallResult.Success
            ).value
        val clearReceipt = (secondApi.clearViewerFact(viewerId, level) as ApiCallResult.Success).value

        assertEquals(listOf(1L, 2L, 3L), listOf(firstReceipt, secondReceipt, clearReceipt).map { it.viewerFactRevision })
        assertEquals(IntegerDataValue(4), facts.snapshot(viewerId)[level])

        assertSame(
            ApiDenialReason.VIEWER_FACT_WRITE_DENIED,
            (
                firstApi.publishViewerFact(
                    viewerId,
                    ItemKey.parse("itemerness:resource-pack-ready"),
                    BooleanDataValue(true),
                ) as ApiCallResult.Denied
                ).reason,
        )
        assertSame(
            ApiDenialReason.INVALID_VALUE,
            (firstApi.publishViewerFact(viewerId, level, StringDataValue("4")) as ApiCallResult.Denied).reason,
        )
        assertSame(
            ApiDenialReason.VIEWER_FACT_NOT_FOUND,
            (
                firstApi.publishViewerFact(
                    viewerId,
                    ItemKey.parse("example:missing"),
                    IntegerDataValue(1),
                ) as ApiCallResult.Denied
                ).reason,
        )
        assertSame(
            ApiDenialReason.INVALID_VALUE,
            (
                firstApi.publishViewerFact(
                    UUID.fromString("00000000-0000-4000-8000-000000000099"),
                    level,
                    IntegerDataValue(1),
                ) as ApiCallResult.Denied
                ).reason,
        )

        assertTrue(secondApi.publishViewerFact(viewerId, level, IntegerDataValue(9)) is ApiCallResult.Success)
        service.retireCaller(second.instance)
        assertEquals(IntegerDataValue(4), facts.snapshot(viewerId)[level])
        assertSame(
            ApiDenialReason.CALLER_NOT_ACTIVE,
            (
                secondApi.publishViewerFact(
                    viewerId,
                    level,
                    IntegerDataValue(10),
                ) as ApiCallResult.Denied
                ).reason,
        )

        service.close()
        assertEquals(null, facts.snapshot(viewerId)[level])
    }

    private fun registryWithItem(): DefaultItemRegistry {
        val registry = DefaultItemRegistry()
        val compilation = registry.compile(
            CatalogSource(
                schemas = emptyList(),
                items = listOf(
                    ItemDefinitionSource(
                        id = "itemerness:test",
                        enabled = true,
                        material = "minecraft:stone",
                        instance = ItemInstanceSource(
                            mode = ItemInstanceMode.FUNGIBLE,
                            schemas = emptyList(),
                        ),
                    ),
                ),
            ),
        )
        assertTrue(compilation.successful, compilation.diagnostics.joinToString())
        registry.publish(requireNotNull(compilation.candidate))
        return registry
    }

    private fun policy(): AccessPolicy = AccessPolicy(
        defaults = ApiAction.entries.associateWith { AccessDecision.ALLOW },
        grants = emptyList(),
    )

    private fun presentationCatalog(): PresentationCatalogSnapshot {
        val compilation = PresentationCompiler().compile(
            PresentationSource(
                formats = emptyList(),
                locales = listOf(LocaleSource("en_us", messages = emptyMap())),
                fonts = emptyList(),
                glyphs = emptyList(),
                bitmaps = emptyList(),
                assetProfiles = listOf(AssetProfileSource("itemerness:vanilla", emptyList())),
                viewerFacts = listOf(
                    ViewerFactSource(
                        id = "itemerness:resource-pack-ready",
                        type = ViewerFactType.BOOLEAN,
                        providers = listOf("bukkit-resource-pack-status"),
                        defaultValue = BooleanDataValue(false),
                    ),
                    ViewerFactSource(
                        id = "example:level",
                        type = ViewerFactType.INTEGER,
                        providers = listOf("api"),
                        defaultValue = IntegerDataValue(0),
                    ),
                ),
                layouts = emptyList(),
                themes = emptyList(),
                items = emptyList(),
            ),
        )
        assertTrue(compilation.successful, compilation.diagnostics.joinToString())
        return requireNotNull(compilation.catalog)
    }
}
