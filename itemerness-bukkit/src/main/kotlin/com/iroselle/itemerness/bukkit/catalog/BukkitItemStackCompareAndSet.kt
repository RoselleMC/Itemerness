package com.iroselle.itemerness.bukkit.catalog

import org.bukkit.inventory.ItemStack

/**
 * Compares one live slot against an owning-context baseline without discarding foreign state.
 *
 * Paper's exact [ItemStack.equals] contract includes the amount, material, and complete data
 * component patch. A canonical-NBT fingerprint is intentionally insufficient here because another
 * plugin may concurrently change a vanilla component or unrelated custom data on the same stack.
 */
internal fun samePhysicalItemStack(
    expected: ItemStack,
    actual: ItemStack,
): Boolean = expected == actual
