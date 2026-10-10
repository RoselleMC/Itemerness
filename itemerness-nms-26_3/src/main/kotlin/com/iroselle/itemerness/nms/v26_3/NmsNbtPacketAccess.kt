package com.iroselle.itemerness.nms.v26_3

import io.netty.buffer.Unpooled
import java.lang.reflect.Constructor
import java.lang.reflect.Field
import java.lang.reflect.Modifier
import java.util.Optional
import net.minecraft.nbt.CompoundTag
import net.minecraft.network.RegistryFriendlyByteBuf
import net.minecraft.network.protocol.Packet
import net.minecraft.network.protocol.game.ClientboundLevelChunkPacketData
import net.minecraft.network.protocol.game.ClientboundLevelChunkWithLightPacket
import net.minecraft.world.level.block.entity.BlockEntityType

/** Exact 26.3 access to the private block-entity entries embedded in a chunk packet. */
internal object NmsChunkPacketAccess {
    private val blockEntityInfoClass = Class.forName(
        "net.minecraft.network.protocol.game.ClientboundLevelChunkPacketData\$BlockEntityInfo",
    )
    private val blockEntitiesDataField: Field = ClientboundLevelChunkPacketData::class.java
        .getDeclaredField("blockEntitiesData")
        .also(::makeInstanceFieldAccessible)
    private val packedXzField: Field = blockEntityInfoClass
        .getDeclaredField("packedXZ")
        .also(::makeInstanceFieldAccessible)
    private val yField: Field = blockEntityInfoClass
        .getDeclaredField("y")
        .also(::makeInstanceFieldAccessible)
    private val typeField: Field = blockEntityInfoClass
        .getDeclaredField("type")
        .also(::makeInstanceFieldAccessible)
    private val tagField: Field = blockEntityInfoClass
        .getDeclaredField("tag")
        .also(::makeInstanceFieldAccessible)
    // 26.3 turned BlockEntityInfo into a private record whose wire tag is Optional<CompoundTag>
    // and whose packed coordinates are a byte and a short.
    private val blockEntityInfoConstructor: Constructor<*> = blockEntityInfoClass
        .getDeclaredConstructor(
            Byte::class.javaPrimitiveType,
            Short::class.javaPrimitiveType,
            BlockEntityType::class.java,
            Optional::class.java,
        )
        .also { constructor ->
            check(constructor.trySetAccessible()) {
                "Cannot access ClientboundLevelChunkPacketData.BlockEntityInfo constructor"
            }
        }

    /**
     * Copies the packet through its registry-aware wire codec. This retains every vanilla wire
     * field without making the adapter depend on private light or heightmap layouts.
     */
    fun wireCopy(
        source: ClientboundLevelChunkWithLightPacket,
        registryAccess: net.minecraft.core.RegistryAccess,
        maxPacketBytes: Int = NmsProjectionLimits.DEFAULT.chunkPacketBytes,
    ): ClientboundLevelChunkWithLightPacket {
        requireProjectionInput(maxPacketBytes > 0) { "Chunk packet codec-copy limit must be positive" }
        val storage = Unpooled.buffer(INITIAL_PACKET_BYTES, maxPacketBytes)
        try {
            val buffer = RegistryFriendlyByteBuf(storage, registryAccess)
            ClientboundLevelChunkWithLightPacket.STREAM_CODEC.encode(buffer, source)
            requireProjectionInput(buffer.readableBytes() <= maxPacketBytes) {
                "Chunk packet exceeds the codec-copy byte limit"
            }
            buffer.readerIndex(0)
            val copy = ClientboundLevelChunkWithLightPacket.STREAM_CODEC.decode(buffer)
            check(!buffer.isReadable) { "Chunk packet codec left unread bytes" }

            // These are Paper transport fields rather than wire fields. Connection expansion
            // normally occurs before this channel hook, but preserving them keeps direct writes
            // and test harnesses semantically equivalent as well.
            copy.setReady(source.isReady)
            copy.chunkData.extraPackets.addAll(source.extraPackets)
            return copy
        } finally {
            storage.release()
        }
    }

    fun rewriteBlockEntityTags(
        packet: ClientboundLevelChunkWithLightPacket,
        transform: (CompoundTag) -> NmsCompoundProjection,
    ): Boolean {
        var changed = false
        val entries = blockEntityEntries(packet.chunkData)
        val iterator = entries.listIterator()
        while (iterator.hasNext()) {
            val entry = iterator.next()
            val sourceTag = (tagField.get(entry) as Optional<*>).orElse(null) as CompoundTag? ?: continue
            val projected = transform(sourceTag)
            if (!projected.changed) continue

            iterator.set(
                blockEntityInfoConstructor.newInstance(
                    packedXzField.getByte(entry),
                    yField.getShort(entry),
                    typeField.get(entry),
                    Optional.of(projected.tag),
                ),
            )
            changed = true
        }
        return changed
    }

    fun verifyAbi() {
        check(blockEntityInfoClass.enclosingClass == ClientboundLevelChunkPacketData::class.java) {
            "BlockEntityInfo moved out of ClientboundLevelChunkPacketData"
        }
        check(Modifier.isPrivate(blockEntityInfoClass.modifiers)) {
            "ClientboundLevelChunkPacketData.BlockEntityInfo is no longer private"
        }
        check(blockEntityInfoClass.isRecord) {
            "ClientboundLevelChunkPacketData.BlockEntityInfo is no longer a record"
        }
        check(blockEntityInfoClass.recordComponents.map { component -> component.name } ==
            listOf("packedXZ", "y", "type", "tag")) {
            "ClientboundLevelChunkPacketData.BlockEntityInfo record components changed"
        }
        check(Modifier.isPrivate(blockEntityInfoConstructor.modifiers)) {
            "ClientboundLevelChunkPacketData.BlockEntityInfo constructor is no longer private"
        }
        check(List::class.java.isAssignableFrom(blockEntitiesDataField.type)) {
            "ClientboundLevelChunkPacketData.blockEntitiesData is no longer a List"
        }
        check(packedXzField.type == Byte::class.javaPrimitiveType)
        check(yField.type == Short::class.javaPrimitiveType)
        check(BlockEntityType::class.java.isAssignableFrom(typeField.type))
        check(tagField.type == Optional::class.java)
        ClientboundLevelChunkWithLightPacket::class.java.getField("STREAM_CODEC")
        check(ClientboundLevelChunkWithLightPacket::class.java.isRecord) {
            "ClientboundLevelChunkWithLightPacket is no longer a record"
        }
        check(ClientboundLevelChunkWithLightPacket::class.java.recordComponents.map { component -> component.name } ==
            listOf("x", "z", "chunkData", "lightData")) {
            "ClientboundLevelChunkWithLightPacket record components changed"
        }
        ClientboundLevelChunkWithLightPacket::class.java.getMethod("getExtraPackets")
        ClientboundLevelChunkWithLightPacket::class.java.getMethod("isReady")
        ClientboundLevelChunkWithLightPacket::class.java.getMethod(
            "setReady",
            Boolean::class.javaPrimitiveType,
        )
        RegistryFriendlyByteBuf::class.java.getConstructor(
            io.netty.buffer.ByteBuf::class.java,
            net.minecraft.core.RegistryAccess::class.java,
        )
    }

    @Suppress("UNCHECKED_CAST")
    private fun blockEntityEntries(data: ClientboundLevelChunkPacketData): MutableList<Any> =
        blockEntitiesDataField.get(data) as MutableList<Any>

    private fun makeInstanceFieldAccessible(field: Field) {
        check(!Modifier.isStatic(field.modifiers)) { "${field.name} unexpectedly became static" }
        check(field.trySetAccessible()) { "Cannot access ${field.declaringClass.name}.${field.name}" }
    }

    private const val INITIAL_PACKET_BYTES = 256
}
