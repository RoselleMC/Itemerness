package com.iroselle.itemerness.bukkit.catalog

import com.iroselle.itemerness.api.DataKey
import com.iroselle.itemerness.api.ItemDefinition
import com.iroselle.itemerness.api.ItemKey
import com.iroselle.itemerness.api.ItemernessApi
import com.iroselle.itemerness.bukkit.access.AccessPolicy
import com.iroselle.itemerness.bukkit.access.AccessPolicyLoader
import com.iroselle.itemerness.bukkit.access.DataAccessRuleIndex
import com.iroselle.itemerness.bukkit.command.CommandCatalogView
import com.iroselle.itemerness.bukkit.config.ItemernessSettings
import com.iroselle.itemerness.bukkit.presentation.BuiltinFontMetricsLoader
import com.iroselle.itemerness.bukkit.presentation.LoadedPresentationSource
import com.iroselle.itemerness.bukkit.presentation.PresentationSourceLoader
import com.iroselle.itemerness.core.catalog.CatalogCompilation
import com.iroselle.itemerness.core.catalog.CatalogCandidate
import com.iroselle.itemerness.core.catalog.CatalogCompiler
import com.iroselle.itemerness.core.catalog.CatalogDiagnostic
import com.iroselle.itemerness.core.catalog.CatalogDiagnosticCode
import com.iroselle.itemerness.core.catalog.CatalogSnapshot
import com.iroselle.itemerness.core.presentation.PresentationCatalogSnapshot
import java.nio.file.Path
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

internal class RuntimeCatalogManager(
    private val dataFolder: Path,
    minecraftVersion: String,
    private val loader: CatalogSourceLoader = CatalogSourceLoader(),
    private val compiler: CatalogCompiler = CatalogCompiler(),
    private val presentationLoader: PresentationSourceLoader =
        PresentationSourceLoader(BuiltinFontMetricsLoader.bundled(minecraftVersion)),
    private val validator: RuntimeCatalogValidator = RuntimeCatalogValidator(),
) : ItemernessApi,
    CommandCatalogView {
    private val current = AtomicReference<RuntimeCatalogSnapshot?>()
    private val requestSequence = AtomicLong()
    private val closed = AtomicBoolean()
    private val publicationLock = Any()

    override val catalogRevision: Long
        get() = current.get()?.domain?.revision ?: 0

    override fun findItem(key: ItemKey): ItemDefinition? = current.get()?.domain?.findItem(key)

    override fun items(): Collection<ItemDefinition> = current.get()?.domain?.items?.values.orEmpty()

    override fun itemKeys(): Collection<ItemKey> = current.get()?.domain?.items?.keys.orEmpty()

    override fun dataKeys(): Collection<DataKey> = current.get()?.domain?.schemas?.values
        ?.asSequence()
        ?.flatMap { schema -> schema.keys.keys.asSequence() }
        ?.distinct()
        ?.sorted()
        ?.toList()
        .orEmpty()

    override fun locales(): Collection<String> = current.get()?.presentation?.locales?.keys.orEmpty()

    fun snapshot(): RuntimeCatalogSnapshot? = current.get()

    /**
     * Acquires the active snapshot while excluding catalog publication. The reader must remain
     * bounded and must not schedule or wait. This is the coherence boundary for downstream state
     * that is committed before [current] is exchanged, such as projection catalogs and viewer
     * facts.
     */
    fun <T> withCurrentSnapshot(reader: (RuntimeCatalogSnapshot) -> T): T? = synchronized(publicationLock) {
        if (closed.get()) return null
        current.get()?.let(reader)
    }

    /** Parses and compiles outside the publication lock without changing the active snapshot. */
    fun prepareReload(checkOnly: Boolean = false): RuntimeCatalogUpdate {
        val request = synchronized(publicationLock) {
            if (closed.get()) return closedUpdate()
            requestSequence.incrementAndGet()
        }
        val loaded = try {
            val settings = ItemernessSettings.load(dataFolder.resolve("config.yml"))
            val source = loader.load(dataFolder)
            val domainCompilation = compiler.compile(source.source)
            val presentation = presentationLoader.loadAndCompile(
                root = dataFolder,
                catalog = source,
                defaultLocale = settings.defaultLocale,
                defaultLayout = settings.defaultLayout,
                defaultTheme = settings.defaultTheme,
            )
            LoadedRuntimeCandidate(
                settings = settings,
                source = source,
                accessPolicy = AccessPolicyLoader.load(dataFolder.resolve("access.yml")),
                dataAccessRules = DataAccessRuleIndex.from(source),
                compilation = domainCompilation,
                presentation = presentation,
            )
        } catch (exception: Exception) {
            return RuntimeCatalogUpdate.Rejected(
                active = current.get(),
                diagnostics = listOf(
                    CatalogDiagnostic(
                        code = CatalogDiagnosticCode.INVALID_SCHEMA,
                        path = "\$",
                        message = exception.message ?: exception.javaClass.simpleName,
                    ),
                ),
            )
        }
        val compilationDiagnostics = loaded.compilation.diagnostics + loaded.presentation.compilation.diagnostics.map { diagnostic ->
            CatalogDiagnostic(
                code = CatalogDiagnosticCode.INVALID_SCHEMA,
                path = "presentation.${diagnostic.path}",
                message = "${diagnostic.code}: ${diagnostic.message}",
            )
        }
        val candidate = loaded.compilation.candidate
        val presentationCandidate = loaded.presentation.compilation.catalog
        if (candidate == null || presentationCandidate == null) {
            return RuntimeCatalogUpdate.Rejected(current.get(), compilationDiagnostics)
        }
        val validationDiagnostics = validator.validate(
            settings = loaded.settings,
            source = loaded.source.source,
            domain = candidate.materializeValidationView(),
            presentation = presentationCandidate,
            integrations = loaded.source.dataKeyIntegrations,
        )
        val diagnostics = compilationDiagnostics + validationDiagnostics
        if (diagnostics.isNotEmpty()) {
            return RuntimeCatalogUpdate.Rejected(current.get(), diagnostics)
        }
        if (checkOnly) {
            synchronized(publicationLock) {
                return if (closed.get()) {
                    closedUpdate()
                } else {
                    RuntimeCatalogUpdate.Validated(current.get(), diagnostics)
                }
            }
        }

        return RuntimeCatalogUpdate.Prepared(
            active = current.get(),
            diagnostics = diagnostics,
            owner = this,
            request = request,
            loaded = loaded,
            candidate = candidate,
            presentation = presentationCandidate,
        )
    }

    /** Preserves the original synchronous API for startup and tests that have no downstream state. */
    fun reload(checkOnly: Boolean = false): RuntimeCatalogUpdate = when (val prepared = prepareReload(checkOnly)) {
        is RuntimeCatalogUpdate.Prepared -> publish(prepared)
        else -> prepared
    }

    /**
     * Commits a prepared reload and its downstream projection/fact state as one owned transaction.
     * The active API snapshot is exchanged only after downstream commit succeeds. If downstream
     * preparation or commit fails, rollback runs while the old API snapshot is still active.
     */
    fun publish(
        prepared: RuntimeCatalogUpdate.Prepared,
        publication: RuntimeCatalogPublication = RuntimeCatalogPublication.NO_OP,
    ): RuntimeCatalogUpdate = synchronized(publicationLock) {
        if (closed.get()) return closedUpdate()
        require(prepared.owner === this) { "Prepared catalog reload belongs to a different manager" }
        if (requestSequence.get() != prepared.request) {
            return RuntimeCatalogUpdate.Superseded(current.get(), prepared.diagnostics)
        }
        if (!prepared.claim()) {
            return RuntimeCatalogUpdate.Superseded(current.get(), prepared.diagnostics)
        }
        val previous = current.get()
        val previousRevision = previous?.domain?.revision ?: 0
        check(previousRevision != Long.MAX_VALUE) { "Catalog revision is exhausted" }
        val revision = previousRevision + 1
        val published = RuntimeCatalogSnapshot(
            settings = prepared.loaded.settings,
            domain = prepared.candidate.materialize(revision),
            presentation = prepared.presentation.withRevision(revision),
            source = prepared.loaded.source,
            accessPolicy = prepared.loaded.accessPolicy,
            dataAccessRules = prepared.loaded.dataAccessRules,
        )
        val transaction = try {
            publication.prepare(published)
        } catch (failure: Throwable) {
            failure.rethrowIfFatalPublicationFailure()
            return RuntimeCatalogUpdate.PublicationFailed(previous, prepared.diagnostics, failure)
        }
        try {
            transaction.commit()
        } catch (failure: Throwable) {
            var publicationFailure = failure
            try {
                transaction.rollback()
            } catch (rollbackFailure: Throwable) {
                publicationFailure = publicationFailure.withPublicationFailure(rollbackFailure)
            }
            publicationFailure.rethrowIfFatalPublicationFailure()
            return RuntimeCatalogUpdate.PublicationFailed(previous, prepared.diagnostics, publicationFailure)
        }

        // AtomicReference.set has no user code or validation path. All fallible publication work
        // has completed before this final exchange, so downstream can never lag a visible API revision.
        current.set(published)
        val completionFailures = try {
            transaction.complete()
            emptyList()
        } catch (failure: Throwable) {
            failure.rethrowIfFatalPublicationFailure()
            listOf(failure)
        }
        RuntimeCatalogUpdate.Published(published, prepared.diagnostics, completionFailures)
    }

    /**
     * Linearizes an entity-owned canonical write with catalog publication. The action is run only
     * while [expected] is still the exact active snapshot; callers must keep the action bounded and
     * must not schedule or wait while holding this boundary.
     */
    fun commitIfCurrent(
        expected: RuntimeCatalogSnapshot,
        action: () -> Unit,
    ): Boolean = synchronized(publicationLock) {
        if (closed.get() || current.get() !== expected) return false
        action()
        true
    }

    fun clear() {
        synchronized(publicationLock) {
            if (!closed.compareAndSet(false, true)) return
            requestSequence.incrementAndGet()
            current.set(null)
        }
    }

    private fun closedUpdate(): RuntimeCatalogUpdate.Rejected = RuntimeCatalogUpdate.Rejected(
        active = null,
        diagnostics = listOf(
            CatalogDiagnostic(
                code = CatalogDiagnosticCode.INVALID_SCHEMA,
                path = "\$",
                message = "The Itemerness catalog manager is closed",
            ),
        ),
    )

    internal data class LoadedRuntimeCandidate(
        val settings: ItemernessSettings,
        val source: LoadedCatalogSource,
        val accessPolicy: AccessPolicy,
        val dataAccessRules: DataAccessRuleIndex,
        val compilation: CatalogCompilation,
        val presentation: LoadedPresentationSource,
    )
}

internal class RuntimeCatalogSnapshot(
    val settings: ItemernessSettings,
    val domain: CatalogSnapshot,
    val presentation: PresentationCatalogSnapshot,
    val source: LoadedCatalogSource,
    val accessPolicy: AccessPolicy,
    val dataAccessRules: DataAccessRuleIndex,
)

internal sealed interface RuntimeCatalogUpdate {
    val active: RuntimeCatalogSnapshot?
    val diagnostics: List<CatalogDiagnostic>

    data class Published(
        override val active: RuntimeCatalogSnapshot,
        override val diagnostics: List<CatalogDiagnostic>,
        val completionFailures: List<Throwable> = emptyList(),
    ) : RuntimeCatalogUpdate

    class Prepared internal constructor(
        override val active: RuntimeCatalogSnapshot?,
        override val diagnostics: List<CatalogDiagnostic>,
        internal val owner: RuntimeCatalogManager,
        internal val request: Long,
        internal val loaded: RuntimeCatalogManager.LoadedRuntimeCandidate,
        internal val candidate: CatalogCandidate,
        internal val presentation: PresentationCatalogSnapshot,
    ) : RuntimeCatalogUpdate {
        private val claimed = AtomicBoolean()

        internal fun claim(): Boolean = claimed.compareAndSet(false, true)
    }

    data class Validated(
        override val active: RuntimeCatalogSnapshot?,
        override val diagnostics: List<CatalogDiagnostic>,
    ) : RuntimeCatalogUpdate

    data class Rejected(
        override val active: RuntimeCatalogSnapshot?,
        override val diagnostics: List<CatalogDiagnostic>,
    ) : RuntimeCatalogUpdate

    data class Superseded(
        override val active: RuntimeCatalogSnapshot?,
        override val diagnostics: List<CatalogDiagnostic>,
    ) : RuntimeCatalogUpdate

    data class PublicationFailed(
        override val active: RuntimeCatalogSnapshot?,
        override val diagnostics: List<CatalogDiagnostic>,
        val failure: Throwable,
    ) : RuntimeCatalogUpdate
}

/** Creates one rollback-capable downstream transaction for a materialized catalog snapshot. */
internal fun interface RuntimeCatalogPublication {
    fun prepare(snapshot: RuntimeCatalogSnapshot): PreparedRuntimeCatalogPublication

    companion object {
        val NO_OP = RuntimeCatalogPublication {
            object : PreparedRuntimeCatalogPublication {
                override fun commit() = Unit
                override fun rollback() = Unit
            }
        }
    }
}

/**
 * A prepared publication has no externally visible effects until [commit]. Rollback must be safe
 * after any failed commit; [complete] runs only after the API snapshot and downstream state agree.
 */
internal interface PreparedRuntimeCatalogPublication {
    fun commit()

    fun rollback()

    fun complete() = Unit
}

private fun Throwable.withPublicationFailure(other: Throwable): Throwable {
    if (other === this) return this
    return if (!isFatalPublicationFailure() && other.isFatalPublicationFailure()) {
        other.apply { addSuppressed(this@withPublicationFailure) }
    } else {
        apply { addSuppressed(other) }
    }
}

private fun Throwable.rethrowIfFatalPublicationFailure() {
    if (isFatalPublicationFailure()) throw this
}

@Suppress("DEPRECATION")
private fun Throwable.isFatalPublicationFailure(): Boolean =
    this is VirtualMachineError || this is ThreadDeath
