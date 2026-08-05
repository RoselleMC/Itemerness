package com.iroselle.itemerness.api

/**
 * Public identity contract for an item registered with Itemerness.
 *
 * Implementations must keep [key] stable for their entire registered lifetime.
 */
interface ItemDefinition {
    val key: ItemKey

    /** Vanilla material used by the canonical item before viewer projection. */
    val material: ItemKey

    /** Whether separately created instances may share a vanilla item stack. */
    val instanceMode: ItemInstanceMode
}

enum class ItemInstanceMode {
    FUNGIBLE,
    UNIQUE,
}
