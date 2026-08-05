package com.iroselle.itemerness.nms.v26_1_2

import java.util.UUID
import net.minecraft.network.protocol.game.ClientboundContainerSetSlotPacket

internal class NmsContainerSlotProjector(
    private val itemProjector: NmsItemStackProjector,
) {
    fun project(
        source: ClientboundContainerSetSlotPacket,
        viewerId: UUID,
    ): ClientboundContainerSetSlotPacket {
        val projected = itemProjector.project(source.item, viewerId)
        if (projected === source.item) {
            return source
        }
        return ClientboundContainerSetSlotPacket(
            source.containerId,
            source.stateId,
            source.slot,
            projected,
        )
    }
}
