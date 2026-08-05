package com.iroselle.itemerness.nms.v26_1_2

import io.netty.buffer.Unpooled
import net.minecraft.advancements.AdvancementHolder
import net.minecraft.advancements.AdvancementProgress
import net.minecraft.core.RegistryAccess
import net.minecraft.network.RegistryFriendlyByteBuf
import net.minecraft.network.protocol.game.ClientboundSelectAdvancementsTabPacket
import net.minecraft.network.protocol.game.ClientboundUpdateAdvancementsPacket
import net.minecraft.server.PlayerAdvancements

internal data class NmsAdvancementRefreshSnapshot(
    val advancements: ClientboundUpdateAdvancementsPacket,
    val selectedTab: ClientboundSelectAdvancementsTabPacket,
)

/** Exact 26.1.2 access for a complete advancement client-state replacement. */
internal object NmsPlayerAdvancementsAccess {
    private val visibleField = PlayerAdvancements::class.java.getDeclaredField("visible").also { field ->
        check(field.trySetAccessible()) { "Cannot access PlayerAdvancements.visible" }
    }
    private val progressField = PlayerAdvancements::class.java.getDeclaredField("progress").also { field ->
        check(field.trySetAccessible()) { "Cannot access PlayerAdvancements.progress" }
    }
    private val lastSelectedTabField = PlayerAdvancements::class.java
        .getDeclaredField("lastSelectedTab")
        .also { field ->
            check(field.trySetAccessible()) { "Cannot access PlayerAdvancements.lastSelectedTab" }
        }

    /**
     * Captures the authoritative visible tree without mutating the source collections. The packet
     * codec round trip owns every mutable icon/progress value before it reaches the Netty event loop.
     */
    fun fullSnapshot(
        source: PlayerAdvancements,
        registryAccess: RegistryAccess,
    ): NmsAdvancementRefreshSnapshot {
        @Suppress("UNCHECKED_CAST")
        val visible = (visibleField.get(source) as Set<AdvancementHolder>)
            .sortedBy { holder -> holder.id().toString() }
        if (visible.size > MAX_VISIBLE_ADVANCEMENTS) {
            throw NmsPersistentSurfaceIncompleteException(
                "Authoritative advancement refresh exceeds the visible-entry boundary",
            )
        }

        @Suppress("UNCHECKED_CAST")
        val sourceProgress = progressField.get(source) as Map<AdvancementHolder, AdvancementProgress>
        val progress = LinkedHashMap<net.minecraft.resources.Identifier, AdvancementProgress>(visible.size)
        visible.forEach { holder ->
            sourceProgress[holder]?.let { value -> progress[holder.id()] = value }
        }
        val canonical = ClientboundUpdateAdvancementsPacket(
            true,
            java.util.List.copyOf(visible),
            emptySet(),
            java.util.Map.copyOf(progress),
            false,
        )
        val copy = copyPacket(canonical, registryAccess)
        val selected = (lastSelectedTabField.get(source) as? AdvancementHolder)?.id()
        return NmsAdvancementRefreshSnapshot(
            advancements = copy,
            selectedTab = ClientboundSelectAdvancementsTabPacket(selected),
        )
    }

    fun verifyAbi() {
        check(Set::class.java.isAssignableFrom(visibleField.type)) {
            "PlayerAdvancements.visible is not a Set"
        }
        check(Map::class.java.isAssignableFrom(progressField.type)) {
            "PlayerAdvancements.progress is not a Map"
        }
        check(lastSelectedTabField.type == AdvancementHolder::class.java) {
            "PlayerAdvancements.lastSelectedTab is not an AdvancementHolder"
        }
    }

    private fun copyPacket(
        source: ClientboundUpdateAdvancementsPacket,
        registryAccess: RegistryAccess,
    ): ClientboundUpdateAdvancementsPacket {
        val storage = Unpooled.buffer(1_024, MAX_PACKET_BYTES)
        return try {
            val buffer = RegistryFriendlyByteBuf(storage, registryAccess)
            ClientboundUpdateAdvancementsPacket.STREAM_CODEC.encode(buffer, source)
            val copy = ClientboundUpdateAdvancementsPacket.STREAM_CODEC.decode(buffer)
            check(!storage.isReadable) { "Advancement snapshot codec left unread bytes" }
            copy
        } catch (failure: IndexOutOfBoundsException) {
            throw NmsPersistentSurfaceIncompleteException(
                "Cannot retain a complete bounded authoritative advancement snapshot",
                failure,
            )
        } finally {
            storage.release()
        }
    }

    private const val MAX_VISIBLE_ADVANCEMENTS = 4_096
    private const val MAX_PACKET_BYTES = 8 * 1_024 * 1_024
}
