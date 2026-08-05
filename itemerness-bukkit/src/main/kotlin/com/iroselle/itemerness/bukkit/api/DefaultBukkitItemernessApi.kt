package com.iroselle.itemerness.bukkit.api

import com.iroselle.itemerness.api.ApiAction
import com.iroselle.itemerness.api.ApiCallResult
import com.iroselle.itemerness.api.ApiDenialReason
import com.iroselle.itemerness.api.DataKey
import com.iroselle.itemerness.api.DomainItemInstance
import com.iroselle.itemerness.api.ItemDataMutation
import com.iroselle.itemerness.api.ItemDataValue
import com.iroselle.itemerness.api.ItemDefinition
import com.iroselle.itemerness.api.ItemInstanceMode
import com.iroselle.itemerness.api.ItemKey
import com.iroselle.itemerness.api.RefreshReceipt
import com.iroselle.itemerness.api.RefreshRequest
import com.iroselle.itemerness.bukkit.access.AccessDecision
import com.iroselle.itemerness.bukkit.access.AccessPolicy
import com.iroselle.itemerness.bukkit.access.DataAccessAuthorizer
import com.iroselle.itemerness.bukkit.access.DataAccessRuleIndex
import com.iroselle.itemerness.bukkit.catalog.BukkitCatalogItemFactory
import com.iroselle.itemerness.bukkit.catalog.BukkitItemComponentWriter
import com.iroselle.itemerness.bukkit.catalog.CanonicalDomainMapper
import com.iroselle.itemerness.bukkit.catalog.CanonicalDomainResult
import com.iroselle.itemerness.bukkit.catalog.PaperBukkitItemComponentWriter
import com.iroselle.itemerness.bukkit.catalog.RuntimeCatalogManager
import com.iroselle.itemerness.bukkit.catalog.RuntimeCatalogSnapshot
import com.iroselle.itemerness.bukkit.catalog.samePhysicalItemStack
import com.iroselle.itemerness.bukkit.spi.BukkitCanonicalItemBridge
import com.iroselle.itemerness.bukkit.spi.CanonicalItemInspection
import com.iroselle.itemerness.bukkit.spi.PendingItemName
import com.iroselle.itemerness.core.DefaultItemRegistry
import com.iroselle.itemerness.core.catalog.CanonicalItemInstance
import com.iroselle.itemerness.core.catalog.CatalogSnapshot
import com.iroselle.itemerness.core.catalog.CatalogItemDefinition
import com.iroselle.itemerness.core.catalog.InstanceDataMutation
import com.iroselle.itemerness.core.presentation.PresentationCatalogSnapshot
import com.iroselle.itemerness.core.presentation.ViewerFactMutationResult
import com.iroselle.itemerness.core.presentation.ViewerFactOwnerLease
import com.iroselle.itemerness.core.presentation.ViewerFactStore
import com.iroselle.itemerness.core.presentation.ViewerFactValidationCode
import com.iroselle.itemerness.projection.CanonicalItemSnapshot
import java.util.IdentityHashMap
import java.util.LinkedHashMap
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CompletionStage
import java.util.concurrent.atomic.AtomicBoolean
import org.bukkit.entity.Player
import org.bukkit.event.EventHandler
import org.bukkit.event.EventPriority
import org.bukkit.event.HandlerList
import org.bukkit.event.Listener
import org.bukkit.event.server.PluginDisableEvent
import org.bukkit.event.server.PluginEnableEvent
import org.bukkit.inventory.ItemStack
import org.bukkit.inventory.PlayerInventory
import org.bukkit.plugin.Plugin

internal fun interface RefreshRequestDispatcher {
    /** Returns true only after the request has been accepted by the real scheduling boundary. */
    fun dispatch(request: RefreshRequest): Boolean
}

internal fun interface ViewerRefreshDispatcher {
    /** Returns true only after a viewer-wide refresh has crossed the scheduling boundary. */
    fun dispatch(viewerId: UUID): Boolean
}

internal fun interface PlayerSlotDispatcher {
    /** Schedules the complete slot transaction in [player]'s owning entity context. */
    fun dispatch(
        player: Player,
        retired: () -> Unit,
        action: () -> Unit,
    ): Boolean
}

internal fun interface CatalogCommitter {
    /** Runs a bounded compare-and-replace only while [expected] remains the active catalog. */
    fun commit(
        expected: RuntimeCatalogSnapshot,
        action: () -> Unit,
    ): Boolean
}

internal fun interface SlotCompletionHandoff {
    /** Testable boundary after a slot outcome owns completion but before callbacks are released. */
    fun beforeComplete()
}

private inline fun bestEffortDispatch(action: () -> Boolean): Boolean = try {
    action()
} catch (failure: Throwable) {
    failure.rethrowIfFatalBoundaryFailure()
    false
}

private fun Throwable.rethrowIfFatalBoundaryFailure() {
    if (isFatalBoundaryFailure()) throw this
}

@Suppress("DEPRECATION")
private fun Throwable.isFatalBoundaryFailure(): Boolean =
    this is VirtualMachineError || this is ThreadDeath

internal class DefaultBukkitItemernessApi private constructor(
    private val ownerPlugin: Plugin,
    private val snapshotProvider: () -> ApiCatalogState?,
    private val presentationProvider: () -> PresentationCatalogSnapshot?,
    private val bridge: BukkitCanonicalItemBridge?,
    private val pdcFallbackReader: PdcFallbackReader,
    private val viewerFacts: ViewerFactStore,
    private val componentWriter: BukkitItemComponentWriter,
    private val viewerAvailable: (UUID) -> Boolean,
    private val callerRegistry: PluginCallerRegistry,
    private val callerOriginVerifier: CallerOriginVerifier,
    private val refreshDispatcher: RefreshRequestDispatcher? = null,
    private val viewerRefreshDispatcher: ViewerRefreshDispatcher? = null,
    private val playerSlotDispatcher: PlayerSlotDispatcher? = null,
    private val catalogCommitter: CatalogCommitter? = null,
    private val slotCompletionHandoff: SlotCompletionHandoff = SlotCompletionHandoff {},
    private val pluginRegistrationVerifier: ((Plugin) -> Boolean)? = null,
) : BukkitItemernessApi,
    Listener,
    AutoCloseable {
    private val active = AtomicBoolean(true)
    private val lifecycleLock = Any()
    private val facades = IdentityHashMap<Plugin, BoundFacade>()
    private var lifecycleListenerStarted = false

    constructor(
        ownerPlugin: Plugin,
        catalog: RuntimeCatalogManager,
        bridge: BukkitCanonicalItemBridge,
        activePlugins: Collection<Plugin>? = null,
        refreshDispatcher: RefreshRequestDispatcher? = null,
        pdcFallbackReader: PdcFallbackReader = BukkitPdcFallbackReader,
        viewerFacts: ViewerFactStore = ViewerFactStore(),
        componentWriter: BukkitItemComponentWriter = PaperBukkitItemComponentWriter,
        viewerAvailable: (UUID) -> Boolean = { true },
        callerOriginVerifier: CallerOriginVerifier = if (activePlugins == null) {
            StackWalkerCallerOriginVerifier(ownerPlugin.javaClass.classLoader)
        } else {
            CallerOriginVerifier { true }
        },
        viewerRefreshDispatcher: ViewerRefreshDispatcher? = null,
        playerSlotDispatcher: PlayerSlotDispatcher? = null,
        slotCompletionHandoff: SlotCompletionHandoff = SlotCompletionHandoff {},
        pluginRegistrationVerifier: ((Plugin) -> Boolean)? = null,
    ) : this(
        ownerPlugin = ownerPlugin,
        snapshotProvider = {
            catalog.snapshot()?.let { snapshot ->
                ApiCatalogState(
                    domain = snapshot.domain,
                    accessPolicy = snapshot.accessPolicy,
                    dataAccessRules = snapshot.dataAccessRules,
                    runtime = snapshot,
                )
            }
        },
        presentationProvider = { catalog.snapshot()?.presentation },
        bridge = bridge,
        pdcFallbackReader = pdcFallbackReader,
        viewerFacts = viewerFacts,
        componentWriter = componentWriter,
        viewerAvailable = viewerAvailable,
        callerRegistry = PluginCallerRegistry(
            (activePlugins ?: ownerPlugin.server.pluginManager.plugins.filter(Plugin::isEnabled))
                .plus(ownerPlugin)
                .distinctBy { plugin -> plugin.name.lowercase() },
        ),
        callerOriginVerifier = callerOriginVerifier,
        refreshDispatcher = refreshDispatcher,
        viewerRefreshDispatcher = viewerRefreshDispatcher,
        playerSlotDispatcher = playerSlotDispatcher,
        catalogCommitter = CatalogCommitter { expected, action -> catalog.commitIfCurrent(expected, action) },
        slotCompletionHandoff = slotCompletionHandoff,
        pluginRegistrationVerifier = pluginRegistrationVerifier,
    )

    /** Test seam retained for platform-identity tests without a filesystem-backed runtime. */
    internal constructor(
        ownerPlugin: Plugin,
        registry: DefaultItemRegistry,
        accessPolicy: AccessPolicy,
        activePlugins: Collection<Plugin> = listOf(ownerPlugin),
        refreshDispatcher: RefreshRequestDispatcher? = null,
        bridge: BukkitCanonicalItemBridge? = null,
        pdcFallbackReader: PdcFallbackReader = BukkitPdcFallbackReader,
        viewerFacts: ViewerFactStore = ViewerFactStore(),
        componentWriter: BukkitItemComponentWriter = PaperBukkitItemComponentWriter,
        presentation: PresentationCatalogSnapshot? = null,
        viewerAvailable: (UUID) -> Boolean = { true },
        callerOriginVerifier: CallerOriginVerifier = CallerOriginVerifier { true },
        viewerRefreshDispatcher: ViewerRefreshDispatcher? = ViewerRefreshDispatcher { true },
        playerSlotDispatcher: PlayerSlotDispatcher? = null,
        catalogCommitter: CatalogCommitter? = null,
        slotCompletionHandoff: SlotCompletionHandoff = SlotCompletionHandoff {},
        pluginRegistrationVerifier: ((Plugin) -> Boolean)? = null,
    ) : this(
        ownerPlugin = ownerPlugin,
        snapshotProvider = { ApiCatalogState(registry.snapshot(), accessPolicy, null, null) },
        presentationProvider = { presentation },
        bridge = bridge,
        pdcFallbackReader = pdcFallbackReader,
        viewerFacts = viewerFacts,
        componentWriter = componentWriter,
        viewerAvailable = viewerAvailable,
        callerRegistry = PluginCallerRegistry(activePlugins),
        callerOriginVerifier = callerOriginVerifier,
        refreshDispatcher = refreshDispatcher,
        viewerRefreshDispatcher = viewerRefreshDispatcher,
        playerSlotDispatcher = playerSlotDispatcher,
        catalogCommitter = catalogCommitter,
        slotCompletionHandoff = slotCompletionHandoff,
        pluginRegistrationVerifier = pluginRegistrationVerifier,
    )

    init {
        require(callerRegistry.isActive(ownerPlugin)) {
            "The Itemerness API owner must be the active Bukkit plugin registered under its name"
        }
    }

    /** Registers the lifecycle bridge after construction but before the service is published. */
    fun start() {
        synchronized(lifecycleLock) {
            check(active.get()) { "The Itemerness Bukkit service is closed" }
            if (lifecycleListenerStarted) return
            ownerPlugin.server.pluginManager.registerEvents(this, ownerPlugin)
            lifecycleListenerStarted = true
        }
    }

    override fun forPlugin(plugin: Plugin): ApiCallResult<BoundBukkitItemernessApi> {
        val retiredSlotEdits = ArrayList<CompletableFuture<ApiCallResult<BukkitSlotEditReceipt>>>()
        val result = synchronized(lifecycleLock) {
            if (!active.get()) {
                return@synchronized ApiCallResult.Denied(
                    ApiDenialReason.CALLER_NOT_ACTIVE,
                    "The Itemerness Bukkit service is closed",
                )
            }
            if (!callerOriginVerifier.isCaller(plugin)) {
                return@synchronized ApiCallResult.Denied(
                    ApiDenialReason.CALLER_NOT_ACTIVE,
                    "The calling class loader does not own the requested Bukkit plugin binding",
                )
            }
            when (val authentication = AuthenticatedPluginCaller.authenticate(plugin, callerRegistry)) {
                is ApiCallResult.Denied -> authentication
                is ApiCallResult.Success -> {
                    facades[plugin]?.takeIf(BoundFacade::isBindingActive)?.let {
                        return@synchronized ApiCallResult.Success(it)
                    }
                    facades.remove(plugin)?.let { stale ->
                        retiredSlotEdits += stale.beginRetirement()
                    }
                    val facade = BoundFacade(
                        ownerPlugin = ownerPlugin,
                        caller = authentication.value,
                        snapshotProvider = snapshotProvider,
                        presentationProvider = presentationProvider,
                        bridge = bridge,
                        pdcFallbackReader = pdcFallbackReader,
                        viewerFacts = viewerFacts,
                        componentWriter = componentWriter,
                        viewerAvailable = viewerAvailable,
                        viewerFactOwner = viewerFacts.bindOwner(plugin.name, plugin),
                        serviceActive = active::get,
                        refreshDispatcher = refreshDispatcher,
                        viewerRefreshDispatcher = viewerRefreshDispatcher,
                        playerSlotDispatcher = playerSlotDispatcher,
                        catalogCommitter = catalogCommitter,
                        slotCompletionHandoff = slotCompletionHandoff,
                    )
                    facades[plugin] = facade
                    ApiCallResult.Success(facade)
                }
            }
        }
        BoundFacade.completeRetiredSlotEdits(retiredSlotEdits)
        return result
    }

    @EventHandler(priority = EventPriority.LOWEST)
    fun onPluginDisable(event: PluginDisableEvent) {
        handlePluginDisable(event.plugin)
    }

    internal fun handlePluginDisable(plugin: Plugin) {
        if (plugin === ownerPlugin || !isRegisteredPlugin(plugin)) return
        // Bukkit emits this event while the retiring generation can still report enabled. Retire
        // synchronously so a disable/enable cycle cannot reuse its facade, handles, or fact lease.
        retireCaller(plugin)
    }

    @EventHandler(priority = EventPriority.LOWEST)
    fun onPluginEnable(event: PluginEnableEvent) {
        handlePluginEnable(event.plugin)
    }

    internal fun handlePluginEnable(plugin: Plugin) {
        if (
            plugin === ownerPlugin ||
            !isRegisteredPlugin(plugin) ||
            !runCatching(plugin::isEnabled).getOrDefault(false)
        ) {
            return
        }
        activateCaller(plugin)
    }

    internal fun retireCaller(plugin: Plugin) {
        val retiredSlotEdits = ArrayList<CompletableFuture<ApiCallResult<BukkitSlotEditReceipt>>>()
        try {
            synchronized(lifecycleLock) {
                facades.remove(plugin)?.let { facade ->
                    retiredSlotEdits += facade.beginRetirement()
                }
                callerRegistry.retire(plugin)
                viewerFacts.clearOwner(plugin.name, plugin)
            }
        } finally {
            BoundFacade.completeRetiredSlotEdits(retiredSlotEdits)
        }
    }

    internal fun activateCaller(plugin: Plugin) {
        synchronized(lifecycleLock) {
            if (!active.get()) return
            callerRegistry.activate(plugin)
            viewerFacts.activateOwner(plugin.name, plugin)
        }
    }

    override fun close() {
        var primaryFailure: Throwable? = null
        val retiredSlotEdits = ArrayList<CompletableFuture<ApiCallResult<BukkitSlotEditReceipt>>>()
        fun cleanup(action: () -> Unit) {
            try {
                action()
            } catch (failure: Throwable) {
                val previous = primaryFailure
                if (previous == null) primaryFailure = failure
                else if (failure !== previous) previous.addSuppressed(failure)
            }
        }
        synchronized(lifecycleLock) {
            if (!active.getAndSet(false)) return
            if (lifecycleListenerStarted) {
                cleanup { HandlerList.unregisterAll(this) }
                lifecycleListenerStarted = false
            }
            facades.forEach { (plugin, facade) ->
                cleanup { retiredSlotEdits += facade.beginRetirement() }
                cleanup { viewerFacts.clearOwner(plugin.name, plugin) }
            }
            facades.clear()
            cleanup(callerRegistry::close)
        }
        BoundFacade.completeRetiredSlotEdits(retiredSlotEdits)
        primaryFailure?.let { throw it }
    }

    private fun isRegisteredPlugin(plugin: Plugin): Boolean = pluginRegistrationVerifier?.invoke(plugin) ?: try {
        ownerPlugin.server.pluginManager.getPlugin(plugin.name) === plugin
    } catch (_: RuntimeException) {
        false
    }
}

private class BoundFacade(
    private val ownerPlugin: Plugin,
    private val caller: AuthenticatedPluginCaller,
    private val snapshotProvider: () -> ApiCatalogState?,
    private val presentationProvider: () -> PresentationCatalogSnapshot?,
    private val bridge: BukkitCanonicalItemBridge?,
    private val pdcFallbackReader: PdcFallbackReader,
    private val viewerFacts: ViewerFactStore,
    private val componentWriter: BukkitItemComponentWriter,
    private val viewerAvailable: (UUID) -> Boolean,
    private val viewerFactOwner: ViewerFactOwnerLease,
    private val serviceActive: () -> Boolean,
    private val refreshDispatcher: RefreshRequestDispatcher?,
    private val viewerRefreshDispatcher: ViewerRefreshDispatcher?,
    private val playerSlotDispatcher: PlayerSlotDispatcher?,
    private val catalogCommitter: CatalogCommitter?,
    private val slotCompletionHandoff: SlotCompletionHandoff,
) : BoundBukkitItemernessApi,
    AutoCloseable {
    private val domainHandles = DomainHandleStore()
    private val effectiveItemData = EffectiveItemDataResolver(pdcFallbackReader)
    private val pendingSlotEdits = LinkedHashSet<CompletableFuture<ApiCallResult<BukkitSlotEditReceipt>>>()
    private var closed = false

    override val callerPluginName: String = caller.pluginName

    @get:Synchronized
    override val catalogRevision: Long
        get() = if (closed) 0 else snapshotProvider()?.domain?.revision ?: 0

    @Synchronized
    override fun findItem(key: ItemKey): ApiCallResult<ItemDefinition?> {
        activeCallerDenial()?.let { return it }
        val snapshot = snapshotProvider()
        actionDenial(ApiAction.IDENTIFY, key, snapshot)?.let { return it }
        return ApiCallResult.Success(snapshot?.domain?.findItem(key))
    }

    @Synchronized
    override fun items(): ApiCallResult<List<ItemDefinition>> {
        activeCallerDenial()?.let { return it }
        val snapshot = snapshotProvider()
            ?: return ApiCallResult.Success(emptyList())
        val visible = snapshot.domain.items.values
            .filter { definition ->
                snapshot.accessPolicy.decide(
                    callerPluginName,
                    ApiAction.IDENTIFY,
                    definition.key.namespace,
                ) != AccessDecision.DENY
            }
            .sortedBy(ItemDefinition::key)
        return ApiCallResult.Success(java.util.List.copyOf(visible))
    }

    @Synchronized
    override fun createDomainInstance(key: ItemKey): ApiCallResult<DomainItemInstance> {
        activeCallerDenial()?.let { return it }
        val snapshot = snapshotProvider()
            ?: return denied(ApiDenialReason.ITEM_NOT_FOUND, "No catalog is active")
        actionDenial(ApiAction.CREATE, key, snapshot)?.let { return it }
        if (snapshot.domain.findItem(key) == null) {
            return denied(ApiDenialReason.ITEM_NOT_FOUND, "The item is not present in the active catalog")
        }
        return ApiCallResult.Success(domainHandles.issue(snapshot.domain.createInstance(key)))
    }

    @Synchronized
    override fun createItem(
        key: ItemKey,
        amount: Int,
    ): ApiCallResult<ItemStack> {
        activeCallerDenial()?.let { return it }
        val snapshot = snapshotProvider()
            ?: return denied(ApiDenialReason.ITEM_NOT_FOUND, "No catalog is active")
        actionDenial(ApiAction.CREATE, key, snapshot)?.let { return it }
        val definition = snapshot.domain.findItem(key)
            ?: return denied(ApiDenialReason.ITEM_NOT_FOUND, "The item is not present in the active catalog")
        if (amount <= 0) {
            return denied(ApiDenialReason.INVALID_VALUE, "The item amount must be positive")
        }
        if (definition.instanceMode == ItemInstanceMode.UNIQUE && amount != 1) {
            return denied(ApiDenialReason.INVALID_VALUE, "A unique item instance cannot be stacked")
        }
        val runtime = snapshot.runtime
            ?: return platformUnavailable()
        val itemBridge = bridge
            ?: return platformUnavailable()
        return try {
            val instance = snapshot.domain.createInstance(key)
            val factory = BukkitCatalogItemFactory(
                bridge = itemBridge,
                catalog = snapshot.domain,
                pendingName = runtime::pendingItemName,
                componentWriter = componentWriter,
            )
            ApiCallResult.Success(factory.create(definition, instance, amount))
        } catch (failure: RuntimeException) {
            denied(ApiDenialReason.INVALID_VALUE, failure.message ?: "The canonical item could not be created")
        }
    }

    @Synchronized
    override fun identifyItem(source: ItemStack): ApiCallResult<BukkitItemIdentity?> {
        activeCallerDenial()?.let { return it }
        val snapshot = snapshotProvider()
            ?: return denied(ApiDenialReason.ITEM_NOT_FOUND, "No catalog is active")
        return when (val inspected = inspectManaged(source, snapshot)) {
            is ApiCallResult.Denied -> inspected
            is ApiCallResult.Success -> {
                val managed = inspected.value ?: return ApiCallResult.Success(null)
                actionDenial(ApiAction.IDENTIFY, managed.instance.itemKey, snapshot)?.let { return it }
                ApiCallResult.Success(managed.toIdentity())
            }
        }
    }

    @Synchronized
    override fun readItemData(
        source: ItemStack,
        key: DataKey,
    ): ApiCallResult<ItemDataValue?> {
        activeCallerDenial()?.let { return it }
        val snapshot = snapshotProvider()
            ?: return denied(ApiDenialReason.ITEM_NOT_FOUND, "No catalog is active")
        val managed = when (val inspected = inspectManaged(source, snapshot)) {
            is ApiCallResult.Denied -> return inspected
            is ApiCallResult.Success -> inspected.value
                ?: return denied(ApiDenialReason.INVALID_MANAGED_ITEM, "The stack is not managed by Itemerness")
        }
        val keyDefinition = snapshot.domain.dataKeyDefinition(managed.instance.itemKey, key)
            ?: return denied(
                ApiDenialReason.DATA_KEY_NOT_FOUND,
                "The data key is not defined for ${managed.instance.itemKey}",
            )
        val authorizer = snapshot.authorizer(ownerPlugin)
            ?: return denied(ApiDenialReason.DATA_KEY_NOT_FOUND, "No data access rules are active")
        when (val authorization = authorizer.authorizeRead(caller, managed.instance.itemKey, key)) {
            is ApiCallResult.Denied -> return authorization
            is ApiCallResult.Success -> Unit
        }

        val definitionValue = (managed.definition as? CatalogItemDefinition)?.definitionData?.get(key)
        val directValue = managed.instance[key] ?: definitionValue
        if (directValue != null) {
            return ApiCallResult.Success(directValue)
        }

        val runtime = snapshot.runtime
            ?: return platformUnavailable()
        return when (
            val resolved = effectiveItemData.resolveKey(
                source,
                runtime,
                CanonicalDomainResult.Valid(managed.definition, managed.instance),
                key,
            )
        ) {
            EffectiveItemDataRead.Absent -> ApiCallResult.Success(null)
            is EffectiveItemDataRead.Value -> ApiCallResult.Success(resolved.value)
            is EffectiveItemDataRead.Invalid -> denied(ApiDenialReason.INVALID_VALUE, resolved.reason)
        }
    }

    @Synchronized
    override fun editItem(
        source: ItemStack,
        mutations: Collection<ItemDataMutation>,
    ): ApiCallResult<ItemStack> {
        activeCallerDenial()?.let { return it }
        val snapshot = snapshotProvider()
            ?: return denied(ApiDenialReason.ITEM_NOT_FOUND, "No catalog is active")
        return when (val prepared = prepareItemEdit(source, mutations, snapshot)) {
            is ApiCallResult.Denied -> prepared
            is ApiCallResult.Success -> ApiCallResult.Success(prepared.value.rewritten)
        }
    }

    override fun editPlayerSlot(
        player: Player,
        slot: BukkitPlayerSlot,
        mutations: Collection<ItemDataMutation>,
    ): CompletionStage<ApiCallResult<BukkitSlotEditReceipt>> {
        val completion = CompletableFuture<ApiCallResult<BukkitSlotEditReceipt>>()
        val copiedMutations = try {
            java.util.List.copyOf(mutations)
        } catch (failure: RuntimeException) {
            completion.complete(
                denied(ApiDenialReason.INVALID_VALUE, failure.message ?: "Invalid data mutations"),
            )
            return completion
        }
        val dispatcher = synchronized(this) {
            activeCallerDenial()?.let {
                completion.complete(it)
                return completion
            }
            if (copiedMutations.isEmpty()) {
                completion.complete(
                    denied(ApiDenialReason.INVALID_VALUE, "At least one data mutation is required"),
                )
                return completion
            }
            val availableDispatcher = playerSlotDispatcher ?: run {
                completion.complete(
                    denied(
                        ApiDenialReason.OWNER_CONTEXT_REQUIRED,
                        "No player owning-context scheduling boundary is available",
                    ),
                )
                return completion
            }
            if (pendingSlotEdits.size >= MAX_PENDING_SLOT_EDITS) {
                completion.complete(
                    denied(
                        ApiDenialReason.SLOT_QUEUE_FULL,
                        "The bound plugin already owns the maximum of $MAX_PENDING_SLOT_EDITS pending slot transactions",
                    ),
                )
                return completion
            }
            pendingSlotEdits += completion
            availableDispatcher
        }
        val retired = {
            completeRetiredSlotEdit(completion)
            Unit
        }
        val accepted = try {
            dispatcher.dispatch(
                player,
                retired,
            ) {
                completeOwnedSlotEdit(completion) {
                    editPlayerSlotOwned(player, slot, copiedMutations)
                }
            }
        } catch (failure: Throwable) {
            if (failure.isFatalBoundaryFailure()) retired()
            failure.rethrowIfFatalBoundaryFailure()
            false
        }
        if (!accepted) retired()
        return completion
    }

    @Synchronized
    override fun readData(
        instance: DomainItemInstance,
        key: DataKey,
    ): ApiCallResult<ItemDataValue?> {
        activeCallerDenial()?.let { return it }
        val retained = domainHandles.resolve(instance)
            ?: return denied(ApiDenialReason.INVALID_MANAGED_ITEM, "The domain handle is unknown or retired")
        val snapshot = snapshotProvider()
            ?: return denied(ApiDenialReason.ITEM_NOT_FOUND, "No catalog is active")
        if (snapshot.domain.dataKeyDefinition(retained.itemKey, key) == null) {
            return denied(
                ApiDenialReason.DATA_KEY_NOT_FOUND,
                "The data key is not defined for ${retained.itemKey}",
            )
        }
        val authorizer = snapshot.authorizer(ownerPlugin)
            ?: return denied(ApiDenialReason.DATA_KEY_NOT_FOUND, "No data access rules are active")
        when (val authorization = authorizer.authorizeRead(caller, retained.itemKey, key)) {
            is ApiCallResult.Denied -> return authorization
            is ApiCallResult.Success -> Unit
        }
        return try {
            val restored = snapshot.domain.restore(retained)
            val definitionValue = (snapshot.domain.findItem(retained.itemKey) as? CatalogItemDefinition)
                ?.definitionData
                ?.get(key)
            ApiCallResult.Success(restored[key] ?: definitionValue)
        } catch (failure: RuntimeException) {
            denied(ApiDenialReason.INVALID_MANAGED_ITEM, failure.message ?: "Invalid domain instance")
        }
    }

    @Synchronized
    override fun editDomainInstance(
        instance: DomainItemInstance,
        mutations: Collection<ItemDataMutation>,
    ): ApiCallResult<DomainItemInstance> {
        activeCallerDenial()?.let { return it }
        if (mutations.isEmpty()) {
            return denied(ApiDenialReason.INVALID_VALUE, "At least one data mutation is required")
        }
        val retained = domainHandles.resolve(instance)
            ?: return denied(ApiDenialReason.INVALID_MANAGED_ITEM, "The domain handle is unknown or retired")
        val snapshot = snapshotProvider()
            ?: return denied(ApiDenialReason.ITEM_NOT_FOUND, "No catalog is active")
        mutations.forEach { mutation ->
            if (snapshot.domain.dataKeyDefinition(retained.itemKey, mutation.key) == null) {
                return denied(
                    ApiDenialReason.DATA_KEY_NOT_FOUND,
                    "The data key is not defined for ${retained.itemKey}",
                )
            }
        }
        val authorizer = snapshot.authorizer(ownerPlugin)
            ?: return denied(ApiDenialReason.DATA_KEY_NOT_FOUND, "No data access rules are active")
        mutations.forEach { mutation ->
            when (val authorization = authorizer.authorizeInstanceWrite(caller, retained.itemKey, mutation.key)) {
                is ApiCallResult.Denied -> return authorization
                is ApiCallResult.Success -> Unit
            }
        }
        return try {
            val restored = snapshot.domain.restore(retained)
            val coreMutations = mutations.map { mutation ->
                when (mutation) {
                    is ItemDataMutation.Set -> InstanceDataMutation.Set(mutation.key, mutation.value)
                    is ItemDataMutation.Unset -> InstanceDataMutation.Remove(mutation.key)
                }
            }
            ApiCallResult.Success(domainHandles.issue(snapshot.domain.editInstance(restored, coreMutations)))
        } catch (failure: RuntimeException) {
            denied(ApiDenialReason.INVALID_VALUE, failure.message ?: "Invalid data mutation")
        }
    }

    @Synchronized
    override fun requestRefresh(request: RefreshRequest): ApiCallResult<RefreshReceipt> {
        activeCallerDenial()?.let { return it }
        val snapshot = snapshotProvider()
            ?: return denied(ApiDenialReason.ITEM_NOT_FOUND, "No catalog is active")
        actionDenial(ApiAction.REQUEST_REFRESH, request.itemKey, snapshot)?.let { return it }
        if (snapshot.domain.findItem(request.itemKey) == null) {
            return denied(ApiDenialReason.ITEM_NOT_FOUND, "The item is not present in the active catalog")
        }
        if (!viewerAvailable(request.playerId)) {
            return denied(ApiDenialReason.REFRESH_UNAVAILABLE, "The viewer is not currently published by Itemerness")
        }
        val dispatcher = refreshDispatcher
            ?: return denied(ApiDenialReason.REFRESH_UNAVAILABLE, "No refresh scheduling boundary is available")
        if (!dispatcher.dispatch(request)) {
            return denied(ApiDenialReason.REFRESH_UNAVAILABLE, "The refresh scheduling boundary rejected the request")
        }
        return ApiCallResult.Success(
            RefreshReceipt(
                playerId = request.playerId,
                itemKey = request.itemKey,
                catalogRevision = snapshot.domain.revision,
            ),
        )
    }

    @Synchronized
    override fun publishViewerFact(
        viewerId: UUID,
        key: ItemKey,
        value: ItemDataValue,
    ): ApiCallResult<ViewerFactReceipt> {
        activeCallerDenial()?.let { return it }
        if (!viewerAvailable(viewerId)) {
            return denied(ApiDenialReason.INVALID_VALUE, "The viewer is not currently published by Itemerness")
        }
        val snapshot = snapshotProvider()
            ?: return denied(ApiDenialReason.ITEM_NOT_FOUND, "No catalog is active")
        viewerFactActionDenial(key, snapshot)?.let { return it }
        val presentation = snapshot.runtime?.presentation ?: presentationProvider()
            ?: return denied(ApiDenialReason.ITEM_NOT_FOUND, "No presentation catalog is active")
        val dispatcher = viewerRefreshDispatcher
            ?: return denied(ApiDenialReason.REFRESH_UNAVAILABLE, "No viewer refresh scheduling boundary is available")
        return viewerFacts.publish(
            owner = callerPluginName,
            viewerId = viewerId,
            key = key,
            value = value,
            catalog = presentation,
            stillAvailable = { viewerAvailable(viewerId) },
            ownerLease = viewerFactOwner,
            acceptSemanticRefresh = { bestEffortDispatch { dispatcher.dispatch(viewerId) } },
        )
            .toApiResult(viewerId, key)
    }

    @Synchronized
    override fun clearViewerFact(
        viewerId: UUID,
        key: ItemKey,
    ): ApiCallResult<ViewerFactReceipt> {
        activeCallerDenial()?.let { return it }
        if (!viewerAvailable(viewerId)) {
            return denied(ApiDenialReason.INVALID_VALUE, "The viewer is not currently published by Itemerness")
        }
        val snapshot = snapshotProvider()
            ?: return denied(ApiDenialReason.ITEM_NOT_FOUND, "No catalog is active")
        viewerFactActionDenial(key, snapshot)?.let { return it }
        val presentation = snapshot.runtime?.presentation ?: presentationProvider()
            ?: return denied(ApiDenialReason.ITEM_NOT_FOUND, "No presentation catalog is active")
        val dispatcher = viewerRefreshDispatcher
            ?: return denied(ApiDenialReason.REFRESH_UNAVAILABLE, "No viewer refresh scheduling boundary is available")
        return viewerFacts.clear(
            owner = callerPluginName,
            viewerId = viewerId,
            key = key,
            catalog = presentation,
            stillAvailable = { viewerAvailable(viewerId) },
            ownerLease = viewerFactOwner,
            acceptSemanticRefresh = { bestEffortDispatch { dispatcher.dispatch(viewerId) } },
        )
            .toApiResult(viewerId, key)
    }

    private fun activeCallerDenial(): ApiCallResult.Denied? = when {
        closed -> denied(ApiDenialReason.CALLER_NOT_ACTIVE, "The bound Bukkit plugin lifecycle has retired")
        !serviceActive() -> denied(ApiDenialReason.CALLER_NOT_ACTIVE, "The Itemerness Bukkit service is closed")
        !caller.isActive() -> denied(ApiDenialReason.CALLER_NOT_ACTIVE, "The bound Bukkit plugin lifecycle has retired")
        !viewerFacts.isOwnerActive(viewerFactOwner) -> denied(
            ApiDenialReason.CALLER_NOT_ACTIVE,
            "The bound Bukkit plugin lifecycle has retired",
        )
        else -> null
    }

    @Synchronized
    fun isBindingActive(): Boolean =
        !closed && serviceActive() && caller.isActive() && viewerFacts.isOwnerActive(viewerFactOwner)

    override fun close() = completeRetiredSlotEdits(beginRetirement())

    fun beginRetirement(): List<CompletableFuture<ApiCallResult<BukkitSlotEditReceipt>>> = synchronized(this) {
        if (closed) return@synchronized emptyList()
        closed = true
        domainHandles.clear()
        pendingSlotEdits.toList().also { pendingSlotEdits.clear() }
    }

    private fun completeOwnedSlotEdit(
        completion: CompletableFuture<ApiCallResult<BukkitSlotEditReceipt>>,
        action: () -> ApiCallResult<BukkitSlotEditReceipt>,
    ) {
        var result: ApiCallResult<BukkitSlotEditReceipt>? = null
        var failure: Throwable? = null
        val claimed = synchronized(this) {
            if (completion !in pendingSlotEdits) return@synchronized false
            if (completion.isDone) {
                pendingSlotEdits.remove(completion)
                return@synchronized false
            }
            try {
                result = action()
            } catch (caught: Throwable) {
                failure = caught
            } finally {
                pendingSlotEdits.remove(completion)
            }
            true
        }
        if (!claimed) return

        try {
            slotCompletionHandoff.beforeComplete()
        } catch (handoffFailure: Throwable) {
            completion.completeExceptionally(handoffFailure)
            if (handoffFailure is Error) throw handoffFailure
            return
        }
        failure?.let { caught ->
            completion.completeExceptionally(caught)
            if (caught is Error) throw caught
            return
        }
        completion.complete(checkNotNull(result))
    }

    private fun completeRetiredSlotEdit(
        completion: CompletableFuture<ApiCallResult<BukkitSlotEditReceipt>>,
    ) {
        val claimed = synchronized(this) { pendingSlotEdits.remove(completion) }
        if (!claimed) return
        completion.complete(
            denied(
                ApiDenialReason.OWNER_CONTEXT_REQUIRED,
                "The player retired before the slot transaction entered its owning context",
            ),
        )
    }

    private fun actionDenial(
        action: ApiAction,
        key: ItemKey,
        snapshot: ApiCatalogState?,
    ): ApiCallResult.Denied? =
        if (
            snapshot?.accessPolicy?.decide(callerPluginName, action, key.namespace) !=
            AccessDecision.ALLOW
        ) {
            denied(ApiDenialReason.ACTION_DENIED, "${action.name.lowercase()} is not granted for ${key.namespace}")
        } else {
            null
        }

    private fun viewerFactActionDenial(
        key: ItemKey,
        snapshot: ApiCatalogState,
    ): ApiCallResult.Denied? =
        if (
            snapshot.accessPolicy.decide(
                callerPluginName,
                ApiAction.WRITE_VIEWER_FACT,
                key.namespace,
            ) != AccessDecision.ALLOW
        ) {
            denied(
                ApiDenialReason.VIEWER_FACT_WRITE_DENIED,
                "Viewer-fact writes are not granted for ${key.namespace}",
            )
        } else {
            null
        }

    private fun prepareItemEdit(
        source: ItemStack,
        mutations: Collection<ItemDataMutation>,
        snapshot: ApiCatalogState,
    ): ApiCallResult<PreparedBukkitItemEdit> {
        if (mutations.isEmpty()) {
            return denied(ApiDenialReason.INVALID_VALUE, "At least one data mutation is required")
        }
        val managed = when (val inspected = inspectManaged(source, snapshot)) {
            is ApiCallResult.Denied -> return inspected
            is ApiCallResult.Success -> inspected.value
                ?: return denied(ApiDenialReason.INVALID_MANAGED_ITEM, "The stack is not managed by Itemerness")
        }
        val authorizer = snapshot.authorizer(ownerPlugin)
            ?: return denied(ApiDenialReason.DATA_KEY_NOT_FOUND, "No data access rules are active")
        mutations.forEach { mutation ->
            if (snapshot.domain.dataKeyDefinition(managed.instance.itemKey, mutation.key) == null) {
                return denied(
                    ApiDenialReason.DATA_KEY_NOT_FOUND,
                    "The data key is not defined for ${managed.instance.itemKey}",
                )
            }
            when (val authorization = authorizer.authorizeInstanceWrite(caller, managed.instance.itemKey, mutation.key)) {
                is ApiCallResult.Denied -> return authorization
                is ApiCallResult.Success -> Unit
            }
        }
        val runtime = snapshot.runtime
            ?: return platformUnavailable()
        val itemBridge = bridge
            ?: return platformUnavailable()
        return try {
            val edited = snapshot.domain.editInstance(
                managed.instance,
                mutations.map(ItemDataMutation::toCoreMutation),
            )
            val semanticChanged = edited !== managed.instance
            val rewritten = if (semanticChanged) {
                itemBridge.rewrite(
                    source = source,
                    definition = managed.definition,
                    instance = edited,
                    pendingName = runtime.pendingItemName(managed.instance.itemKey),
                )
            } else {
                source.clone()
            }
            ApiCallResult.Success(
                PreparedBukkitItemEdit(
                    managed = managed,
                    edited = edited,
                    rewritten = rewritten,
                    semanticChanged = semanticChanged,
                ),
            )
        } catch (failure: RuntimeException) {
            denied(ApiDenialReason.INVALID_VALUE, failure.message ?: "The canonical item could not be edited")
        }
    }

    private fun editPlayerSlotOwned(
        player: Player,
        slot: BukkitPlayerSlot,
        mutations: List<ItemDataMutation>,
    ): ApiCallResult<BukkitSlotEditReceipt> {
        activeCallerDenial()?.let { return it }
        val snapshot = snapshotProvider()
            ?: return denied(ApiDenialReason.ITEM_NOT_FOUND, "No catalog is active")
        val runtime = snapshot.runtime
            ?: return platformUnavailable()
        val itemBridge = bridge
            ?: return platformUnavailable()
        val committer = catalogCommitter
            ?: return platformUnavailable()
        val source = readPlayerSlot(player.inventory, slot)?.clone()
            ?: return denied(ApiDenialReason.INVALID_MANAGED_ITEM, "The selected player slot is empty")
        val prepared = when (val result = prepareItemEdit(source, mutations, snapshot)) {
            is ApiCallResult.Denied -> return result
            is ApiCallResult.Success -> result.value
        }
        val viewerId = player.uniqueId
        if (prepared.semanticChanged) {
            val dispatcher = viewerRefreshDispatcher
                ?: return denied(
                    ApiDenialReason.REFRESH_UNAVAILABLE,
                    "No viewer refresh scheduling boundary is available",
                )
            if (!viewerAvailable(viewerId) || !bestEffortDispatch { dispatcher.dispatch(viewerId) }) {
                return denied(
                    ApiDenialReason.REFRESH_UNAVAILABLE,
                    "The immediate viewer refresh could not be reserved",
                )
            }
        }

        val committed = try {
            committer.commit(runtime) {
                activeCallerDenial()?.let { throw CallerRetiredDuringSlotEditException() }
                val current = readPlayerSlot(player.inventory, slot)?.clone()
                    ?: throw SlotChangedDuringEditException()
                if (!samePhysicalItemStack(source, current)) {
                    throw SlotChangedDuringEditException()
                }
                if (prepared.semanticChanged) {
                    writePlayerSlot(player.inventory, slot, prepared.rewritten.clone())
                }
            }
        } catch (_: SlotChangedDuringEditException) {
            return denied(
                ApiDenialReason.SLOT_CONFLICT,
                "The player slot changed before the transaction could commit",
            )
        } catch (_: CallerRetiredDuringSlotEditException) {
            return denied(ApiDenialReason.CALLER_NOT_ACTIVE, "The bound plugin lifecycle retired before commit")
        } catch (failure: RuntimeException) {
            return denied(ApiDenialReason.INVALID_VALUE, failure.message ?: "The player slot could not be edited")
        }
        if (!committed) {
            return denied(
                ApiDenialReason.CATALOG_CONFLICT,
                "The catalog changed before the slot transaction could commit",
            )
        }
        return ApiCallResult.Success(
            BukkitSlotEditReceipt(
                playerId = viewerId,
                slot = slot,
                identity = prepared.toIdentity(),
                catalogRevision = runtime.domain.revision,
                semanticChanged = prepared.semanticChanged,
            ),
        )
    }

    private fun inspectManaged(
        source: ItemStack,
        snapshot: ApiCatalogState,
    ): ApiCallResult<RestoredBukkitItem?> {
        val runtime = snapshot.runtime
            ?: return platformUnavailable()
        val itemBridge = bridge
            ?: return platformUnavailable()
        val inspection = try {
            itemBridge.inspect(source)
        } catch (failure: RuntimeException) {
            return denied(
                ApiDenialReason.INVALID_MANAGED_ITEM,
                failure.message ?: "The canonical item could not be inspected",
            )
        }
        return when (inspection) {
            CanonicalItemInspection.Unmanaged -> ApiCallResult.Success(null)
            is CanonicalItemInspection.InvalidManaged -> denied(
                ApiDenialReason.INVALID_MANAGED_ITEM,
                inspection.reason,
            )

            is CanonicalItemInspection.Managed -> when (
                val restored = CanonicalDomainMapper.restore(inspection.snapshot, runtime)
            ) {
                is CanonicalDomainResult.Invalid -> denied(
                    ApiDenialReason.INVALID_MANAGED_ITEM,
                    restored.reason,
                )

                is CanonicalDomainResult.Valid -> if (
                    restored.definition.instanceMode == ItemInstanceMode.UNIQUE &&
                    inspection.snapshot.count != 1
                ) {
                    denied(
                        ApiDenialReason.INVALID_MANAGED_ITEM,
                        "A unique managed item cannot be stacked",
                    )
                } else {
                    ApiCallResult.Success(
                        RestoredBukkitItem(
                            definition = restored.definition,
                            instance = restored.instance,
                            canonical = inspection.snapshot,
                        ),
                    )
                }
            }
        }
    }

    private fun platformUnavailable(): ApiCallResult.Denied = denied(
        ApiDenialReason.PLATFORM_ACCESS_UNAVAILABLE,
        "The Bukkit canonical item bridge is unavailable",
    )

    private fun denied(
        reason: ApiDenialReason,
        detail: String,
    ): ApiCallResult.Denied = ApiCallResult.Denied(reason, detail)

    companion object {
        private const val MAX_PENDING_SLOT_EDITS = 4_096

        fun completeRetiredSlotEdits(
            pending: Collection<CompletableFuture<ApiCallResult<BukkitSlotEditReceipt>>>,
        ) {
            if (pending.isEmpty()) return
            val denial = ApiCallResult.Denied(
                ApiDenialReason.CALLER_NOT_ACTIVE,
                "The bound Bukkit plugin lifecycle retired before the slot transaction completed",
            )
            pending.forEach { completion -> completion.complete(denial) }
        }
    }
}

private fun ViewerFactMutationResult.toApiResult(
    viewerId: UUID,
    key: ItemKey,
): ApiCallResult<ViewerFactReceipt> = when (this) {
    is ViewerFactMutationResult.Applied -> ApiCallResult.Success(
        ViewerFactReceipt(
            viewerId = viewerId,
            key = key,
            viewerFactRevision = snapshot.revision,
            semanticChanged = semanticChanged,
        ),
    )

    is ViewerFactMutationResult.Rejected -> ApiCallResult.Denied(
        reason = when (failure.code) {
            ViewerFactValidationCode.UNKNOWN_FACT -> ApiDenialReason.VIEWER_FACT_NOT_FOUND
            ViewerFactValidationCode.PROVIDER_NOT_ALLOWED -> ApiDenialReason.VIEWER_FACT_WRITE_DENIED
            ViewerFactValidationCode.OWNER_NOT_ACTIVE -> ApiDenialReason.CALLER_NOT_ACTIVE
            ViewerFactValidationCode.REFRESH_REJECTED -> ApiDenialReason.REFRESH_UNAVAILABLE
            ViewerFactValidationCode.TYPE_MISMATCH,
            ViewerFactValidationCode.CONSTRAINT_VIOLATION,
            ViewerFactValidationCode.STALE_CATALOG,
            -> ApiDenialReason.INVALID_VALUE
        },
        detail = failure.detail,
    )
}

private data class ApiCatalogState(
    val domain: CatalogSnapshot,
    val accessPolicy: AccessPolicy,
    val dataAccessRules: DataAccessRuleIndex?,
    val runtime: RuntimeCatalogSnapshot?,
)

private data class RestoredBukkitItem(
    val definition: ItemDefinition,
    val instance: CanonicalItemInstance,
    val canonical: CanonicalItemSnapshot,
) {
    fun toIdentity(): BukkitItemIdentity = BukkitItemIdentity(
        itemKey = instance.itemKey,
        material = definition.material,
        amount = canonical.count,
        instanceId = instance.instanceId,
        createdAgainstRevision = instance.createdAgainstRevision,
        instanceRevision = instance.instanceRevision,
    )
}

private data class PreparedBukkitItemEdit(
    val managed: RestoredBukkitItem,
    val edited: CanonicalItemInstance,
    val rewritten: ItemStack,
    val semanticChanged: Boolean,
) {
    fun toIdentity(): BukkitItemIdentity = BukkitItemIdentity(
        itemKey = edited.itemKey,
        material = managed.definition.material,
        amount = managed.canonical.count,
        instanceId = edited.instanceId,
        createdAgainstRevision = edited.createdAgainstRevision,
        instanceRevision = edited.instanceRevision,
    )
}

private class SlotChangedDuringEditException : RuntimeException()

private class CallerRetiredDuringSlotEditException : RuntimeException()

private fun readPlayerSlot(
    inventory: PlayerInventory,
    slot: BukkitPlayerSlot,
): ItemStack? = when (slot) {
    BukkitPlayerSlot.MAIN_HAND -> inventory.itemInMainHand
    BukkitPlayerSlot.OFF_HAND -> inventory.itemInOffHand
    BukkitPlayerSlot.HELMET -> inventory.helmet
    BukkitPlayerSlot.CHESTPLATE -> inventory.chestplate
    BukkitPlayerSlot.LEGGINGS -> inventory.leggings
    BukkitPlayerSlot.BOOTS -> inventory.boots
}

private fun writePlayerSlot(
    inventory: PlayerInventory,
    slot: BukkitPlayerSlot,
    stack: ItemStack,
) {
    when (slot) {
        BukkitPlayerSlot.MAIN_HAND -> inventory.setItemInMainHand(stack)
        BukkitPlayerSlot.OFF_HAND -> inventory.setItemInOffHand(stack)
        BukkitPlayerSlot.HELMET -> inventory.setHelmet(stack)
        BukkitPlayerSlot.CHESTPLATE -> inventory.setChestplate(stack)
        BukkitPlayerSlot.LEGGINGS -> inventory.setLeggings(stack)
        BukkitPlayerSlot.BOOTS -> inventory.setBoots(stack)
    }
}

/** Per-facade bounded capability table; canonical values never cross the public API boundary. */
private class DomainHandleStore(
    private val capacity: Int = DEFAULT_CAPACITY,
) {
    private val retained = LinkedHashMap<UUID, CanonicalItemInstance>(16, 0.75f, true)

    init {
        require(capacity > 0) { "Domain handle capacity must be positive" }
    }

    @Synchronized
    fun issue(instance: CanonicalItemInstance): DomainItemInstance {
        var handleId: UUID
        do {
            handleId = UUID.randomUUID()
        } while (handleId in retained)
        retained[handleId] = instance
        while (retained.size > capacity) {
            retained.entries.iterator().also { iterator ->
                iterator.next()
                iterator.remove()
            }
        }
        return DomainItemInstance(
            handleId = handleId,
            itemKey = instance.itemKey,
            createdAgainstRevision = instance.createdAgainstRevision,
            instanceRevision = instance.instanceRevision,
        )
    }

    @Synchronized
    fun resolve(handle: DomainItemInstance): CanonicalItemInstance? =
        retained[handle.handleId]?.takeIf { instance ->
            instance.itemKey == handle.itemKey &&
                instance.createdAgainstRevision == handle.createdAgainstRevision &&
                instance.instanceRevision == handle.instanceRevision
        }

    @Synchronized
    fun clear() {
        retained.clear()
    }

    private companion object {
        const val DEFAULT_CAPACITY = 4_096
    }
}

private fun ApiCatalogState.authorizer(ownerPlugin: Plugin): DataAccessAuthorizer? =
    dataAccessRules?.let { rules -> DataAccessAuthorizer(ownerPlugin, accessPolicy, rules) }

private fun RuntimeCatalogSnapshot.pendingItemName(key: ItemKey): PendingItemName =
    PendingItemName(
        text = settings.pendingName(key),
        colorRgb = settings.pendingNameColorRgb,
    )

private fun CatalogSnapshot.restore(instance: CanonicalItemInstance): CanonicalItemInstance = restoreInstance(
    itemKey = instance.itemKey,
    createdAgainstRevision = instance.createdAgainstRevision,
    instanceRevision = instance.instanceRevision,
    schemaVersions = instance.schemaVersions,
    instanceId = instance.instanceId,
    data = instance.data,
)

private fun ItemDataMutation.toCoreMutation(): InstanceDataMutation = when (this) {
    is ItemDataMutation.Set -> InstanceDataMutation.Set(key, value)
    is ItemDataMutation.Unset -> InstanceDataMutation.Remove(key)
}
