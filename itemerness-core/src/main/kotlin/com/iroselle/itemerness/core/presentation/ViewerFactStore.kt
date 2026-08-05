package com.iroselle.itemerness.core.presentation

import com.iroselle.itemerness.api.BooleanDataValue
import com.iroselle.itemerness.api.DecimalDataValue
import com.iroselle.itemerness.api.IntegerDataValue
import com.iroselle.itemerness.api.ItemDataValue
import com.iroselle.itemerness.api.ItemKey
import com.iroselle.itemerness.api.LongDataValue
import com.iroselle.itemerness.api.NamespacedKeyDataValue
import com.iroselle.itemerness.api.StringDataValue
import com.iroselle.itemerness.api.UuidDataValue
import java.util.Collections
import java.util.Locale
import java.util.TreeMap
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

enum class ViewerFactValidationCode {
    UNKNOWN_FACT,
    PROVIDER_NOT_ALLOWED,
    TYPE_MISMATCH,
    CONSTRAINT_VIOLATION,
    OWNER_NOT_ACTIVE,
    STALE_CATALOG,
    REFRESH_REJECTED,
}

data class ViewerFactValidationFailure(
    val code: ViewerFactValidationCode,
    val detail: String,
)

sealed interface ViewerFactMutationResult {
    data class Applied(
        val snapshot: ApiViewerFactSnapshot,
        val semanticChanged: Boolean,
    ) : ViewerFactMutationResult

    data class Rejected(
        val failure: ViewerFactValidationFailure,
    ) : ViewerFactMutationResult
}

/** Opaque lease tying fact mutations to one concrete plugin lifecycle generation. */
class ViewerFactOwnerLease internal constructor(
    val owner: String,
)

/** Immutable resolved contribution from the `api` viewer-fact provider. */
class ApiViewerFactSnapshot internal constructor(
    val viewerId: UUID,
    val revision: Long,
    values: Map<ItemKey, ItemDataValue>,
) {
    val values: Map<ItemKey, ItemDataValue> = Collections.unmodifiableMap(TreeMap(values))

    init {
        require(revision >= 0) { "Viewer fact revision must not be negative" }
    }

    operator fun get(key: ItemKey): ItemDataValue? = values[key]

    override fun equals(other: Any?): Boolean =
        this === other ||
            other is ApiViewerFactSnapshot &&
            viewerId == other.viewerId &&
            revision == other.revision &&
            values == other.values

    override fun hashCode(): Int {
        var result = viewerId.hashCode()
        result = 31 * result + revision.hashCode()
        result = 31 * result + values.hashCode()
        return result
    }

    override fun toString(): String =
        "ApiViewerFactSnapshot(viewerId=$viewerId, revision=$revision, values=$values)"
}

/**
 * Thread-safe ownership and conflict resolution for values published through the API provider.
 *
 * Every plugin owns one contribution per viewer and key. The most recently accepted publication
 * wins; removing it reveals the next most recent contribution. Revisions and listeners advance
 * only when the resolved value map changes, not when ownership metadata alone changes.
 */
class ViewerFactStore(
    private val viewerCapacity: Int = DEFAULT_VIEWER_CAPACITY,
) : AutoCloseable {
    private val lock = ReentrantLock()
    private val contributions = HashMap<UUID, MutableMap<ItemKey, MutableMap<String, Contribution>>>()
    private val snapshots = HashMap<UUID, ApiViewerFactSnapshot>()
    private val listeners = CopyOnWriteArrayList<(UUID) -> Unit>()
    private val ownerStates = HashMap<String, OwnerState>()
    private var activeCatalog: PresentationCatalogSnapshot? = null
    private var sequence = 0L
    private var closed = false

    init {
        require(viewerCapacity > 0) { "Viewer fact capacity must be positive" }
    }

    fun publish(
        owner: String,
        viewerId: UUID,
        key: ItemKey,
        value: ItemDataValue,
        catalog: PresentationCatalogSnapshot,
        stillAvailable: () -> Boolean = { true },
        ownerLease: ViewerFactOwnerLease? = null,
        acceptSemanticRefresh: () -> Boolean = { true },
    ): ViewerFactMutationResult {
        require(owner.isNotBlank()) { "Viewer fact owner must not be blank" }

        val outcome = lock.withLock {
            if (closed) return inactiveStore()
            validateOwnerLocked(owner, ownerLease)?.let { return ViewerFactMutationResult.Rejected(it) }
            val currentCatalog = mutationCatalogLocked(catalog)
                ?: return staleCatalog(catalog.revision)
            val normalized = normalizeApiViewerFactValue(currentCatalog, key, value)
            validateApiViewerFact(currentCatalog, key, normalized)?.let {
                return ViewerFactMutationResult.Rejected(it)
            }
            if (!stillAvailable()) return unavailableViewer(viewerId)
            if (viewerId !in snapshots && viewerId !in contributions && snapshots.size >= viewerCapacity) {
                return ViewerFactMutationResult.Rejected(
                    ViewerFactValidationFailure(
                        ViewerFactValidationCode.CONSTRAINT_VIOLATION,
                        "Viewer fact store reached its bounded capacity of $viewerCapacity viewers",
                    ),
                )
            }
            if (sequence == Long.MAX_VALUE) compactSequences()
            val before = snapshotLocked(viewerId)
            val previousSnapshot = snapshots[viewerId]
            val previousContribution = contributions[viewerId]?.get(key)?.get(owner)
            val previousSequence = sequence
            contributions
                .getOrPut(viewerId, ::HashMap)
                .getOrPut(key, ::HashMap)[owner] = Contribution(normalized, ++sequence)
            val update = updateSnapshotLocked(viewerId, before)
            if (update.changed) {
                val accepted = try {
                    acceptSemanticRefresh()
                } catch (failure: Throwable) {
                    restoreContributionLocked(owner, viewerId, key, previousContribution)
                    restoreSnapshotLocked(viewerId, previousSnapshot)
                    sequence = previousSequence
                    throw failure
                }
                if (!accepted) {
                    restoreContributionLocked(owner, viewerId, key, previousContribution)
                    restoreSnapshotLocked(viewerId, previousSnapshot)
                    sequence = previousSequence
                    return refreshRejected(viewerId)
                }
            }
            update
        }
        notifyIfChanged(outcome)
        return ViewerFactMutationResult.Applied(outcome.snapshot, outcome.changed)
    }

    fun clear(
        owner: String,
        viewerId: UUID,
        key: ItemKey,
        catalog: PresentationCatalogSnapshot,
        stillAvailable: () -> Boolean = { true },
        ownerLease: ViewerFactOwnerLease? = null,
        acceptSemanticRefresh: () -> Boolean = { true },
    ): ViewerFactMutationResult {
        require(owner.isNotBlank()) { "Viewer fact owner must not be blank" }

        val outcome = lock.withLock {
            if (closed) return inactiveStore()
            validateOwnerLocked(owner, ownerLease)?.let { return ViewerFactMutationResult.Rejected(it) }
            val currentCatalog = mutationCatalogLocked(catalog)
                ?: return staleCatalog(catalog.revision)
            validateApiViewerFact(currentCatalog, key, null)?.let {
                return ViewerFactMutationResult.Rejected(it)
            }
            if (!stillAvailable()) return unavailableViewer(viewerId)
            val before = snapshotLocked(viewerId)
            val previousSnapshot = snapshots[viewerId]
            val previousContribution = contributions[viewerId]?.get(key)?.get(owner)
            removeContributionLocked(owner, viewerId, key)
            val update = updateSnapshotLocked(viewerId, before)
            if (update.changed) {
                val accepted = try {
                    acceptSemanticRefresh()
                } catch (failure: Throwable) {
                    restoreContributionLocked(owner, viewerId, key, previousContribution)
                    restoreSnapshotLocked(viewerId, previousSnapshot)
                    throw failure
                }
                if (!accepted) {
                    restoreContributionLocked(owner, viewerId, key, previousContribution)
                    restoreSnapshotLocked(viewerId, previousSnapshot)
                    return refreshRejected(viewerId)
                }
            }
            update
        }
        notifyIfChanged(outcome)
        return ViewerFactMutationResult.Applied(outcome.snapshot, outcome.changed)
    }

    /** Returns one stable lease for a concrete plugin object until that lifecycle retires. */
    fun bindOwner(owner: String, identity: Any): ViewerFactOwnerLease {
        require(owner.isNotBlank()) { "Viewer fact owner must not be blank" }
        val (lease, outcomes) = lock.withLock {
            check(!closed) { "Viewer fact store is closed" }
            val current = ownerStates[owner]
            if (current?.identity === identity) return current.lease
            val cleared = clearOwnerContributionsLocked(owner)
            val created = ViewerFactOwnerLease(owner)
            ownerStates[owner] = OwnerState(identity, created, active = true)
            created to cleared
        }
        outcomes.forEach(::notifyIfChanged)
        return lease
    }

    /** Opens a fresh generation only from the platform's explicit plugin-enable event. */
    fun activateOwner(owner: String, identity: Any): ViewerFactOwnerLease {
        require(owner.isNotBlank()) { "Viewer fact owner must not be blank" }
        val (lease, outcomes) = lock.withLock {
            check(!closed) { "Viewer fact store is closed" }
            val current = ownerStates[owner]
            if (current?.identity === identity && current.active) return current.lease
            val cleared = clearOwnerContributionsLocked(owner)
            val created = ViewerFactOwnerLease(owner)
            ownerStates[owner] = OwnerState(identity, created, active = true)
            created to cleared
        }
        outcomes.forEach(::notifyIfChanged)
        return lease
    }

    fun isOwnerActive(lease: ViewerFactOwnerLease): Boolean = lock.withLock {
        val state = ownerStates[lease.owner]
        !closed && state?.lease === lease && state.active
    }

    /** Removes every contribution owned by a retiring plugin and reveals any fallbacks. */
    fun clearOwner(
        owner: String,
        identity: Any? = null,
    ): List<ApiViewerFactSnapshot> {
        val outcomes = lock.withLock {
            if (closed) return emptyList()
            val state = ownerStates[owner]
            if (identity != null && state != null && state.identity !== identity) return emptyList()
            if (state != null && (identity == null || state.identity === identity)) {
                state.active = false
            }
            clearOwnerContributionsLocked(owner)
        }
        outcomes.forEach(::notifyIfChanged)
        return outcomes.filter(ViewerFactUpdate::changed).map(ViewerFactUpdate::snapshot)
    }

    /** Drops all state for a viewer whose Bukkit entity has retired. */
    fun clearViewer(viewerId: UUID) {
        lock.withLock {
            contributions.remove(viewerId)
            snapshots.remove(viewerId)
        }
    }

    /**
     * Removes contributions no longer valid under a newly published presentation catalog.
     * Returning snapshots identify only viewers whose resolved API facts changed.
     */
    fun reconcile(
        catalog: PresentationCatalogSnapshot,
        contributionAllowed: (owner: String, key: ItemKey) -> Boolean = { _, _ -> true },
    ): List<ApiViewerFactSnapshot> {
        val prepared = prepareReconcile(catalog, contributionAllowed, strict = false)
        val changed = prepared.commit()
        val notificationFailures = prepared.complete()
        if (notificationFailures.isNotEmpty()) {
            val failure = IllegalStateException("Viewer fact reconciliation listener failed")
            notificationFailures.forEach(failure::addSuppressed)
            throw failure
        }
        return changed
    }

    /**
     * Computes reconciliation only at commit time under the mutation lock. Preparation is side
     * effect free; commit swaps a fully built contribution/snapshot state before releasing the
     * lock, and listener delivery is deferred until the surrounding catalog transaction completes.
     */
    fun prepareReconcile(
        catalog: PresentationCatalogSnapshot,
        contributionAllowed: (owner: String, key: ItemKey) -> Boolean = { _, _ -> true },
    ): PreparedViewerFactReconciliation {
        return prepareReconcile(catalog, contributionAllowed, strict = true)
    }

    private fun prepareReconcile(
        catalog: PresentationCatalogSnapshot,
        contributionAllowed: (owner: String, key: ItemKey) -> Boolean,
        strict: Boolean,
    ): PreparedViewerFactReconciliation {
        lock.withLock {
            if (closed) {
                check(!strict) { "Viewer fact store is closed" }
                return PreparedViewerFactReconciliation.noOp()
            }
            val current = activeCatalog
            if (current != null && catalog.revision < current.revision) {
                return PreparedViewerFactReconciliation.noOp()
            }
            if (current != null && catalog.revision == current.revision && catalog !== current) {
                return PreparedViewerFactReconciliation.noOp()
            }
        }
        return PreparedViewerFactReconciliation(
            commitAction = {
                lock.withLock {
                    if (closed) {
                        check(!strict) { "Viewer fact store is closed" }
                        return@withLock emptyList()
                    }
                    val current = activeCatalog
                    if (current != null && catalog.revision < current.revision) {
                        check(!strict) { "Viewer fact catalog changed after reconciliation preparation" }
                        return@withLock emptyList()
                    }
                    if (current != null && catalog.revision == current.revision && catalog !== current) {
                        check(!strict) {
                            "A different viewer fact catalog already owns revision ${catalog.revision}"
                        }
                        return@withLock emptyList()
                    }
                    if (current === catalog) {
                        emptyList()
                    } else {
                        val proposal = reconciliationProposalLocked(catalog, contributionAllowed)
                        contributions.clear()
                        contributions.putAll(proposal.contributions)
                        snapshots.clear()
                        snapshots.putAll(proposal.snapshots)
                        activeCatalog = catalog
                        proposal.changed
                    }
                }
            },
            completionAction = { changed ->
                val failures = ArrayList<Throwable>()
                changed.forEach { snapshot ->
                    listeners.forEach { listener ->
                        try {
                            listener(snapshot.viewerId)
                        } catch (failure: Exception) {
                            failures += failure
                        }
                    }
                }
                failures
            },
        )
    }

    fun snapshot(viewerId: UUID): ApiViewerFactSnapshot = lock.withLock {
        snapshotLocked(viewerId)
    }

    /** The returned handle removes only this listener and is safe to close repeatedly. */
    fun listen(listener: (UUID) -> Unit): AutoCloseable {
        lock.withLock {
            check(!closed) { "Viewer fact store is closed" }
            listeners += listener
        }
        return AutoCloseable { listeners.remove(listener) }
    }

    override fun close() {
        lock.withLock {
            if (closed) return
            closed = true
            contributions.clear()
            snapshots.clear()
            ownerStates.clear()
            activeCatalog = null
        }
        listeners.clear()
    }

    private fun removeContributionLocked(owner: String, viewerId: UUID, key: ItemKey) {
        val byKey = contributions[viewerId] ?: return
        val owners = byKey[key] ?: return
        owners.remove(owner)
        if (owners.isEmpty()) byKey.remove(key)
        if (byKey.isEmpty()) contributions.remove(viewerId)
    }

    private fun restoreContributionLocked(
        owner: String,
        viewerId: UUID,
        key: ItemKey,
        previous: Contribution?,
    ) {
        if (previous == null) {
            removeContributionLocked(owner, viewerId, key)
        } else {
            contributions
                .getOrPut(viewerId, ::HashMap)
                .getOrPut(key, ::HashMap)[owner] = previous
        }
    }

    private fun restoreSnapshotLocked(
        viewerId: UUID,
        previous: ApiViewerFactSnapshot?,
    ) {
        if (previous == null) snapshots.remove(viewerId) else snapshots[viewerId] = previous
    }

    private fun unavailableViewer(viewerId: UUID): ViewerFactMutationResult.Rejected =
        ViewerFactMutationResult.Rejected(
            ViewerFactValidationFailure(
                ViewerFactValidationCode.CONSTRAINT_VIOLATION,
                "Viewer $viewerId is no longer available for fact publication",
            ),
        )

    private fun staleCatalog(expectedRevision: Long): ViewerFactMutationResult.Rejected =
        ViewerFactMutationResult.Rejected(
            ViewerFactValidationFailure(
                ViewerFactValidationCode.STALE_CATALOG,
                "Viewer fact catalog changed while publishing revision $expectedRevision",
            ),
        )

    private fun refreshRejected(viewerId: UUID): ViewerFactMutationResult.Rejected =
        ViewerFactMutationResult.Rejected(
            ViewerFactValidationFailure(
                ViewerFactValidationCode.REFRESH_REJECTED,
                "Immediate projection refresh was rejected for viewer $viewerId",
            ),
        )

    private fun inactiveStore(): ViewerFactMutationResult.Rejected =
        ViewerFactMutationResult.Rejected(
            ViewerFactValidationFailure(
                ViewerFactValidationCode.OWNER_NOT_ACTIVE,
                "Viewer fact store is closed",
            ),
        )

    private fun mutationCatalogLocked(expected: PresentationCatalogSnapshot): PresentationCatalogSnapshot? {
        val current = activeCatalog
        if (current == null) {
            activeCatalog = expected
            return expected
        }
        return current.takeIf { it === expected }
    }

    private fun validateOwnerLocked(
        owner: String,
        lease: ViewerFactOwnerLease?,
    ): ViewerFactValidationFailure? {
        if (lease == null) return null
        val state = ownerStates[owner]
        return if (lease.owner != owner || state?.lease !== lease || !state.active) {
            ViewerFactValidationFailure(
                ViewerFactValidationCode.OWNER_NOT_ACTIVE,
                "Viewer fact owner $owner is no longer active",
            )
        } else {
            null
        }
    }

    private fun clearOwnerContributionsLocked(owner: String): List<ViewerFactUpdate> =
        contributions.keys.toList().mapNotNull { viewerId ->
            val before = snapshotLocked(viewerId)
            val byKey = contributions[viewerId] ?: return@mapNotNull null
            var removed = false
            byKey.keys.toList().forEach { key ->
                val owners = byKey[key] ?: return@forEach
                removed = owners.remove(owner) != null || removed
                if (owners.isEmpty()) byKey.remove(key)
            }
            if (!removed) return@mapNotNull null
            if (byKey.isEmpty()) contributions.remove(viewerId)
            updateSnapshotLocked(viewerId, before)
        }

    private fun snapshotLocked(viewerId: UUID): ApiViewerFactSnapshot =
        snapshots[viewerId] ?: ApiViewerFactSnapshot(viewerId, 0, emptyMap())

    private fun updateSnapshotLocked(
        viewerId: UUID,
        before: ApiViewerFactSnapshot,
    ): ViewerFactUpdate {
        val resolved = TreeMap<ItemKey, ItemDataValue>()
        contributions[viewerId]?.forEach { (key, owners) ->
            owners.values.maxByOrNull(Contribution::sequence)?.let { resolved[key] = it.value }
        }
        if (resolved == before.values) {
            if (before.values.isNotEmpty() || contributions.containsKey(viewerId)) snapshots[viewerId] = before
            return ViewerFactUpdate(before, false)
        }
        check(before.revision != Long.MAX_VALUE) { "Viewer fact revision is exhausted for $viewerId" }
        val after = ApiViewerFactSnapshot(viewerId, before.revision + 1, resolved)
        snapshots[viewerId] = after
        return ViewerFactUpdate(after, true)
    }

    private fun reconciliationProposalLocked(
        catalog: PresentationCatalogSnapshot,
        contributionAllowed: (owner: String, key: ItemKey) -> Boolean,
    ): ReconciliationProposal {
        val nextContributions = HashMap<UUID, MutableMap<ItemKey, MutableMap<String, Contribution>>>()
        val nextSnapshots = HashMap(snapshots)
        val changed = ArrayList<ApiViewerFactSnapshot>()
        contributions.forEach { (viewerId, byKey) ->
            val filteredByKey = HashMap<ItemKey, MutableMap<String, Contribution>>()
            byKey.forEach { (key, owners) ->
                val filteredOwners = HashMap<String, Contribution>()
                owners.forEach { (owner, contribution) ->
                    if (
                        contributionAllowed(owner, key) &&
                        validateApiViewerFact(catalog, key, contribution.value) == null
                    ) {
                        filteredOwners[owner] = contribution
                    }
                }
                if (filteredOwners.isNotEmpty()) filteredByKey[key] = filteredOwners
            }
            if (filteredByKey.isNotEmpty()) nextContributions[viewerId] = filteredByKey

            val before = snapshotLocked(viewerId)
            val resolved = TreeMap<ItemKey, ItemDataValue>()
            filteredByKey.forEach { (key, owners) ->
                owners.values.maxByOrNull(Contribution::sequence)?.let { resolved[key] = it.value }
            }
            if (resolved != before.values) {
                check(before.revision != Long.MAX_VALUE) { "Viewer fact revision is exhausted for $viewerId" }
                val after = ApiViewerFactSnapshot(viewerId, before.revision + 1, resolved)
                nextSnapshots[viewerId] = after
                changed += after
            }
        }
        return ReconciliationProposal(nextContributions, nextSnapshots, changed)
    }

    private fun notifyIfChanged(update: ViewerFactUpdate) {
        if (!update.changed) return
        listeners.forEach { listener -> listener(update.snapshot.viewerId) }
    }

    private fun compactSequences() {
        val ordered = contributions.values
            .asSequence()
            .flatMap { byKey -> byKey.values.asSequence() }
            .flatMap { owners -> owners.values.asSequence() }
            .sortedBy(Contribution::sequence)
            .toList()
        ordered.forEachIndexed { index, contribution -> contribution.sequence = index + 1L }
        sequence = ordered.size.toLong()
    }

    private data class Contribution(
        val value: ItemDataValue,
        var sequence: Long,
    )

    private data class ViewerFactUpdate(
        val snapshot: ApiViewerFactSnapshot,
        val changed: Boolean,
    )

    private data class ReconciliationProposal(
        val contributions: Map<UUID, MutableMap<ItemKey, MutableMap<String, Contribution>>>,
        val snapshots: Map<UUID, ApiViewerFactSnapshot>,
        val changed: List<ApiViewerFactSnapshot>,
    )

    private data class OwnerState(
        val identity: Any,
        val lease: ViewerFactOwnerLease,
        var active: Boolean,
    )

    private companion object {
        const val DEFAULT_VIEWER_CAPACITY = 16_384
    }
}

/**
 * Strict transaction handle used to join viewer-fact reconciliation to an external catalog
 * publication. Listener callbacks are a post-commit completion phase and cannot roll back or hide
 * the already coherent fact state.
 */
class PreparedViewerFactReconciliation internal constructor(
    private val commitAction: () -> List<ApiViewerFactSnapshot>,
    private val completionAction: (List<ApiViewerFactSnapshot>) -> List<Throwable>,
) {
    private var state = State.PREPARED
    private var changed: List<ApiViewerFactSnapshot> = emptyList()
    private var completionFailures: List<Throwable> = emptyList()

    @Synchronized
    fun commit(): List<ApiViewerFactSnapshot> = when (state) {
        State.PREPARED -> commitAction().also {
            changed = it
            state = State.COMMITTED
        }
        State.COMMITTED, State.COMPLETED -> changed
        State.ROLLED_BACK -> error("A rolled-back viewer fact reconciliation cannot commit")
    }

    @Synchronized
    fun rollback() {
        when (state) {
            State.PREPARED -> state = State.ROLLED_BACK
            State.ROLLED_BACK -> return
            State.COMMITTED, State.COMPLETED ->
                error("A committed viewer fact reconciliation cannot roll back")
        }
    }

    @Synchronized
    fun complete(): List<Throwable> = when (state) {
        State.COMMITTED -> completionAction(changed).also {
            completionFailures = it
            state = State.COMPLETED
        }
        State.COMPLETED -> completionFailures
        State.PREPARED -> error("Viewer fact reconciliation must commit before completion")
        State.ROLLED_BACK -> error("A rolled-back viewer fact reconciliation cannot complete")
    }

    private enum class State {
        PREPARED,
        COMMITTED,
        COMPLETED,
        ROLLED_BACK,
    }

    companion object {
        internal fun noOp(): PreparedViewerFactReconciliation =
            PreparedViewerFactReconciliation({ emptyList() }, { emptyList() })
    }
}

/** Resolves all provider layers in configured order, followed by the declared default. */
object ViewerFactResolver {
    fun resolve(
        catalog: PresentationCatalogSnapshot,
        providerValues: Map<String, Map<ItemKey, ItemDataValue>>,
    ): Map<ItemKey, ItemDataValue> {
        val resolved = TreeMap<ItemKey, ItemDataValue>()
        catalog.viewerFacts.forEach { (key, definition) ->
            val providerValue = definition.providers.firstNotNullOfOrNull { provider ->
                providerValues[provider]?.get(key)?.takeIf {
                    validateViewerFactValue(catalog, definition, it) == null
                }
            }
            val value = providerValue ?: definition.defaultValue?.takeIf {
                validateViewerFactValue(catalog, definition, it) == null
            }
            if (value != null) resolved[key] = value
        }
        return Collections.unmodifiableMap(resolved)
    }
}

fun validateApiViewerFact(
    catalog: PresentationCatalogSnapshot,
    key: ItemKey,
    value: ItemDataValue?,
): ViewerFactValidationFailure? {
    val definition = catalog.viewerFacts[key]
        ?: return ViewerFactValidationFailure(
            ViewerFactValidationCode.UNKNOWN_FACT,
            "Viewer fact $key is not declared in the active catalog",
        )
    if (API_PROVIDER !in definition.providers) {
        return ViewerFactValidationFailure(
            ViewerFactValidationCode.PROVIDER_NOT_ALLOWED,
            "Viewer fact $key does not permit the api provider",
        )
    }
    return value?.let { validateViewerFactValue(catalog, definition, it) }
}

private fun validateViewerFactValue(
    catalog: PresentationCatalogSnapshot,
    definition: ViewerFactDefinition,
    value: ItemDataValue,
): ViewerFactValidationFailure? {
    val typeMatches = when (definition.type) {
        ViewerFactType.LOCALE, ViewerFactType.STRING -> value is StringDataValue
        ViewerFactType.BOOLEAN -> value is BooleanDataValue
        ViewerFactType.INTEGER -> value is IntegerDataValue
        ViewerFactType.LONG -> value is LongDataValue
        ViewerFactType.DECIMAL -> value is DecimalDataValue
        ViewerFactType.UUID -> value is UuidDataValue
        ViewerFactType.NAMESPACED_KEY -> value is NamespacedKeyDataValue
    }
    if (!typeMatches) {
        return ViewerFactValidationFailure(
            ViewerFactValidationCode.TYPE_MISMATCH,
            "Viewer fact ${definition.id} requires ${definition.type}",
        )
    }
    if (value is StringDataValue &&
        value.value.codePointCount(0, value.value.length) > catalog.budgets.maximumTextCodePoints
    ) {
        return ViewerFactValidationFailure(
            ViewerFactValidationCode.CONSTRAINT_VIOLATION,
            "Viewer fact ${definition.id} exceeds ${catalog.budgets.maximumTextCodePoints} code points",
        )
    }
    if (value is StringDataValue && value.value.length > MAX_VIEWER_FACT_STRING_LENGTH) {
        return ViewerFactValidationFailure(
            ViewerFactValidationCode.CONSTRAINT_VIOLATION,
            "Viewer fact ${definition.id} exceeds $MAX_VIEWER_FACT_STRING_LENGTH characters",
        )
    }
    if (definition.type == ViewerFactType.LOCALE &&
        (value as StringDataValue).value !in catalog.locales
    ) {
        return ViewerFactValidationFailure(
            ViewerFactValidationCode.CONSTRAINT_VIOLATION,
            "Viewer fact ${definition.id} references an unknown locale ${value.value}",
        )
    }
    if (definition.id == THEME_FACT) {
        val theme = value as? NamespacedKeyDataValue
            ?: return ViewerFactValidationFailure(
                ViewerFactValidationCode.TYPE_MISMATCH,
                "Viewer fact ${definition.id} requires NAMESPACED_KEY",
            )
        if (theme.value !in catalog.themes) {
            return ViewerFactValidationFailure(
                ViewerFactValidationCode.CONSTRAINT_VIOLATION,
                "Viewer fact ${definition.id} references an unknown theme ${theme.value}",
            )
        }
    }
    if (definition.id == ASSET_PROFILE_FACT) {
        val profile = value as? NamespacedKeyDataValue
            ?: return ViewerFactValidationFailure(
                ViewerFactValidationCode.TYPE_MISMATCH,
                "Viewer fact ${definition.id} requires NAMESPACED_KEY",
            )
        if (profile.value !in catalog.assetProfiles) {
            return ViewerFactValidationFailure(
                ViewerFactValidationCode.CONSTRAINT_VIOLATION,
                "Viewer fact ${definition.id} references an unknown asset profile ${profile.value}",
            )
        }
    }
    return null
}

private fun normalizeApiViewerFactValue(
    catalog: PresentationCatalogSnapshot,
    key: ItemKey,
    value: ItemDataValue,
): ItemDataValue =
    if (catalog.viewerFacts[key]?.type == ViewerFactType.LOCALE && value is StringDataValue) {
        StringDataValue(value.value.lowercase(Locale.ROOT).replace('-', '_'))
    } else {
        value
    }

private const val API_PROVIDER = "api"
internal const val MAX_VIEWER_FACTS = 256
internal const val MAX_VIEWER_FACT_STRING_LENGTH = 8_192
private val THEME_FACT = ItemKey.parse("itemerness:theme")
private val ASSET_PROFILE_FACT = ItemKey.parse("itemerness:asset-profile")
