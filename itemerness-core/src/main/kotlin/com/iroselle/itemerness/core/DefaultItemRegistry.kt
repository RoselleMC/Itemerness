package com.iroselle.itemerness.core

import com.iroselle.itemerness.api.ItemDefinition
import com.iroselle.itemerness.api.ItemKey
import com.iroselle.itemerness.api.ItemernessApi
import java.util.concurrent.ConcurrentHashMap

/**
 * Thread-safe registry for plugin-owned immutable definitions.
 *
 * Thread safety here only covers registry state. It does not make Bukkit objects safe to access
 * outside their owning entity or region context.
 */
class DefaultItemRegistry : ItemernessApi {
    private val definitions = ConcurrentHashMap<ItemKey, ItemDefinition>()

    fun register(definition: ItemDefinition) {
        val previous = definitions.putIfAbsent(definition.key, definition)
        require(previous == null) {
            "An item with key ${definition.key} is already registered"
        }
    }

    fun unregister(key: ItemKey): ItemDefinition? = definitions.remove(key)

    override fun findItem(key: ItemKey): ItemDefinition? = definitions[key]

    override fun items(): Collection<ItemDefinition> = definitions.values.toList()

    fun clear() {
        definitions.clear()
    }
}
