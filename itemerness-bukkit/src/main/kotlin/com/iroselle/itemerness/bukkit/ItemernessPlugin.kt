package com.iroselle.itemerness.bukkit

import com.iroselle.itemerness.api.ApiAction
import com.iroselle.itemerness.bukkit.access.AccessDecision
import com.iroselle.itemerness.bukkit.api.BukkitItemernessApi
import com.iroselle.itemerness.bukkit.api.DefaultBukkitItemernessApi
import com.iroselle.itemerness.bukkit.api.PlayerSlotDispatcher
import com.iroselle.itemerness.bukkit.api.RefreshRequestDispatcher
import com.iroselle.itemerness.bukkit.api.ViewerRefreshDispatcher
import com.iroselle.itemerness.bukkit.catalog.PreparedRuntimeCatalogPublication
import com.iroselle.itemerness.bukkit.editor.EditorAgentService
import com.iroselle.itemerness.bukkit.editor.EditorAgentCoordinator
import com.iroselle.itemerness.bukkit.editor.FoliaAgentScheduler
import com.iroselle.itemerness.bukkit.editor.FoliaAsyncExecutor
import com.iroselle.itemerness.bukkit.catalog.RuntimeCatalogManager
import com.iroselle.itemerness.bukkit.catalog.RuntimeCatalogPublication
import com.iroselle.itemerness.bukkit.catalog.RuntimeCatalogUpdate
import com.iroselle.itemerness.bukkit.command.DefaultItemernessCommandActions
import com.iroselle.itemerness.bukkit.command.ItemernessCommands
import com.iroselle.itemerness.bukkit.placeholder.PlaceholderApiIntegration
import com.iroselle.itemerness.bukkit.placeholder.PlaceholderSnapshotStore
import com.iroselle.itemerness.bukkit.projection.ProjectionStateStore
import com.iroselle.itemerness.bukkit.projection.VisibleSurfaceRefreshCoordinator
import com.iroselle.itemerness.bukkit.projection.ViewerStatePublisher
import com.iroselle.itemerness.bukkit.spi.BukkitCanonicalItemBridge
import com.iroselle.itemerness.core.presentation.ViewerFactStore
import com.iroselle.itemerness.projection.BoundedProjectionResyncQueue
import com.iroselle.itemerness.projection.ProjectionAdapter
import com.iroselle.itemerness.projection.ProjectionRefreshAdapter
import com.iroselle.itemerness.projection.ProjectionRuntime
import com.iroselle.itemerness.projection.ProjectionViewerBindingAdapter
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import java.util.logging.Level
import org.bukkit.plugin.ServicePriority
import org.bukkit.plugin.java.JavaPlugin

class ItemernessPlugin : JavaPlugin() {
    private val runtimeActive = AtomicBoolean()
    private val runtimeGeneration = AtomicLong()
    private var catalog: RuntimeCatalogManager? = null
    private var bukkitApi: DefaultBukkitItemernessApi? = null
    private var canonicalBridge: BukkitCanonicalItemBridge? = null
    private var placeholderSnapshots: PlaceholderSnapshotStore? = null
    private var placeholderIntegration: PlaceholderApiIntegration? = null
    private var projectionState: ProjectionStateStore? = null
    private var viewerPublisher: ViewerStatePublisher? = null
    private var viewerFacts: ViewerFactStore? = null
    private var refreshCoordinator: VisibleSurfaceRefreshCoordinator? = null
    private var viewerFactRefreshListener: AutoCloseable? = null
    private var projectionAdapter: ProjectionAdapter? = null
    private var editorAgent: EditorAgentCoordinator? = null

    override fun onEnable() {
        check(catalog == null) { "Itemerness has already been enabled" }
        check(runtimeActive.compareAndSet(false, true)) { "Itemerness runtime is already active" }
        val generation = runtimeGeneration.incrementAndGet()

        try {
            saveDefaultConfig()
            BundledResources.extract(this)

            val scheduler = FoliaScheduler(this)
            val catalog = RuntimeCatalogManager(dataFolder.toPath())
            val initial = catalog.reload()
            check(initial is RuntimeCatalogUpdate.Published) {
                val diagnostics = initial.diagnostics.joinToString("; ") { diagnostic ->
                    "${diagnostic.code} at ${diagnostic.path}: ${diagnostic.message}"
                }
                "Initial Itemerness catalog is invalid: $diagnostics"
            }
            val bridge = BukkitCanonicalBridgeLoader.load(server.minecraftVersion)
            val snapshots = PlaceholderSnapshotStore()
            val projectionState = ProjectionStateStore().also { state ->
                state.publishCatalog(initial.active, initial.active.presentation)
            }
            val resyncRequests = BoundedProjectionResyncQueue()
            val viewerFacts = ViewerFactStore()
            val projectionFailureShutdown = ProjectionFailureShutdown(
                runtimeCurrent = {
                    runtimeActive.get() && runtimeGeneration.get() == generation
                },
                scheduleGlobal = scheduler::tryRunGlobal,
                report = { terminalFailure ->
                    logger.log(
                        Level.SEVERE,
                        "Itemerness projection failed during ${terminalFailure.operation}; disabling the plugin",
                        terminalFailure.cause,
                    )
                },
                disable = { server.pluginManager.disablePlugin(this) },
            )
            val projectionAdapter = ProjectionAdapterLoader.load(
                server.minecraftVersion,
                ProjectionRuntime(
                    projector = projectionState,
                    contexts = projectionState,
                    pdcFallbackPlans = projectionState,
                    resyncRequests = resyncRequests,
                    failures = projectionFailureShutdown,
                ),
            )
            val publisher = ViewerStatePublisher(
                plugin = this,
                scheduler = scheduler,
                catalog = catalog,
                bridge = bridge,
                projection = projectionState,
                placeholders = snapshots,
                resyncRequests = resyncRequests,
                viewerFacts = viewerFacts,
                viewerBinding = projectionAdapter as? ProjectionViewerBindingAdapter,
                projectionRefresh = { player ->
                    (projectionAdapter as? ProjectionRefreshAdapter)?.refreshViewer(player.uniqueId, player)
                },
            )
            val placeholders = PlaceholderApiIntegration(
                plugin = this,
                snapshots = snapshots,
                catalogRevision = { catalog.snapshot()?.domain?.revision },
            )
            val refreshCoordinator = VisibleSurfaceRefreshCoordinator(
                plugin = this,
                scheduler = scheduler,
                viewerPublished = { player -> publisher.capture(player, refreshIfChanged = false) },
                projectionRefresh = { player ->
                    (projectionAdapter as? ProjectionRefreshAdapter)?.refreshViewer(player.uniqueId, player)
                },
                viewerAvailable = { viewerId -> projectionState.viewer(viewerId) != null },
            )
            val factRefreshListener = viewerFacts.listen { viewerId ->
                if (runtimeActive.get() && runtimeGeneration.get() == generation) {
                    refreshCoordinator.request(viewerId)
                }
            }
            val refreshDispatcher = RefreshRequestDispatcher { request ->
                refreshCoordinator.request(request.playerId)
            }
            val bukkitApi = DefaultBukkitItemernessApi(
                ownerPlugin = this,
                catalog = catalog,
                bridge = bridge,
                refreshDispatcher = refreshDispatcher,
                viewerRefreshDispatcher = ViewerRefreshDispatcher(refreshCoordinator::request),
                playerSlotDispatcher = PlayerSlotDispatcher { player, retired, action ->
                    scheduler.tryRunForEntity(player, retired, action)
                },
                viewerFacts = viewerFacts,
                viewerAvailable = { viewerId -> projectionState.viewer(viewerId) != null },
            )
            val editorAgent = EditorAgentCoordinator { endpoint ->
                val asyncExecutor = FoliaAsyncExecutor(scheduler)
                EditorAgentService(
                    endpoint = endpoint,
                    // Informational only: the control plane derives the authoritative identity from
                    // the token binding, so a server cannot rename itself into another project.
                    serverId = "${server.name.lowercase()}-${server.port}",
                    agentVersion = pluginMeta.version,
                    minecraftVersion = server.minecraftVersion,
                    platform = server.name,
                    logger = logger,
                    scheduler = FoliaAgentScheduler(scheduler),
                    worker = asyncExecutor,
                    transportExecutor = asyncExecutor,
                )
            }

            // Publish every closeable before any registration or start call. A later lifecycle
            // failure must be able to unwind listeners, tasks, services, and channel hooks.
            this.catalog = catalog
            this.bukkitApi = bukkitApi
            this.canonicalBridge = bridge
            this.placeholderSnapshots = snapshots
            this.placeholderIntegration = placeholders
            this.projectionState = projectionState
            this.viewerPublisher = publisher
            this.viewerFacts = viewerFacts
            this.refreshCoordinator = refreshCoordinator
            this.viewerFactRefreshListener = factRefreshListener
            this.projectionAdapter = projectionAdapter
            this.editorAgent = editorAgent

            // The exact NMS release gate must be ready before any API or command can create a
            // canonical item. Viewer capture then refreshes already-online players after hooks exist.
            projectionAdapter.start()
            bukkitApi.start()
            publisher.start()
            placeholders.start()
            startEditorAgent(editorAgent, initial.active.settings)

            server.servicesManager.register(BukkitItemernessApi::class.java, bukkitApi, this, ServicePriority.Normal)
            ItemernessCommands(
                actions = DefaultItemernessCommandActions(
                    plugin = this,
                    scheduler = scheduler,
                    catalog = catalog,
                    bridge = bridge,
                    catalogPublication = RuntimeCatalogPublication { published ->
                        // Reserve every currently published viewer before downstream state is
                        // exchanged. The delayed owning-context tasks cannot run concurrently with
                        // this global publication task, and a rejected reservation keeps the old
                        // catalog active instead of silently leaving a viewer on stale presentation.
                        server.onlinePlayers.forEach { player ->
                            val viewerId = player.uniqueId
                            if (projectionState.viewer(viewerId) != null) {
                                check(refreshCoordinator.request(viewerId)) {
                                    "Immediate catalog refresh could not be reserved for $viewerId"
                                }
                            }
                        }
                        val projectionPublication = projectionState.prepareCatalog(
                            published,
                            published.presentation,
                        )
                        val factPublication = try {
                            viewerFacts.prepareReconcile(published.presentation) { owner, key ->
                                published.accessPolicy.decide(
                                    callerPluginName = owner,
                                    action = ApiAction.WRITE_VIEWER_FACT,
                                    itemNamespace = key.namespace,
                                ) == AccessDecision.ALLOW
                            }
                        } catch (failure: Throwable) {
                            var publicationFailure = failure
                            try {
                                projectionPublication.rollback()
                            } catch (rollbackFailure: Throwable) {
                                publicationFailure = mergePublicationFailure(publicationFailure, rollbackFailure)
                            }
                            throw publicationFailure
                        }
                        val editorPublication = try {
                            editorAgent.prepare(published.settings.editor)
                        } catch (failure: Throwable) {
                            var publicationFailure = failure
                            try {
                                factPublication.rollback()
                            } catch (rollbackFailure: Throwable) {
                                publicationFailure = mergePublicationFailure(publicationFailure, rollbackFailure)
                            }
                            try {
                                projectionPublication.rollback()
                            } catch (rollbackFailure: Throwable) {
                                publicationFailure = mergePublicationFailure(publicationFailure, rollbackFailure)
                            }
                            throw publicationFailure
                        }
                        object : PreparedRuntimeCatalogPublication {
                            override fun commit() {
                                projectionPublication.commit()
                                factPublication.commit()
                                editorPublication.commit()
                            }

                            override fun rollback() {
                                var firstFailure: Throwable? = null
                                try {
                                    editorPublication.rollback()
                                } catch (failure: Throwable) {
                                    firstFailure = mergePublicationFailure(firstFailure, failure)
                                }
                                try {
                                    factPublication.rollback()
                                } catch (failure: Throwable) {
                                    firstFailure = mergePublicationFailure(firstFailure, failure)
                                }
                                try {
                                    projectionPublication.rollback()
                                } catch (failure: Throwable) {
                                    firstFailure = mergePublicationFailure(firstFailure, failure)
                                }
                                firstFailure?.let { throw it }
                            }

                            override fun complete() {
                                val failures = mutableListOf<Throwable>()
                                try {
                                    editorPublication.complete()
                                } catch (failure: Throwable) {
                                    failures += failure
                                }
                                failures += factPublication.complete()
                                if (failures.isNotEmpty()) {
                                    val failure = IllegalStateException(
                                        "${failures.size} viewer fact listener(s) failed after catalog commit",
                                    )
                                    failures.forEach(failure::addSuppressed)
                                    throw failure
                                }
                            }
                        }
                    },
                    playerRefreshed = { viewerId ->
                        refreshCoordinator.request(viewerId)
                    },
                    runtimeActive = {
                        runtimeActive.get() && runtimeGeneration.get() == generation
                    },
                ),
                catalog = catalog,
            ).register(this)
            logger.info(
                "Loaded catalog revision ${initial.active.domain.revision} with " +
                    "${initial.active.domain.items.size} enabled items for Minecraft ${server.minecraftVersion}",
            )
        } catch (failure: Throwable) {
            closeRuntime(failure)
            throw failure
        }
    }

    /**
     * Dials the control plane when the operator has paired this server.
     *
     * Started last, once the runtime is up, so a preview request cannot arrive while the catalog is
     * still being built. A failure here is logged and does not abort enable: an unreachable editor
     * must never stop a server from running its local catalog.
     */
    private fun startEditorAgent(
        coordinator: EditorAgentCoordinator,
        settings: com.iroselle.itemerness.bukkit.config.ItemernessSettings,
    ) {
        val endpoint = settings.editor
        if (endpoint == null) {
            logger.info("Editor is not configured; the catalog stays local")
            return
        }
        try {
            coordinator.start(endpoint)
        } catch (failure: Throwable) {
            logger.log(java.util.logging.Level.SEVERE, "Could not start the editor agent", failure)
        }
    }

    override fun onDisable() {
        closeRuntime()
    }

    private fun closeRuntime(primaryFailure: Throwable? = null) {
        runtimeActive.set(false)
        val cleanupFailures = ArrayList<Pair<String, Throwable>>()
        fun cleanup(name: String, action: () -> Unit) {
            try {
                action()
            } catch (failure: Throwable) {
                cleanupFailures += name to failure
            }
        }

        // Stopped first: once teardown begins nothing should accept a new compile against a
        // catalog that is about to be dismantled.
        editorAgent.also { editorAgent = null }?.let { coordinator ->
            cleanup("editor agent", coordinator::close)
        }
        bukkitApi.also { bukkitApi = null }?.let { api ->
            cleanup("Bukkit API", api::close)
        }
        cleanup("Bukkit services") { server.servicesManager.unregisterAll(this) }
        viewerFactRefreshListener.also { viewerFactRefreshListener = null }?.let { listener ->
            cleanup("viewer fact listener", listener::close)
        }
        refreshCoordinator.also { refreshCoordinator = null }?.let { coordinator ->
            cleanup("refresh coordinator", coordinator::close)
        }
        viewerPublisher.also { viewerPublisher = null }?.let { publisher ->
            cleanup("viewer publisher", publisher::close)
        }
        viewerFacts.also { viewerFacts = null }?.let { facts ->
            cleanup("viewer fact store", facts::close)
        }
        placeholderIntegration.also { placeholderIntegration = null }?.let { integration ->
            cleanup("PlaceholderAPI integration", integration::close)
        }
        catalog.also { catalog = null }?.let { manager ->
            cleanup("catalog", manager::clear)
        }
        projectionAdapter.also { projectionAdapter = null }?.let { adapter ->
            cleanup("projection adapter", adapter::close)
        }
        placeholderSnapshots.also { placeholderSnapshots = null }?.let { snapshots ->
            cleanup("placeholder snapshots", snapshots::clear)
        }
        projectionState.also { projectionState = null }?.let { state ->
            cleanup("projection state", state::clear)
        }
        canonicalBridge = null

        cleanupFailures.forEach { (name, failure) ->
            if (primaryFailure != null) {
                if (failure !== primaryFailure) primaryFailure.addSuppressed(failure)
            } else {
                logger.log(Level.SEVERE, "Failed to close Itemerness $name", failure)
            }
        }
    }
}

private fun mergePublicationFailure(
    current: Throwable?,
    next: Throwable,
): Throwable {
    if (current == null || current === next) return current ?: next
    return if (!current.isFatalPublicationFailure() && next.isFatalPublicationFailure()) {
        next.apply { addSuppressed(current) }
    } else {
        current.apply { addSuppressed(next) }
    }
}

@Suppress("DEPRECATION")
private fun Throwable.isFatalPublicationFailure(): Boolean =
    this is VirtualMachineError || this is ThreadDeath
