package com.iroselle.itemerness.bukkit.projection

import com.iroselle.itemerness.api.BooleanDataValue
import com.iroselle.itemerness.api.DecimalDataValue
import com.iroselle.itemerness.api.IntegerDataValue
import com.iroselle.itemerness.api.ItemDataValue
import com.iroselle.itemerness.api.ItemKey
import com.iroselle.itemerness.api.LongDataValue
import com.iroselle.itemerness.api.NamespacedKeyDataValue
import com.iroselle.itemerness.api.StringDataValue
import com.iroselle.itemerness.api.UuidDataValue
import com.iroselle.itemerness.bukkit.catalog.CanonicalDomainMapper
import com.iroselle.itemerness.bukkit.catalog.CanonicalDomainResult
import com.iroselle.itemerness.bukkit.catalog.RuntimeCatalogSnapshot
import com.iroselle.itemerness.core.catalog.CatalogItemDefinition
import com.iroselle.itemerness.core.catalog.BaseItemComponent
import com.iroselle.itemerness.core.presentation.PresentationCatalogSnapshot
import com.iroselle.itemerness.core.presentation.PresentationEngine
import com.iroselle.itemerness.core.presentation.NestedItemPresentation
import com.iroselle.itemerness.core.presentation.PresentationRenderRequest
import com.iroselle.itemerness.core.presentation.PresentationRenderResult
import com.iroselle.itemerness.core.presentation.PresentationTextRun
import com.iroselle.itemerness.core.presentation.PresentationViewer
import com.iroselle.itemerness.core.presentation.VanillaTooltipLinePolicy
import com.iroselle.itemerness.projection.BooleanProjectionValue
import com.iroselle.itemerness.projection.DecimalProjectionValue
import com.iroselle.itemerness.projection.IntegerProjectionValue
import com.iroselle.itemerness.projection.ItemProjector
import com.iroselle.itemerness.projection.KeyProjectionValue
import com.iroselle.itemerness.projection.LongProjectionValue
import com.iroselle.itemerness.projection.ProjectionContext
import com.iroselle.itemerness.projection.ProjectionContextSource
import com.iroselle.itemerness.projection.ProjectionCatalogHandle
import com.iroselle.itemerness.projection.ProjectionFallbackReason
import com.iroselle.itemerness.projection.ProjectionGeneration
import com.iroselle.itemerness.projection.ProjectionPdcFallbackPlan
import com.iroselle.itemerness.projection.ProjectionPdcFallbackPlanSource
import com.iroselle.itemerness.projection.ProjectionRequest
import com.iroselle.itemerness.projection.ProjectionResult
import com.iroselle.itemerness.projection.RenderedDisplay
import com.iroselle.itemerness.projection.RenderedText
import com.iroselle.itemerness.projection.RenderedTextRun
import com.iroselle.itemerness.projection.RgbColor
import com.iroselle.itemerness.projection.StringProjectionValue
import com.iroselle.itemerness.projection.TextDecorations
import com.iroselle.itemerness.projection.UuidProjectionValue
import com.iroselle.itemerness.projection.ViewerProjectionSnapshot
import java.util.Collections
import java.util.LinkedHashMap
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicReference

/**
 * Publishes the network-thread state as immutable revisions. Catalogs still referenced by a
 * viewer remain available, while an acquired context retains its exact immutable catalog through
 * an opaque handle so an in-flight packet never mixes two reloads.
 */
internal class ProjectionStateStore : ProjectionContextSource,
    ProjectionPdcFallbackPlanSource,
    ItemProjector {
    private val catalogOwner = Any()
    private val catalogs = AtomicReference<Map<Long, PublishedProjectionCatalog>>(emptyMap())
    private val activeRevision = AtomicReference<Long?>()
    private val viewers = ConcurrentHashMap<UUID, PublishedViewer>()
    private val renderCache = LinkedHashMap<ProjectionCacheKey, ProjectionResult>(256, 0.75F, true)
    @Volatile
    private var closed = false

    fun publishCatalog(
        runtime: RuntimeCatalogSnapshot,
        presentation: PresentationCatalogSnapshot,
    ) = prepareCatalog(runtime, presentation).commit()

    /**
     * Builds the presentation engine and immutable replacement maps without making them visible.
     * The returned handle owns the exact before/after pair, so a later participant failure can
     * restore projection state without accepting an unrelated publication.
     */
    @Synchronized
    fun prepareCatalog(
        runtime: RuntimeCatalogSnapshot,
        presentation: PresentationCatalogSnapshot,
    ): PreparedProjectionCatalogPublication {
        checkOpen()
        require(runtime.domain.revision == presentation.revision) {
            "Domain and presentation revisions must be published together"
        }
        val previousRevision = activeRevision.get()
        val previousCatalogs = catalogs.get()
        if (previousRevision != null && runtime.domain.revision <= previousRevision) {
            if (runtime.domain.revision == previousRevision) {
                val current = previousCatalogs[previousRevision]
                check(current?.runtime === runtime && current.presentation === presentation) {
                    "A different projection catalog cannot replace revision $previousRevision"
                }
            }
            return PreparedProjectionCatalogPublication.noOp()
        }

        // PresentationEngine construction is deliberately part of preparation: commit contains no
        // user parsing/rendering work and therefore cannot expose a half-built catalog.
        val published = PublishedProjectionCatalog(
            owner = catalogOwner,
            runtime = runtime,
            presentation = presentation,
            engine = PresentationEngine(presentation),
            pdcFallbackPlan = compilePdcFallbackPlan(runtime),
        )
        val nextCatalogs = Collections.unmodifiableMap(
            LinkedHashMap<Long, PublishedProjectionCatalog>(2).apply {
                previousCatalogs[previousRevision]?.let { old -> put(old.revision, old) }
                put(runtime.domain.revision, published)
            },
        )
        val previousCache = synchronized(renderCache) { LinkedHashMap(renderCache) }
        val nextCache = LinkedHashMap<ProjectionCacheKey, ProjectionResult>().apply {
            previousCache.forEach { (key, value) ->
                if (key.generation.catalogRevision in nextCatalogs) put(key, value)
            }
        }
        return PreparedProjectionCatalogPublication(
            commitAction = {
                synchronized(this) {
                    checkOpen()
                    check(catalogs.get() === previousCatalogs && activeRevision.get() == previousRevision) {
                        "Projection catalog changed after publication preparation"
                    }
                    try {
                        catalogs.set(nextCatalogs)
                        activeRevision.set(runtime.domain.revision)
                        synchronized(renderCache) {
                            renderCache.clear()
                            renderCache.putAll(nextCache)
                        }
                    } catch (failure: Throwable) {
                        var publicationFailure = failure
                        try {
                            catalogs.set(previousCatalogs)
                            activeRevision.set(previousRevision)
                            synchronized(renderCache) {
                                renderCache.clear()
                                renderCache.putAll(previousCache)
                            }
                        } catch (rollbackFailure: Throwable) {
                            publicationFailure = mergeProjectionPublicationFailure(
                                publicationFailure,
                                rollbackFailure,
                            )
                        }
                        throw publicationFailure
                    }
                }
            },
            rollbackAction = {
                synchronized(this) {
                    checkOpen()
                    check(catalogs.get() === nextCatalogs && activeRevision.get() == runtime.domain.revision) {
                        "Projection catalog changed before publication rollback"
                    }
                    catalogs.set(previousCatalogs)
                    activeRevision.set(previousRevision)
                    synchronized(renderCache) {
                        renderCache.clear()
                        renderCache.putAll(previousCache)
                    }
                }
            },
        )
    }

    /** Retains one exact immutable catalog even after it leaves the bounded lookup map. */
    @Synchronized
    fun catalogHandle(catalogRevision: Long): ProjectionCatalogHandle? {
        if (closed) return null
        return catalogs.get()[catalogRevision]
    }

    @Synchronized
    fun publishViewer(
        snapshot: ViewerProjectionSnapshot,
        retainedCatalog: ProjectionCatalogHandle? = null,
    ) {
        checkOpen()
        val retained = retainedCatalog?.let { handle -> ownedCatalog(handle, snapshot.catalogRevision) }
        val publishedCatalog = retained ?: catalogs.get()[snapshot.catalogRevision]
        viewers.compute(snapshot.viewerId) { _, current ->
            when {
                current == null -> PublishedViewer(snapshot, publishedCatalog)
                snapshot.revision > current.snapshot.revision -> PublishedViewer(
                    snapshot,
                    publishedCatalog ?: current.catalog.takeIf { current.snapshot.catalogRevision == snapshot.catalogRevision },
                )
                else -> current
            }
        }
    }

    fun viewer(viewerId: UUID): ViewerProjectionSnapshot? = viewers[viewerId]?.snapshot

    fun render(
        viewerId: UUID,
        canonical: com.iroselle.itemerness.projection.CanonicalItemSnapshot,
    ): ProjectionResult {
        val context = acquire(viewerId)
            ?: return ProjectionResult.Fallback(ProjectionFallbackReason.RENDERING_FAILED)
        return project(ProjectionRequest(canonical, context))
    }

    /** Renders against an entity-owned candidate before it becomes the published lookup value. */
    fun render(
        viewer: ViewerProjectionSnapshot,
        canonical: com.iroselle.itemerness.projection.CanonicalItemSnapshot,
    ): ProjectionResult {
        val published = catalogs.get()[viewer.catalogRevision]
        if (published == null) {
            return ProjectionResult.Fallback(ProjectionFallbackReason.RENDERING_FAILED)
        }
        return render(viewer, canonical, published)
    }

    /** Renders an entity-owned candidate against the exact catalog retained for its capture. */
    fun render(
        viewer: ViewerProjectionSnapshot,
        canonical: com.iroselle.itemerness.projection.CanonicalItemSnapshot,
        retainedCatalog: ProjectionCatalogHandle,
    ): ProjectionResult {
        val published = ownedCatalog(retainedCatalog, viewer.catalogRevision)
        return project(
            ProjectionRequest(
                canonical,
                ProjectionContext(
                    viewer,
                    ProjectionGeneration(viewer.catalogRevision, viewer.revision),
                    published,
                ),
            ),
        )
    }

    /** Renders owner-context data that already includes validated read-only PDC fallbacks. */
    fun render(
        viewer: ViewerProjectionSnapshot,
        canonical: com.iroselle.itemerness.projection.CanonicalItemSnapshot,
        retainedCatalog: ProjectionCatalogHandle,
        effectiveData: Map<com.iroselle.itemerness.api.DataKey, ItemDataValue>,
    ): ProjectionResult {
        val published = ownedCatalog(retainedCatalog, viewer.catalogRevision)
        return projectUncached(
            ProjectionRequest(
                canonical,
                ProjectionContext(
                    viewer,
                    ProjectionGeneration(viewer.catalogRevision, viewer.revision),
                    published,
                ),
            ),
            Collections.unmodifiableMap(LinkedHashMap(effectiveData)),
        )
    }

    fun formatValue(
        catalogRevision: Long,
        value: ItemDataValue,
        format: ItemKey?,
        locale: String,
    ): Result<String> = catalogs.get()[catalogRevision]?.engine?.formatValue(value, format, locale)
        ?: Result.failure(IllegalStateException("Presentation revision $catalogRevision is unavailable"))

    fun formatValue(
        retainedCatalog: ProjectionCatalogHandle,
        value: ItemDataValue,
        format: ItemKey?,
        locale: String,
    ): Result<String> = ownedCatalog(retainedCatalog).engine.formatValue(value, format, locale)

    fun matchAssetProfile(
        catalogRevision: Long,
        packId: UUID,
        sha1: String,
    ): ItemKey? = catalogs.get()[catalogRevision]?.presentation?.resourcePackBindings?.values
        ?.firstOrNull { binding ->
            binding.enabled &&
                binding.packId == packId &&
                binding.sha1 != null &&
                binding.sha1.equals(sha1, ignoreCase = true)
        }
        ?.assetProfile

    /**
     * Resolves an explicitly trusted dynamic pack when Bukkit reports only its UUID.
     *
     * The binding must still declare a SHA-1. This keeps a bare UUID from becoming an implicit
     * capability grant while allowing pack senders whose UUID is content-derived to participate.
     */
    fun matchAssetProfileByPackId(
        catalogRevision: Long,
        packId: UUID,
    ): ItemKey? = catalogs.get()[catalogRevision]?.presentation?.resourcePackBindings?.values
        ?.filter { binding ->
            binding.enabled && binding.packId == packId && binding.sha1 != null
        }
        ?.singleOrNull()
        ?.assetProfile

    fun matchAssetProfile(
        retainedCatalog: ProjectionCatalogHandle,
        packId: UUID,
        sha1: String,
    ): ItemKey? = matchAssetProfile(ownedCatalog(retainedCatalog), packId, sha1)

    fun matchAssetProfileByPackId(
        retainedCatalog: ProjectionCatalogHandle,
        packId: UUID,
    ): ItemKey? = ownedCatalog(retainedCatalog).presentation.resourcePackBindings.values
        .filter { binding ->
            binding.enabled && binding.packId == packId && binding.sha1 != null
        }
        .singleOrNull()
        ?.assetProfile

    fun capabilities(
        catalogRevision: Long,
        assetProfile: ItemKey,
    ): Set<ItemKey> = catalogs.get()[catalogRevision]
        ?.presentation
        ?.assetProfiles
        ?.get(assetProfile)
        ?.capabilities
        .orEmpty()

    fun capabilities(
        retainedCatalog: ProjectionCatalogHandle,
        assetProfile: ItemKey,
    ): Set<ItemKey> = ownedCatalog(retainedCatalog)
        .presentation
        .assetProfiles
        .get(assetProfile)
        ?.capabilities
        .orEmpty()

    @Synchronized
    fun removeViewer(viewerId: UUID) {
        if (closed) return
        viewers.remove(viewerId)
        synchronized(renderCache) {
            renderCache.keys.removeIf { key -> key.viewerId == viewerId }
        }
    }

    /** Permanently closes this publication generation and releases all retained state. */
    @Synchronized
    fun clear() {
        if (closed) return
        closed = true
        viewers.clear()
        activeRevision.set(null)
        catalogs.set(emptyMap())
        synchronized(renderCache) { renderCache.clear() }
    }

    override fun acquire(viewerId: UUID): ProjectionContext? {
        repeat(2) {
            if (closed) return null
            val publishedCatalogs = catalogs.get()
            val viewer = viewers[viewerId] ?: return null
            val published = viewer.catalog ?: publishedCatalogs[viewer.snapshot.catalogRevision] ?: return null
            if (
                !closed &&
                catalogs.get() === publishedCatalogs &&
                viewers[viewerId] === viewer
            ) {
                return ProjectionContext(
                    viewer = viewer.snapshot,
                    generation = ProjectionGeneration(viewer.snapshot.catalogRevision, viewer.snapshot.revision),
                    catalogHandle = published,
                )
            }
        }
        return null
    }

    override fun acquire(context: ProjectionContext): ProjectionPdcFallbackPlan {
        if (closed) return ProjectionPdcFallbackPlan.EMPTY
        val retained = context.catalogHandle
        val published = if (retained == null) {
            catalogs.get()[context.generation.catalogRevision]
        } else {
            (retained as? PublishedProjectionCatalog)?.takeIf { candidate ->
                candidate.owner === catalogOwner &&
                    candidate.revision == context.generation.catalogRevision
            }
        }
        return published?.pdcFallbackPlan ?: ProjectionPdcFallbackPlan.EMPTY
    }

    override fun project(request: ProjectionRequest): ProjectionResult {
        val key = ProjectionCacheKey(
            fingerprint = request.canonical.fingerprint,
            viewerId = request.context.viewer.viewerId,
            generation = request.context.generation,
        )
        val cached = synchronized(this) {
            if (closed) return closedFallback()
            synchronized(renderCache) { renderCache[key] }
        }
        if (cached != null) return cached
        val rendered = projectUncached(request)
        return synchronized(this) {
            when {
                closed -> closedFallback()
                request.context.generation.catalogRevision !in catalogs.get() -> rendered
                else -> synchronized(renderCache) {
                    renderCache[key] ?: rendered.also {
                        renderCache[key] = it
                        evictCacheLocked()
                    }
                }
            }
        }
    }

    private fun checkOpen() {
        check(!closed) { "The projection state store is closed" }
    }

    private fun closedFallback(): ProjectionResult =
        ProjectionResult.Fallback(ProjectionFallbackReason.RENDERING_FAILED)

    private fun projectUncached(
        request: ProjectionRequest,
        effectiveData: Map<com.iroselle.itemerness.api.DataKey, ItemDataValue>? = null,
    ): ProjectionResult {
        val retained = request.context.catalogHandle
        val published = if (retained == null) {
            catalogs.get()[request.context.generation.catalogRevision]
        } else {
            (retained as? PublishedProjectionCatalog)?.takeIf {
                it.owner === catalogOwner &&
                    it.revision == request.context.generation.catalogRevision
            }
        }
            ?: return ProjectionResult.Fallback(ProjectionFallbackReason.DEFINITION_NOT_FOUND)
        if (request.context.viewer.revision != request.context.generation.epoch) {
            return ProjectionResult.Fallback(ProjectionFallbackReason.RENDERING_FAILED)
        }
        val restored = CanonicalDomainMapper.restore(request.canonical, published.runtime)
        if (restored !is CanonicalDomainResult.Valid) {
            return ProjectionResult.Fallback(ProjectionFallbackReason.INVALID_CANONICAL_DATA)
        }
        val definition = restored.definition as? CatalogItemDefinition
            ?: return ProjectionResult.Fallback(ProjectionFallbackReason.DEFINITION_NOT_FOUND)
        val data = effectiveData ?: when (
            val merged = mergeProjectionPdcFallbacks(
                runtime = published.runtime,
                restored = restored,
                fallbackData = request.canonical.pdcFallbackData,
            )
        ) {
            is ProjectionPdcMergeResult.Invalid ->
                return ProjectionResult.Fallback(ProjectionFallbackReason.INVALID_CANONICAL_DATA)
            is ProjectionPdcMergeResult.Valid -> merged.data
        }
        val viewer = request.context.viewer
        val facts = try {
            viewer.facts.associate { fact -> fact.key to projectionFact(fact.value) }
        } catch (_: RuntimeException) {
            return ProjectionResult.Fallback(ProjectionFallbackReason.INVALID_CANONICAL_DATA)
        }
        val profile = viewer.assetProfile?.let(published.presentation.assetProfiles::get)
        val nestedItems = try {
            definition.contents.map { content ->
                NestedItemPresentation(
                    itemKey = content.item,
                    displayName = published.engine.itemDisplayName(content.item, viewer.locale.value).getOrThrow(),
                    amount = content.amount,
                )
            }
        } catch (_: RuntimeException) {
            return ProjectionResult.Fallback(ProjectionFallbackReason.RENDERING_FAILED)
        }
        val rendered = try {
            published.engine.render(
                PresentationRenderRequest(
                    itemKey = request.canonical.itemKey,
                    data = data,
                    viewer = PresentationViewer(
                        locale = viewer.locale.value,
                        requestedTheme = viewer.theme,
                        assetProfile = viewer.assetProfile,
                        capabilities = viewer.capabilities,
                        metricsRevision = profile?.metricsRevision,
                        facts = facts,
                        factRevision = viewer.revision,
                        resourcePackLoaded =
                            (viewer.fact(RESOURCE_PACK_FACT) as? BooleanProjectionValue)?.value == true,
                    managesVanillaTooltipLines = request.canonical.canManageVanillaTooltipLines,
                    ),
                    nestedItems = nestedItems,
                ),
            )
        } catch (_: RuntimeException) {
            return ProjectionResult.Fallback(ProjectionFallbackReason.RENDERING_FAILED)
        }
        return when (rendered) {
            is PresentationRenderResult.Rejected -> ProjectionResult.Fallback(
                when (rendered.failure.code) {
                    com.iroselle.itemerness.core.presentation.PresentationRenderFailureCode.UNKNOWN_ITEM ->
                        ProjectionFallbackReason.DEFINITION_NOT_FOUND
                    com.iroselle.itemerness.core.presentation.PresentationRenderFailureCode.OUTPUT_BUDGET_EXCEEDED ->
                        ProjectionFallbackReason.RENDER_LIMIT_EXCEEDED
                    else -> ProjectionFallbackReason.RENDERING_FAILED
                },
            )
            is PresentationRenderResult.Rendered -> ProjectionResult.Rendered(
                RenderedDisplay(
                    displayName = rendered.display.displayName.toRenderedText(),
                    lore = rendered.display.lore.map { line -> line.toRenderedText() },
                    tooltipStyle = rendered.display.tooltipStyle,
                    itemModel = definition.baseComponents
                        .filterIsInstance<BaseItemComponent.ItemModel>()
                        .singleOrNull()
                        ?.value
                        ?: definition.material,
                    managesVanillaTooltipLines = published.presentation.themes
                        .getValue(rendered.display.selectedTheme)
                        .source
                        .vanillaTooltipLines == VanillaTooltipLinePolicy.REQUIRE_MANAGED,
                ),
            )
        }
    }

    private fun evictCacheLocked() {
        while (renderCache.size > MAX_CACHE_ENTRIES) {
            val iterator = renderCache.entries.iterator()
            if (!iterator.hasNext()) return
            iterator.next()
            iterator.remove()
        }
    }

    private fun ownedCatalog(
        handle: ProjectionCatalogHandle,
        expectedRevision: Long? = null,
    ): PublishedProjectionCatalog {
        require(handle is PublishedProjectionCatalog && handle.owner === catalogOwner) {
            "Projection catalog handle belongs to a different projection store"
        }
        require(expectedRevision == null || handle.revision == expectedRevision) {
            "Projection catalog handle revision does not match the requested revision"
        }
        return handle
    }

    private fun matchAssetProfile(
        catalog: PublishedProjectionCatalog,
        packId: UUID,
        sha1: String,
    ): ItemKey? = catalog.presentation.resourcePackBindings.values
        .firstOrNull { binding ->
            binding.enabled &&
                binding.packId == packId &&
                binding.sha1 != null &&
                binding.sha1.equals(sha1, ignoreCase = true)
        }
        ?.assetProfile

    private data class PublishedProjectionCatalog(
        val owner: Any,
        val runtime: RuntimeCatalogSnapshot,
        val presentation: PresentationCatalogSnapshot,
        val engine: PresentationEngine,
        val pdcFallbackPlan: ProjectionPdcFallbackPlan,
    ) : ProjectionCatalogHandle {
        override val revision: Long = runtime.domain.revision
    }

    private data class PublishedViewer(
        val snapshot: ViewerProjectionSnapshot,
        val catalog: PublishedProjectionCatalog?,
    )

    private data class ProjectionCacheKey(
        val fingerprint: com.iroselle.itemerness.projection.CanonicalItemFingerprint,
        val viewerId: UUID,
        val generation: ProjectionGeneration,
    )

    private companion object {
        const val MAX_CACHE_ENTRIES = 8_192
        val RESOURCE_PACK_FACT: ItemKey = ItemKey.parse("itemerness:resource-pack-ready")
    }
}

/** Strictly stateful handle for one prepared projection catalog exchange. */
internal class PreparedProjectionCatalogPublication internal constructor(
    private val commitAction: () -> Unit,
    private val rollbackAction: () -> Unit,
) {
    private var state = State.PREPARED

    @Synchronized
    fun commit() {
        when (state) {
            State.COMMITTED -> return
            State.ROLLED_BACK -> error("A rolled-back projection publication cannot commit")
            State.PREPARED -> {
                commitAction()
                state = State.COMMITTED
            }
        }
    }

    @Synchronized
    fun rollback() {
        when (state) {
            State.ROLLED_BACK -> return
            State.PREPARED -> state = State.ROLLED_BACK
            State.COMMITTED -> {
                rollbackAction()
                state = State.ROLLED_BACK
            }
        }
    }

    private enum class State {
        PREPARED,
        COMMITTED,
        ROLLED_BACK,
    }

    companion object {
        fun noOp(): PreparedProjectionCatalogPublication = PreparedProjectionCatalogPublication({}, {})
    }
}

private fun mergeProjectionPublicationFailure(
    current: Throwable,
    next: Throwable,
): Throwable {
    if (current === next) return current
    return if (!current.isFatalProjectionPublicationFailure() && next.isFatalProjectionPublicationFailure()) {
        next.apply { addSuppressed(current) }
    } else {
        current.apply { addSuppressed(next) }
    }
}

@Suppress("DEPRECATION")
private fun Throwable.isFatalProjectionPublicationFailure(): Boolean =
    this is VirtualMachineError || this is ThreadDeath

private fun projectionFact(value: com.iroselle.itemerness.projection.ProjectionValue): ItemDataValue = when (value) {
    is BooleanProjectionValue -> BooleanDataValue(value.value)
    is IntegerProjectionValue -> IntegerDataValue(value.value)
    is LongProjectionValue -> LongDataValue(value.value)
    is DecimalProjectionValue -> DecimalDataValue(value.value.toDouble())
    is StringProjectionValue -> StringDataValue(value.value)
    is UuidProjectionValue -> UuidDataValue(value.value)
    is KeyProjectionValue -> NamespacedKeyDataValue(value.value)
    else -> error("Viewer facts must be scalar")
}

private fun com.iroselle.itemerness.core.presentation.PresentationLine.toRenderedText(): RenderedText =
    RenderedText(runs.map(PresentationTextRun::toRenderedRun))

private fun PresentationTextRun.toRenderedRun(): RenderedTextRun = RenderedTextRun(
    text = text,
    color = style.color?.let(::RgbColor),
    font = style.font,
    decorations = TextDecorations(
        bold = style.bold,
        italic = style.italic,
        underlined = style.underlined,
        strikethrough = style.strikethrough,
    ),
)
