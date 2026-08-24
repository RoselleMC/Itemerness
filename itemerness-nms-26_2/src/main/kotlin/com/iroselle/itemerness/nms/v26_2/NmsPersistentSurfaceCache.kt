package com.iroselle.itemerness.nms.v26_2

import com.mojang.datafixers.util.Pair
import io.netty.buffer.Unpooled
import java.util.LinkedHashMap
import java.util.Optional
import net.minecraft.core.RegistryAccess
import net.minecraft.core.particles.ItemParticleOption
import net.minecraft.core.particles.ParticleOptions
import net.minecraft.core.registries.BuiltInRegistries
import net.minecraft.nbt.CompoundTag
import net.minecraft.nbt.ListTag
import net.minecraft.nbt.NbtOps
import net.minecraft.nbt.StringTag
import net.minecraft.nbt.Tag
import net.minecraft.network.RegistryFriendlyByteBuf
import net.minecraft.network.chat.Component
import net.minecraft.network.chat.ComponentSerialization
import net.minecraft.network.protocol.Packet
import net.minecraft.network.protocol.game.ClientboundBundlePacket
import net.minecraft.network.protocol.game.ClientboundContainerClosePacket
import net.minecraft.network.protocol.game.ClientboundLoginPacket
import net.minecraft.network.protocol.game.ClientboundOpenScreenPacket
import net.minecraft.network.protocol.game.ClientboundPlaceGhostRecipePacket
import net.minecraft.network.protocol.game.ClientboundRemoveEntitiesPacket
import net.minecraft.network.protocol.game.ClientboundRespawnPacket
import net.minecraft.network.protocol.game.ClientboundSetEntityDataPacket
import net.minecraft.network.protocol.game.ClientboundSetEquipmentPacket
import net.minecraft.network.protocol.game.ClientboundStartConfigurationPacket
import net.minecraft.network.syncher.EntityDataSerializer
import net.minecraft.network.syncher.EntityDataSerializers
import net.minecraft.network.syncher.SynchedEntityData
import net.minecraft.world.entity.EquipmentSlot
import net.minecraft.world.item.ItemStack
import net.minecraft.world.item.crafting.display.FurnaceRecipeDisplay
import net.minecraft.world.item.crafting.display.RecipeDisplay
import net.minecraft.world.item.crafting.display.ShapedCraftingRecipeDisplay
import net.minecraft.world.item.crafting.display.ShapelessCraftingRecipeDisplay
import net.minecraft.world.item.crafting.display.SlotDisplay
import net.minecraft.world.item.crafting.display.SmithingRecipeDisplay
import net.minecraft.world.item.crafting.display.StonecutterRecipeDisplay

/**
 * Canonical snapshots for persistent client surfaces that cannot be reconstructed safely from
 * authoritative server state during a viewer refresh.
 *
 * Every observation is transactional. Resource exhaustion rejects the current connection through
 * [NmsPersistentSurfaceIncompleteException]; it never evicts covered state and then reports a
 * complete refresh. Recipe synchronization, recipe-book entries, and advancements are deliberately
 * absent because the owning player context can reconstruct them directly from NMS state.
 */
internal class NmsPersistentSurfaceCache(
    private val entityCapacity: Int = DEFAULT_ENTITY_CAPACITY,
    private val registryAccess: RegistryAccess = RegistryAccess.fromRegistryOfRegistries(BuiltInRegistries.REGISTRY),
    private val wireSizer: NmsPersistentWireSizer = NmsRegistryPersistentWireSizer(registryAccess),
    private val packetSnapshots: NmsPersistentPacketSnapshotter = NmsPersistentPacketSnapshots(registryAccess),
    private val snapshotValueLimit: Int = MAX_STORED_VALUES,
    private val snapshotWireByteLimit: Int = MAX_STORED_WIRE_BYTES,
    private val snapshotPacketLimit: Int = MAX_SNAPSHOT_PACKETS,
) {
    private val detector = NmsPersistentManagedSurfaceDetector(registryAccess)
    private val entities = LinkedHashMap<Int, EntitySurfaces>()
    private var ghostRecipe: GhostRecipeSurface? = null
    private var storedValues = 0
    private var storedWireBytes = 0
    @Volatile
    private var surfaceRevision = 0L

    init {
        require(entityCapacity > 0) { "Persistent surface capacity must be positive" }
        require(snapshotValueLimit > 0) { "Persistent snapshot value limit must be positive" }
        require(snapshotWireByteLimit > 0) { "Persistent snapshot byte limit must be positive" }
        require(snapshotPacketLimit > 0) { "Persistent snapshot packet limit must be positive" }
    }

    @Synchronized
    fun observe(packet: Packet<*>): Boolean {
        val working = WorkingState(
            entities = LinkedHashMap<Int, EntitySurfaces>().also { target ->
                entities.forEach { (entityId, surfaces) -> target[entityId] = surfaces.copy() }
            },
            ghostRecipe = ghostRecipe,
        )
        try {
            val changed = observe(packet, working, ObservationBudget(), depth = 0)
            working.removeEmptyEntities()
            working.requireComplete()
            commit(working, changed)
            return changed
        } catch (failure: NmsPersistentSurfaceIncompleteException) {
            throw failure
        }
    }

    /**
     * Applies the removal side of a successfully sanitized canonical fallback. The fallback
     * projector already proved that owned markers are absent, so rescanning a deliberately deep
     * foreign component here would duplicate projection work and could reject a safe packet.
     */
    @Synchronized
    fun observeSanitizedFallback(packet: Packet<*>): Boolean {
        val working = WorkingState(
            entities = LinkedHashMap<Int, EntitySurfaces>().also { target ->
                entities.forEach { (entityId, surfaces) -> target[entityId] = surfaces.copy() }
            },
            ghostRecipe = ghostRecipe,
        )
        val changed = observeSanitizedFallback(packet, working, FallbackObservationBudget(), depth = 0)
        working.removeEmptyEntities()
        working.requireComplete()
        commit(working, changed)
        return changed
    }

    @Synchronized
    fun observeContainerClosed(containerId: Int): Boolean {
        val removed = ghostRecipe?.takeIf { surface -> surface.packet.containerId() == containerId } ?: return false
        ghostRecipe = null
        storedValues--
        storedWireBytes -= removed.wireBytes
        surfaceRevision++
        return true
    }

    private fun commit(working: WorkingState, changed: Boolean) {
        entities.clear()
        entities.putAll(working.entities)
        ghostRecipe = working.ghostRecipe
        storedValues = working.valueCount()
        storedWireBytes = working.wireBytes()
        if (changed) surfaceRevision++
    }

    @Synchronized
    fun snapshotPageSet(
        activeContainerId: Int? = null,
        maxPacketsPerPage: Int = DEFAULT_PACKETS_PER_PAGE,
    ): NmsPersistentSurfacePageSet {
        require(maxPacketsPerPage in 1..MAX_PACKETS_PER_PAGE) {
            "Persistent refresh page size must be between 1 and $MAX_PACKETS_PER_PAGE"
        }
        if (storedValues > snapshotValueLimit || storedWireBytes > snapshotWireByteLimit) {
            throw NmsPersistentSurfaceIncompleteException(
                "Persistent refresh snapshot exceeds its configured value or byte boundary",
            )
        }

        val packets = ArrayList<Packet<*>>(minOf(entities.size * 3 + 1, snapshotPacketLimit))
        entities.forEach { (entityId, surfaces) ->
            if (surfaces.metadata.isNotEmpty()) {
                packets += ClientboundSetEntityDataPacket(
                    entityId,
                    java.util.List.copyOf(surfaces.metadata.values.map { surface -> copyDataValue(surface.value) }),
                )
            }
            if (surfaces.equipment.isNotEmpty()) {
                surfaces.equipment.entries.groupBy { entry -> entry.value.sanitize }.forEach { (sanitize, entries) ->
                    packets += ClientboundSetEquipmentPacket(
                        entityId,
                        java.util.List.copyOf(entries.map { entry -> Pair.of(entry.key, entry.value.stack.copy()) }),
                        sanitize,
                    )
                }
            }
        }
        ghostRecipe
            ?.takeIf { surface -> activeContainerId != null && surface.packet.containerId() == activeContainerId }
            ?.let { surface -> packets += packetSnapshots.copyGhostRecipe(surface.packet).packet }

        if (packets.size > snapshotPacketLimit) {
            throw NmsPersistentSurfaceIncompleteException(
                "Persistent refresh snapshot exceeds its configured packet boundary",
            )
        }
        return NmsPersistentSurfacePageSet(
            revision = surfaceRevision,
            pages = java.util.List.copyOf(
                packets.chunked(maxPacketsPerPage).map { page -> java.util.List.copyOf(page) },
            ),
        )
    }

    @Synchronized
    fun snapshotPages(
        activeContainerId: Int? = null,
        maxPacketsPerPage: Int = DEFAULT_PACKETS_PER_PAGE,
    ): List<List<Packet<*>>> = snapshotPageSet(activeContainerId, maxPacketsPerPage).pages

    @Synchronized
    fun snapshot(activeContainerId: Int? = null): List<Packet<*>> =
        java.util.List.copyOf(snapshotPages(activeContainerId).flatten())

    @Synchronized
    fun clear() {
        val changed = entities.isNotEmpty() || ghostRecipe != null
        entities.clear()
        ghostRecipe = null
        storedValues = 0
        storedWireBytes = 0
        if (changed) surfaceRevision++
    }

    fun revision(): Long = surfaceRevision

    private fun observe(
        packet: Packet<*>,
        working: WorkingState,
        budget: ObservationBudget,
        depth: Int,
    ): Boolean {
        budget.enter(depth)
        return when (packet) {
            is ClientboundSetEntityDataPacket -> observeMetadata(packet, working, budget)
            is ClientboundSetEquipmentPacket -> observeEquipment(packet, working, budget)
            is ClientboundPlaceGhostRecipePacket -> observeGhostRecipe(packet, working, budget)
            is ClientboundRemoveEntitiesPacket -> packet.entityIds.fold(false) { changed, entityId ->
                working.entities.remove(entityId) != null || changed
            }
            is ClientboundOpenScreenPacket -> (working.ghostRecipe != null).also { working.ghostRecipe = null }
            is ClientboundContainerClosePacket -> {
                if (working.ghostRecipe?.packet?.containerId() == packet.containerId) {
                    working.ghostRecipe = null
                    true
                } else false
            }
            is ClientboundLoginPacket,
            is ClientboundRespawnPacket,
            is ClientboundStartConfigurationPacket,
            -> (!working.isEmpty()).also { working.clear() }
            is ClientboundBundlePacket -> packet.subPackets().fold(false) { changed, nested ->
                observe(nested, working, budget, depth + 1) || changed
            }
            else -> false
        }
    }

    private fun observeSanitizedFallback(
        packet: Packet<*>,
        working: WorkingState,
        budget: FallbackObservationBudget,
        depth: Int,
    ): Boolean {
        budget.enter(depth)
        return when (packet) {
            is ClientboundSetEntityDataPacket -> working.entities[packet.id()]?.let { target ->
                packet.packedItems().fold(false) { changed, value ->
                    target.metadata.remove(value.id()) != null || changed
                }
            } ?: false
            is ClientboundSetEquipmentPacket -> working.entities[packet.entity]?.let { target ->
                packet.slots.fold(false) { changed, entry ->
                    target.equipment.remove(entry.first) != null || changed
                }
            } ?: false
            is ClientboundPlaceGhostRecipePacket -> (working.ghostRecipe != null).also {
                working.ghostRecipe = null
            }
            is ClientboundRemoveEntitiesPacket -> packet.entityIds.fold(false) { changed, entityId ->
                working.entities.remove(entityId) != null || changed
            }
            is ClientboundOpenScreenPacket -> (working.ghostRecipe != null).also { working.ghostRecipe = null }
            is ClientboundContainerClosePacket -> {
                if (working.ghostRecipe?.packet?.containerId() == packet.containerId) {
                    working.ghostRecipe = null
                    true
                } else false
            }
            is ClientboundLoginPacket,
            is ClientboundRespawnPacket,
            is ClientboundStartConfigurationPacket,
            -> (!working.isEmpty()).also { working.clear() }
            is ClientboundBundlePacket -> packet.subPackets().fold(false) { changed, nested ->
                observeSanitizedFallback(nested, working, budget, depth + 1) || changed
            }
            else -> false
        }
    }

    private fun observeMetadata(
        packet: ClientboundSetEntityDataPacket,
        working: WorkingState,
        budget: ObservationBudget,
    ): Boolean {
        if (packet.packedItems().size > MAX_METADATA_VALUES_PER_PACKET) {
            throw NmsPersistentSurfaceIncompleteException(
                "Persistent metadata update exceeds the per-packet value boundary",
            )
        }
        val target = working.entities[packet.id()]?.copy() ?: EntitySurfaces()
        var changed = false
        packet.packedItems().forEach { source ->
            if (!detector.needsProjection(source)) {
                changed = target.metadata.remove(source.id()) != null || changed
            } else {
                val copied = copyDataValue(source)
                val bytes = measureDataValue(copied, budget)
                target.metadata[source.id()] = MetadataSurface(copied, bytes)
                changed = true
            }
        }
        if (target.isEmpty()) working.entities.remove(packet.id()) else working.entities[packet.id()] = target
        return changed
    }

    private fun observeEquipment(
        packet: ClientboundSetEquipmentPacket,
        working: WorkingState,
        budget: ObservationBudget,
    ): Boolean {
        if (packet.slots.size > MAX_EQUIPMENT_VALUES_PER_PACKET) {
            throw NmsPersistentSurfaceIncompleteException(
                "Persistent equipment update exceeds the per-packet slot boundary",
            )
        }
        val target = working.entities[packet.entity]?.copy() ?: EntitySurfaces()
        val sanitize = NmsEquipmentPacketAccess.sanitize(packet)
        var changed = false
        packet.slots.forEach { entry ->
            if (!detector.needsProjection(entry.second)) {
                changed = target.equipment.remove(entry.first) != null || changed
            } else {
                val copied = entry.second.copy()
                val bytes = measureItem(copied, budget)
                target.equipment[entry.first] = EquipmentSurface(copied, sanitize, bytes)
                changed = true
            }
        }
        if (target.isEmpty()) working.entities.remove(packet.entity) else working.entities[packet.entity] = target
        return changed
    }

    private fun observeGhostRecipe(
        packet: ClientboundPlaceGhostRecipePacket,
        working: WorkingState,
        budget: ObservationBudget,
    ): Boolean {
        if (!detector.needsProjection(packet.recipeDisplay())) {
            val changed = working.ghostRecipe != null
            working.ghostRecipe = null
            return changed
        }
        val snapshot = packetSnapshots.copyGhostRecipe(packet)
        if (snapshot.wireBytes > MAX_STORED_VALUE_WIRE_BYTES) {
            throw NmsPersistentSurfaceIncompleteException(
                "Persistent ghost-recipe value exceeds the wire byte boundary",
            )
        }
        budget.consumeWireBytes(snapshot.wireBytes)
        working.ghostRecipe = GhostRecipeSurface(snapshot.packet, snapshot.wireBytes)
        return true
    }

    @Suppress("UNCHECKED_CAST")
    private fun copyDataValue(source: SynchedEntityData.DataValue<*>): SynchedEntityData.DataValue<*> {
        val serializer = source.serializer() as EntityDataSerializer<Any>
        return SynchedEntityData.DataValue(source.id(), serializer, serializer.copy(source.value() as Any))
    }

    private fun measureDataValue(
        source: SynchedEntityData.DataValue<*>,
        budget: ObservationBudget,
    ): Int = measureBounded("metadata") { wireSizer.dataValueBytes(source) }.also { bytes ->
        requireStoredValueBytes(bytes, "metadata")
        budget.consumeWireBytes(bytes)
    }

    private fun measureItem(source: ItemStack, budget: ObservationBudget): Int =
        measureBounded("equipment") { wireSizer.itemBytes(source) }.also { bytes ->
            requireStoredValueBytes(bytes, "equipment")
            budget.consumeWireBytes(bytes)
        }

    private fun measureBounded(surface: String, measure: () -> Int): Int = try {
        measure()
    } catch (failure: IndexOutOfBoundsException) {
        throw NmsPersistentSurfaceIncompleteException(
            "Persistent $surface value exceeds the codec buffer boundary",
            failure,
        )
    }

    private fun requireStoredValueBytes(bytes: Int, surface: String) {
        if (bytes !in 0..MAX_STORED_VALUE_WIRE_BYTES) {
            throw NmsPersistentSurfaceIncompleteException(
                "Persistent $surface value exceeds the wire byte boundary",
            )
        }
    }

    private inner class WorkingState(
        val entities: LinkedHashMap<Int, EntitySurfaces>,
        var ghostRecipe: GhostRecipeSurface?,
    ) {
        fun clear() {
            entities.clear()
            ghostRecipe = null
        }

        fun removeEmptyEntities() {
            entities.entries.removeIf { entry -> entry.value.isEmpty() }
        }

        fun isEmpty(): Boolean = entities.isEmpty() && ghostRecipe == null

        fun valueCount(): Int = entities.values.sumOf { surface ->
            surface.metadata.size + surface.equipment.size
        } + if (ghostRecipe == null) 0 else 1

        fun wireBytes(): Int = entities.values.sumOf { surface ->
            surface.metadata.values.sumOf(MetadataSurface::wireBytes) +
                surface.equipment.values.sumOf(EquipmentSurface::wireBytes)
        } + (ghostRecipe?.wireBytes ?: 0)

        fun requireComplete() {
            if (entities.size > entityCapacity) {
                throw NmsPersistentSurfaceIncompleteException(
                    "Persistent entity surface capacity is exhausted",
                )
            }
            if (valueCount() > MAX_STORED_VALUES) {
                throw NmsPersistentSurfaceIncompleteException(
                    "Persistent surface value capacity is exhausted",
                )
            }
            if (wireBytes() > MAX_STORED_WIRE_BYTES) {
                throw NmsPersistentSurfaceIncompleteException(
                    "Persistent surface wire byte capacity is exhausted",
                )
            }
        }
    }

    private class EntitySurfaces(
        val metadata: LinkedHashMap<Int, MetadataSurface> = LinkedHashMap(),
        val equipment: LinkedHashMap<EquipmentSlot, EquipmentSurface> = LinkedHashMap(),
    ) {
        fun copy(): EntitySurfaces = EntitySurfaces(LinkedHashMap(metadata), LinkedHashMap(equipment))

        fun isEmpty(): Boolean = metadata.isEmpty() && equipment.isEmpty()
    }

    private data class MetadataSurface(
        val value: SynchedEntityData.DataValue<*>,
        val wireBytes: Int,
    )

    private data class EquipmentSurface(
        val stack: ItemStack,
        val sanitize: Boolean,
        val wireBytes: Int,
    )

    private data class GhostRecipeSurface(
        val packet: ClientboundPlaceGhostRecipePacket,
        val wireBytes: Int,
    )

    private class ObservationBudget {
        private var packets = 0
        private var wireBytes = 0

        fun enter(depth: Int) {
            if (depth > MAX_BUNDLE_DEPTH) {
                throw NmsPersistentSurfaceIncompleteException(
                    "Persistent surface bundle exceeds the recursion boundary",
                )
            }
            packets++
            if (packets > MAX_PACKETS) {
                throw NmsPersistentSurfaceIncompleteException(
                    "Persistent surface bundle exceeds the packet boundary",
                )
            }
        }

        fun consumeWireBytes(bytes: Int) {
            wireBytes += bytes
            if (wireBytes > MAX_OBSERVATION_WIRE_BYTES) {
                throw NmsPersistentSurfaceIncompleteException(
                    "Persistent surface update exceeds the aggregate wire byte work boundary",
                )
            }
        }
    }

    private class FallbackObservationBudget {
        private var packets = 0

        fun enter(depth: Int) {
            if (depth > MAX_FALLBACK_BUNDLE_DEPTH) {
                throw NmsPersistentSurfaceIncompleteException(
                    "Sanitized persistent fallback exceeds the recursion boundary",
                )
            }
            packets++
            if (packets > MAX_FALLBACK_PACKETS) {
                throw NmsPersistentSurfaceIncompleteException(
                    "Sanitized persistent fallback exceeds the packet boundary",
                )
            }
        }
    }

    private companion object {
        const val DEFAULT_ENTITY_CAPACITY = 2_048
        const val MAX_BUNDLE_DEPTH = 8
        const val MAX_PACKETS = 512
        const val MAX_FALLBACK_BUNDLE_DEPTH = 64
        const val MAX_FALLBACK_PACKETS = 8_192
        const val MAX_METADATA_VALUES_PER_PACKET = 256
        const val MAX_EQUIPMENT_VALUES_PER_PACKET = 6
        const val MAX_STORED_VALUES = 4_096
        const val MAX_STORED_VALUE_WIRE_BYTES = 256 * 1_024
        const val MAX_STORED_WIRE_BYTES = 8 * 1_024 * 1_024
        const val MAX_OBSERVATION_WIRE_BYTES = 2 * 1_024 * 1_024
        const val MAX_SNAPSHOT_PACKETS = DEFAULT_ENTITY_CAPACITY * 3 + 1
        const val DEFAULT_PACKETS_PER_PAGE = 64
        const val MAX_PACKETS_PER_PAGE = 128
    }
}

internal data class NmsPersistentSurfacePageSet(
    val revision: Long,
    val pages: List<List<Packet<*>>>,
)

/** Ordinary per-connection coverage exhaustion; callers must close only the affected channel. */
internal class NmsPersistentSurfaceIncompleteException(
    message: String,
    cause: Throwable? = null,
) : RuntimeException(message, cause)

internal data class NmsPersistentPacketSnapshot<T : Packet<*>>(
    val packet: T,
    val wireBytes: Int,
)

internal fun interface NmsPersistentPacketSnapshotter {
    fun copyGhostRecipe(source: ClientboundPlaceGhostRecipePacket):
        NmsPersistentPacketSnapshot<ClientboundPlaceGhostRecipePacket>
}

/** Bounded exact-codec copies prevent mutable source state from crossing into delayed refresh pages. */
internal class NmsPersistentPacketSnapshots(
    private val registryAccess: RegistryAccess,
) : NmsPersistentPacketSnapshotter {
    override fun copyGhostRecipe(source: ClientboundPlaceGhostRecipePacket):
        NmsPersistentPacketSnapshot<ClientboundPlaceGhostRecipePacket> {
        val storage = Unpooled.buffer(256, MAX_PACKET_BYTES)
        return try {
            val buffer = RegistryFriendlyByteBuf(storage, registryAccess)
            ClientboundPlaceGhostRecipePacket.STREAM_CODEC.encode(buffer, source)
            val bytes = storage.readableBytes()
            val packet = ClientboundPlaceGhostRecipePacket.STREAM_CODEC.decode(buffer)
            check(!storage.isReadable) { "Ghost-recipe snapshot codec left unread bytes" }
            NmsPersistentPacketSnapshot(packet, bytes)
        } catch (failure: IndexOutOfBoundsException) {
            throw NmsPersistentSurfaceIncompleteException(
                "Cannot retain a bounded ghost-recipe snapshot",
                failure,
            )
        } finally {
            storage.release()
        }
    }

    private companion object {
        const val MAX_PACKET_BYTES = 256 * 1_024
    }
}

/** Detects whether an exact persistent carrier can change under viewer projection. */
internal class NmsPersistentManagedSurfaceDetector(
    registryAccess: RegistryAccess,
) {
    private val itemScanner = NmsManagedViewScanner(registryAccess)
    private val ops = registryAccess.createSerializationContext(NbtOps.INSTANCE)

    fun needsProjection(source: ItemStack): Boolean = itemScanner.containsManagedMarker(source)

    fun needsProjection(source: SynchedEntityData.DataValue<*>): Boolean {
        val serializer = source.serializer()
        return when {
            serializer === EntityDataSerializers.ITEM_STACK -> needsProjection(source.value() as ItemStack)
            serializer === EntityDataSerializers.PARTICLE -> needsProjection(source.value() as ParticleOptions)
            serializer === EntityDataSerializers.PARTICLES -> (source.value() as List<*>).any { value ->
                val particle = value as? ParticleOptions ?: return true
                needsProjection(particle)
            }
            serializer === EntityDataSerializers.COMPONENT -> needsProjection(source.value() as Component)
            serializer === EntityDataSerializers.OPTIONAL_COMPONENT -> {
                val optional = source.value() as Optional<*>
                optional.isPresent && needsProjection(optional.orElseThrow() as Component)
            }
            else -> false
        }
    }

    fun needsProjection(source: RecipeDisplay): Boolean = when (source) {
        is ShapedCraftingRecipeDisplay ->
            source.ingredients().any(::needsProjection) || needsProjection(source.result()) ||
                needsProjection(source.craftingStation())
        is ShapelessCraftingRecipeDisplay ->
            source.ingredients().any(::needsProjection) || needsProjection(source.result()) ||
                needsProjection(source.craftingStation())
        is FurnaceRecipeDisplay ->
            needsProjection(source.ingredient()) || needsProjection(source.fuel()) ||
                needsProjection(source.result()) || needsProjection(source.craftingStation())
        is SmithingRecipeDisplay ->
            needsProjection(source.template()) || needsProjection(source.base()) ||
                needsProjection(source.addition()) || needsProjection(source.result()) ||
                needsProjection(source.craftingStation())
        is StonecutterRecipeDisplay ->
            needsProjection(source.input()) || needsProjection(source.result()) ||
                needsProjection(source.craftingStation())
        else -> false
    }

    private fun needsProjection(source: ParticleOptions): Boolean =
        source is ItemParticleOption && needsProjection(source.item.create())

    private fun needsProjection(source: Component): Boolean {
        val encoded = ComponentSerialization.CODEC.encodeStart(ops, source).result().orElse(null)
            ?: throw NmsPersistentSurfaceIncompleteException(
                "Cannot encode a component-backed persistent surface within the exact codec",
            )
        return MarkerScanBudget().scan(encoded)
    }

    private fun needsProjection(source: SlotDisplay): Boolean = when (source) {
        is SlotDisplay.ItemStackSlotDisplay -> needsProjection(source.stack().create())
        is SlotDisplay.Composite -> source.contents().any(::needsProjection)
        is SlotDisplay.DyedSlotDemo -> needsProjection(source.dye()) || needsProjection(source.target())
        is SlotDisplay.OnlyWithComponent -> needsProjection(source.source())
        is SlotDisplay.SmithingTrimDemoSlotDisplay ->
            needsProjection(source.base()) || needsProjection(source.material()) ||
                needsProjection(source.pattern().value().description())
        is SlotDisplay.WithAnyPotion -> needsProjection(source.display())
        is SlotDisplay.WithRemainder -> needsProjection(source.input()) || needsProjection(source.remainder())
        else -> false
    }

    private class MarkerScanBudget {
        private var nodes = 0
        private var stringBytes = 0

        fun scan(source: Tag): Boolean = scan(source, depth = 0)

        private fun scan(source: Tag, depth: Int): Boolean {
            if (depth > MAX_DEPTH) {
                throw NmsPersistentSurfaceIncompleteException(
                    "Persistent marker scan exceeds the depth boundary",
                )
            }
            nodes++
            if (nodes > MAX_NODES) {
                throw NmsPersistentSurfaceIncompleteException(
                    "Persistent marker scan exceeds the node boundary",
                )
            }
            return when (source) {
                is CompoundTag -> {
                    if (source.size() > MAX_COMPOUND_ENTRIES) {
                        throw NmsPersistentSurfaceIncompleteException(
                            "Persistent marker scan exceeds the compound boundary",
                        )
                    }
                    for (key in source.keySet()) {
                        consumeString(key, MAX_KEY_BYTES)
                        if (key == NmsCanonicalItemCodec.ROOT_KEY || key == NmsViewTokenCodec.VIEW_KEY) {
                            return true
                        }
                        if (scan(requireNotNull(source.get(key)), depth + 1)) return true
                    }
                    false
                }
                is ListTag -> {
                    if (source.size > MAX_LIST_ELEMENTS) {
                        throw NmsPersistentSurfaceIncompleteException(
                            "Persistent marker scan exceeds the list boundary",
                        )
                    }
                    source.any { child -> scan(child, depth + 1) }
                }
                is StringTag -> {
                    consumeString(source.value(), MAX_STRING_BYTES)
                    false
                }
                else -> false
            }
        }

        private fun consumeString(value: String, perValueLimit: Int) {
            val bytes = value.toByteArray(Charsets.UTF_8).size
            if (bytes > perValueLimit) {
                throw NmsPersistentSurfaceIncompleteException(
                    "Persistent marker scan string exceeds its boundary",
                )
            }
            stringBytes += bytes
            if (stringBytes > MAX_TOTAL_STRING_BYTES) {
                throw NmsPersistentSurfaceIncompleteException(
                    "Persistent marker scan exceeds the aggregate string boundary",
                )
            }
        }

        private companion object {
            // Detection must not reject a legal carrier before the projector's bounded canonical
            // fallback can sanitize it. These match NmsProjectionLimits.CANONICAL_FALLBACK; the
            // retained wire snapshot has a substantially tighter 256 KiB boundary afterward.
            const val MAX_DEPTH = 256
            const val MAX_NODES = 262_144
            const val MAX_COMPOUND_ENTRIES = 65_536
            const val MAX_LIST_ELEMENTS = 65_536
            const val MAX_KEY_BYTES = 65_535
            const val MAX_STRING_BYTES = 1_048_576
            const val MAX_TOTAL_STRING_BYTES = 16 * 1_024 * 1_024
        }
    }
}

internal interface NmsPersistentWireSizer {
    fun dataValueBytes(source: SynchedEntityData.DataValue<*>): Int

    fun itemBytes(source: ItemStack): Int

    companion object {
        fun fixed(bytes: Int): NmsPersistentWireSizer {
            require(bytes >= 0)
            return object : NmsPersistentWireSizer {
                override fun dataValueBytes(source: SynchedEntityData.DataValue<*>): Int = bytes
                override fun itemBytes(source: ItemStack): Int = bytes
            }
        }
    }
}

/** Measures the exact value codec bytes used by the pinned 26.2 network ABI. */
internal class NmsRegistryPersistentWireSizer(
    private val registryAccess: RegistryAccess,
) : NmsPersistentWireSizer {
    override fun dataValueBytes(source: SynchedEntityData.DataValue<*>): Int {
        @Suppress("UNCHECKED_CAST")
        val serializer = source.serializer() as EntityDataSerializer<Any>
        return measure { buffer -> serializer.codec().encode(buffer, source.value() as Any) }
    }

    override fun itemBytes(source: ItemStack): Int =
        measure { buffer -> ItemStack.OPTIONAL_STREAM_CODEC.encode(buffer, source) }

    private fun measure(encode: (RegistryFriendlyByteBuf) -> Unit): Int {
        val bytes = Unpooled.buffer(256, MAX_VALUE_BYTES)
        return try {
            encode(RegistryFriendlyByteBuf(bytes, registryAccess))
            bytes.readableBytes()
        } finally {
            bytes.release()
        }
    }

    private companion object {
        const val MAX_VALUE_BYTES = 256 * 1_024
    }
}
