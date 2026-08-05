package com.iroselle.itemerness.api

import java.util.UUID

/**
 * API view permanently bound to one platform lifecycle identity.
 *
 * This contract intentionally contains no Bukkit ItemStack, NMS tag, packet, or scheduler type.
 * Platform-owned slot transactions live on the Bukkit-specific bound extension.
 */
interface BoundItemernessApi {
    /** Informational plugin name captured from the bound platform identity. */
    val callerPluginName: String

    /** Revision of the immutable catalog snapshot currently visible to this facade. */
    val catalogRevision: Long

    fun findItem(key: ItemKey): ApiCallResult<ItemDefinition?>

    /** Returns only definitions that this caller may identify. */
    fun items(): ApiCallResult<List<ItemDefinition>>

    /** Creates an opaque caller-bound domain handle without exposing canonical data. */
    fun createDomainInstance(key: ItemKey): ApiCallResult<DomainItemInstance>

    /** Reads one schema-authorized value through a caller-bound opaque handle. */
    fun readData(
        instance: DomainItemInstance,
        key: DataKey,
    ): ApiCallResult<ItemDataValue?>

    /** Applies all authorized mutations atomically and returns a new opaque handle. */
    fun editDomainInstance(
        instance: DomainItemInstance,
        mutations: Collection<ItemDataMutation>,
    ): ApiCallResult<DomainItemInstance>

    /** Requests refresh scheduling; it does not expose or mutate a Bukkit inventory slot. */
    fun requestRefresh(request: RefreshRequest): ApiCallResult<RefreshReceipt>
}

sealed interface ItemDataMutation {
    val key: DataKey

    data class Set(
        override val key: DataKey,
        val value: ItemDataValue,
    ) : ItemDataMutation

    data class Unset(
        override val key: DataKey,
    ) : ItemDataMutation
}

/**
 * Opaque, platform-neutral handle for one immutable domain instance.
 *
 * The random handle is meaningful only to the bound API facade that issued it. Canonical schema
 * versions, instance identity, and data deliberately remain behind per-key authorization.
 */
class DomainItemInstance(
    val handleId: UUID,
    val itemKey: ItemKey,
    val createdAgainstRevision: Long,
    val instanceRevision: Long,
) {
    init {
        require(createdAgainstRevision >= 0) { "Creation revision must not be negative" }
        require(instanceRevision >= 0) { "Instance revision must not be negative" }
    }

    override fun equals(other: Any?): Boolean =
        other is DomainItemInstance &&
            handleId == other.handleId &&
            itemKey == other.itemKey &&
            createdAgainstRevision == other.createdAgainstRevision &&
            instanceRevision == other.instanceRevision

    override fun hashCode(): Int {
        var result = handleId.hashCode()
        result = 31 * result + itemKey.hashCode()
        result = 31 * result + createdAgainstRevision.hashCode()
        result = 31 * result + instanceRevision.hashCode()
        return result
    }

    override fun toString(): String =
        "DomainItemInstance(handleId=$handleId, itemKey=$itemKey, " +
            "createdAgainstRevision=$createdAgainstRevision, instanceRevision=$instanceRevision)"
}

/** The smallest refresh target that can be scoped by both player and managed item namespace. */
data class RefreshRequest(
    val playerId: UUID,
    val itemKey: ItemKey,
)

/** Receipt proving that the request crossed the refresh scheduling boundary. */
data class RefreshReceipt(
    val playerId: UUID,
    val itemKey: ItemKey,
    val catalogRevision: Long,
) {
    init {
        require(catalogRevision >= 0) { "Catalog revision must not be negative" }
    }
}
