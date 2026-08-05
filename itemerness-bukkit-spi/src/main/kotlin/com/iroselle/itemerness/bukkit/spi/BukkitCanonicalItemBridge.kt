package com.iroselle.itemerness.bukkit.spi

import com.iroselle.itemerness.api.ItemDefinition
import com.iroselle.itemerness.api.ItemKey
import com.iroselle.itemerness.core.catalog.CanonicalItemInstance
import com.iroselle.itemerness.projection.CanonicalItemSnapshot
import com.iroselle.itemerness.projection.MinecraftVersion
import org.bukkit.inventory.ItemStack

data class PendingItemName(
    val text: String,
    val colorRgb: Int,
) {
    init {
        require(text.isNotBlank()) { "Pending item name must not be blank" }
        require(text.length <= 1_024) { "Pending item name is too long" }
        require(colorRgb in 0..0xFFFFFF) { "Pending item name color is outside the RGB range" }
    }
}

sealed interface CanonicalItemInspection {
    data object Unmanaged : CanonicalItemInspection

    data class InvalidManaged(
        val reason: String,
    ) : CanonicalItemInspection {
        init {
            require(reason.isNotBlank()) { "Invalid managed item reason must not be blank" }
        }
    }

    data class Managed(
        val snapshot: CanonicalItemSnapshot,
    ) : CanonicalItemInspection
}

data class BukkitCanonicalBridgeDescriptor(
    val id: ItemKey,
    val minecraftVersion: MinecraftVersion,
)

/** Exact-version implementation boundary for direct CUSTOM_DATA reads and writes. */
interface BukkitCanonicalItemBridge {
    val descriptor: BukkitCanonicalBridgeDescriptor

    fun create(
        definition: ItemDefinition,
        instance: CanonicalItemInstance,
        pendingName: PendingItemName,
        amount: Int,
    ): ItemStack

    fun rewrite(
        source: ItemStack,
        definition: ItemDefinition,
        instance: CanonicalItemInstance,
        pendingName: PendingItemName,
    ): ItemStack

    fun inspect(source: ItemStack): CanonicalItemInspection

    /** Returns only the managed canonical root for permission-gated diagnostics. */
    fun canonicalSnbt(source: ItemStack): String?
}

interface BukkitCanonicalItemBridgeFactory {
    val descriptor: BukkitCanonicalBridgeDescriptor

    fun create(): BukkitCanonicalItemBridge
}
