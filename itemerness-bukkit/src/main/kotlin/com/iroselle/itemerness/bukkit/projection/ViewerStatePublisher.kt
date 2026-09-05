package com.iroselle.itemerness.bukkit.projection

import com.iroselle.itemerness.api.ApiAction
import com.iroselle.itemerness.bukkit.access.AccessDecision
import com.iroselle.itemerness.api.BooleanDataValue
import com.iroselle.itemerness.api.CompoundDataValue
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
import com.iroselle.itemerness.bukkit.api.EffectiveItemDataResult
import com.iroselle.itemerness.bukkit.catalog.CanonicalDomainMapper
import com.iroselle.itemerness.bukkit.catalog.CanonicalDomainResult
import com.iroselle.itemerness.bukkit.catalog.RuntimeCatalogManager
import com.iroselle.itemerness.bukkit.catalog.RuntimeCatalogSnapshot
import com.iroselle.itemerness.bukkit.placeholder.PlaceholderItemSnapshot
import com.iroselle.itemerness.bukkit.placeholder.PlaceholderSnapshotStore
import com.iroselle.itemerness.bukkit.placeholder.PlaceholderViewerSnapshot
import com.iroselle.itemerness.bukkit.spi.BukkitCanonicalItemBridge
import com.iroselle.itemerness.bukkit.spi.CanonicalItemInspection
import com.iroselle.itemerness.core.presentation.ViewerFactResolver
import com.iroselle.itemerness.core.presentation.ViewerFactStore
import com.iroselle.itemerness.core.presentation.ApiViewerFactSnapshot
import com.iroselle.itemerness.projection.BooleanProjectionValue
import com.iroselle.itemerness.projection.BoundedProjectionResyncQueue
import com.iroselle.itemerness.projection.DecimalProjectionValue
import com.iroselle.itemerness.projection.IntegerProjectionValue
import com.iroselle.itemerness.projection.KeyProjectionValue
import com.iroselle.itemerness.projection.LongProjectionValue
import com.iroselle.itemerness.projection.LocaleId
import com.iroselle.itemerness.projection.ProjectionResult
import com.iroselle.itemerness.projection.ProjectionCatalogHandle
import com.iroselle.itemerness.projection.ProjectionViewerBindingAdapter
import com.iroselle.itemerness.projection.StringProjectionValue
import com.iroselle.itemerness.projection.UuidProjectionValue
import com.iroselle.itemerness.projection.ViewerFact
import com.iroselle.itemerness.projection.ViewerProjectionSnapshot
import io.papermc.paper.threadedregions.scheduler.ScheduledTask
import java.util.ArrayDeque
import java.util.HashMap
import java.util.Locale
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong
import org.bukkit.Material
import org.bukkit.entity.Player
import org.bukkit.event.EventHandler
import org.bukkit.event.EventPriority
import org.bukkit.event.HandlerList
import org.bukkit.event.Listener
import org.bukkit.event.entity.EntityPickupItemEvent
import org.bukkit.event.entity.PlayerDeathEvent
import org.bukkit.event.inventory.InventoryClickEvent
import org.bukkit.event.inventory.InventoryDragEvent
import org.bukkit.event.player.PlayerDropItemEvent
import org.bukkit.event.player.PlayerItemConsumeEvent
import org.bukkit.event.player.PlayerItemHeldEvent
import org.bukkit.event.player.PlayerJoinEvent
import org.bukkit.event.player.PlayerLocaleChangeEvent
import org.bukkit.event.player.PlayerQuitEvent
import org.bukkit.event.player.PlayerResourcePackStatusEvent
import org.bukkit.event.player.PlayerRespawnEvent
import org.bukkit.event.player.PlayerSwapHandItemsEvent
import org.bukkit.inventory.ItemStack
import org.bukkit.packs.ResourcePack
import org.bukkit.plugin.Plugin

/** Captures Bukkit state only in the player's owning context and publishes immutable readers. */
internal class ViewerStatePublisher(
    private val plugin: Plugin,
    private val scheduler: FoliaScheduler,
    private val catalog: RuntimeCatalogManager,
    private val bridge: BukkitCanonicalItemBridge,
    private val projection: ProjectionStateStore,
    private val placeholders: PlaceholderSnapshotStore,
    private val resyncRequests: BoundedProjectionResyncQueue,
    private val viewerFacts: ViewerFactStore,
    private val viewerBinding: ProjectionViewerBindingAdapter? = null,
    private val projectionRefresh: (Player) -> Unit = {},
    private val effectiveItemData: EffectiveItemDataResolver = EffectiveItemDataResolver(),
) : Listener,
    AutoCloseable {
    private val revisions = ConcurrentHashMap<UUID, AtomicLong>()
    private val packs = ConcurrentHashMap<UUID, PackState>()
    private val sessions = ConcurrentHashMap<UUID, ViewerSession>()
    private val captureAdmissions = ConcurrentHashMap<UUID, CaptureAdmission>()
    private val sessionLock = Any()
    private val globalCaptureQueueLock = Any()
    private val globalCaptureQueue = ArrayDeque<UUID>()
    private val globallyQueuedCaptures = HashMap<UUID, CaptureIntent>()
    private var heartbeatCursor = 0
    private var heartbeat: ScheduledTask? = null
    private var heartbeatPump: ScheduledTask? = null
    private var resyncPump: ScheduledTask? = null
    @Volatile
    private var started = false

    @Volatile
    private var closed = false

    fun start() {
        synchronized(sessionLock) {
            check(!closed) { "Viewer state publisher is closed" }
            if (started) return
            started = true
        }
        plugin.server.pluginManager.registerEvents(this, plugin)
        heartbeat = checkNotNull(scheduler.repeatGlobal(
            initialDelayTicks = HEARTBEAT_TICKS,
            periodTicks = HEARTBEAT_TICKS,
            action = ::enqueueHeartbeatCaptures,
        )) { "The viewer heartbeat scheduler rejected registration" }
        heartbeatPump = checkNotNull(scheduler.repeatGlobal(
            initialDelayTicks = 1,
            periodTicks = 1,
            action = ::pumpHeartbeatCaptures,
        )) { "The viewer heartbeat pump scheduler rejected registration" }
        resyncPump = checkNotNull(scheduler.repeatGlobal(
            initialDelayTicks = 1,
            periodTicks = 1,
            action = ::pumpResyncRequests,
        )) { "The projection resync scheduler rejected registration" }
        checkNotNull(scheduler.runGlobal(::enqueueHeartbeatCaptures)) {
            "The initial viewer capture scheduler rejected registration"
        }
    }

    fun capture(
        player: Player,
        refreshIfChanged: Boolean = true,
    ): Boolean {
        var session = sessions[player.uniqueId]
        return try {
            session = session ?: beginSessionOwned(player) ?: return false
            capture(checkNotNull(session), player, refreshIfChanged)
        } catch (failure: Throwable) {
            if (failure.isFatalCaptureFailure()) throw failure
            session?.let { leased -> retireWithoutFailure(leased, unbind = true) }
            false
        }
    }

    private fun capture(
        session: ViewerSession,
        player: Player,
        refreshIfChanged: Boolean,
    ): Boolean {
        if (session.entityId != player.entityId || sessions[session.viewerId] !== session) return false
        if (!bind(session, player)) return false
        val captureState = catalog.withCurrentSnapshot { runtime ->
            projection.catalogHandle(runtime.domain.revision)?.let { catalogHandle ->
                ViewerCaptureState(
                    runtime = runtime,
                    catalogHandle = catalogHandle,
                    apiFacts = viewerFacts.snapshot(player.uniqueId),
                )
            }
        } ?: run {
            retire(session, unbind = true)
            return false
        }
        val runtime = captureState.runtime
        val clientLocale = normalizeLocale(player.locale())
        val pack = packs[player.uniqueId]
        val bukkitProfile = pack?.takeIf { it.loaded }
            ?.let { loadedPack ->
                loadedPack.verifiedSha1
                    ?.let { sha1 ->
                        projection.matchAssetProfile(captureState.catalogHandle, loadedPack.id, sha1)
                    }
                    // Dynamic pack status events expose the pushed UUID but not its hash. An
                    // enabled local binding is the explicit trust declaration for that UUID.
                    ?: projection.matchAssetProfileByPackId(captureState.catalogHandle, loadedPack.id)
            }
            ?: VANILLA_PROFILE
        val resolvedFacts = ViewerFactResolver.resolve(
            runtime.presentation,
            mapOf(
                API_PROVIDER to captureState.apiFacts.values,
                CLIENT_PROVIDER to mapOf(LOCALE_FACT to StringDataValue(clientLocale)),
                BUKKIT_RESOURCE_PACK_PROVIDER to mapOf(
                    // Pack presence and advanced profile capabilities are separate. Basic icon
                    // glyphs need only a successfully loaded pack, while custom renderers still
                    // require the exact profile resolved above.
                    RESOURCE_PACK_FACT to BooleanDataValue(pack?.loaded == true),
                    ASSET_PROFILE_FACT to NamespacedKeyDataValue(bukkitProfile),
                ),
            ),
        )
        val locale = (resolvedFacts[LOCALE_FACT] as? StringDataValue)?.value
            ?: runtime.presentation.defaultLocale
        val theme = (resolvedFacts[THEME_FACT] as? NamespacedKeyDataValue)?.value
        val profile = (resolvedFacts[ASSET_PROFILE_FACT] as? NamespacedKeyDataValue)?.value
            ?: VANILLA_PROFILE
        val revisionCounter = revisions.computeIfAbsent(player.uniqueId) { AtomicLong() }
        val previous = projection.viewer(player.uniqueId)
        previous?.let { snapshot ->
            revisionCounter.accumulateAndGet(snapshot.revision) { current, published -> maxOf(current, published) }
        }
        val candidateRevision = previous?.revision ?: revisionCounter.incrementAndGet()
        var viewer = ViewerProjectionSnapshot(
            viewerId = player.uniqueId,
            revision = candidateRevision,
            catalogRevision = runtime.domain.revision,
            locale = LocaleId(locale),
            theme = theme,
            assetProfile = profile,
            facts = resolvedFacts.map { (key, value) -> ViewerFact(key, value.toProjectionFact()) },
            capabilities = projection.capabilities(captureState.catalogHandle, profile),
        )
        val semanticChanged = previous == null || viewer != previous
        if (semanticChanged) {
            val nextRevision = if (previous == null) candidateRevision else revisionCounter.incrementAndGet()
            if (nextRevision != candidateRevision) {
                viewer = ViewerProjectionSnapshot(
                    viewerId = viewer.viewerId,
                    revision = nextRevision,
                    catalogRevision = viewer.catalogRevision,
                    locale = viewer.locale,
                    theme = viewer.theme,
                    assetProfile = viewer.assetProfile,
                    facts = viewer.facts,
                    capabilities = viewer.capabilities,
                )
            }
        } else {
            viewer = previous
        }
        val placeholderSnapshot = PlaceholderViewerSnapshot(
            viewerId = player.uniqueId,
            catalogRevision = runtime.domain.revision,
            locale = viewer.locale,
            theme = viewer.theme ?: runtime.settings.defaultTheme,
            assetProfile = viewer.assetProfile,
            mainHand = capturePlaceholderItem(
                source = { player.inventory.itemInMainHand.clone() },
                runtime = runtime,
                viewer = viewer,
                retainedCatalog = captureState.catalogHandle,
            ),
            offHand = capturePlaceholderItem(
                source = { player.inventory.itemInOffHand.clone() },
                runtime = runtime,
                viewer = viewer,
                retainedCatalog = captureState.catalogHandle,
            ),
        )
        val published = synchronized(sessionLock) {
            if (closed || sessions[player.uniqueId] !== session) return false
            projection.publishViewer(viewer, captureState.catalogHandle)
            placeholders.publish(placeholderSnapshot)
            true
        }
        if (published && semanticChanged && refreshIfChanged && sessions[player.uniqueId] === session) {
            projectionRefresh(player)
        }
        return semanticChanged
    }

    fun scheduleCapture(player: Player) {
        enqueueGlobalCapture(player.uniqueId, CaptureIntent.NORMAL)
    }

    private fun submitCapture(
        player: Player,
        intent: CaptureIntent,
    ): CaptureSubmission {
        if (closed) return CaptureSubmission.REJECTED
        val viewerId = player.uniqueId
        val admission = CaptureAdmission()
        if (captureAdmissions.putIfAbsent(viewerId, admission) != null) {
            return CaptureSubmission.BUSY
        }
        if (closed) {
            captureAdmissions.remove(viewerId, admission)
            return CaptureSubmission.REJECTED
        }
        val expected = sessions[viewerId]
        val task = try {
            scheduler.runForEntityDelayed(player, delayTicks = 1, retired = {
                try {
                    expected?.let { session -> retireWithoutFailure(session, unbind = false) }
                } finally {
                    captureAdmissions.remove(viewerId, admission)
                }
            }) {
                var leasedSession: ViewerSession? = null
                try {
                    val current = sessions[viewerId]
                    val session = when {
                        expected != null && current !== expected -> return@runForEntityDelayed
                        current != null -> current
                        else -> beginSessionOwned(player) ?: return@runForEntityDelayed
                    }
                    leasedSession = session
                    capture(session, player, refreshIfChanged = intent == CaptureIntent.NORMAL)
                    if (intent == CaptureIntent.RESYNC && !closed && sessions[viewerId] === session) {
                        player.updateInventory()
                    }
                } catch (failure: Throwable) {
                    if (failure.isFatalCaptureFailure()) throw failure
                    // Unexpected viewer-local capture failures retire only this lease. Item-local
                    // bridge and rendering failures are handled below as absent placeholders, so a
                    // corrupt held item never enters an immediate retry loop.
                    leasedSession?.let { session -> retireWithoutFailure(session, unbind = true) }
                    removeGlobalCapture(viewerId)
                } finally {
                    captureAdmissions.remove(viewerId, admission)
                }
            }
        } catch (failure: Throwable) {
            captureAdmissions.remove(viewerId, admission)
            expected?.let { session -> retireWithoutFailure(session, unbind = false) }
            if (failure.isFatalCaptureFailure()) throw failure
            return CaptureSubmission.REJECTED
        }
        if (task == null) {
            captureAdmissions.remove(viewerId, admission)
            return CaptureSubmission.REJECTED
        }
        return CaptureSubmission.SUBMITTED
    }

    /** Revalidates retained API contributions against an atomically published catalog. */
    fun catalogPublished(runtime: RuntimeCatalogSnapshot) {
        viewerFacts.reconcile(runtime.presentation) { owner, key ->
            runtime.accessPolicy.decide(
                callerPluginName = owner,
                action = ApiAction.WRITE_VIEWER_FACT,
                itemNamespace = key.namespace,
            ) == AccessDecision.ALLOW
        }
    }

    @EventHandler(priority = EventPriority.MONITOR)
    fun onJoin(event: PlayerJoinEvent) {
        beginSessionOwned(event.player)?.let { session -> bind(session, event.player) }
        scheduleCapture(event.player)
    }

    @EventHandler(priority = EventPriority.MONITOR)
    fun onQuit(event: PlayerQuitEvent) {
        sessions[event.player.uniqueId]
            ?.takeIf { session -> session.entityId == event.player.entityId }
            ?.let { session -> retire(session, unbind = true) }
    }

    @EventHandler(priority = EventPriority.MONITOR)
    fun onLocaleChange(event: PlayerLocaleChangeEvent) = scheduleCapture(event.player)

    @EventHandler(priority = EventPriority.MONITOR)
    fun onHeldSlot(event: PlayerItemHeldEvent) = scheduleCapture(event.player)

    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
    fun onSwapHands(event: PlayerSwapHandItemsEvent) = scheduleCapture(event.player)

    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
    fun onConsume(event: PlayerItemConsumeEvent) = scheduleCapture(event.player)

    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
    fun onDrop(event: PlayerDropItemEvent) = scheduleCapture(event.player)

    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
    fun onPickup(event: EntityPickupItemEvent) {
        (event.entity as? Player)?.let(::scheduleCapture)
    }

    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
    fun onInventoryClick(event: InventoryClickEvent) {
        (event.whoClicked as? Player)?.let(::scheduleCapture)
    }

    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
    fun onInventoryDrag(event: InventoryDragEvent) {
        (event.whoClicked as? Player)?.let(::scheduleCapture)
    }

    @EventHandler(priority = EventPriority.MONITOR)
    fun onDeath(event: PlayerDeathEvent) = scheduleCapture(event.player)

    @EventHandler(priority = EventPriority.MONITOR)
    fun onRespawn(event: PlayerRespawnEvent) = scheduleCapture(event.player)

    @EventHandler(priority = EventPriority.MONITOR)
    fun onResourcePack(event: PlayerResourcePackStatusEvent) {
        synchronized(sessionLock) {
            if (closed || sessions[event.player.uniqueId]?.entityId != event.player.entityId) return
            packs[event.player.uniqueId] = PackState(
                id = event.id,
                loaded = event.status == PlayerResourcePackStatusEvent.Status.SUCCESSFULLY_LOADED,
                verifiedSha1 = trustedServerPackSha1(plugin.server.serverResourcePack, event.id),
            )
        }
        scheduleCapture(event.player)
    }

    override fun close() {
        val retiredSessions = synchronized(sessionLock) {
            if (closed) return
            closed = true
            val active = sessions.values.toList()
            sessions.clear()
            active.map { session ->
                val wasBound = session.bound
                session.bound = false
                session to wasBound
            }
        }
        var primaryFailure: Throwable? = null
        fun cleanup(action: () -> Unit) {
            try {
                action()
            } catch (failure: Throwable) {
                val previous = primaryFailure
                if (previous == null) primaryFailure = failure
                else if (failure !== previous) previous.addSuppressed(failure)
            }
        }
        if (started) {
            cleanup { HandlerList.unregisterAll(this) }
            started = false
        }
        heartbeat?.let { task -> cleanup(task::cancel) }
        heartbeat = null
        heartbeatPump?.let { task -> cleanup(task::cancel) }
        heartbeatPump = null
        resyncPump?.let { task -> cleanup(task::cancel) }
        resyncPump = null
        captureAdmissions.clear()
        synchronized(globalCaptureQueueLock) {
            globalCaptureQueue.clear()
            globallyQueuedCaptures.clear()
            heartbeatCursor = 0
        }
        retiredSessions.filter { (_, wasBound) -> wasBound }.forEach { (session, _) ->
            cleanup {
                viewerBinding?.unbindViewer(session.viewerId)
            }
        }
        revisions.clear()
        packs.clear()
        retiredSessions.forEach { (session, _) ->
            cleanup { viewerFacts.clearViewer(session.viewerId) }
        }
        cleanup(placeholders::clear)
        cleanup(projection::clear)
        primaryFailure?.let { throw it }
    }

    private fun placeholderItem(
        source: ItemStack,
        runtime: RuntimeCatalogSnapshot,
        viewer: ViewerProjectionSnapshot,
        retainedCatalog: ProjectionCatalogHandle,
    ): PlaceholderItemSnapshot {
        if (source.type == Material.AIR) return PlaceholderItemSnapshot.absent()
        val inspection = bridge.inspect(source) as? CanonicalItemInspection.Managed
            ?: return PlaceholderItemSnapshot.absent()
        val restored = CanonicalDomainMapper.restore(inspection.snapshot, runtime) as? CanonicalDomainResult.Valid
            ?: return PlaceholderItemSnapshot.absent()
        val values = when (val resolved = effectiveItemData.resolveAll(source, runtime, restored)) {
            is EffectiveItemDataResult.Invalid -> error(resolved.reason)
            is EffectiveItemDataResult.Valid -> resolved.data
        }
        val exposed = runtime.source.dataKeyIntegrations.entries.mapNotNull { (key, integration) ->
            if (!integration.placeholderExposed || integration.readAccess != com.iroselle.itemerness.bukkit.catalog.DataReadAccess.PUBLIC) {
                return@mapNotNull null
            }
            val value = values[com.iroselle.itemerness.api.DataKey(key)] ?: return@mapNotNull null
            if (value is ListDataValue || value is CompoundDataValue) return@mapNotNull null
            val formatted = projection.formatValue(
                retainedCatalog,
                value,
                integration.placeholderFormatter,
                viewer.locale.value,
            ).getOrNull() ?: return@mapNotNull null
            com.iroselle.itemerness.api.DataKey(key) to formatted
        }.toMap()
        val name = when (
            val rendered = projection.render(
                viewer,
                inspection.snapshot,
                retainedCatalog,
                values,
            )
        ) {
            is ProjectionResult.Rendered -> rendered.display.displayName.runs.joinToString("") { it.text }
            is ProjectionResult.Fallback -> null
        }
        return PlaceholderItemSnapshot(
            present = true,
            id = restored.definition.key,
            instanceId = restored.instance.instanceId,
            namePlain = name,
            exposedData = exposed,
        )
    }

    /**
     * Placeholder data is optional derived state. A bridge, formatter, or renderer failure for one
     * hand therefore fails closed to an absent item without retiring the viewer lease or retrying.
     * The other hand and other viewers are still captured independently.
     */
    private fun capturePlaceholderItem(
        source: () -> ItemStack,
        runtime: RuntimeCatalogSnapshot,
        viewer: ViewerProjectionSnapshot,
        retainedCatalog: ProjectionCatalogHandle,
    ): PlaceholderItemSnapshot = try {
        placeholderItem(source(), runtime, viewer, retainedCatalog)
    } catch (failure: Throwable) {
        if (failure.isFatalCaptureFailure()) throw failure
        PlaceholderItemSnapshot.absent()
    }

    /** Adds one UUID-only heartbeat request; mutable Player objects never cross global ticks. */
    private fun enqueueGlobalCapture(
        viewerId: UUID,
        intent: CaptureIntent,
    ): GlobalQueueAdmission {
        if (closed) return GlobalQueueAdmission.CLOSED
        synchronized(globalCaptureQueueLock) {
            if (closed) return GlobalQueueAdmission.CLOSED
            val current = globallyQueuedCaptures[viewerId]
            if (current != null) {
                if (intent == CaptureIntent.RESYNC && current != CaptureIntent.RESYNC) {
                    globallyQueuedCaptures[viewerId] = CaptureIntent.RESYNC
                }
                return GlobalQueueAdmission.MERGED
            }
            if (globalCaptureQueue.size >= MAX_GLOBAL_CAPTURE_QUEUE) {
                if (intent != CaptureIntent.RESYNC || !evictNormalGlobalCapture()) {
                    return GlobalQueueAdmission.FULL
                }
            }
            globallyQueuedCaptures[viewerId] = intent
            globalCaptureQueue.addLast(viewerId)
            return GlobalQueueAdmission.ADDED
        }
    }

    private fun evictNormalGlobalCapture(): Boolean {
        val descending = globalCaptureQueue.descendingIterator()
        while (descending.hasNext()) {
            val candidate = descending.next()
            if (globallyQueuedCaptures[candidate] == CaptureIntent.NORMAL) {
                descending.remove()
                globallyQueuedCaptures.remove(candidate)
                return true
            }
        }
        return false
    }

    private fun removeGlobalCapture(viewerId: UUID) {
        synchronized(globalCaptureQueueLock) {
            if (globallyQueuedCaptures.remove(viewerId) == null) return
            globalCaptureQueue.remove(viewerId)
        }
    }

    private fun enqueueHeartbeatCaptures() {
        if (closed) return
        val viewerIds = plugin.server.onlinePlayers.map(Player::getUniqueId)
        if (viewerIds.isEmpty()) {
            heartbeatCursor = 0
            return
        }
        val start = Math.floorMod(heartbeatCursor, viewerIds.size)
        var visited = 0
        while (visited < viewerIds.size) {
            val viewerId = viewerIds[(start + visited) % viewerIds.size]
            visited += 1
            if (enqueueGlobalCapture(viewerId, CaptureIntent.NORMAL) == GlobalQueueAdmission.FULL) break
        }
        heartbeatCursor = (start + visited) % viewerIds.size
    }

    /**
     * Submits a fixed number of entity tasks per global tick. Busy viewers rotate to the tail, so
     * a continuously busy UUID cannot starve the rest of the online population.
     */
    private fun pumpHeartbeatCaptures() {
        if (closed) return
        val ready = ArrayList<QueuedCapture>(MAX_HEARTBEAT_VIEWERS_PER_TICK)
        synchronized(globalCaptureQueueLock) {
            repeat(minOf(MAX_HEARTBEAT_VIEWERS_PER_TICK, globalCaptureQueue.size)) {
                val viewerId = globalCaptureQueue.removeFirst()
                val intent = checkNotNull(globallyQueuedCaptures.remove(viewerId))
                ready += QueuedCapture(viewerId, intent)
            }
        }
        ready.forEach { request ->
            val player = plugin.server.getPlayer(request.viewerId) ?: return@forEach
            when (submitCapture(player, request.intent)) {
                CaptureSubmission.SUBMITTED -> Unit
                CaptureSubmission.BUSY -> enqueueGlobalCapture(request.viewerId, request.intent)
                CaptureSubmission.REJECTED -> if (request.intent == CaptureIntent.RESYNC && !closed) {
                    enqueueGlobalCapture(request.viewerId, CaptureIntent.RESYNC)
                }
            }
        }
    }

    private fun pumpResyncRequests() {
        if (closed) return
        resyncRequests.pollReadyViewers(MAX_RESYNC_VIEWERS_PER_TICK).forEach { viewerId ->
            when (enqueueGlobalCapture(viewerId, CaptureIntent.RESYNC)) {
                GlobalQueueAdmission.ADDED,
                GlobalQueueAdmission.MERGED,
                -> resyncRequests.drain(viewerId)

                GlobalQueueAdmission.FULL,
                GlobalQueueAdmission.CLOSED,
                -> resyncRequests.retryReady(viewerId)
            }
        }
    }

    private fun beginSessionOwned(player: Player): ViewerSession? = synchronized(sessionLock) {
        if (closed) return null
        val viewerId = player.uniqueId
        val session = ViewerSession(viewerId, player.entityId)
        val previous = sessions.remove(viewerId)
        if (previous?.bound == true) {
            previous.bound = false
            viewerBinding?.unbindViewer(viewerId)
        }
        clearPublishedState(viewerId)
        sessions[viewerId] = session
        session
    }

    private fun bind(
        session: ViewerSession,
        player: Player,
    ): Boolean = synchronized(sessionLock) {
        if (closed || sessions[session.viewerId] !== session || session.entityId != player.entityId) return false
        if (session.bound) return true
        session.bound = true
        try {
            viewerBinding?.bindViewer(session.viewerId, player)
            true
        } catch (failure: Throwable) {
            try {
                viewerBinding?.unbindViewer(session.viewerId)
            } catch (cleanupFailure: Throwable) {
                if (cleanupFailure !== failure) failure.addSuppressed(cleanupFailure)
            } finally {
                session.bound = false
            }
            throw failure
        }
    }

    private fun retire(
        session: ViewerSession,
        unbind: Boolean,
    ) {
        synchronized(sessionLock) {
            if (!sessions.remove(session.viewerId, session)) return@synchronized
            var primaryFailure: Throwable? = null
            if (unbind && session.bound) {
                session.bound = false
                try {
                    viewerBinding?.unbindViewer(session.viewerId)
                } catch (failure: Throwable) {
                    primaryFailure = failure
                }
            }
            try {
                clearPublishedState(session.viewerId)
            } catch (failure: Throwable) {
                if (primaryFailure == null) primaryFailure = failure else primaryFailure.addSuppressed(failure)
            }
            primaryFailure?.let { throw it }
        }
    }

    private fun retireWithoutFailure(
        session: ViewerSession,
        unbind: Boolean,
    ) {
        try {
            retire(session, unbind)
        } catch (failure: Throwable) {
            if (failure.isFatalCaptureFailure()) throw failure
            // Retirement is already best-effort on a rejected or failed scheduler boundary. The
            // public close path still preserves and reports cleanup failures.
        }
    }

    private fun clearPublishedState(viewerId: UUID) {
        revisions.remove(viewerId)
        packs.remove(viewerId)
        placeholders.remove(viewerId)
        projection.removeViewer(viewerId)
        viewerFacts.clearViewer(viewerId)
    }

    private data class ViewerCaptureState(
        val runtime: RuntimeCatalogSnapshot,
        val catalogHandle: ProjectionCatalogHandle,
        val apiFacts: ApiViewerFactSnapshot,
    )

    private class CaptureAdmission

    private data class QueuedCapture(
        val viewerId: UUID,
        val intent: CaptureIntent,
    )

    private enum class CaptureIntent {
        NORMAL,
        RESYNC,
    }

    private enum class GlobalQueueAdmission {
        ADDED,
        MERGED,
        FULL,
        CLOSED,
    }

    private enum class CaptureSubmission {
        SUBMITTED,
        BUSY,
        REJECTED,
    }

    private class ViewerSession(
        val viewerId: UUID,
        val entityId: Int,
    ) {
        var bound = false
    }

    private data class PackState(
        val id: UUID,
        val loaded: Boolean,
        val verifiedSha1: String?,
    )

    private companion object {
        const val HEARTBEAT_TICKS = 200L
        const val MAX_HEARTBEAT_VIEWERS_PER_TICK = 64
        const val MAX_GLOBAL_CAPTURE_QUEUE = 4_096
        const val MAX_RESYNC_VIEWERS_PER_TICK = 64
        val VANILLA_PROFILE: ItemKey = ItemKey.parse("itemerness:vanilla")
        val LOCALE_FACT: ItemKey = ItemKey.parse("itemerness:locale")
        val THEME_FACT: ItemKey = ItemKey.parse("itemerness:theme")
        val RESOURCE_PACK_FACT: ItemKey = ItemKey.parse("itemerness:resource-pack-ready")
        val ASSET_PROFILE_FACT: ItemKey = ItemKey.parse("itemerness:asset-profile")
        const val API_PROVIDER = "api"
        const val CLIENT_PROVIDER = "client"
        const val BUKKIT_RESOURCE_PACK_PROVIDER = "bukkit-resource-pack-status"
    }
}

/**
 * Status packets identify a pack but no longer carry its hash. Only the pack configured by the
 * server exposes a hash that this plugin can independently bind to that identifier. Dynamic pack
 * pushes therefore remain on the vanilla profile unless a future trusted source supplies both.
 */
internal fun trustedServerPackSha1(
    configured: ResourcePack?,
    reportedId: UUID,
): String? {
    if (configured?.id != reportedId) return null
    val hash = configured.hash?.lowercase(Locale.ROOT) ?: return null
    return hash.takeIf { it.matches(SHA1_PATTERN) }
}

private fun normalizeLocale(locale: Locale): String =
    locale.toLanguageTag().lowercase(Locale.ROOT).replace('-', '_')

private val SHA1_PATTERN = Regex("[0-9a-f]{40}")

@Suppress("DEPRECATION")
private fun Throwable.isFatalCaptureFailure(): Boolean =
    this is VirtualMachineError || this is ThreadDeath

private fun ItemDataValue.toProjectionFact() = when (this) {
    is BooleanDataValue -> BooleanProjectionValue(value)
    is IntegerDataValue -> IntegerProjectionValue(value)
    is LongDataValue -> LongProjectionValue(value)
    is DecimalDataValue -> DecimalProjectionValue(value.toBigDecimal())
    is StringDataValue -> StringProjectionValue(value)
    is UuidDataValue -> UuidProjectionValue(value)
    is NamespacedKeyDataValue -> KeyProjectionValue(value)
    is ListDataValue,
    is CompoundDataValue,
    -> error("Container values cannot be declared as viewer facts")
}
