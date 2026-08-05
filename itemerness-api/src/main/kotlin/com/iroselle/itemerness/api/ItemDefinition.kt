package com.iroselle.itemerness.api

/**
 * Public identity contract for an item registered with Itemerness.
 *
 * Implementations must keep [key] stable for their entire registered lifetime.
 */
interface ItemDefinition {
    val key: ItemKey
}
