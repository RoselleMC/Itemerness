package com.iroselle.itemerness.core

import com.iroselle.itemerness.api.ItemDefinition
import com.iroselle.itemerness.api.ItemKey
import com.iroselle.itemerness.api.ItemernessApi
import com.iroselle.itemerness.core.catalog.AtomicCatalog
import com.iroselle.itemerness.core.catalog.CatalogCandidate
import com.iroselle.itemerness.core.catalog.CatalogCompilation
import com.iroselle.itemerness.core.catalog.CatalogCompiler
import com.iroselle.itemerness.core.catalog.CatalogSnapshot
import com.iroselle.itemerness.core.catalog.CatalogSource
import com.iroselle.itemerness.core.catalog.CatalogUpdate
import com.iroselle.itemerness.core.catalog.CanonicalItemInstance
import com.iroselle.itemerness.core.catalog.InstanceCreationContext
import com.iroselle.itemerness.core.catalog.InstanceDataMutation

/**
 * Read-only API facade backed by a complete, atomically published catalog snapshot.
 *
 * Thread safety here only covers registry state. It does not make Bukkit objects safe to access
 * outside their owning entity or region context.
 */
class DefaultItemRegistry : ItemernessApi {
    private val catalog = AtomicCatalog()

    override val catalogRevision: Long
        get() = catalog.snapshot().revision

    override fun findItem(key: ItemKey): ItemDefinition? = catalog.snapshot().findItem(key)

    override fun items(): Collection<ItemDefinition> = catalog.snapshot().items.values

    fun snapshot(): CatalogSnapshot = catalog.snapshot()

    fun compile(source: CatalogSource, compiler: CatalogCompiler = CatalogCompiler()): CatalogCompilation =
        compiler.compile(source)

    fun publish(candidate: CatalogCandidate): CatalogSnapshot = catalog.publish(candidate)

    fun compileAndPublish(source: CatalogSource, compiler: CatalogCompiler = CatalogCompiler()): CatalogUpdate =
        catalog.compileAndPublish(source, compiler)

    fun createInstance(
        key: ItemKey,
        context: InstanceCreationContext = InstanceCreationContext.system(),
    ): CanonicalItemInstance = catalog.snapshot().createInstance(key, context)

    fun editInstance(
        instance: CanonicalItemInstance,
        mutations: Collection<InstanceDataMutation>,
    ): CanonicalItemInstance = catalog.snapshot().editInstance(instance, mutations)

    fun clear(): CatalogSnapshot = catalog.clear()
}
