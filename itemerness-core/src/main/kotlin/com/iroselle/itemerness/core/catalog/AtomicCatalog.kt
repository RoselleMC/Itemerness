package com.iroselle.itemerness.core.catalog

import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

/** Publishes complete catalog snapshots with one compare-and-set operation. */
class AtomicCatalog(
    initialSnapshot: CatalogSnapshot = CatalogSnapshot.empty(),
) {
    private val current = AtomicReference(initialSnapshot)
    private val reloadSequence = AtomicLong()
    private val publicationLock = Any()

    fun snapshot(): CatalogSnapshot = current.get()

    fun publish(candidate: CatalogCandidate): CatalogSnapshot = synchronized(publicationLock) {
        reloadSequence.incrementAndGet()
        publishCandidate(candidate)
    }

    private fun publishCandidate(candidate: CatalogCandidate): CatalogSnapshot {
        while (true) {
            val previous = current.get()
            check(previous.revision != Long.MAX_VALUE) { "Catalog revision is exhausted" }
            val next = candidate.materialize(previous.revision + 1)
            if (current.compareAndSet(previous, next)) {
                return next
            }
        }
    }

    /**
     * Compiles outside the publication lock and publishes only the newest requested reload.
     * A newer invalid request deliberately supersedes an older in-flight request and leaves the
     * previously active snapshot untouched.
     */
    fun compileAndPublish(
        source: CatalogSource,
        compiler: CatalogCompiler = CatalogCompiler(),
    ): CatalogUpdate {
        val request = reloadSequence.incrementAndGet()
        val compilation = compiler.compile(source)
        val candidate = compilation.candidate
        if (candidate == null) {
            synchronized(publicationLock) {
                return if (reloadSequence.get() == request) {
                    CatalogUpdate.Rejected(snapshot(), compilation.diagnostics)
                } else {
                    CatalogUpdate.Superseded(snapshot(), compilation.diagnostics)
                }
            }
        }
        synchronized(publicationLock) {
            if (reloadSequence.get() != request) {
                return CatalogUpdate.Superseded(snapshot(), compilation.diagnostics)
            }
            return CatalogUpdate.Published(publishCandidate(candidate), compilation.diagnostics)
        }
    }

    fun clear(): CatalogSnapshot = publish(CatalogCandidate(emptyMap(), emptyMap(), emptyMap()))
}

sealed interface CatalogUpdate {
    val snapshot: CatalogSnapshot
    val diagnostics: List<CatalogDiagnostic>

    data class Published(
        override val snapshot: CatalogSnapshot,
        override val diagnostics: List<CatalogDiagnostic>,
    ) : CatalogUpdate

    data class Rejected(
        override val snapshot: CatalogSnapshot,
        override val diagnostics: List<CatalogDiagnostic>,
    ) : CatalogUpdate

    data class Superseded(
        override val snapshot: CatalogSnapshot,
        override val diagnostics: List<CatalogDiagnostic>,
    ) : CatalogUpdate
}
