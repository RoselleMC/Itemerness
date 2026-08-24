package com.iroselle.itemerness.nms.v26_2

import com.iroselle.itemerness.projection.ProjectionResyncRequest
import com.iroselle.itemerness.projection.ProjectionResyncSink
import it.unimi.dsi.fastutil.ints.Int2ObjectOpenHashMap
import java.util.UUID
import net.minecraft.network.HashedStack
import net.minecraft.network.protocol.Packet
import net.minecraft.network.protocol.common.ServerboundCustomClickActionPacket
import net.minecraft.network.protocol.game.ServerboundContainerClickPacket
import net.minecraft.network.protocol.game.ServerboundSetCreativeModeSlotPacket

internal class NmsInboundPacketProjector(
    private val state: NmsConnectionProjectionState,
    private val resyncRequests: ProjectionResyncSink,
) {
    fun isProjectionCarrier(source: Packet<*>): Boolean =
        source is ServerboundContainerClickPacket ||
            source is ServerboundSetCreativeModeSlotPacket ||
            source is ServerboundCustomClickActionPacket

    fun project(source: Packet<*>, viewerId: UUID): InboundPacketDecision = when (source) {
        is ServerboundContainerClickPacket -> InboundPacketDecision.Forward(rewriteClick(source))
        is ServerboundSetCreativeModeSlotPacket -> try {
            rewriteCreative(source, viewerId)
        } catch (_: RuntimeException) {
            if (state.containsManagedMarker(source.itemStack())) {
                rejectCreative(source, viewerId, CreativeRejectReason.MALFORMED_TOKEN)
            } else {
                InboundPacketDecision.Forward(source)
            }
        }
        is ServerboundCustomClickActionPacket -> rewriteCustomClick(source)
        else -> InboundPacketDecision.Forward(source)
    }

    private fun rewriteCustomClick(source: ServerboundCustomClickActionPacket): InboundPacketDecision =
        when (val restored = state.restoreCustomClick(source.id(), source.payload())) {
            CustomClickRestoreResult.Unmanaged -> InboundPacketDecision.Forward(source)
            is CustomClickRestoreResult.Restored -> InboundPacketDecision.Forward(
                ServerboundCustomClickActionPacket(source.id(), restored.payload),
            )
            is CustomClickRestoreResult.Rejected -> InboundPacketDecision.RejectCustomClick(restored.reason)
        }

    private fun rewriteClick(source: ServerboundContainerClickPacket): ServerboundContainerClickPacket = try {
        var changed = false
        val slots = Int2ObjectOpenHashMap<HashedStack>(source.changedSlots().size)
        source.changedSlots().int2ObjectEntrySet().forEach { entry ->
            val result = state.rewrite(entry.value)
            val rewritten = result.stack
            changed = changed || result is HashedRewriteResult.Hit
            slots.put(entry.intKey, rewritten)
        }
        val carriedResult = state.rewrite(source.carriedItem())
        changed = changed || carriedResult is HashedRewriteResult.Hit
        if (!changed) {
            source
        } else {
            ServerboundContainerClickPacket(
                source.containerId(),
                source.stateId(),
                source.slotNum(),
                source.buttonNum(),
                source.containerInput(),
                slots,
                carriedResult.stack,
            )
        }
    } catch (_: RuntimeException) {
        // Unknown or malformed hashes are deliberately left to vanilla RemoteSlot correction.
        source
    }

    private fun rewriteCreative(
        source: ServerboundSetCreativeModeSlotPacket,
        viewerId: UUID,
    ): InboundPacketDecision = when (val result = state.restoreCreative(source.itemStack())) {
        CreativeRestoreResult.Unmanaged -> InboundPacketDecision.Forward(source)
        is CreativeRestoreResult.Restored -> InboundPacketDecision.Forward(
            ServerboundSetCreativeModeSlotPacket(source.slotNum(), result.stack),
        )
        is CreativeRestoreResult.Rejected -> rejectCreative(source, viewerId, result.reason)
    }

    private fun rejectCreative(
        source: ServerboundSetCreativeModeSlotPacket,
        viewerId: UUID,
        reason: CreativeRejectReason,
    ): InboundPacketDecision {
        val slot = source.slotNum().toInt()
        try {
            resyncRequests.offer(
                ProjectionResyncRequest(
                    viewerId = viewerId,
                    connectionGeneration = state.connectionGeneration(),
                    slot = slot.takeIf { it in 1..45 },
                    fullInventory = slot !in 1..45,
                ),
            )
        } catch (_: RuntimeException) {
            // Rejection remains authoritative even when the optional refresh consumer is faulty.
        }
        return InboundPacketDecision.RejectCreative(reason)
    }
}

internal sealed interface InboundPacketDecision {
    data class Forward(val packet: Packet<*>) : InboundPacketDecision
    data class RejectCreative(val reason: CreativeRejectReason) : InboundPacketDecision
    data class RejectCustomClick(val reason: CustomClickRejectReason) : InboundPacketDecision
}
