package com.iroselle.itemerness.bukkit.api

import com.iroselle.itemerness.api.ApiCallResult
import com.iroselle.itemerness.api.BoundItemernessApi
import com.iroselle.itemerness.api.DataKey
import com.iroselle.itemerness.api.ItemDataMutation
import com.iroselle.itemerness.api.ItemDataValue
import com.iroselle.itemerness.api.ItemKey
import java.util.UUID
import java.util.concurrent.CompletionStage
import org.bukkit.entity.Player
import org.bukkit.inventory.ItemStack

/**
 * Bukkit item operations bound to one active plugin lifecycle generation.
 *
 * Returned stacks are independent copies owned by the caller. For live inventory mutation use
 * [editPlayerSlot], which moves the complete compare-and-replace transaction into the player's
 * owning Folia context. The binding is a cooperative plugin-governance boundary, not a hostile
 * in-process JVM sandbox.
 */
interface BoundBukkitItemernessApi : BoundItemernessApi {
    fun createItem(key: ItemKey): ApiCallResult<ItemStack> = createItem(key, 1)

    /** Creates a new canonical stack whose authority is direct Itemerness custom NBT. */
    fun createItem(
        key: ItemKey,
        amount: Int,
    ): ApiCallResult<ItemStack>

    /**
     * Identifies a canonical stack without exposing its data values.
     *
     * Unmanaged stacks return a successful `null`; malformed managed stacks return a typed denial.
     */
    fun identifyItem(source: ItemStack): ApiCallResult<BukkitItemIdentity?>

    /** Reads one authorized typed value, including an explicitly configured read-only fallback. */
    fun readItemData(
        source: ItemStack,
        key: DataKey,
    ): ApiCallResult<ItemDataValue?>

    /**
     * Applies all mutations to an immutable domain copy and returns a rewritten stack copy.
     * The supplied [source] is never modified.
     */
    fun editItem(
        source: ItemStack,
        mutations: Collection<ItemDataMutation>,
    ): ApiCallResult<ItemStack>

    /**
     * Atomically edits one live player slot in that player's owning scheduler context.
     *
     * The operation re-reads the slot and active catalog immediately before replacement. A
     * concurrent slot or catalog change produces a typed conflict and preserves the newer stack.
     */
    fun editPlayerSlot(
        player: Player,
        slot: BukkitPlayerSlot,
        mutations: Collection<ItemDataMutation>,
    ): CompletionStage<ApiCallResult<BukkitSlotEditReceipt>>

    /** Publishes this caller's typed contribution to an API-enabled viewer fact. */
    fun publishViewerFact(
        viewerId: UUID,
        key: ItemKey,
        value: ItemDataValue,
    ): ApiCallResult<ViewerFactReceipt>

    /** Clears only this caller's contribution, revealing the prior caller or lower provider. */
    fun clearViewerFact(
        viewerId: UUID,
        key: ItemKey,
    ): ApiCallResult<ViewerFactReceipt>
}

/** Player inventory locations whose Bukkit access has an unambiguous owning entity. */
enum class BukkitPlayerSlot {
    MAIN_HAND,
    OFF_HAND,
    HELMET,
    CHESTPLATE,
    LEGGINGS,
    BOOTS,
}

/** Immutable receipt for a completed owning-context slot transaction. */
data class BukkitSlotEditReceipt(
    val playerId: UUID,
    val slot: BukkitPlayerSlot,
    val identity: BukkitItemIdentity,
    val catalogRevision: Long,
    val semanticChanged: Boolean,
) {
    init {
        require(catalogRevision >= 0) { "Catalog revision must not be negative" }
    }
}

/** Result of accepting an owned viewer-fact mutation. */
data class ViewerFactReceipt(
    val viewerId: UUID,
    val key: ItemKey,
    val viewerFactRevision: Long,
    val semanticChanged: Boolean,
) {
    init {
        require(viewerFactRevision >= 0) { "Viewer fact revision must not be negative" }
    }
}

/** Safe identity metadata that does not bypass per-data-key read authorization. */
data class BukkitItemIdentity(
    val itemKey: ItemKey,
    val material: ItemKey,
    val amount: Int,
    val instanceId: UUID?,
    val createdAgainstRevision: Long,
    val instanceRevision: Long,
) {
    init {
        require(amount > 0) { "Managed item amount must be positive" }
        require(createdAgainstRevision >= 0) { "Creation revision must not be negative" }
        require(instanceRevision >= 0) { "Instance revision must not be negative" }
    }
}
