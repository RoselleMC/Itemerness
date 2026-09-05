package com.iroselle.itemerness.bukkit.event

import org.bukkit.event.Event
import org.bukkit.event.HandlerList

/** Fired after Itemerness has atomically committed a new complete catalog revision. */
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
