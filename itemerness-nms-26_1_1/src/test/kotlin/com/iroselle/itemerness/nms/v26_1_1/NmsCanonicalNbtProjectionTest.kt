package com.iroselle.itemerness.nms.v26_1_1

import com.iroselle.itemerness.api.ItemKey
import com.iroselle.itemerness.projection.ItemProjector
import com.iroselle.itemerness.projection.LocaleId
import com.iroselle.itemerness.projection.ProjectionContext
import com.iroselle.itemerness.projection.ProjectionContextSource
import com.iroselle.itemerness.projection.ProjectionGeneration
import com.iroselle.itemerness.projection.ProjectionResult
import com.iroselle.itemerness.projection.ProjectionRuntime
import com.iroselle.itemerness.projection.RenderedDisplay
import com.iroselle.itemerness.projection.RenderedText
import com.iroselle.itemerness.projection.ViewerProjectionSnapshot
import io.netty.buffer.Unpooled
import java.util.BitSet
import java.util.UUID
import net.minecraft.SharedConstants
import net.minecraft.core.BlockPos
import net.minecraft.core.RegistryAccess
import net.minecraft.core.component.DataComponentMap
import net.minecraft.core.component.DataComponents
import net.minecraft.core.registries.BuiltInRegistries
import net.minecraft.core.registries.Registries
import net.minecraft.nbt.ByteTag
import net.minecraft.nbt.CompoundTag
import net.minecraft.nbt.IntTag
import net.minecraft.nbt.ListTag
import net.minecraft.nbt.NbtOps
import net.minecraft.network.RegistryFriendlyByteBuf
import net.minecraft.network.chat.Component
import net.minecraft.network.codec.ByteBufCodecs
import net.minecraft.network.protocol.Packet
import net.minecraft.network.protocol.game.ClientGamePacketListener
import net.minecraft.network.protocol.game.ClientboundBlockEntityDataPacket
import net.minecraft.network.protocol.game.ClientboundBundlePacket
import net.minecraft.network.protocol.game.ClientboundLevelChunkWithLightPacket
import net.minecraft.network.protocol.game.ClientboundTagQueryPacket
import net.minecraft.server.Bootstrap
import net.minecraft.world.item.ItemStack
import net.minecraft.world.item.Items
import net.minecraft.world.item.component.CustomData
import net.minecraft.world.level.block.entity.BlockEntityType
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotSame
import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Test

class NmsCanonicalNbtProjectionTest {
    @Test
    fun `exact nested stack candidates project while outer fields and source stay intact`() {
        val item = encodedCanonicalStack().apply {
            putByte("Slot", 7)
            put("foreign", CompoundTag().apply { putString("owner", "kept") })
        }
        val source = CompoundTag().apply {
            put("inventory", ListTag().apply { add(item) })
            putString("ordinary", "untouched")
        }
        val before = source.copy()

        val projected = nbtSession().project(source)
        val projectedItem = ((projected.tag.get("inventory") as ListTag)[0] as CompoundTag)

        assertTrue(projected.changed)
        assertNotSame(source, projected.tag)
        assertEquals(before, source)
        assertEquals(7, (projectedItem.get("Slot") as ByteTag).value().toInt())
        assertEquals("kept", (projectedItem.get("foreign") as CompoundTag).getString("owner").orElseThrow())
        assertProjected(decodeStack(projectedItem))
        assertCanonical(decodeStack(item))
    }

    @Test
    fun `near markers are deep copied but never decoded as item candidates`() {
        val exact = encodedCanonicalStack()
        val components = exact.get("components") as CompoundTag
        val customData = components.get("minecraft:custom_data") as CompoundTag
        customData.put("itemerness-near", customData.get(NmsCanonicalItemCodec.ROOT_KEY)!!.copy())
        customData.remove(NmsCanonicalItemCodec.ROOT_KEY)
        val source = CompoundTag().apply {
            put("near", exact)
        }

        val projected = nbtSession().project(source)

        assertFalse(projected.changed)
        assertNotSame(source, projected.tag)
        assertEquals(source, projected.tag)
        assertNotSame(source.get("near"), projected.tag.get("near"))
    }

    @Test
    fun `malformed exact candidates are sanitized without exposing their canonical marker`() {
        val malformed = listOf(
            encodedCanonicalStack().apply { putString("id", "minecraft:not_registered") },
            encodedCanonicalStack().apply { remove("id") },
            encodedCanonicalStack().apply { putInt("count", 100) },
            encodedCanonicalStack().apply {
                val customData = (get("components") as CompoundTag)
                    .get("minecraft:custom_data") as CompoundTag
                customData.putString(NmsCanonicalItemCodec.ROOT_KEY, "wrong-type")
            },
        )
        val source = CompoundTag().apply {
            put("payloads", ListTag().apply { malformed.forEach(::add) })
        }

        val projected = nbtSession().project(source)
        val sanitized = projected.tag.get("payloads") as ListTag

        assertTrue(projected.changed)
        sanitized.forEach { assertFalse(hasCanonicalMarker(it as CompoundTag)) }
        malformed.forEach { assertTrue(hasReservedMarker(it)) }
    }

    @Test
    fun `malformed outer candidate sanitizes presentation and still projects nested canonical stacks`() {
        val nested = encodedCanonicalStack()
        val malformed = encodedCanonicalStack().apply {
            putString("id", "minecraft:not_registered")
            val components = get("components") as CompoundTag
            val customData = components.get("minecraft:custom_data") as CompoundTag
            customData.put(
                "foreign",
                CompoundTag().apply { put("nested", nested) },
            )
            customData.put(NmsViewTokenCodec.VIEW_KEY, CompoundTag().apply { putInt("format", 1) })
        }

        val projected = nbtSession().project(CompoundTag().apply { put("outer", malformed) })
        val outer = projected.tag.get("outer") as CompoundTag
        val components = outer.get("components") as CompoundTag
        val customData = components.get("minecraft:custom_data") as CompoundTag
        val projectedNested = (customData.get("foreign") as CompoundTag).get("nested") as CompoundTag

        assertTrue(projected.changed)
        assertFalse(customData.contains(NmsCanonicalItemCodec.ROOT_KEY))
        assertFalse(customData.contains(NmsViewTokenCodec.VIEW_KEY))
        assertFalse(components.contains("minecraft:item_name"))
        assertProjected(decodeStack(projectedNested))
        assertCanonical(decodeStack(nested))
    }

    @Test
    fun `depth list node and aggregate byte limits fail atomically`() {
        var deep = CompoundTag().apply { putInt("leaf", 1) }
        repeat(33) { deep = CompoundTag().apply { put("next", deep) } }
        assertThrows(IllegalStateException::class.java) { nbtSession().project(deep) }

        val oversizedList = ListTag().apply {
            repeat(4_097) { add(IntTag.valueOf(it)) }
        }
        assertThrows(IllegalStateException::class.java) {
            nbtSession().project(CompoundTag().apply { put("list", oversizedList) })
        }

        val nodeFlood = CompoundTag().apply {
            put("left", ListTag().apply { repeat(4_096) { add(IntTag.valueOf(it)) } })
            put("right", ListTag().apply { repeat(4_096) { add(IntTag.valueOf(it)) } })
        }
        assertThrows(IllegalStateException::class.java) { nbtSession().project(nodeFlood) }

        val byteFlood = CompoundTag().apply { putByteArray("bytes", ByteArray(2 * 1_024 * 1_024)) }
        assertThrows(IllegalStateException::class.java) { nbtSession().project(byteFlood) }
    }

    @Test
    fun `bundle shares one nbt byte budget across nested packets`() {
        fun query(id: Int) = ClientboundTagQueryPacket(
            id,
            CompoundTag().apply { putByteArray("payload", ByteArray(1_100_000)) },
        )
        val first = query(1)
        val second = query(2)
        assertSame(first, outbound().project(first, VIEWER_ID))
        assertSame(second, outbound().project(second, VIEWER_ID))

        val bundle = ClientboundBundlePacket(
            listOf<Packet<in ClientGamePacketListener>>(first, second),
        )
        assertThrows(IllegalStateException::class.java) {
            outbound().project(bundle, VIEWER_ID)
        }
    }

    @Test
    fun `tag query block entity and bundle envelopes preserve metadata and project nested items`() {
        val queryTag = CompoundTag().apply { put("result", encodedCanonicalStack()) }
        val blockTag = CompoundTag().apply { put("items", ListTag().apply { add(encodedCanonicalStack()) }) }
        val query = ClientboundTagQueryPacket(73, queryTag)
        val block = ClientboundBlockEntityDataPacket(BlockPos(4, 65, -9), BlockEntityType.CHEST, blockTag)
        val bundle = ClientboundBundlePacket(
            listOf<Packet<in ClientGamePacketListener>>(query, block),
        )

        val projected = outbound().project(bundle, VIEWER_ID) as ClientboundBundlePacket
        val packets = projected.subPackets().toList()
        val projectedQuery = packets[0] as ClientboundTagQueryPacket
        val projectedBlock = packets[1] as ClientboundBlockEntityDataPacket

        assertEquals(73, projectedQuery.transactionId)
        assertProjected(decodeStack(projectedQuery.tag!!.get("result") as CompoundTag))
        assertEquals(BlockPos(4, 65, -9), projectedBlock.pos)
        assertSame(BlockEntityType.CHEST, projectedBlock.type)
        assertProjected(decodeStack((projectedBlock.tag.get("items") as ListTag)[0] as CompoundTag))
        assertTrue(hasCanonicalMarker(queryTag.get("result") as CompoundTag))
        assertTrue(hasCanonicalMarker((blockTag.get("items") as ListTag)[0] as CompoundTag))
    }

    @Test
    fun `chunk projection rewrites copied block entity tags and survives an exact codec round trip`() {
        val canonicalTag = CompoundTag().apply { put("slot", encodedCanonicalStack().apply { putByte("Slot", 2) }) }
        val ordinaryTag = CompoundTag().apply { putString("id", "ordinary-block-entity") }
        val source = chunkPacket(listOf(canonicalTag, ordinaryTag)).also { it.setReady(true) }
        val sourceWireSize = source.chunkData.readBuffer.readableBytes()

        val projected = outbound().project(source, VIEWER_ID) as ClientboundLevelChunkWithLightPacket
        val projectedTags = chunkTags(projected)

        assertNotSame(source, projected)
        assertEquals(source.x, projected.x)
        assertEquals(source.z, projected.z)
        assertEquals(sourceWireSize, projected.chunkData.readBuffer.readableBytes())
        assertEquals(source.lightData.skyYMask, projected.lightData.skyYMask)
        assertEquals(source.lightData.blockYMask, projected.lightData.blockYMask)
        assertTrue(projected.isReady)
        assertProjected(decodeStack(projectedTags[0].get("slot") as CompoundTag))
        assertEquals(ordinaryTag, projectedTags[1])
        assertCanonical(decodeStack(chunkTags(source)[0].get("slot") as CompoundTag))

        val roundTripped = roundTripChunk(projected)
        val roundTripTags = chunkTags(roundTripped)
        assertProjected(decodeStack(roundTripTags[0].get("slot") as CompoundTag))
        assertEquals(projected.x, roundTripped.x)
        assertEquals(projected.z, roundTripped.z)
        assertEquals(projected.lightData.emptySkyYMask, roundTripped.lightData.emptySkyYMask)
        assertEquals(projected.lightData.emptyBlockYMask, roundTripped.lightData.emptyBlockYMask)
    }

    @Test
    fun `unmarked nbt packets retain identity and null tag query remains null`() {
        val ordinary = ClientboundTagQueryPacket(5, CompoundTag().apply { putString("value", "plain") })
        val empty = ClientboundTagQueryPacket(6, null)

        assertSame(ordinary, outbound().project(ordinary, VIEWER_ID))
        assertSame(empty, outbound().project(empty, VIEWER_ID))
    }

    private fun nbtSession(): NmsCanonicalNbtProjector.Session = NmsCanonicalNbtProjector(
        NmsRecursiveItemProjector(NmsItemStackProjector(runtime())),
    ).newSession(VIEWER_ID, REGISTRY_ACCESS)

    private fun outbound(): NmsOutboundPacketProjector = NmsOutboundPacketProjector(
        NmsItemStackProjector(runtime()),
        registryAccessSource = { REGISTRY_ACCESS },
    )

    private fun encodedCanonicalStack(): CompoundTag = ItemStack.CODEC
        .encodeStart(OPS, canonicalStack())
        .result()
        .orElseThrow() as CompoundTag

    private fun decodeStack(tag: CompoundTag): ItemStack = ItemStack.CODEC
        .parse(OPS, tag)
        .result()
        .orElseThrow()

    private fun canonicalStack(): ItemStack {
        val root = CompoundTag().apply {
            putInt("format", 1)
            putString("id", "itemerness:travel-token")
            putLong("created_against_revision", 1)
            putLong("instance_revision", 0)
            put("data_schemas", CompoundTag().apply { putInt("itemerness:common", 1) })
            put("data", CompoundTag().apply { putInt("example:charges", 3) })
        }
        return ItemStack(Items.PAPER).also { stack ->
            CustomData.set(
                DataComponents.CUSTOM_DATA,
                stack,
                CompoundTag().apply { put(NmsCanonicalItemCodec.ROOT_KEY, root) },
            )
            stack.set(DataComponents.ITEM_NAME, Component.literal("[itemerness:travel-token]"))
        }
    }

    private fun runtime(): ProjectionRuntime = ProjectionRuntime(
        projector = ItemProjector {
            ProjectionResult.Rendered(
                RenderedDisplay(
                    displayName = RenderedText.plain("Projected item"),
                    lore = listOf(RenderedText.plain("Projected lore")),
                ),
            )
        },
        contexts = ProjectionContextSource { viewerId ->
            if (viewerId != VIEWER_ID) null else ProjectionContext(
                viewer = ViewerProjectionSnapshot(
                    viewerId = VIEWER_ID,
                    revision = 1,
                    locale = LocaleId("en_us"),
                    theme = ItemKey.parse("itemerness:default"),
                    assetProfile = null,
                ),
                generation = ProjectionGeneration(catalogRevision = 1, epoch = 1),
            )
        },
    )

    private fun assertCanonical(stack: ItemStack) {
        assertTrue(stack.get(DataComponents.CUSTOM_DATA)?.contains(NmsCanonicalItemCodec.ROOT_KEY) == true)
    }

    private fun assertProjected(stack: ItemStack) {
        assertFalse(stack.get(DataComponents.CUSTOM_DATA)?.contains(NmsCanonicalItemCodec.ROOT_KEY) == true)
        assertEquals("Projected item", stack.get(DataComponents.ITEM_NAME)?.string)
    }

    private fun hasCanonicalMarker(tag: CompoundTag): Boolean {
        val components = tag.get("components") as? CompoundTag ?: return false
        val customData = components.get("minecraft:custom_data") as? CompoundTag ?: return false
        return customData.get(NmsCanonicalItemCodec.ROOT_KEY) is CompoundTag
    }

    private fun hasReservedMarker(tag: CompoundTag): Boolean {
        val components = tag.get("components") as? CompoundTag ?: return false
        val customData = components.get("minecraft:custom_data") as? CompoundTag ?: return false
        return customData.contains(NmsCanonicalItemCodec.ROOT_KEY)
    }

    private fun chunkPacket(tags: List<CompoundTag>): ClientboundLevelChunkWithLightPacket {
        val storage = Unpooled.buffer()
        try {
            val buffer = RegistryFriendlyByteBuf(storage, REGISTRY_ACCESS)
            buffer.writeInt(CHUNK_X)
            buffer.writeInt(CHUNK_Z)
            buffer.writeVarInt(0) // heightmap entry count
            buffer.writeVarInt(0) // serialized section bytes
            buffer.writeVarInt(tags.size)
            tags.forEachIndexed { index, tag ->
                buffer.writeByte((index shl 4) or index)
                buffer.writeShort(64 + index)
                ByteBufCodecs.registry(Registries.BLOCK_ENTITY_TYPE).encode(buffer, BlockEntityType.CHEST)
                buffer.writeNbt(tag)
            }
            repeat(4) { buffer.writeBitSet(BitSet()) }
            buffer.writeVarInt(0) // sky updates
            buffer.writeVarInt(0) // block updates
            buffer.readerIndex(0)
            return ClientboundLevelChunkWithLightPacket.STREAM_CODEC.decode(buffer).also {
                check(!buffer.isReadable) { "Synthetic chunk packet left unread bytes" }
            }
        } finally {
            storage.release()
        }
    }

    private fun roundTripChunk(source: ClientboundLevelChunkWithLightPacket): ClientboundLevelChunkWithLightPacket {
        val storage = Unpooled.buffer()
        try {
            val buffer = RegistryFriendlyByteBuf(storage, REGISTRY_ACCESS)
            ClientboundLevelChunkWithLightPacket.STREAM_CODEC.encode(buffer, source)
            buffer.readerIndex(0)
            return ClientboundLevelChunkWithLightPacket.STREAM_CODEC.decode(buffer).also {
                check(!buffer.isReadable) { "Chunk round trip left unread bytes" }
            }
        } finally {
            storage.release()
        }
    }

    private fun chunkTags(packet: ClientboundLevelChunkWithLightPacket): List<CompoundTag> {
        val result = ArrayList<CompoundTag>()
        packet.chunkData.getBlockEntitiesTagsConsumer(packet.x, packet.z).accept { _, _, tag ->
            if (tag != null) result += tag.copy()
        }
        return result
    }

    private companion object {
        val VIEWER_ID: UUID = UUID.fromString("7fd6fb62-3986-4e9b-aa85-77096311f36a")
        lateinit var REGISTRY_ACCESS: RegistryAccess
        val OPS get() = REGISTRY_ACCESS.createSerializationContext(NbtOps.INSTANCE)
        const val CHUNK_X = 11
        const val CHUNK_Z = -4

        @JvmStatic
        @BeforeAll
        fun bootstrapMinecraft() {
            SharedConstants.tryDetectVersion()
            Bootstrap.bootStrap()
            Items.PAPER.builtInRegistryHolder().bindComponents(DataComponentMap.EMPTY)
            REGISTRY_ACCESS = RegistryAccess.fromRegistryOfRegistries(BuiltInRegistries.REGISTRY)
        }
    }
}
