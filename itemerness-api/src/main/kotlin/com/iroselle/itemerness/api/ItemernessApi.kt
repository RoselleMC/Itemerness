package com.iroselle.itemerness.api

/** Read-only service exposed to other plugins through Bukkit's services manager. */
interface ItemernessApi {
    fun findItem(key: ItemKey): ItemDefinition?

    fun items(): Collection<ItemDefinition>
}
