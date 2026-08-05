package com.iroselle.itemerness.api

/**
 * Platform-neutral read-only catalog view.
 *
 * Bukkit deliberately does not register this unbound contract as a service; plugins bind through
 * the Bukkit-specific lifecycle entrypoint before receiving an authorized facade.
 */
interface ItemernessApi {
    /** Revision of the complete catalog snapshot currently visible to readers. */
    val catalogRevision: Long

    fun findItem(key: ItemKey): ItemDefinition?

    fun items(): Collection<ItemDefinition>
}
