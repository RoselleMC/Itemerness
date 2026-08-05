package com.iroselle.itemerness.bukkit.projection

import com.iroselle.itemerness.api.BooleanDataValue
import com.iroselle.itemerness.api.CompoundDataValue
import com.iroselle.itemerness.api.DataKey
import com.iroselle.itemerness.api.DecimalDataValue
import com.iroselle.itemerness.api.IntegerDataValue
import com.iroselle.itemerness.api.ItemDataValue
import com.iroselle.itemerness.api.ItemKey
import com.iroselle.itemerness.api.ListDataValue
import com.iroselle.itemerness.api.LongDataValue
import com.iroselle.itemerness.api.NamespacedKeyDataValue
import com.iroselle.itemerness.api.StringDataValue
import com.iroselle.itemerness.api.UuidDataValue
import com.iroselle.itemerness.bukkit.FoliaScheduler
import com.iroselle.itemerness.bukkit.api.EffectiveItemDataResolver
import com.iroselle.itemerness.bukkit.api.PdcFallbackRead
import com.iroselle.itemerness.bukkit.api.PdcFallbackReader
import com.iroselle.itemerness.bukkit.catalog.RuntimeCatalogManager
import com.iroselle.itemerness.bukkit.catalog.RuntimeCatalogUpdate
import com.iroselle.itemerness.bukkit.placeholder.PlaceholderItemSnapshot
import com.iroselle.itemerness.bukkit.placeholder.PlaceholderSnapshotStore
import com.iroselle.itemerness.bukkit.spi.BukkitCanonicalItemBridge
import com.iroselle.itemerness.bukkit.spi.CanonicalItemInspection
import com.iroselle.itemerness.core.presentation.ViewerFactStore
import com.iroselle.itemerness.core.catalog.InstanceDataMutation
import com.iroselle.itemerness.projection.BooleanProjectionValue
import com.iroselle.itemerness.projection.BoundedProjectionResyncQueue
import com.iroselle.itemerness.projection.CanonicalDataSchemaVersion
import com.iroselle.itemerness.projection.CanonicalDataSchemas
import com.iroselle.itemerness.projection.CanonicalItemFingerprint
import com.iroselle.itemerness.projection.CanonicalItemSnapshot
import com.iroselle.itemerness.projection.DecimalProjectionValue
import com.iroselle.itemerness.projection.IntegerProjectionValue
import com.iroselle.itemerness.projection.KeyProjectionValue
import com.iroselle.itemerness.projection.ListProjectionValue
import com.iroselle.itemerness.projection.LocaleId
import com.iroselle.itemerness.projection.LongProjectionValue
import com.iroselle.itemerness.projection.ProjectionCompound
import com.iroselle.itemerness.projection.ProjectionResyncRequest
import com.iroselle.itemerness.projection.ProjectionValue
import com.iroselle.itemerness.projection.ProjectionViewerBindingAdapter
import com.iroselle.itemerness.projection.StringProjectionValue
import com.iroselle.itemerness.projection.UuidProjectionValue
import com.iroselle.itemerness.projection.ViewerProjectionSnapshot
import io.papermc.paper.threadedregions.scheduler.EntityScheduler
import io.papermc.paper.threadedregions.scheduler.ScheduledTask
import java.lang.reflect.InvocationTargetException
import java.lang.reflect.Proxy
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.util.ArrayDeque
import java.util.Locale
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.function.Consumer
import org.bukkit.Material
import org.bukkit.Server
import org.bukkit.entity.Player
import org.bukkit.inventory.ItemStack
import org.bukkit.inventory.PlayerInventory
import org.bukkit.packs.ResourcePack
import org.bukkit.plugin.Plugin
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir

class ViewerStatePublisherTest {
    @TempDir
    lateinit var directory: Path

    @Test
    fun `server pack hash is trusted only for the exact reported id and a valid sha1`() {
        val packId = UUID.randomUUID()
        val hash = "A".repeat(40)
        val pack = proxy<ResourcePack> { proxy, method, arguments ->
            when (method.name) {
                "getId" -> packId
                "getHash" -> hash
                "equals" -> proxy === arguments?.singleOrNull()
                "hashCode" -> System.identityHashCode(proxy)
                else -> defaultValue(method.returnType)
            }
        }

        assertEquals("a".repeat(40), trustedServerPackSha1(pack, packId))
        assertNull(trustedServerPackSha1(pack, UUID.randomUUID()))
        assertNull(trustedServerPackSha1(null, packId))

        val malformed = proxy<ResourcePack> { _, method, _ ->
            when (method.name) {
                "getId" -> packId
                "getHash" -> "not-a-sha1"
                else -> defaultValue(method.returnType)
            }
        }
        assertNull(trustedServerPackSha1(malformed, packId))
    }

    @Test
    fun `stale session cannot unbind a replacement session with the same viewer id`() {
        val viewerId = UUID.randomUUID()
        val oldPlayer = player(viewerId, entityId = 41)
        val newPlayer = player(viewerId, entityId = 42)
        val binding = BlockingBinding()
        val publisher = publisher(binding = binding)
        val oldSession = beginSession(publisher, oldPlayer)
        assertTrue(oldSession.javaClass.declaredFields.none { Player::class.java.isAssignableFrom(it.type) })
        assertTrue(bind(publisher, oldSession, oldPlayer))
        assertFalse(bind(publisher, oldSession, newPlayer))

        val executor = Executors.newFixedThreadPool(2)
        try {
            val retired = executor.submit { retire(publisher, oldSession, unbind = true) }
            assertTrue(binding.unbindEntered.await(2, TimeUnit.SECONDS))

            val replacementStarted = CountDownLatch(1)
            val replacementBound = CountDownLatch(1)
            val replacement = executor.submit<Any> {
                replacementStarted.countDown()
                val session = beginSession(publisher, newPlayer)
                assertTrue(bind(publisher, session, newPlayer))
                replacementBound.countDown()
                session
            }

            assertTrue(replacementStarted.await(2, TimeUnit.SECONDS))
            assertFalse(
                replacementBound.await(150, TimeUnit.MILLISECONDS),
                "A replacement bind must wait until the old UUID unbind has completed",
            )
            binding.releaseUnbind.countDown()
            retired.get(2, TimeUnit.SECONDS)
            replacement.get(2, TimeUnit.SECONDS)

            assertSame(newPlayer, binding.current[viewerId])
        } finally {
            binding.releaseUnbind.countDown()
            executor.shutdownNow()
            publisher.close()
        }
    }

    @Test
    fun `close still clears published state when viewer unbind fails`() {
        val viewerId = UUID.randomUUID()
        val projection = ProjectionStateStore()
        val binding = object : ProjectionViewerBindingAdapter {
            override fun bindViewer(viewerId: UUID, owningPlayer: Any) = Unit

            override fun unbindViewer(viewerId: UUID) {
                throw IllegalStateException("unbind failed")
            }
        }
        val publisher = publisher(binding = binding, projection = projection)
        val player = player(viewerId)
        val session = beginSession(publisher, player)
        assertTrue(bind(publisher, session, player))
        projection.publishViewer(
            ViewerProjectionSnapshot(
                viewerId = viewerId,
                revision = 1,
                locale = LocaleId("en_us"),
                theme = null,
                assetProfile = null,
            ),
        )

        val failure = assertThrows(IllegalStateException::class.java, publisher::close)

        assertEquals("unbind failed", failure.message)
        assertNull(projection.viewer(viewerId))
        publisher.close()
    }

    @Test
    fun `resync pump drains only a bounded ready set and discards offline viewer work`() {
        val scheduled = AtomicInteger()
        val onlineId = UUID.randomUUID()
        val onlinePlayer = player(onlineId, scheduled)
        val lookups = CopyOnWriteArrayList<UUID>()
        val server = proxy<Server> { proxy, method, arguments ->
            when (method.name) {
                "getPlayer" -> (arguments?.single() as UUID).let { viewerId ->
                    lookups += viewerId
                    if (viewerId == onlineId) onlinePlayer else null
                }
                "getOnlinePlayers" -> throw AssertionError("The resync pump must not scan online players")
                "equals" -> proxy === arguments?.singleOrNull()
                "hashCode" -> System.identityHashCode(proxy)
                "toString" -> "ViewerStatePublisherTestServer"
                else -> defaultValue(method.returnType)
            }
        }
        val queue = BoundedProjectionResyncQueue(maxConnections = 128)
        val viewerIds = buildList {
            add(onlineId)
            repeat(64) { add(UUID.randomUUID()) }
        }
        viewerIds.forEachIndexed { generation, viewerId ->
            assertTrue(
                queue.offer(
                    ProjectionResyncRequest(
                        viewerId = viewerId,
                        connectionGeneration = generation.toLong(),
                        slot = null,
                        fullInventory = true,
                    ),
                ),
            )
        }
        val publisher = publisher(
            plugin = plugin(server),
            resyncRequests = queue,
        )

        pumpResyncRequests(publisher)
        pumpHeartbeatCaptures(publisher)

        assertEquals(64, lookups.size)
        assertEquals(1, scheduled.get())
        assertEquals(1, queue.pendingConnectionCount())

        pumpResyncRequests(publisher)
        pumpHeartbeatCaptures(publisher)

        assertEquals(65, lookups.size)
        assertEquals(1, scheduled.get())
        assertEquals(0, queue.pendingConnectionCount())
        publisher.close()
    }

    @Test
    fun `capture event storm keeps one entity task and one coalesced trailing request`() {
        val viewerId = UUID.randomUUID()
        val entityScheduler = ControlledEntityScheduler()
        val viewer = player(viewerId, schedulerOverride = entityScheduler.scheduler)
        val server = proxy<Server> { proxy, method, arguments ->
            when (method.name) {
                "getPlayer" -> viewer.takeIf { arguments?.singleOrNull() == viewerId }
                "equals" -> proxy === arguments?.singleOrNull()
                "hashCode" -> System.identityHashCode(proxy)
                else -> defaultValue(method.returnType)
            }
        }
        val resyncRequests = BoundedProjectionResyncQueue()
        val publisher = publisher(plugin = plugin(server), resyncRequests = resyncRequests)

        repeat(1_000) { publisher.scheduleCapture(viewer) }
        assertEquals(1, globalCaptureQueueSize(publisher))
        assertTrue(
            resyncRequests.offer(
                ProjectionResyncRequest(viewerId, connectionGeneration = 1, slot = null, fullInventory = true),
            ),
        )
        pumpResyncRequests(publisher)
        pumpHeartbeatCaptures(publisher)

        assertEquals(1, entityScheduler.submissions.get())
        publisher.scheduleCapture(viewer)
        pumpHeartbeatCaptures(publisher)
        assertEquals(
            1,
            entityScheduler.submissions.get(),
            "A busy UUID must rotate normal and resync work without another submission",
        )

        entityScheduler.runNext()
        pumpHeartbeatCaptures(publisher)

        assertEquals(2, entityScheduler.submissions.get(), "The storm must collapse into one trailing capture")
        publisher.close()
    }

    @Test
    fun `initial multi viewer event storm uses the bounded global admission pump`() {
        val scheduled = AtomicInteger()
        val viewers = List(4_160) { player(UUID.randomUUID(), scheduled) }
        val byId = viewers.associateBy(Player::getUniqueId)
        val server = proxy<Server> { proxy, method, arguments ->
            when (method.name) {
                "getPlayer" -> byId[arguments?.singleOrNull() as? UUID]
                "equals" -> proxy === arguments?.singleOrNull()
                "hashCode" -> System.identityHashCode(proxy)
                else -> defaultValue(method.returnType)
            }
        }
        val publisher = publisher(plugin = plugin(server))

        viewers.forEach(publisher::scheduleCapture)

        assertEquals(4_096, globalCaptureQueueSize(publisher))
        assertEquals(0, scheduled.get(), "Events must not bypass global capture admission")
        pumpHeartbeatCaptures(publisher)
        assertEquals(64, scheduled.get())
        assertEquals(4_032, globalCaptureQueueSize(publisher))
        pumpHeartbeatCaptures(publisher)
        assertEquals(128, scheduled.get())
        assertEquals(3_968, globalCaptureQueueSize(publisher))
        publisher.close()
    }

    @Test
    fun `resync remains pending while the global queue is full of resync work`() {
        val targetId = UUID.randomUUID()
        val scheduled = AtomicInteger()
        val target = player(targetId, scheduled)
        val server = proxy<Server> { proxy, method, arguments ->
            when (method.name) {
                "getPlayer" -> target.takeIf { arguments?.singleOrNull() == targetId }
                "equals" -> proxy === arguments?.singleOrNull()
                "hashCode" -> System.identityHashCode(proxy)
                else -> defaultValue(method.returnType)
            }
        }
        val resyncRequests = BoundedProjectionResyncQueue()
        val publisher = publisher(
            plugin = plugin(server),
            resyncRequests = resyncRequests,
        )
        repeat(4_096) { enqueueGlobalResync(publisher, UUID.randomUUID()) }
        assertEquals(4_096, globalCaptureQueueSize(publisher))
        assertTrue(
            resyncRequests.offer(
                ProjectionResyncRequest(targetId, connectionGeneration = 1, slot = null, fullInventory = true),
            ),
        )

        pumpResyncRequests(publisher)

        assertEquals(1, resyncRequests.pendingConnectionCount(), "A full admission queue must not drain resync")
        assertFalse(isGloballyQueued(publisher, targetId))

        pumpHeartbeatCaptures(publisher)
        pumpResyncRequests(publisher)
        assertEquals(0, resyncRequests.pendingConnectionCount())
        assertTrue(isGloballyQueued(publisher, targetId))

        repeat(64) { pumpHeartbeatCaptures(publisher) }
        assertEquals(1, scheduled.get(), "The retained correction must eventually be admitted exactly once")
        pumpResyncRequests(publisher)
        pumpHeartbeatCaptures(publisher)
        assertEquals(1, scheduled.get())
        publisher.close()
    }

    @Test
    fun `rejected resync submission is retried and eventually refreshes inventory`() {
        installBundledResources()
        val catalog = RuntimeCatalogManager(directory)
        val update = catalog.reload()
        require(update is RuntimeCatalogUpdate.Published) { update.diagnostics.joinToString() }
        val projection = ProjectionStateStore().also { state ->
            state.publishCatalog(update.active, update.active.presentation)
        }
        val viewerId = UUID.randomUUID()
        val inventoryUpdates = AtomicInteger()
        val entityScheduler = RejectOnceEntityScheduler()
        val stack = TestItemStack(false)
        val viewer = player(
            viewerId = viewerId,
            schedulerOverride = entityScheduler.scheduler,
            inventory = inventory(stack, stack),
            inventoryUpdates = inventoryUpdates,
        )
        val server = proxy<Server> { proxy, method, arguments ->
            when (method.name) {
                "getPlayer" -> viewer.takeIf { arguments?.singleOrNull() == viewerId }
                "equals" -> proxy === arguments?.singleOrNull()
                "hashCode" -> System.identityHashCode(proxy)
                else -> defaultValue(method.returnType)
            }
        }
        val resyncRequests = BoundedProjectionResyncQueue()
        val publisher = publisher(
            plugin = plugin(server),
            catalog = catalog,
            projection = projection,
            resyncRequests = resyncRequests,
        )
        assertTrue(
            resyncRequests.offer(
                ProjectionResyncRequest(viewerId, connectionGeneration = 1, slot = null, fullInventory = true),
            ),
        )

        pumpResyncRequests(publisher)
        pumpHeartbeatCaptures(publisher)

        assertEquals(1, entityScheduler.submissions.get())
        assertTrue(isGloballyQueued(publisher, viewerId), "A rejected resync must remain admitted for retry")
        pumpHeartbeatCaptures(publisher)
        assertEquals(2, entityScheduler.submissions.get())
        entityScheduler.runNext()

        assertEquals(1, inventoryUpdates.get())
        assertFalse(isGloballyQueued(publisher, viewerId))
        publisher.close()
    }

    @Test
    fun `rejected entity task releases its UUID admission`() {
        val submissions = AtomicInteger()
        val rejectingScheduler = proxy<EntityScheduler> { _, method, _ ->
            when (method.name) {
                "runDelayed" -> {
                    submissions.incrementAndGet()
                    null
                }
                else -> defaultValue(method.returnType)
            }
        }
        val viewer = player(UUID.randomUUID(), schedulerOverride = rejectingScheduler)
        val server = proxy<Server> { proxy, method, arguments ->
            when (method.name) {
                "getPlayer" -> viewer.takeIf { arguments?.singleOrNull() == viewer.uniqueId }
                "equals" -> proxy === arguments?.singleOrNull()
                "hashCode" -> System.identityHashCode(proxy)
                else -> defaultValue(method.returnType)
            }
        }
        val publisher = publisher(plugin = plugin(server))

        publisher.scheduleCapture(viewer)
        pumpHeartbeatCaptures(publisher)
        publisher.scheduleCapture(viewer)
        pumpHeartbeatCaptures(publisher)

        assertEquals(2, submissions.get(), "A null scheduler result must not leave the UUID permanently busy")
        publisher.close()
    }

    @Test
    fun `nonfatal binding linkage failure retires only that lease and releases admission`() {
        val viewerId = UUID.randomUUID()
        val entityScheduler = ControlledEntityScheduler()
        val viewer = player(viewerId, schedulerOverride = entityScheduler.scheduler)
        val binding = object : ProjectionViewerBindingAdapter {
            override fun bindViewer(viewerId: UUID, owningPlayer: Any) {
                throw LinkageError("incompatible exact-version binding")
            }

            override fun unbindViewer(viewerId: UUID) = Unit
        }
        val server = proxy<Server> { proxy, method, arguments ->
            when (method.name) {
                "getPlayer" -> viewer.takeIf { arguments?.singleOrNull() == viewerId }
                "equals" -> proxy === arguments?.singleOrNull()
                "hashCode" -> System.identityHashCode(proxy)
                else -> defaultValue(method.returnType)
            }
        }
        val publisher = publisher(plugin = plugin(server), binding = binding)

        publisher.scheduleCapture(viewer)
        pumpHeartbeatCaptures(publisher)
        entityScheduler.runNext()
        publisher.scheduleCapture(viewer)
        pumpHeartbeatCaptures(publisher)

        assertEquals(
            2,
            entityScheduler.submissions.get(),
            "A nonfatal Error must not strand the viewer UUID admission",
        )
        publisher.close()
    }

    @Test
    fun `direct capture isolates binding linkage failure and unbinds the partial lease`() {
        val viewerId = UUID.randomUUID()
        val unbinds = AtomicInteger()
        val binding = object : ProjectionViewerBindingAdapter {
            override fun bindViewer(viewerId: UUID, owningPlayer: Any) {
                throw LinkageError("incompatible direct refresh binding")
            }

            override fun unbindViewer(viewerId: UUID) {
                unbinds.incrementAndGet()
            }
        }
        val projection = ProjectionStateStore()
        val publisher = publisher(binding = binding, projection = projection)

        assertFalse(publisher.capture(player(viewerId)))

        assertEquals(1, unbinds.get())
        assertNull(projection.viewer(viewerId))
        publisher.close()
        assertEquals(1, unbinds.get(), "The failed lease must not remain registered for close")
    }

    @Test
    fun `heartbeat UUID queue is hard bounded and rotates past overflow`() {
        val scheduled = AtomicInteger()
        val viewers = List(4_160) { player(UUID.randomUUID(), scheduled) }
        val byId = viewers.associateBy(Player::getUniqueId)
        val server = proxy<Server> { proxy, method, arguments ->
            when (method.name) {
                "getOnlinePlayers" -> viewers
                "getPlayer" -> byId[arguments?.singleOrNull() as? UUID]
                "equals" -> proxy === arguments?.singleOrNull()
                "hashCode" -> System.identityHashCode(proxy)
                else -> defaultValue(method.returnType)
            }
        }
        val publisher = publisher(plugin = plugin(server))

        enqueueHeartbeatCaptures(publisher)
        assertEquals(4_096, globalCaptureQueueSize(publisher))

        pumpHeartbeatCaptures(publisher)
        assertEquals(64, scheduled.get())
        enqueueHeartbeatCaptures(publisher)

        assertEquals(4_096, globalCaptureQueueSize(publisher))
        assertTrue(
            isGloballyQueued(publisher, viewers.last().uniqueId),
            "A later heartbeat must rotate into the population dropped by the previous hard cap",
        )
        publisher.close()
    }

    @Test
    fun `heartbeat pump admits a bounded fair batch per global tick`() {
        val scheduled = AtomicInteger()
        val viewers = List(145) { player(UUID.randomUUID(), scheduled) }
        val byId = viewers.associateBy(Player::getUniqueId)
        val server = proxy<Server> { proxy, method, arguments ->
            when (method.name) {
                "getOnlinePlayers" -> viewers
                "getPlayer" -> byId[arguments?.singleOrNull() as? UUID]
                "equals" -> proxy === arguments?.singleOrNull()
                "hashCode" -> System.identityHashCode(proxy)
                else -> defaultValue(method.returnType)
            }
        }
        val publisher = publisher(plugin = plugin(server))

        enqueueHeartbeatCaptures(publisher)
        pumpHeartbeatCaptures(publisher)
        assertEquals(64, scheduled.get())

        pumpHeartbeatCaptures(publisher)
        assertEquals(128, scheduled.get())

        pumpHeartbeatCaptures(publisher)
        assertEquals(145, scheduled.get())
        publisher.close()
    }

    @Test
    fun `placeholder bridge failure is isolated to one hand and does not retire viewers`() {
        installBundledResources()
        val catalog = RuntimeCatalogManager(directory)
        val update = catalog.reload()
        require(update is RuntimeCatalogUpdate.Published) { update.diagnostics.joinToString() }
        val projection = ProjectionStateStore().also { state ->
            state.publishCatalog(update.active, update.active.presentation)
        }
        val placeholders = PlaceholderSnapshotStore()
        val inspected = CopyOnWriteArrayList<Boolean>()
        val bridge = proxy<BukkitCanonicalItemBridge> { _, method, arguments ->
            when (method.name) {
                "inspect" -> {
                    val source = arguments?.singleOrNull() as TestItemStack
                    inspected += source.failInspection
                    if (source.failInspection) throw LinkageError("malformed exact-version bridge")
                    CanonicalItemInspection.Unmanaged
                }
                else -> defaultValue(method.returnType)
            }
        }
        val publisher = publisher(
            catalog = catalog,
            bridge = bridge,
            projection = projection,
            placeholders = placeholders,
        )
        val badViewerId = UUID.randomUUID()
        val goodViewerId = UUID.randomUUID()
        val badViewer = player(
            viewerId = badViewerId,
            inventory = inventory(TestItemStack(true), TestItemStack(false)),
        )
        val goodViewer = player(
            viewerId = goodViewerId,
            inventory = inventory(TestItemStack(false), TestItemStack(false)),
        )

        assertTrue(publisher.capture(badViewer))
        assertTrue(publisher.capture(goodViewer))

        assertEquals(listOf(true, false, false, false), inspected)
        assertFalse(checkNotNull(placeholders.find(badViewerId)).mainHand.present)
        assertFalse(checkNotNull(placeholders.find(badViewerId)).offHand.present)
        assertNotNull(projection.viewer(badViewerId), "An item-local failure must retain the viewer lease")
        assertNotNull(projection.viewer(goodViewerId), "A bad item must not block another viewer")
        publisher.close()
    }

    @Test
    fun `placeholder snapshot exposes a declared PDC fallback without scanning foreign data`() {
        installBundledResources()
        val itemFile = directory.resolve("items/examples.yml")
        Files.writeString(itemFile, Files.readString(itemFile).replaceFirst("enabled: false", "enabled: true"))
        val catalog = RuntimeCatalogManager(directory)
        val runtime = (catalog.reload() as RuntimeCatalogUpdate.Published).active
        val projection = ProjectionStateStore().also { state ->
            state.publishCatalog(runtime, runtime.presentation)
        }
        val itemKey = ItemKey.parse("itemerness:travel-token")
        val quality = DataKey.parse("example:quality")
        val instance = runtime.domain.editInstance(
            runtime.domain.createInstance(itemKey),
            listOf(InstanceDataMutation.Remove(quality)),
        )
        val stack = TestItemStack(
            failInspection = false,
            canonical = CanonicalItemSnapshot(
                itemKey = itemKey,
                materialKey = ItemKey.parse("minecraft:paper"),
                count = 1,
                pendingName = runtime.settings.pendingName(itemKey),
                createdAgainstRevision = instance.createdAgainstRevision,
                instanceRevision = instance.instanceRevision,
                dataSchemas = CanonicalDataSchemas(
                    instance.schemaVersions.map { (key, version) -> CanonicalDataSchemaVersion(key, version) },
                ),
                instanceId = instance.instanceId,
                data = ProjectionCompound(
                    instance.data.map { (key, value) ->
                        ProjectionCompound.Entry(key.toString(), value.toProjectionValue())
                    },
                ),
                fingerprint = CanonicalItemFingerprint(byteArrayOf(7, 1)),
            ),
        )
        val bridge = proxy<BukkitCanonicalItemBridge> { _, method, arguments ->
            when (method.name) {
                "inspect" -> CanonicalItemInspection.Managed(
                    requireNotNull((arguments?.singleOrNull() as TestItemStack).canonical),
                )
                else -> defaultValue(method.returnType)
            }
        }
        val reads = CopyOnWriteArrayList<ItemKey>()
        val effectiveData = EffectiveItemDataResolver(
            PdcFallbackReader { _, key, _ ->
                reads += key
                PdcFallbackRead.Value(NamespacedKeyDataValue(ItemKey.parse("example:rare")))
            },
        )
        val publisher = publisher(
            catalog = catalog,
            bridge = bridge,
            projection = projection,
            effectiveItemData = effectiveData,
        )
        val viewerId = UUID.randomUUID()
        val viewer = ViewerProjectionSnapshot(
            viewerId = viewerId,
            revision = 1,
            catalogRevision = runtime.domain.revision,
            locale = LocaleId("en_us"),
            theme = null,
            assetProfile = ItemKey.parse("itemerness:vanilla"),
        )
        val snapshot = invokePrivate(
            publisher,
            "placeholderItem",
            stack,
            runtime,
            viewer,
            requireNotNull(projection.catalogHandle(runtime.domain.revision)),
        ) as PlaceholderItemSnapshot

        assertEquals(listOf(ItemKey.parse("legacyitems:quality")), reads)
        assertEquals("Rare", snapshot[quality])
        assertEquals("Harbor Travel Token", snapshot.namePlain)
        publisher.close()
    }

    private fun publisher(
        plugin: Plugin = plugin(proxy { _, method, _ -> defaultValue(method.returnType) }),
        binding: ProjectionViewerBindingAdapter? = null,
        projection: ProjectionStateStore = ProjectionStateStore(),
        resyncRequests: BoundedProjectionResyncQueue = BoundedProjectionResyncQueue(),
        catalog: RuntimeCatalogManager = RuntimeCatalogManager(directory),
        bridge: BukkitCanonicalItemBridge = proxy { _, method, _ -> defaultValue(method.returnType) },
        placeholders: PlaceholderSnapshotStore = PlaceholderSnapshotStore(),
        effectiveItemData: EffectiveItemDataResolver = EffectiveItemDataResolver(),
    ): ViewerStatePublisher = ViewerStatePublisher(
        plugin = plugin,
        scheduler = FoliaScheduler(plugin),
        catalog = catalog,
        bridge = bridge,
        projection = projection,
        placeholders = placeholders,
        resyncRequests = resyncRequests,
        viewerFacts = ViewerFactStore(),
        viewerBinding = binding,
        effectiveItemData = effectiveItemData,
    )

    private fun beginSession(
        publisher: ViewerStatePublisher,
        player: Player,
    ): Any = invokePrivate(publisher, "beginSessionOwned", player)!!

    private fun bind(
        publisher: ViewerStatePublisher,
        session: Any,
        player: Player,
    ): Boolean = invokePrivate(publisher, "bind", session, player) as Boolean

    private fun retire(
        publisher: ViewerStatePublisher,
        session: Any,
        unbind: Boolean,
    ) {
        invokePrivate(publisher, "retire", session, unbind)
    }

    private fun pumpResyncRequests(publisher: ViewerStatePublisher) {
        invokePrivate(publisher, "pumpResyncRequests")
    }

    private fun enqueueHeartbeatCaptures(publisher: ViewerStatePublisher) {
        invokePrivate(publisher, "enqueueHeartbeatCaptures")
    }

    private fun pumpHeartbeatCaptures(publisher: ViewerStatePublisher) {
        invokePrivate(publisher, "pumpHeartbeatCaptures")
    }

    private fun globalCaptureQueueSize(publisher: ViewerStatePublisher): Int {
        val field = publisher.javaClass.getDeclaredField("globalCaptureQueue")
        field.isAccessible = true
        return (field.get(publisher) as Collection<*>).size
    }

    private fun isGloballyQueued(
        publisher: ViewerStatePublisher,
        viewerId: UUID,
    ): Boolean {
        val field = publisher.javaClass.getDeclaredField("globallyQueuedCaptures")
        field.isAccessible = true
        return viewerId in (field.get(publisher) as Map<*, *>)
    }

    private fun enqueueGlobalResync(
        publisher: ViewerStatePublisher,
        viewerId: UUID,
    ) {
        val intentType = publisher.javaClass.declaredClasses.single { type -> type.simpleName == "CaptureIntent" }
        val resync = intentType.enumConstants.single { value -> (value as Enum<*>).name == "RESYNC" }
        invokePrivate(publisher, "enqueueGlobalCapture", viewerId, resync)
    }

    private fun installBundledResources() {
        copyResource("config.yml")
        val paths = checkNotNull(javaClass.classLoader.getResourceAsStream("itemerness-resources.txt"))
            .bufferedReader(Charsets.UTF_8)
            .useLines { lines ->
                lines.map(String::trim).filter { it.isNotEmpty() && !it.startsWith('#') }.toList()
            }
        paths.forEach(::copyResource)
    }

    private fun copyResource(path: String) {
        val destination = directory.resolve(path)
        Files.createDirectories(destination.parent)
        checkNotNull(javaClass.classLoader.getResourceAsStream(path)).use { input ->
            Files.copy(input, destination, StandardCopyOption.REPLACE_EXISTING)
        }
    }

    private fun invokePrivate(
        target: Any,
        name: String,
        vararg arguments: Any,
    ): Any? {
        val method = target.javaClass.declaredMethods.single { candidate ->
            candidate.name == name && candidate.parameterCount == arguments.size
        }
        method.isAccessible = true
        return try {
            method.invoke(target, *arguments)
        } catch (failure: InvocationTargetException) {
            throw failure.targetException
        }
    }

    private class BlockingBinding : ProjectionViewerBindingAdapter {
        val current = ConcurrentHashMap<UUID, Any>()
        val unbindEntered = CountDownLatch(1)
        val releaseUnbind = CountDownLatch(1)
        private val blockFirstUnbind = AtomicBoolean(true)

        override fun bindViewer(viewerId: UUID, owningPlayer: Any) {
            current[viewerId] = owningPlayer
        }

        override fun unbindViewer(viewerId: UUID) {
            if (blockFirstUnbind.compareAndSet(true, false)) {
                unbindEntered.countDown()
                assertTrue(releaseUnbind.await(2, TimeUnit.SECONDS))
            }
            current.remove(viewerId)
        }
    }

    private class ControlledEntityScheduler {
        val submissions = AtomicInteger()
        private val actions = ArrayDeque<() -> Unit>()
        private val task = proxy<ScheduledTask> { proxy, method, arguments ->
            when (method.name) {
                "equals" -> proxy === arguments?.singleOrNull()
                "hashCode" -> System.identityHashCode(proxy)
                else -> defaultValue(method.returnType)
            }
        }
        val scheduler = proxy<EntityScheduler> { _, method, arguments ->
            when (method.name) {
                "runDelayed" -> {
                    submissions.incrementAndGet()
                    @Suppress("UNCHECKED_CAST")
                    val action = arguments?.get(1) as Consumer<ScheduledTask>
                    actions.addLast { action.accept(task) }
                    task
                }
                else -> defaultValue(method.returnType)
            }
        }

        fun runNext() {
            check(actions.isNotEmpty()) { "No entity task is pending" }
            actions.removeFirst().invoke()
        }
    }

    private class RejectOnceEntityScheduler {
        val submissions = AtomicInteger()
        private val actions = ArrayDeque<() -> Unit>()
        private val task = proxy<ScheduledTask> { proxy, method, arguments ->
            when (method.name) {
                "equals" -> proxy === arguments?.singleOrNull()
                "hashCode" -> System.identityHashCode(proxy)
                else -> defaultValue(method.returnType)
            }
        }
        val scheduler = proxy<EntityScheduler> { _, method, arguments ->
            when (method.name) {
                "runDelayed" -> {
                    if (submissions.incrementAndGet() == 1) {
                        null
                    } else {
                        @Suppress("UNCHECKED_CAST")
                        val action = arguments?.get(1) as Consumer<ScheduledTask>
                        actions.addLast { action.accept(task) }
                        task
                    }
                }
                else -> defaultValue(method.returnType)
            }
        }

        fun runNext() {
            check(actions.isNotEmpty()) { "No accepted entity task is pending" }
            actions.removeFirst().invoke()
        }
    }
}

private fun plugin(server: Server): Plugin = proxy { proxy, method, arguments ->
    when (method.name) {
        "getServer" -> server
        "getName" -> "ViewerStatePublisherTest"
        "isEnabled" -> true
        "equals" -> proxy === arguments?.singleOrNull()
        "hashCode" -> System.identityHashCode(proxy)
        "toString" -> "ViewerStatePublisherTestPlugin"
        else -> defaultValue(method.returnType)
    }
}

private fun player(
    viewerId: UUID,
    scheduled: AtomicInteger = AtomicInteger(),
    entityId: Int = 1,
    schedulerOverride: EntityScheduler? = null,
    inventory: PlayerInventory? = null,
    inventoryUpdates: AtomicInteger = AtomicInteger(),
): Player {
    val task = proxy<ScheduledTask> { proxy, method, arguments ->
        when (method.name) {
            "equals" -> proxy === arguments?.singleOrNull()
            "hashCode" -> System.identityHashCode(proxy)
            "toString" -> "ViewerStatePublisherTestTask"
            else -> defaultValue(method.returnType)
        }
    }
    val scheduler = schedulerOverride ?: proxy<EntityScheduler> { _, method, _ ->
        when (method.name) {
            "run", "runDelayed", "runAtFixedRate" -> {
                scheduled.incrementAndGet()
                task
            }
            "execute" -> {
                scheduled.incrementAndGet()
                true
            }
            else -> defaultValue(method.returnType)
        }
    }
    return proxy { proxy, method, arguments ->
        when (method.name) {
            "getUniqueId" -> viewerId
            "getEntityId" -> entityId
            "getScheduler" -> scheduler
            "getInventory" -> inventory
            "updateInventory" -> {
                inventoryUpdates.incrementAndGet()
                null
            }
            "locale" -> Locale.US
            "isOnline" -> true
            "equals" -> proxy === arguments?.singleOrNull()
            "hashCode" -> System.identityHashCode(proxy)
            "toString" -> "ViewerStatePublisherTestPlayer($viewerId)"
            else -> defaultValue(method.returnType)
        }
    }
}

private fun inventory(
    mainHand: ItemStack,
    offHand: ItemStack,
): PlayerInventory = proxy { _, method, _ ->
    when (method.name) {
        "getItemInMainHand" -> mainHand
        "getItemInOffHand" -> offHand
        else -> defaultValue(method.returnType)
    }
}

@Suppress("DEPRECATION")
private class TestItemStack(
    val failInspection: Boolean,
    val canonical: CanonicalItemSnapshot? = null,
) : ItemStack() {
    override fun getType(): Material = Material.STONE

    public override fun clone(): TestItemStack = TestItemStack(failInspection, canonical)
}

private fun ItemDataValue.toProjectionValue(): ProjectionValue = when (this) {
    is BooleanDataValue -> BooleanProjectionValue(value)
    is IntegerDataValue -> IntegerProjectionValue(value)
    is LongDataValue -> LongProjectionValue(value)
    is DecimalDataValue -> DecimalProjectionValue(java.math.BigDecimal.valueOf(value))
    is StringDataValue -> StringProjectionValue(value)
    is UuidDataValue -> UuidProjectionValue(value)
    is NamespacedKeyDataValue -> KeyProjectionValue(value)
    is ListDataValue -> ListProjectionValue(values.map(ItemDataValue::toProjectionValue))
    is CompoundDataValue -> ProjectionCompound(
        entries.map { (key, value) -> ProjectionCompound.Entry(key, value.toProjectionValue()) },
    )
}

private inline fun <reified T> proxy(
    crossinline handler: (Any, java.lang.reflect.Method, Array<out Any?>?) -> Any?,
): T = Proxy.newProxyInstance(
    T::class.java.classLoader,
    arrayOf(T::class.java),
) { instance, method, arguments -> handler(instance, method, arguments) } as T

private fun defaultValue(type: Class<*>): Any? = when (type) {
    java.lang.Boolean.TYPE -> false
    java.lang.Byte.TYPE -> 0.toByte()
    java.lang.Short.TYPE -> 0.toShort()
    java.lang.Integer.TYPE -> 0
    java.lang.Long.TYPE -> 0L
    java.lang.Float.TYPE -> 0F
    java.lang.Double.TYPE -> 0.0
    java.lang.Character.TYPE -> '\u0000'
    java.lang.Void.TYPE -> null
    else -> null
}
