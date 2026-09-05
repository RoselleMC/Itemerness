package com.iroselle.itemerness.bukkit.api

import com.iroselle.itemerness.api.ApiCallResult
import com.iroselle.itemerness.api.ApiDenialReason
import com.iroselle.itemerness.api.BooleanDataValue
import com.iroselle.itemerness.api.CompoundDataValue
import com.iroselle.itemerness.api.DataKey
import com.iroselle.itemerness.api.DecimalDataValue
import com.iroselle.itemerness.api.IntegerDataValue
import com.iroselle.itemerness.api.ItemDataMutation
import com.iroselle.itemerness.api.ItemDataValue
import com.iroselle.itemerness.api.ItemDefinition
import com.iroselle.itemerness.api.ItemKey
import com.iroselle.itemerness.api.ListDataValue
import com.iroselle.itemerness.api.LongDataValue
import com.iroselle.itemerness.api.NamespacedKeyDataValue
import com.iroselle.itemerness.api.StringDataValue
import com.iroselle.itemerness.api.UuidDataValue
import com.iroselle.itemerness.bukkit.catalog.BukkitCatalogItemFactory
import com.iroselle.itemerness.bukkit.catalog.BukkitItemComponentWriter
import com.iroselle.itemerness.bukkit.catalog.RuntimeCatalogManager
import com.iroselle.itemerness.bukkit.catalog.RuntimeCatalogUpdate
import com.iroselle.itemerness.bukkit.spi.BukkitCanonicalBridgeDescriptor
import com.iroselle.itemerness.bukkit.spi.BukkitCanonicalItemBridge
import com.iroselle.itemerness.bukkit.spi.CanonicalItemInspection
import com.iroselle.itemerness.bukkit.spi.PendingItemName
import com.iroselle.itemerness.core.catalog.CanonicalItemInstance
import com.iroselle.itemerness.core.catalog.BaseItemComponent
import com.iroselle.itemerness.core.catalog.CatalogItemDefinition
import com.iroselle.itemerness.core.catalog.DataType
import com.iroselle.itemerness.core.catalog.NestedContentComponent
import com.iroselle.itemerness.projection.BooleanProjectionValue
import com.iroselle.itemerness.projection.CanonicalDataSchemaVersion
import com.iroselle.itemerness.projection.CanonicalDataSchemas
import com.iroselle.itemerness.projection.CanonicalItemFingerprint
import com.iroselle.itemerness.projection.CanonicalItemSnapshot
import com.iroselle.itemerness.projection.DecimalProjectionValue
import com.iroselle.itemerness.projection.IntegerProjectionValue
import com.iroselle.itemerness.projection.KeyProjectionValue
import com.iroselle.itemerness.projection.ListProjectionValue
import com.iroselle.itemerness.projection.LongProjectionValue
import com.iroselle.itemerness.projection.MinecraftVersion
import com.iroselle.itemerness.projection.ProjectionCompound
import com.iroselle.itemerness.projection.ProjectionValue
import com.iroselle.itemerness.projection.StringProjectionValue
import com.iroselle.itemerness.projection.UuidProjectionValue
import org.bukkit.entity.Player
import org.bukkit.inventory.ItemStack
import org.bukkit.inventory.PlayerInventory
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotSame
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.math.BigDecimal
import java.lang.reflect.Proxy
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.util.IdentityHashMap
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

class BukkitItemStackApiTest {
    @TempDir
    lateinit var directory: Path

    @Test
    fun `creates identifies and immutably edits a canonical stack`() {
        val fixture = fixture(allowEdit = true)
        val itemKey = ItemKey.parse("itemerness:travel-token")
        val qualityKey = DataKey.parse("example:quality")

        val original = fixture.facade.createItem(itemKey, 2).successValue()
        val identity = fixture.facade.identifyItem(original).successValue()
        assertEquals(itemKey, identity?.itemKey)
        assertEquals(ItemKey.parse("minecraft:paper"), identity?.material)
        assertEquals(2, identity?.amount)
        assertEquals(0, identity?.instanceRevision)
        assertEquals(
            NamespacedKeyDataValue(ItemKey.parse("example:common")),
            fixture.facade.readItemData(original, qualityKey).successValue(),
        )

        val edited = fixture.facade.editItem(
            original,
            listOf(
                ItemDataMutation.Set(
                    qualityKey,
                    NamespacedKeyDataValue(ItemKey.parse("example:rare")),
                ),
            ),
        ).successValue()

        assertNotSame(original, edited)
        assertEquals(
            NamespacedKeyDataValue(ItemKey.parse("example:common")),
            fixture.facade.readItemData(original, qualityKey).successValue(),
        )
        assertEquals(
            NamespacedKeyDataValue(ItemKey.parse("example:rare")),
            fixture.facade.readItemData(edited, qualityKey).successValue(),
        )
        assertEquals(0, fixture.facade.identifyItem(original).successValue()?.instanceRevision)
        assertEquals(1, fixture.facade.identifyItem(edited).successValue()?.instanceRevision)
        assertEquals(1, fixture.bridge.rewriteCount)
    }

    @Test
    fun `direct canonical data wins without consulting declared PDC fallback`() {
        val fixture = fixture(allowEdit = true)
        val qualityKey = DataKey.parse("example:quality")
        val legacyKey = ItemKey.parse("legacyitems:quality")
        val stack = fixture.facade.createItem(ItemKey.parse("itemerness:travel-token")).successValue()
        fixture.pdc.put(
            stack,
            legacyKey,
            PdcFallbackRead.Invalid("wrong physical type"),
        )

        val value = fixture.facade.readItemData(stack, qualityKey).successValue()

        assertEquals(NamespacedKeyDataValue(ItemKey.parse("example:common")), value)
        assertEquals(0, fixture.pdc.readCount)
    }

    @Test
    fun `only an explicitly declared PDC key can supply a constrained read-only fallback`() {
        val fixture = fixture(allowEdit = true)
        val qualityKey = DataKey.parse("example:quality")
        val customLabelKey = DataKey.parse("example:custom-label")
        val legacyKey = ItemKey.parse("legacyitems:quality")
        val stack = fixture.facade.createItem(ItemKey.parse("itemerness:travel-token")).successValue()
        fixture.bridge.update(stack) { snapshot -> snapshot.withoutData(qualityKey) }
        fixture.pdc.put(
            stack,
            legacyKey,
            PdcFallbackRead.Value(NamespacedKeyDataValue(ItemKey.parse("example:rare"))),
        )

        assertEquals(
            NamespacedKeyDataValue(ItemKey.parse("example:rare")),
            fixture.facade.readItemData(stack, qualityKey).successValue(),
        )
        assertEquals(1, fixture.pdc.readCount)

        assertNull(fixture.facade.readItemData(stack, customLabelKey).successValue())
        assertEquals(1, fixture.pdc.readCount, "A key without a declared fallback must not read PDC")

        fixture.pdc.put(
            stack,
            legacyKey,
            PdcFallbackRead.Value(NamespacedKeyDataValue(ItemKey.parse("example:legendary"))),
        )
        val invalid = fixture.facade.readItemData(stack, qualityKey) as ApiCallResult.Denied
        assertSame(ApiDenialReason.INVALID_VALUE, invalid.reason)
    }

    @Test
    fun `PDC cannot supply identity and malformed canonical claims are rejected`() {
        val fixture = fixture(allowEdit = true)
        val unmanaged = OpaqueItemStack()
        fixture.pdc.put(
            unmanaged,
            ItemKey.parse("legacyitems:quality"),
            PdcFallbackRead.Value(NamespacedKeyDataValue(ItemKey.parse("example:epic"))),
        )

        assertNull(fixture.facade.identifyItem(unmanaged).successValue())
        assertSame(
            ApiDenialReason.INVALID_MANAGED_ITEM,
            (fixture.facade.readItemData(unmanaged, DataKey.parse("example:quality")) as ApiCallResult.Denied).reason,
        )
        assertEquals(0, fixture.pdc.readCount)

        val forged = fixture.facade.createItem(ItemKey.parse("itemerness:travel-token")).successValue()
        fixture.bridge.update(forged) { snapshot -> snapshot.copy(pendingName = "[itemerness:forged]") }
        assertSame(
            ApiDenialReason.INVALID_MANAGED_ITEM,
            (fixture.facade.identifyItem(forged) as ApiCallResult.Denied).reason,
        )
    }

    @Test
    fun `edit denial and caller retirement happen before any canonical rewrite`() {
        val fixture = fixture(allowEdit = false)
        val stack = fixture.facade.createItem(ItemKey.parse("itemerness:travel-token")).successValue()
        val mutation = ItemDataMutation.Set(
            DataKey.parse("example:quality"),
            NamespacedKeyDataValue(ItemKey.parse("example:rare")),
        )

        assertSame(
            ApiDenialReason.ACTION_DENIED,
            (fixture.facade.editItem(stack, listOf(mutation)) as ApiCallResult.Denied).reason,
        )
        assertEquals(0, fixture.bridge.rewriteCount)

        val inspectionsBeforeRetirement = fixture.bridge.inspectCount
        fixture.service.retireCaller(fixture.consumer.instance)
        assertSame(
            ApiDenialReason.CALLER_NOT_ACTIVE,
            (
                fixture.facade.readItemData(stack, DataKey.parse("example:quality")) as ApiCallResult.Denied
                ).reason,
        )
        assertEquals(inspectionsBeforeRetirement, fixture.bridge.inspectCount)
    }

    @Test
    fun `public creation uses the command catalog factory for base components and nested contents`() {
        val fixture = fixture(allowEdit = true, enableNested = true)
        val satchelKey = ItemKey.parse("itemerness:nested-satchel")

        val apiStack = fixture.facade.createItem(satchelKey).successValue() as OpaqueItemStack
        val runtime = requireNotNull(fixture.catalog.snapshot())
        val definition = runtime.domain.findItem(satchelKey) as CatalogItemDefinition
        val directFactory = BukkitCatalogItemFactory(
            bridge = RecordingCanonicalBridge(),
            catalog = runtime.domain,
            pendingName = { key -> PendingItemName(runtime.settings.pendingName(key), runtime.settings.pendingNameColorRgb) },
            componentWriter = RecordingItemComponentWriter,
        )
        val commandFactoryStack = directFactory.create(
            definition,
            runtime.domain.createInstance(satchelKey),
            1,
        ) as OpaqueItemStack

        assertEquals(commandFactoryStack.shape(), apiStack.shape())
        assertEquals(NestedContentComponent.BUNDLE, apiStack.contentComponent)
        assertEquals(1, apiStack.children.size)
        assertEquals(2, apiStack.children.single().amount)
        assertTrue(apiStack.baseComponents.any { it is BaseItemComponent.UseCooldown })
        assertTrue(
            (apiStack.children.single() as OpaqueItemStack).baseComponents.any {
                it == BaseItemComponent.MaxStackSize(16)
            },
        )
        val identity = fixture.facade.identifyItem(apiStack).successValue()
        assertEquals(satchelKey, identity?.itemKey)
        assertTrue(identity?.instanceId != null)
        val rootCanonical = (fixture.bridge.inspect(apiStack) as CanonicalItemInspection.Managed).snapshot
        val childCanonical = (
            fixture.bridge.inspect(apiStack.children.single()) as CanonicalItemInspection.Managed
            ).snapshot
        assertEquals(fixture.bridge.created[0].snapshot.copy(count = 1), rootCanonical)
        assertEquals(fixture.bridge.created[1].snapshot.copy(count = 2), childCanonical)
        assertEquals(
            listOf(satchelKey, ItemKey.parse("itemerness:travel-token")),
            fixture.bridge.created.map(CreatedCanonical::itemKey),
        )

        assertSame(
            ApiDenialReason.INVALID_VALUE,
            (fixture.facade.createItem(satchelKey, 2) as ApiCallResult.Denied).reason,
        )
        assertSame(
            ApiDenialReason.INVALID_VALUE,
            (fixture.facade.createItem(ItemKey.parse("itemerness:travel-token"), 17) as ApiCallResult.Denied).reason,
        )
    }

    @Test
    fun `domain handles enforce per-key access integrity and facade ownership`() {
        val fixture = fixture(allowEdit = true)
        val itemKey = ItemKey.parse("itemerness:travel-token")
        val qualityKey = DataKey.parse("example:quality")
        val internalKey = DataKey.parse("example:metadata")
        val handle = fixture.facade.createDomainInstance(itemKey).successValue()

        assertEquals(
            NamespacedKeyDataValue(ItemKey.parse("example:common")),
            fixture.facade.readData(handle, qualityKey).successValue(),
        )
        assertSame(
            ApiDenialReason.DATA_KEY_READ_DENIED,
            (fixture.facade.readData(handle, internalKey) as ApiCallResult.Denied).reason,
        )

        val tampered = com.iroselle.itemerness.api.DomainItemInstance(
            handleId = handle.handleId,
            itemKey = handle.itemKey,
            createdAgainstRevision = handle.createdAgainstRevision,
            instanceRevision = handle.instanceRevision + 1,
        )
        assertSame(
            ApiDenialReason.INVALID_MANAGED_ITEM,
            (fixture.facade.readData(tampered, qualityKey) as ApiCallResult.Denied).reason,
        )
        assertSame(
            ApiDenialReason.INVALID_MANAGED_ITEM,
            (
                fixture.facade.readData(
                    com.iroselle.itemerness.api.DomainItemInstance(
                        UUID.randomUUID(),
                        handle.itemKey,
                        handle.createdAgainstRevision,
                        handle.instanceRevision,
                    ),
                    qualityKey,
                ) as ApiCallResult.Denied
                ).reason,
        )

        val other = FakePlugin("OtherConsumer")
        fixture.service.activateCaller(other.instance)
        val otherFacade = fixture.service.forPlugin(other.instance).successValue()
        assertSame(
            ApiDenialReason.INVALID_MANAGED_ITEM,
            (otherFacade.readData(handle, qualityKey) as ApiCallResult.Denied).reason,
        )

        val edited = fixture.facade.editDomainInstance(
            handle,
            listOf(
                ItemDataMutation.Set(
                    qualityKey,
                    NamespacedKeyDataValue(ItemKey.parse("example:rare")),
                ),
            ),
        ).successValue()
        assertEquals(1, edited.instanceRevision)
        assertEquals(
            NamespacedKeyDataValue(ItemKey.parse("example:rare")),
            fixture.facade.readData(edited, qualityKey).successValue(),
        )
    }

    @Test
    fun `owning-context slot transaction rewrites once and reports the committed identity`() {
        val refreshes = AtomicInteger()
        val fixture = fixture(
            allowEdit = true,
            playerSlotDispatcher = PlayerSlotDispatcher { _, _, action -> action(); true },
            viewerRefreshDispatcher = ViewerRefreshDispatcher { refreshes.incrementAndGet(); true },
        )
        val initial = fixture.facade.createItem(ItemKey.parse("itemerness:travel-token")).successValue()
        val player = TestPlayerSlot(initial)

        val result = fixture.facade.editPlayerSlot(
            player.player,
            BukkitPlayerSlot.MAIN_HAND,
            listOf(
                ItemDataMutation.Set(
                    DataKey.parse("example:quality"),
                    NamespacedKeyDataValue(ItemKey.parse("example:rare")),
                ),
            ),
        ).toCompletableFuture().get(5, TimeUnit.SECONDS).successValue()

        assertTrue(result.semanticChanged)
        assertEquals(1, result.identity.instanceRevision)
        assertEquals(1, refreshes.get())
        assertEquals(
            NamespacedKeyDataValue(ItemKey.parse("example:rare")),
            fixture.facade.readItemData(player.current(), DataKey.parse("example:quality")).successValue(),
        )
    }

    @Test
    fun `slot compare-and-replace preserves concurrent foreign and vanilla component changes`() {
        val executor = Executors.newSingleThreadExecutor()
        try {
            val fixture = fixture(
                allowEdit = true,
                playerSlotDispatcher = PlayerSlotDispatcher { _, _, action -> executor.execute(action); true },
                viewerRefreshDispatcher = ViewerRefreshDispatcher { true },
            )
            val initial = fixture.facade.createItem(ItemKey.parse("itemerness:travel-token")).successValue()
            val replacement = initial.clone() as OpaqueItemStack
            replacement.foreignCustomData = "other-plugin:new-value"
            replacement.vanillaComponent = "minecraft:custom_name:new-value"
            val player = TestPlayerSlot(initial)
            val entered = CountDownLatch(1)
            val release = CountDownLatch(1)
            fixture.bridge.rewriteEntered = entered
            fixture.bridge.rewriteRelease = release

            val future = fixture.facade.editPlayerSlot(
                player.player,
                BukkitPlayerSlot.MAIN_HAND,
                listOf(
                    ItemDataMutation.Set(
                        DataKey.parse("example:quality"),
                        NamespacedKeyDataValue(ItemKey.parse("example:rare")),
                    ),
                ),
            ).toCompletableFuture()
            assertTrue(entered.await(5, TimeUnit.SECONDS))
            player.replace(replacement)
            release.countDown()

            val denied = future.get(5, TimeUnit.SECONDS) as ApiCallResult.Denied
            assertSame(ApiDenialReason.SLOT_CONFLICT, denied.reason)
            assertSame(replacement, player.current())
            assertEquals("other-plugin:new-value", (player.current() as OpaqueItemStack).foreignCustomData)
            assertEquals("minecraft:custom_name:new-value", (player.current() as OpaqueItemStack).vanillaComponent)
        } finally {
            executor.shutdownNow()
        }
    }

    @Test
    fun `service close completes an accepted slot transaction whose scheduler never calls back`() {
        val fixture = fixture(
            allowEdit = true,
            playerSlotDispatcher = PlayerSlotDispatcher { _, _, _ -> true },
            viewerRefreshDispatcher = ViewerRefreshDispatcher { true },
        )
        val initial = fixture.facade.createItem(ItemKey.parse("itemerness:travel-token")).successValue()
        val player = TestPlayerSlot(initial)
        val future = fixture.facade.editPlayerSlot(
            player.player,
            BukkitPlayerSlot.MAIN_HAND,
            listOf(
                ItemDataMutation.Set(
                    DataKey.parse("example:quality"),
                    NamespacedKeyDataValue(ItemKey.parse("example:rare")),
                ),
            ),
        ).toCompletableFuture()
        assertFalse(future.isDone)

        fixture.service.close()

        val denied = future.get(5, TimeUnit.SECONDS) as ApiCallResult.Denied
        assertSame(ApiDenialReason.CALLER_NOT_ACTIVE, denied.reason)
        assertSame(initial, player.current())
    }

    @Test
    fun `pending slot capacity rejects the boundary call and reopens after one completion`() {
        val scheduled = ArrayList<() -> Unit>()
        val fixture = fixture(
            allowEdit = true,
            playerSlotDispatcher = PlayerSlotDispatcher { _, _, action -> scheduled += action; true },
            viewerRefreshDispatcher = ViewerRefreshDispatcher { true },
        )
        val initial = fixture.facade.createItem(ItemKey.parse("itemerness:travel-token")).successValue()
        val player = TestPlayerSlot(initial)
        val mutation = listOf(
            ItemDataMutation.Set(
                DataKey.parse("example:quality"),
                NamespacedKeyDataValue(ItemKey.parse("example:rare")),
            ),
        )
        val pending = List(4_096) {
            fixture.facade.editPlayerSlot(
                player.player,
                BukkitPlayerSlot.MAIN_HAND,
                mutation,
            ).toCompletableFuture()
        }
        assertEquals(4_096, scheduled.size)
        assertTrue(pending.none { it.isDone })

        val overflow = fixture.facade.editPlayerSlot(
            player.player,
            BukkitPlayerSlot.MAIN_HAND,
            mutation,
        ).toCompletableFuture().get(5, TimeUnit.SECONDS) as ApiCallResult.Denied

        assertSame(ApiDenialReason.SLOT_QUEUE_FULL, overflow.reason)
        assertEquals(4_096, scheduled.size, "A rejected boundary call must not reach the entity scheduler")
        assertSame(initial, player.current())

        assertTrue(pending[1].cancel(false))
        val afterCallerCancellation = fixture.facade.editPlayerSlot(
            player.player,
            BukkitPlayerSlot.MAIN_HAND,
            mutation,
        ).toCompletableFuture().get(5, TimeUnit.SECONDS) as ApiCallResult.Denied
        assertSame(ApiDenialReason.SLOT_QUEUE_FULL, afterCallerCancellation.reason)
        assertEquals(4_096, scheduled.size, "Caller cancellation must not bypass the scheduled-work bound")

        scheduled.removeAt(0).invoke()
        assertTrue(pending.first().get(5, TimeUnit.SECONDS) is ApiCallResult.Success)
        val admitted = fixture.facade.editPlayerSlot(
            player.player,
            BukkitPlayerSlot.MAIN_HAND,
            mutation,
        ).toCompletableFuture()
        assertFalse(admitted.isDone)
        assertEquals(4_096, scheduled.size)

        fixture.service.close()
        assertSame(
            ApiDenialReason.CALLER_NOT_ACTIVE,
            (admitted.get(5, TimeUnit.SECONDS) as ApiCallResult.Denied).reason,
        )
    }

    @Test
    fun `nonfatal dispatcher errors complete and retire slot admissions without leaking capacity`() {
        var rejectDispatch = true
        val dispatchFailure = LinkageError("incompatible entity scheduler boundary")
        val fixture = fixture(
            allowEdit = true,
            playerSlotDispatcher = PlayerSlotDispatcher { _, _, action ->
                if (rejectDispatch) throw dispatchFailure
                action()
                true
            },
            viewerRefreshDispatcher = ViewerRefreshDispatcher { true },
        )
        val initial = fixture.facade.createItem(ItemKey.parse("itemerness:travel-token")).successValue()
        val player = TestPlayerSlot(initial)
        val mutation = listOf(
            ItemDataMutation.Set(
                DataKey.parse("example:quality"),
                NamespacedKeyDataValue(ItemKey.parse("example:rare")),
            ),
        )

        repeat(4_096) {
            val denied = fixture.facade.editPlayerSlot(
                player.player,
                BukkitPlayerSlot.MAIN_HAND,
                mutation,
            ).toCompletableFuture().get(5, TimeUnit.SECONDS) as ApiCallResult.Denied
            assertSame(ApiDenialReason.OWNER_CONTEXT_REQUIRED, denied.reason)
        }
        assertSame(initial, player.current())

        rejectDispatch = false
        val admitted = fixture.facade.editPlayerSlot(
            player.player,
            BukkitPlayerSlot.MAIN_HAND,
            mutation,
        ).toCompletableFuture().get(5, TimeUnit.SECONDS).successValue()

        assertTrue(admitted.semanticChanged)
        assertEquals(1, admitted.identity.instanceRevision)
    }

    @Test
    fun `fatal dispatcher error retires the admission before it is rethrown`() {
        val fatal = object : VirtualMachineError("fatal entity scheduler boundary") {}
        var dispatchFailure: Throwable? = fatal
        var deferredAction: (() -> Unit)? = null
        val fixture = fixture(
            allowEdit = true,
            playerSlotDispatcher = PlayerSlotDispatcher { _, _, action ->
                deferredAction = action
                dispatchFailure?.let { throw it }
                action()
                true
            },
            viewerRefreshDispatcher = ViewerRefreshDispatcher { true },
        )
        val initial = fixture.facade.createItem(ItemKey.parse("itemerness:travel-token")).successValue()
        val player = TestPlayerSlot(initial)
        val mutation = listOf(
            ItemDataMutation.Set(
                DataKey.parse("example:quality"),
                NamespacedKeyDataValue(ItemKey.parse("example:rare")),
            ),
        )

        val thrown = assertThrows(VirtualMachineError::class.java) {
            fixture.facade.editPlayerSlot(
                player.player,
                BukkitPlayerSlot.MAIN_HAND,
                mutation,
            )
        }
        assertSame(fatal, thrown)

        checkNotNull(deferredAction).invoke()
        assertSame(initial, player.current(), "A task retained by a failed dispatcher must lose its slot claim")

        dispatchFailure = null
        val admitted = fixture.facade.editPlayerSlot(
            player.player,
            BukkitPlayerSlot.MAIN_HAND,
            mutation,
        ).toCompletableFuture().get(5, TimeUnit.SECONDS).successValue()
        assertTrue(admitted.semanticChanged)
    }

    @Test
    fun `slot commit owns its successful completion before concurrent service retirement`() {
        val executor = Executors.newSingleThreadExecutor()
        val outcomeClaimed = CountDownLatch(1)
        val releaseCompletion = CountDownLatch(1)
        try {
            val fixture = fixture(
                allowEdit = true,
                playerSlotDispatcher = PlayerSlotDispatcher { _, _, action -> executor.execute(action); true },
                viewerRefreshDispatcher = ViewerRefreshDispatcher { true },
                slotCompletionHandoff = SlotCompletionHandoff {
                    outcomeClaimed.countDown()
                    check(releaseCompletion.await(5, TimeUnit.SECONDS))
                },
            )
            val initial = fixture.facade.createItem(ItemKey.parse("itemerness:travel-token")).successValue()
            val player = TestPlayerSlot(initial)
            val future = fixture.facade.editPlayerSlot(
                player.player,
                BukkitPlayerSlot.MAIN_HAND,
                listOf(
                    ItemDataMutation.Set(
                        DataKey.parse("example:quality"),
                        NamespacedKeyDataValue(ItemKey.parse("example:rare")),
                    ),
                ),
            ).toCompletableFuture()
            assertTrue(outcomeClaimed.await(5, TimeUnit.SECONDS))

            fixture.service.close()

            assertFalse(future.isDone, "Retirement must not steal an outcome that already committed")
            releaseCompletion.countDown()
            val receipt = future.get(5, TimeUnit.SECONDS).successValue()
            assertTrue(receipt.semanticChanged)
            assertEquals(
                1,
                (fixture.bridge.inspect(player.current()) as CanonicalItemInspection.Managed).snapshot.instanceRevision,
            )
        } finally {
            releaseCompletion.countDown()
            executor.shutdownNow()
        }
    }

    @Test
    fun `slot transaction cannot commit against a retired catalog snapshot`() {
        val executor = Executors.newSingleThreadExecutor()
        try {
            val fixture = fixture(
                allowEdit = true,
                playerSlotDispatcher = PlayerSlotDispatcher { _, _, action -> executor.execute(action); true },
                viewerRefreshDispatcher = ViewerRefreshDispatcher { true },
            )
            val initial = fixture.facade.createItem(ItemKey.parse("itemerness:travel-token")).successValue()
            val player = TestPlayerSlot(initial)
            val entered = CountDownLatch(1)
            val release = CountDownLatch(1)
            fixture.bridge.rewriteEntered = entered
            fixture.bridge.rewriteRelease = release

            val future = fixture.facade.editPlayerSlot(
                player.player,
                BukkitPlayerSlot.MAIN_HAND,
                listOf(
                    ItemDataMutation.Set(
                        DataKey.parse("example:quality"),
                        NamespacedKeyDataValue(ItemKey.parse("example:rare")),
                    ),
                ),
            ).toCompletableFuture()
            assertTrue(entered.await(5, TimeUnit.SECONDS))
            assertTrue(fixture.catalog.reload() is RuntimeCatalogUpdate.Published)
            release.countDown()

            val denied = future.get(5, TimeUnit.SECONDS) as ApiCallResult.Denied
            assertSame(ApiDenialReason.CATALOG_CONFLICT, denied.reason)
            assertEquals(
                NamespacedKeyDataValue(ItemKey.parse("example:common")),
                fixture.facade.readItemData(player.current(), DataKey.parse("example:quality")).successValue(),
            )
        } finally {
            executor.shutdownNow()
        }
    }

    private fun fixture(
        allowEdit: Boolean,
        enableNested: Boolean = false,
        playerSlotDispatcher: PlayerSlotDispatcher? = null,
        viewerRefreshDispatcher: ViewerRefreshDispatcher? = null,
        slotCompletionHandoff: SlotCompletionHandoff = SlotCompletionHandoff {},
    ): Fixture {
        installBundledDomain(allowEdit, enableNested)
        val catalog = RuntimeCatalogManager(directory, "26.1.2")
        val update = catalog.reload()
        assertTrue(
            update is RuntimeCatalogUpdate.Published,
            update.diagnostics.joinToString { diagnostic -> "${diagnostic.path}: ${diagnostic.message}" },
        )
        val owner = FakePlugin("Itemerness")
        val consumer = FakePlugin("ExampleConsumer")
        val registrations = mapOf(
            owner.instance.name to owner.instance,
            consumer.instance.name to consumer.instance,
        )
        val bridge = RecordingCanonicalBridge()
        val pdc = RecordingPdcFallbackReader()
        val service = DefaultBukkitItemernessApi(
            ownerPlugin = owner.instance,
            catalog = catalog,
            bridge = bridge,
            activePlugins = registrations.values,
            pdcFallbackReader = pdc,
            componentWriter = RecordingItemComponentWriter,
            playerSlotDispatcher = playerSlotDispatcher,
            viewerRefreshDispatcher = viewerRefreshDispatcher,
            slotCompletionHandoff = slotCompletionHandoff,
        )
        return Fixture(
            consumer = consumer,
            service = service,
            facade = service.forPlugin(consumer.instance).successValue(),
            bridge = bridge,
            pdc = pdc,
            catalog = catalog,
        )
    }

    private fun installBundledDomain(allowEdit: Boolean, enableNested: Boolean) {
        copyResource("config.yml")
        val resources = checkNotNull(javaClass.classLoader.getResourceAsStream("itemerness-resources.txt"))
            .bufferedReader(Charsets.UTF_8)
            .useLines { lines ->
                lines.map(String::trim)
                    .filter { it.isNotEmpty() && !it.startsWith('#') }
                    .toList()
            }
        com.iroselle.itemerness.bukkit.TestResourcePaths.withProduction(resources)
            .distinct()
            .forEach(::copyResource)
        val itemFile = directory.resolve("items/examples.yml")
        var items = Files.readString(itemFile).replaceFirst("enabled: false", "enabled: true")
        if (enableNested) {
            items = items.replaceFirst(
                "  nested-satchel:\n    enabled: false",
                "  nested-satchel:\n    enabled: true",
            )
        }
        Files.writeString(itemFile, items, Charsets.UTF_8)
        if (allowEdit) {
            Files.writeString(directory.resolve("access.yml"), EDIT_ACCESS, Charsets.UTF_8)
        }
    }

    private fun copyResource(path: String) {
        val destination = directory.resolve(path)
        Files.createDirectories(destination.parent)
        checkNotNull(javaClass.classLoader.getResourceAsStream(path)).use { input ->
            Files.copy(input, destination, StandardCopyOption.REPLACE_EXISTING)
        }
    }

    private data class Fixture(
        val consumer: FakePlugin,
        val service: DefaultBukkitItemernessApi,
        val facade: BoundBukkitItemernessApi,
        val bridge: RecordingCanonicalBridge,
        val pdc: RecordingPdcFallbackReader,
        val catalog: RuntimeCatalogManager,
    )

    private companion object {
        val EDIT_ACCESS = """
            config-version: 1
            api:
              defaults:
                identify: allow
                create: allow
                read-data: schema-policy
                edit-data: deny
                write-viewer-fact: deny
                request-refresh: allow
              grants:
                - plugin: ExampleConsumer
                  actions: [edit-data]
                  item-namespaces: [itemerness]
                  data-namespaces: [example]
        """.trimIndent() + "\n"
    }
}

private class RecordingPdcFallbackReader : PdcFallbackReader {
    private val values = IdentityHashMap<ItemStack, MutableMap<ItemKey, PdcFallbackRead>>()
    var readCount: Int = 0
        private set

    fun put(
        source: ItemStack,
        key: ItemKey,
        value: PdcFallbackRead,
    ) {
        values.computeIfAbsent(source) { LinkedHashMap() }[key] = value
    }

    override fun read(
        source: ItemStack,
        key: ItemKey,
        type: DataType,
    ): PdcFallbackRead {
        readCount += 1
        return values[source]?.get(key) ?: PdcFallbackRead.Absent
    }
}

private class RecordingCanonicalBridge : BukkitCanonicalItemBridge {
    override val descriptor: BukkitCanonicalBridgeDescriptor = BukkitCanonicalBridgeDescriptor(
        id = ItemKey.parse("itemerness:test-canonical-bridge"),
        minecraftVersion = MinecraftVersion("26.1.2"),
    )
    var inspectCount: Int = 0
        private set
    var rewriteCount: Int = 0
        private set
    var rewriteEntered: CountDownLatch? = null
    var rewriteRelease: CountDownLatch? = null
    val created = ArrayList<CreatedCanonical>()

    override fun create(
        definition: ItemDefinition,
        instance: CanonicalItemInstance,
        pendingName: PendingItemName,
        amount: Int,
    ): ItemStack = OpaqueItemStack(amount).also { result ->
        val snapshot = instance.toSnapshot(definition, pendingName, amount)
        result.canonical = snapshot
        created += CreatedCanonical(snapshot.itemKey, snapshot)
    }

    override fun rewrite(
        source: ItemStack,
        definition: ItemDefinition,
        instance: CanonicalItemInstance,
        pendingName: PendingItemName,
    ): ItemStack {
        rewriteCount += 1
        rewriteEntered?.countDown()
        rewriteRelease?.let { release -> check(release.await(5, TimeUnit.SECONDS)) }
        require((source as? OpaqueItemStack)?.canonical != null) {
            "Test bridge cannot rewrite an unmanaged stack"
        }
        val count = source.amount
        return OpaqueItemStack(count).also { result ->
            result.canonical = instance.toSnapshot(definition, pendingName, count)
        }
    }

    override fun inspect(source: ItemStack): CanonicalItemInspection {
        inspectCount += 1
        val snapshot = (source as? OpaqueItemStack)?.canonical ?: return CanonicalItemInspection.Unmanaged
        return CanonicalItemInspection.Managed(snapshot.copy(count = source.amount))
    }

    override fun canonicalSnbt(source: ItemStack): String? = null

    fun update(
        source: ItemStack,
        transform: (CanonicalItemSnapshot) -> CanonicalItemSnapshot,
    ) {
        val target = source as? OpaqueItemStack ?: error("Test stack is unmanaged")
        target.canonical = transform(target.canonical ?: error("Test stack is unmanaged"))
    }
}

private class TestPlayerSlot(initial: ItemStack) {
    private val current = AtomicReference(initial)
    private val playerId = UUID.fromString("00000000-0000-4000-8000-000000000123")
    private val inventory = Proxy.newProxyInstance(
        PlayerInventory::class.java.classLoader,
        arrayOf(PlayerInventory::class.java),
    ) { proxy, method, arguments ->
        when (method.name) {
            "getItemInMainHand" -> current.get()
            "setItemInMainHand" -> {
                current.set(arguments?.single() as ItemStack)
                null
            }
            "equals" -> proxy === arguments?.singleOrNull()
            "hashCode" -> System.identityHashCode(proxy)
            else -> primitiveDefault(method.returnType)
        }
    } as PlayerInventory

    val player: Player = Proxy.newProxyInstance(
        Player::class.java.classLoader,
        arrayOf(Player::class.java),
    ) { proxy, method, arguments ->
        when (method.name) {
            "getUniqueId" -> playerId
            "getInventory" -> inventory
            "equals" -> proxy === arguments?.singleOrNull()
            "hashCode" -> System.identityHashCode(proxy)
            else -> primitiveDefault(method.returnType)
        }
    } as Player

    fun current(): ItemStack = current.get()

    fun replace(stack: ItemStack) {
        current.set(stack)
    }
}

private fun primitiveDefault(type: Class<*>): Any? = when (type) {
    java.lang.Boolean.TYPE -> false
    java.lang.Byte.TYPE -> 0.toByte()
    java.lang.Short.TYPE -> 0.toShort()
    java.lang.Integer.TYPE -> 0
    java.lang.Long.TYPE -> 0L
    java.lang.Float.TYPE -> 0F
    java.lang.Double.TYPE -> 0.0
    java.lang.Character.TYPE -> '\u0000'
    else -> null
}

private data class CreatedCanonical(
    val itemKey: ItemKey,
    val snapshot: CanonicalItemSnapshot,
)

private object RecordingItemComponentWriter : BukkitItemComponentWriter {
    override fun applyBase(stack: ItemStack, components: List<BaseItemComponent>) {
        val target = stack as OpaqueItemStack
        target.baseComponents = components
        components.filterIsInstance<BaseItemComponent.MaxStackSize>().singleOrNull()?.let { component ->
            target.maximumStackSize = component.value
        }
    }

    override fun applyContents(
        stack: ItemStack,
        component: NestedContentComponent,
        children: List<ItemStack>,
    ) {
        val target = stack as OpaqueItemStack
        target.contentComponent = component
        target.children = children
    }
}

@Suppress("DEPRECATION")
private class OpaqueItemStack(
    private var quantity: Int = 1,
) : ItemStack() {
    var canonical: CanonicalItemSnapshot? = null
    var maximumStackSize: Int = 64
    var baseComponents: List<BaseItemComponent> = emptyList()
    var contentComponent: NestedContentComponent? = null
    var children: List<ItemStack> = emptyList()
    var foreignCustomData: String? = null
    var vanillaComponent: String? = null

    override fun getAmount(): Int = quantity

    override fun setAmount(amount: Int) {
        quantity = amount
    }

    override fun getMaxStackSize(): Int = maximumStackSize

    public override fun clone(): OpaqueItemStack = OpaqueItemStack(quantity).also { copy ->
        copy.canonical = canonical
        copy.maximumStackSize = maximumStackSize
        copy.baseComponents = baseComponents
        copy.contentComponent = contentComponent
        copy.children = children.map(ItemStack::clone)
        copy.foreignCustomData = foreignCustomData
        copy.vanillaComponent = vanillaComponent
    }

    override fun equals(other: Any?): Boolean =
        other is OpaqueItemStack &&
            quantity == other.quantity &&
            canonical == other.canonical &&
            maximumStackSize == other.maximumStackSize &&
            baseComponents == other.baseComponents &&
            contentComponent == other.contentComponent &&
            children == other.children &&
            foreignCustomData == other.foreignCustomData &&
            vanillaComponent == other.vanillaComponent

    override fun hashCode(): Int {
        var result = quantity
        result = 31 * result + (canonical?.hashCode() ?: 0)
        result = 31 * result + maximumStackSize
        result = 31 * result + baseComponents.hashCode()
        result = 31 * result + (contentComponent?.hashCode() ?: 0)
        result = 31 * result + children.hashCode()
        result = 31 * result + (foreignCustomData?.hashCode() ?: 0)
        result = 31 * result + (vanillaComponent?.hashCode() ?: 0)
        return result
    }

    fun shape(): StackShape = StackShape(
        amount = amount,
        maximumStackSize = maximumStackSize,
        baseComponents = baseComponents,
        contentComponent = contentComponent,
        children = children.map { (it as OpaqueItemStack).shape() },
    )
}

private data class StackShape(
    val amount: Int,
    val maximumStackSize: Int,
    val baseComponents: List<BaseItemComponent>,
    val contentComponent: NestedContentComponent?,
    val children: List<StackShape>,
)

private fun CanonicalItemInstance.toSnapshot(
    definition: ItemDefinition,
    pendingName: PendingItemName,
    amount: Int,
): CanonicalItemSnapshot = CanonicalItemSnapshot(
    itemKey = itemKey,
    materialKey = definition.material,
    count = amount,
    pendingName = pendingName.text,
    createdAgainstRevision = createdAgainstRevision,
    instanceRevision = instanceRevision,
    dataSchemas = CanonicalDataSchemas(
        schemaVersions.map { (key, version) -> CanonicalDataSchemaVersion(key, version) },
    ),
    instanceId = instanceId,
    data = ProjectionCompound(
        data.map { (key, value) -> ProjectionCompound.Entry(key.toString(), value.toProjectionValue()) },
    ),
    fingerprint = CanonicalItemFingerprint(byteArrayOf(1, instanceRevision.toByte())),
)

private fun CanonicalItemSnapshot.withoutData(key: DataKey): CanonicalItemSnapshot = copy(
    data = ProjectionCompound(data.entries.filterNot { entry -> entry.key == key.toString() }),
)

private fun ItemDataValue.toProjectionValue(): ProjectionValue = when (this) {
    is BooleanDataValue -> BooleanProjectionValue(value)
    is IntegerDataValue -> IntegerProjectionValue(value)
    is LongDataValue -> LongProjectionValue(value)
    is DecimalDataValue -> DecimalProjectionValue(BigDecimal.valueOf(value))
    is StringDataValue -> StringProjectionValue(value)
    is UuidDataValue -> UuidProjectionValue(value)
    is NamespacedKeyDataValue -> KeyProjectionValue(value)
    is ListDataValue -> ListProjectionValue(values.map(ItemDataValue::toProjectionValue))
    is CompoundDataValue -> ProjectionCompound(
        entries.map { (key, value) -> ProjectionCompound.Entry(key, value.toProjectionValue()) },
    )
}

private fun <T> ApiCallResult<T>.successValue(): T = when (this) {
    is ApiCallResult.Success -> value
    is ApiCallResult.Denied -> error("Expected success, got $reason: $detail")
}
