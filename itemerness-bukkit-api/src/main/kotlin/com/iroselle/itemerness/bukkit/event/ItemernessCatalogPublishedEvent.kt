package com.iroselle.itemerness.bukkit.event

import org.bukkit.event.Event
import org.bukkit.event.HandlerList

/**
 * Reports a successful runtime YAML catalog reload after the complete revision has committed.
 *
 * Delivered synchronously on the global region scheduler, outside Itemerness's publication lock,
 * in publication order. This context does not own any entity or region: listeners must schedule
 * player, inventory, block, and world work in the appropriate owning context and must not wait for
 * that work here. Listener failures do not roll back the committed catalog.
 *
 * The initial startup catalog is not announced. Consumers should bind the Bukkit API after their
 * enable lifecycle has completed, read its current revision, and use this event to invalidate
 * cached catalog data.
 * Validation-only reloads, rejected candidates, and editor draft saves do not emit this event.
 * Revisions belong to the current Itemerness lifecycle and may restart after the plugin restarts.
 */
class ItemernessCatalogPublishedEvent(
    val catalogRevision: Long,
) : Event() {
    init {
        require(catalogRevision >= 0) { "Catalog revision must not be negative" }
    }

    override fun getHandlers(): HandlerList = handlerList

    companion object {
        @JvmStatic
        val handlerList = HandlerList()
    }
}
