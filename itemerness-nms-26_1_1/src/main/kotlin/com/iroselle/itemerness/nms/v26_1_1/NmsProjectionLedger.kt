package com.iroselle.itemerness.nms.v26_1_1

import com.google.common.hash.HashCode
import com.mojang.serialization.DynamicOps
import com.iroselle.itemerness.projection.ProjectionGeneration
import java.io.DataOutput
import java.io.DataOutputStream
import java.io.OutputStream
import java.nio.ByteBuffer
import java.security.SecureRandom
import java.util.Collections
import java.util.HashMap
import java.util.HashSet
import java.util.LinkedHashMap
import java.util.Optional
import java.util.UUID
import net.minecraft.core.Holder
import net.minecraft.core.RegistryAccess
import net.minecraft.core.UUIDUtil
import net.minecraft.core.component.DataComponentPatch
import net.minecraft.core.component.DataComponentType
import net.minecraft.core.component.DataComponents
import net.minecraft.core.component.TypedDataComponent
import net.minecraft.nbt.ByteArrayTag
import net.minecraft.nbt.ByteTag
import net.minecraft.nbt.CompoundTag
import net.minecraft.nbt.DoubleTag
import net.minecraft.nbt.EndTag
import net.minecraft.nbt.FloatTag
import net.minecraft.nbt.IntArrayTag
import net.minecraft.nbt.IntTag
import net.minecraft.nbt.ListTag
import net.minecraft.nbt.LongArrayTag
import net.minecraft.nbt.LongTag
import net.minecraft.nbt.NbtIo
import net.minecraft.nbt.NbtOps
import net.minecraft.nbt.ShortTag
import net.minecraft.nbt.StringTag
import net.minecraft.nbt.Tag
import net.minecraft.network.HashedPatchMap
import net.minecraft.network.HashedStack
import net.minecraft.network.protocol.Packet
import net.minecraft.resources.Identifier
import net.minecraft.util.HashOps
import net.minecraft.world.item.Item
import net.minecraft.world.item.ItemStack
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import net.minecraft.world.item.component.CustomData

internal fun interface NmsProjectionRegistration {
    fun register(
        canonical: ItemStack,
        projected: ItemStack,
        generation: ProjectionGeneration?,
    ): ItemStack

    fun markerOnly(): NmsProjectionRegistration = NONE

    companion object {
        val NONE = NmsProjectionRegistration { _, projected, _ -> projected }
    }
}

internal interface NmsCustomPayloadRegistration {
    fun registerDirect(
        id: Identifier,
        canonical: Tag,
        projected: Tag,
        generation: ProjectionGeneration?,
    ): Tag

    fun registerAdditions(
        id: Identifier,
        canonical: CompoundTag,
        projected: CompoundTag,
        generation: ProjectionGeneration?,
    ): CompoundTag

    companion object {
        val NONE: NmsCustomPayloadRegistration = object : NmsCustomPayloadRegistration {
            override fun registerDirect(
                id: Identifier,
                canonical: Tag,
                projected: Tag,
                generation: ProjectionGeneration?,
            ): Tag = projected

            override fun registerAdditions(
                id: Identifier,
                canonical: CompoundTag,
                projected: CompoundTag,
                generation: ProjectionGeneration?,
            ): CompoundTag = projected
        }
    }
}

/**
 * Sanitizes transformed custom actions without minting a restoration capability. The malformed
 * owned marker is deliberately impossible to restore, and [handledCustomPayload] lets the
 * connection reject the same action even if a hostile client removes that marker entirely.
 */
internal class NmsRejectingFallbackRegistration :
    NmsProjectionRegistration,
    NmsCustomPayloadRegistration {
    var handledCustomPayload: Boolean = false
        private set

    override fun register(
        canonical: ItemStack,
        projected: ItemStack,
        generation: ProjectionGeneration?,
    ): ItemStack = projected

    override fun registerDirect(
        id: Identifier,
        canonical: Tag,
        projected: Tag,
        generation: ProjectionGeneration?,
    ): Tag {
        handledCustomPayload = true
        return NmsCustomClickTokenCodec.rejected()
    }

    override fun registerAdditions(
        id: Identifier,
        canonical: CompoundTag,
        projected: CompoundTag,
        generation: ProjectionGeneration?,
    ): CompoundTag {
        handledCustomPayload = true
        return NmsCustomClickTokenCodec.rejectedAdditions(projected)
    }
}

/** Packet-local capability transaction. No inbound mapping is visible before [commit]. */
internal interface NmsOutboundProjectionTransaction :
    NmsProjectionRegistration,
    NmsCustomPayloadRegistration {
    fun commit()

    fun abort()
}

internal class NmsComponentHashGenerator private constructor(
    private val registryHashOps: DynamicOps<HashCode>,
) : HashedPatchMap.HashGenerator {
    override fun apply(component: TypedDataComponent<*>): Int = component
        .encodeValue(registryHashOps)
        .getOrThrow { message -> NmsRecoverableHashEncodingException("Failed to hash $component: $message") }
        .asInt()

    companion object {
        fun create(registryAccess: RegistryAccess): NmsComponentHashGenerator =
            NmsComponentHashGenerator(registryAccess.createSerializationContext(HashOps.CRC32C_INSTANCE))
    }
}

internal class NmsConnectionProjectionState(
    private val connectionGeneration: Long,
    private val hasher: HashedPatchMap.HashGenerator,
    private val registryAccess: RegistryAccess = RegistryAccess.fromRegistryOfRegistries(
        net.minecraft.core.registries.BuiltInRegistries.REGISTRY,
    ),
    hashedCapacity: Int = DEFAULT_HASHED_CAPACITY,
    creativeCapacity: Int = DEFAULT_CREATIVE_CAPACITY,
    customClickCapacity: Int = DEFAULT_CUSTOM_CLICK_CAPACITY,
    persistentEntityCapacity: Int = DEFAULT_PERSISTENT_ENTITY_CAPACITY,
    persistentWireSizer: NmsPersistentWireSizer? = null,
    persistentPacketSnapshotter: NmsPersistentPacketSnapshotter? = null,
    private val random: SecureRandom = SecureRandom(),
) : NmsProjectionRegistration, NmsCustomPayloadRegistration {
    @Volatile
    private var capabilityState = ProjectionCapabilityState(
        ProjectionGenerationWindow(),
        HashedPatchLedger(hashedCapacity),
        CreativeProjectionLedger(creativeCapacity),
        CustomClickPayloadLedger(customClickCapacity),
    )
    private val generations: ProjectionGenerationWindow
        get() = capabilityState.generations
    private val hashed: HashedPatchLedger
        get() = capabilityState.hashed
    private val creative: CreativeProjectionLedger
        get() = capabilityState.creative
    private val customClicks: CustomClickPayloadLedger
        get() = capabilityState.customClicks
    private val persistentSurfaces = NmsPersistentSurfaceCache(
        entityCapacity = persistentEntityCapacity,
        registryAccess = registryAccess,
        wireSizer = persistentWireSizer ?: NmsRegistryPersistentWireSizer(registryAccess),
        packetSnapshots = persistentPacketSnapshotter ?: NmsPersistentPacketSnapshots(registryAccess),
    )
    private val managedViewScanner = NmsManagedViewScanner(registryAccess)
    private val canonicalCodec = NmsCanonicalItemCodec()
    private val tokenSecret = ByteArray(TOKEN_SECRET_BYTES).also(random::nextBytes)
    @Volatile
    private var rejectUnmanagedCustomClicks = false

    init {
        require(connectionGeneration >= 0) { "Connection generation must not be negative" }
    }

    override fun register(
        canonical: ItemStack,
        projected: ItemStack,
        generation: ProjectionGeneration?,
    ): ItemStack {
        if (canonical.isEmpty || projected.isEmpty) {
            return projected
        }
        val effectiveGeneration = generation ?: generations.current ?: BOOTSTRAP_GENERATION
        val tokenized = mark(canonical, projected, effectiveGeneration)
        recordItem(canonical, tokenized, effectiveGeneration)
        return tokenized
    }

    private fun recordItem(
        canonical: ItemStack,
        tokenized: ItemStack,
        effectiveGeneration: ProjectionGeneration,
    ) = recordItem(canonical, tokenized, effectiveGeneration, capabilityState)

    private fun recordItem(
        canonical: ItemStack,
        tokenized: ItemStack,
        effectiveGeneration: ProjectionGeneration,
        target: ProjectionCapabilityState,
    ) {
        observeGeneration(effectiveGeneration, target)
        if (
            canonical.typeHolder() != tokenized.typeHolder() ||
            canonical.get(DataComponents.CUSTOM_DATA)?.contains(NmsViewTokenCodec.VIEW_KEY) == true
        ) {
            // Keep the opaque marker so an impossible material-changing projection is rejected on
            // the creative path, but never create a restoration capability for it.
            return
        }

        val token = (NmsViewTokenCodec.read(tokenized) as ViewTokenResult.Present).token
        target.creative.record(token, canonical, tokenized, effectiveGeneration)
        try {
            target.hashed.record(canonical, tokenized, effectiveGeneration, hasher)
        } catch (_: NmsRecoverableHashEncodingException) {
            // Creative restoration remains exact even if a component cannot be encoded by the
            // vanilla hash context. The ordinary click path safely falls back to correction.
        }
    }

    override fun markerOnly(): NmsProjectionRegistration = NmsProjectionRegistration { canonical, projected, generation ->
        if (canonical.isEmpty || projected.isEmpty) {
            projected
        } else {
            mark(canonical, projected, generation ?: generations.current ?: BOOTSTRAP_GENERATION)
        }
    }

    override fun registerDirect(
        id: Identifier,
        canonical: Tag,
        projected: Tag,
        generation: ProjectionGeneration?,
    ): Tag {
        val effectiveGeneration = generation ?: generations.current ?: BOOTSTRAP_GENERATION
        val token = derivePayloadToken(id, canonical, effectiveGeneration, DIRECT_PAYLOAD_DOMAIN)
        recordCustomClick(token, id, canonical, projected, effectiveGeneration, CustomClickMode.DIRECT)
        return NmsCustomClickTokenCodec.direct(token)
    }

    override fun registerAdditions(
        id: Identifier,
        canonical: CompoundTag,
        projected: CompoundTag,
        generation: ProjectionGeneration?,
    ): CompoundTag {
        requireProjectionInput(!canonical.contains(NmsCustomClickTokenCodec.ACTION_KEY)) {
            "Custom action additions use the reserved Itemerness capability key"
        }
        val effectiveGeneration = generation ?: generations.current ?: BOOTSTRAP_GENERATION
        val token = derivePayloadToken(id, canonical, effectiveGeneration, ADDITIONS_PAYLOAD_DOMAIN)
        recordCustomClick(token, id, canonical, projected, effectiveGeneration, CustomClickMode.ADDITIONS)
        return NmsCustomClickTokenCodec.additions(projected, token)
    }

    private fun recordCustomClick(
        token: UUID,
        id: Identifier,
        canonical: Tag,
        projected: Tag,
        generation: ProjectionGeneration,
        mode: CustomClickMode,
    ) = recordCustomClick(token, id, canonical, projected, generation, mode, capabilityState)

    private fun recordCustomClick(
        token: UUID,
        id: Identifier,
        canonical: Tag,
        projected: Tag,
        generation: ProjectionGeneration,
        mode: CustomClickMode,
        target: ProjectionCapabilityState,
    ) {
        observeGeneration(generation, target)
        target.customClicks.record(token, id, canonical, projected, generation, mode)
    }

    fun beginOutboundProjection(): NmsOutboundProjectionTransaction = OutboundProjectionTransaction()

    private inner class OutboundProjectionTransaction : NmsOutboundProjectionTransaction {
        private val items = ArrayList<PendingItemRegistration>()
        private val customPayloads = ArrayList<PendingCustomPayloadRegistration>()
        private var state = TransactionState.OPEN

        override fun register(
            canonical: ItemStack,
            projected: ItemStack,
            generation: ProjectionGeneration?,
        ): ItemStack {
            requireOpen()
            if (canonical.isEmpty || projected.isEmpty) return projected
            val effectiveGeneration = generation ?: generations.current ?: BOOTSTRAP_GENERATION
            val tokenized = mark(canonical, projected, effectiveGeneration)
            items += PendingItemRegistration(canonical.copy(), tokenized.copy(), effectiveGeneration)
            return tokenized
        }

        override fun markerOnly(): NmsProjectionRegistration = NmsProjectionRegistration { canonical, projected, generation ->
            requireOpen()
            if (canonical.isEmpty || projected.isEmpty) {
                projected
            } else {
                mark(canonical, projected, generation ?: generations.current ?: BOOTSTRAP_GENERATION)
            }
        }

        override fun registerDirect(
            id: Identifier,
            canonical: Tag,
            projected: Tag,
            generation: ProjectionGeneration?,
        ): Tag {
            requireOpen()
            val effectiveGeneration = generation ?: generations.current ?: BOOTSTRAP_GENERATION
            val token = derivePayloadToken(id, canonical, effectiveGeneration, DIRECT_PAYLOAD_DOMAIN)
            customPayloads += PendingCustomPayloadRegistration(
                token,
                id,
                canonical.copy(),
                projected.copy(),
                effectiveGeneration,
                CustomClickMode.DIRECT,
            )
            return NmsCustomClickTokenCodec.direct(token)
        }

        override fun registerAdditions(
            id: Identifier,
            canonical: CompoundTag,
            projected: CompoundTag,
            generation: ProjectionGeneration?,
        ): CompoundTag {
            requireOpen()
            requireProjectionInput(!canonical.contains(NmsCustomClickTokenCodec.ACTION_KEY)) {
                "Custom action additions use the reserved Itemerness capability key"
            }
            val effectiveGeneration = generation ?: generations.current ?: BOOTSTRAP_GENERATION
            val token = derivePayloadToken(id, canonical, effectiveGeneration, ADDITIONS_PAYLOAD_DOMAIN)
            customPayloads += PendingCustomPayloadRegistration(
                token,
                id,
                canonical.copy(),
                projected.copy(),
                effectiveGeneration,
                CustomClickMode.ADDITIONS,
            )
            return NmsCustomClickTokenCodec.additions(projected, token)
        }

        override fun commit() {
            check(state == TransactionState.OPEN) { "Projection transaction is not open" }
            commitOutboundProjection(items, customPayloads)
            state = TransactionState.COMMITTED
            clearPending()
        }

        override fun abort() {
            if (state != TransactionState.OPEN) return
            state = TransactionState.ABORTED
            clearPending()
        }

        private fun requireOpen() {
            check(state == TransactionState.OPEN) { "Projection transaction is not open" }
        }

        private fun clearPending() {
            items.clear()
            customPayloads.clear()
        }
    }

    private fun commitOutboundProjection(
        items: List<PendingItemRegistration>,
        customPayloads: List<PendingCustomPayloadRegistration>,
    ) {
        val current = capabilityState
        val working = ProjectionCapabilityState(
            current.generations.copy(),
            current.hashed.copy(),
            current.creative.copy(),
            current.customClicks.copy(),
        )
        items.forEach { pending ->
            recordItem(pending.canonical, pending.projected, pending.generation, working)
        }
        customPayloads.forEach { pending ->
            recordCustomClick(
                pending.token,
                pending.id,
                pending.canonical,
                pending.projected,
                pending.generation,
                pending.mode,
                working,
            )
        }
        // Preparation above performs every allocation, retention, eviction, capacity check, and
        // conflict resolution against private copies. Publishing one reference makes the whole
        // packet's inbound capabilities visible together, or not at all.
        capabilityState = working
    }

    fun restoreCustomClick(id: Identifier, payload: Optional<Tag>): CustomClickRestoreResult {
        val restored = capabilityState.let { current ->
            current.customClicks.restore(id, payload, current.generations)
        }
        return if (restored is CustomClickRestoreResult.Unmanaged && rejectUnmanagedCustomClicks) {
            CustomClickRestoreResult.Rejected(CustomClickRejectReason.MISSING_TOKEN)
        } else {
            restored
        }
    }

    fun rejectUnmanagedCustomClicks() {
        rejectUnmanagedCustomClicks = true
    }

    fun rewrite(hashedStack: HashedStack): HashedRewriteResult =
        capabilityState.let { current -> current.hashed.rewrite(hashedStack, current.generations) }

    fun restoreCreative(source: ItemStack): CreativeRestoreResult =
        capabilityState.let { current ->
            current.creative.restore(source, current.generations, managedViewScanner)
        }

    fun containsManagedMarker(source: ItemStack): Boolean =
        managedViewScanner.containsManagedMarker(source)

    fun observeOutbound(packet: Packet<*>): Boolean = persistentSurfaces.observe(packet)

    fun observeSanitizedFallback(packet: Packet<*>): Boolean =
        persistentSurfaces.observeSanitizedFallback(packet)

    fun observeContainerClosed(containerId: Int): Boolean =
        persistentSurfaces.observeContainerClosed(containerId)

    fun persistentSurfacePageSet(activeContainerId: Int): NmsPersistentSurfacePageSet =
        persistentSurfaces.snapshotPageSet(activeContainerId)

    fun persistentSurfaceRevision(): Long = persistentSurfaces.revision()

    fun clear() {
        hashed.clear()
        creative.clear()
        customClicks.clear()
        persistentSurfaces.clear()
        generations.clear()
        rejectUnmanagedCustomClicks = false
    }

    fun connectionGeneration(): Long = connectionGeneration

    private fun mark(
        canonical: ItemStack,
        projected: ItemStack,
        generation: ProjectionGeneration,
    ): ItemStack = NmsViewTokenCodec.attach(projected, deriveToken(canonical, generation))

    private fun deriveToken(canonical: ItemStack, generation: ProjectionGeneration): UUID {
        val mac = newTokenMac(generation, ITEM_TOKEN_DOMAIN)
        val output = DataOutputStream(object : OutputStream() {
            override fun write(value: Int) {
                mac.update(value.toByte())
            }

            override fun write(bytes: ByteArray, offset: Int, length: Int) {
                mac.update(bytes, offset, length)
            }
        })
        output.use { target ->
            val normalized = canonical.copy()
            normalized.count = 1
            val decoded = canonicalCodec.decode(normalized)
            if (decoded is CanonicalDecodeResult.Decoded) {
                // Merchant predicates are positive subsets: unrelated inventory components must
                // not change the marker that replaces canonical state. The normalized canonical
                // fingerprint includes material, pending name, data, and tooltip ownership while
                // excluding count and unrelated foreign components.
                target.writeByte(CANONICAL_FINGERPRINT_TOKEN_INPUT.toInt())
                val fingerprint = canonicalCodec.identityFingerprint(decoded.snapshot)
                target.writeInt(fingerprint.size)
                target.write(fingerprint)
            } else {
                target.writeByte(FULL_STACK_TOKEN_INPUT.toInt())
                val encoded = ItemStack.CODEC.encodeStart(
                    registryAccess.createSerializationContext(NbtOps.INSTANCE),
                    normalized,
                ).getOrThrow { message -> IllegalArgumentException("Cannot fingerprint canonical item: $message") }
                NmsCanonicalTagWriter.write(encoded, target)
            }
        }

        val digest = mac.doFinal()
        val most = ByteBuffer.wrap(digest, 0, Long.SIZE_BYTES).long
        val least = ByteBuffer.wrap(digest, Long.SIZE_BYTES, Long.SIZE_BYTES).long
        return UUID(most, least)
    }

    private fun derivePayloadToken(
        id: Identifier,
        canonical: Tag,
        generation: ProjectionGeneration,
        domain: Byte,
    ): UUID {
        val mac = newTokenMac(generation, domain)
        val idBytes = id.toString().toByteArray(Charsets.UTF_8)
        mac.update(ByteBuffer.allocate(Int.SIZE_BYTES).putInt(idBytes.size).array())
        mac.update(idBytes)
        DataOutputStream(object : OutputStream() {
            override fun write(value: Int) = mac.update(value.toByte())
            override fun write(bytes: ByteArray, offset: Int, length: Int) = mac.update(bytes, offset, length)
        }).use { output -> NmsCanonicalTagWriter.write(canonical, output) }
        val digest = mac.doFinal()
        return UUID(
            ByteBuffer.wrap(digest, 0, Long.SIZE_BYTES).long,
            ByteBuffer.wrap(digest, Long.SIZE_BYTES, Long.SIZE_BYTES).long,
        )
    }

    private fun newTokenMac(generation: ProjectionGeneration, domain: Byte): Mac =
        Mac.getInstance(TOKEN_MAC_ALGORITHM).also { mac ->
            mac.init(SecretKeySpec(tokenSecret, TOKEN_MAC_ALGORITHM))
            mac.update(domain)
            mac.update(ByteBuffer.allocate(Long.SIZE_BYTES * 2).apply {
                putLong(generation.catalogRevision)
                putLong(generation.epoch)
            }.array())
        }

    private fun observeGeneration(
        generation: ProjectionGeneration,
        target: ProjectionCapabilityState = capabilityState,
    ) {
        if (target.generations.observe(generation)) {
            target.hashed.retainGenerations(target.generations)
            target.creative.retainGenerations(target.generations)
            target.customClicks.retainGenerations(target.generations)
        }
    }

    companion object {
        const val DEFAULT_HASHED_CAPACITY = 1_024
        const val DEFAULT_CREATIVE_CAPACITY = 512
        const val DEFAULT_CUSTOM_CLICK_CAPACITY = 256
        const val DEFAULT_PERSISTENT_ENTITY_CAPACITY = 2_048
        const val TOKEN_SECRET_BYTES = 32
        const val TOKEN_MAC_ALGORITHM = "HmacSHA256"
        const val ITEM_TOKEN_DOMAIN: Byte = 1
        const val DIRECT_PAYLOAD_DOMAIN: Byte = 2
        const val ADDITIONS_PAYLOAD_DOMAIN: Byte = 3
        const val CANONICAL_FINGERPRINT_TOKEN_INPUT: Byte = 1
        const val FULL_STACK_TOKEN_INPUT: Byte = 2
        private val BOOTSTRAP_GENERATION = ProjectionGeneration(catalogRevision = 0, epoch = 0)
    }

    private data class PendingItemRegistration(
        val canonical: ItemStack,
        val projected: ItemStack,
        val generation: ProjectionGeneration,
    )

    private data class PendingCustomPayloadRegistration(
        val token: UUID,
        val id: Identifier,
        val canonical: Tag,
        val projected: Tag,
        val generation: ProjectionGeneration,
        val mode: CustomClickMode,
    )

    private data class ProjectionCapabilityState(
        val generations: ProjectionGenerationWindow,
        val hashed: HashedPatchLedger,
        val creative: CreativeProjectionLedger,
        val customClicks: CustomClickPayloadLedger,
    )

    private enum class TransactionState { OPEN, COMMITTED, ABORTED }
}

/** Order-independent binary form for HMAC inputs; compound entry order is not NBT identity. */
internal object NmsCanonicalTagWriter {
    fun write(source: Tag, output: DataOutput) {
        output.writeByte(source.id.toInt())
        when (source) {
            is EndTag -> Unit
            is ByteTag -> output.writeByte(source.value().toInt())
            is ShortTag -> output.writeShort(source.value().toInt())
            is IntTag -> output.writeInt(source.value())
            is LongTag -> output.writeLong(source.value())
            is FloatTag -> output.writeFloat(source.value())
            is DoubleTag -> output.writeDouble(source.value())
            is ByteArrayTag -> {
                val values = source.getAsByteArray()
                output.writeInt(values.size)
                output.write(values)
            }
            is StringTag -> writeString(source.value(), output)
            is ListTag -> {
                output.writeInt(source.size)
                source.forEach { child -> write(child, output) }
            }
            is CompoundTag -> {
                val keys = source.keySet().sorted()
                output.writeInt(keys.size)
                keys.forEach { key ->
                    writeString(key, output)
                    write(requireNotNull(source.get(key)), output)
                }
            }
            is IntArrayTag -> {
                val values = source.getAsIntArray()
                output.writeInt(values.size)
                values.forEach(output::writeInt)
            }
            is LongArrayTag -> {
                val values = source.getAsLongArray()
                output.writeInt(values.size)
                values.forEach(output::writeLong)
            }
            else -> error("Unsupported NBT tag type in canonical fingerprint: ${source.javaClass.name}")
        }
    }

    private fun writeString(value: String, output: DataOutput) {
        val bytes = value.toByteArray(Charsets.UTF_8)
        output.writeInt(bytes.size)
        output.write(bytes)
    }
}

internal sealed interface HashedRewriteResult {
    val stack: HashedStack

    data class Hit(override val stack: HashedStack) : HashedRewriteResult
    data class PassThrough(
        override val stack: HashedStack,
        val reason: LedgerMissReason,
    ) : HashedRewriteResult
}

internal enum class LedgerMissReason {
    MISS,
    AMBIGUOUS,
}

internal class HashedPatchLedger(
    private val capacity: Int,
) {
    private val mappings = LinkedHashMap<HashedItemSignature, MutableMap<ProjectionGeneration, CanonicalResolution>>(
        16,
        0.75F,
        true,
    )
    init {
        require(capacity > 0) { "Hashed ledger capacity must be positive" }
    }

    fun record(
        canonical: ItemStack,
        projected: ItemStack,
        generation: ProjectionGeneration,
        hasher: HashedPatchMap.HashGenerator,
    ) {
        if (canonical.isEmpty || projected.isEmpty || canonical.typeHolder() != projected.typeHolder()) {
            return
        }
        record(
            projected.typeHolder(),
            HashedPatchMap.create(projected.componentsPatch, hasher),
            HashedPatchMap.create(canonical.componentsPatch, hasher),
            generation,
        )
    }

    fun record(
        item: Holder<Item>,
        projected: HashedPatchMap,
        canonical: HashedPatchMap,
        generation: ProjectionGeneration,
    ) {
        val key = HashedItemSignature(item, projected.freeze())
        if (!mappings.containsKey(key)) {
            while (mappings.size >= capacity) {
                evictEldest()
            }
        }
        val perGeneration = mappings.getOrPut(key) { HashMap(2) }
        val canonicalCopy = canonical.freeze()
        val existing = perGeneration[generation]
        perGeneration[generation] = when {
            existing == null -> CanonicalResolution.Unique(canonicalCopy)
            existing is CanonicalResolution.Ambiguous -> existing
            existing is CanonicalResolution.Unique && existing.patch == canonicalCopy -> existing
            else -> CanonicalResolution.Ambiguous
        }
    }

    fun rewrite(stack: HashedStack, generations: ProjectionGenerationWindow): HashedRewriteResult {
        val actual = stack as? HashedStack.ActualItem
            ?: return HashedRewriteResult.PassThrough(stack, LedgerMissReason.MISS)
        val key = HashedItemSignature(actual.item(), actual.components().freeze())
        val perGeneration = mappings[key]
            ?: return HashedRewriteResult.PassThrough(stack, LedgerMissReason.MISS)
        perGeneration.keys.removeIf { generation -> !generations.accepts(generation) }
        if (perGeneration.isEmpty()) {
            mappings.remove(key)
        }
        val candidates = perGeneration.values
        if (candidates.isEmpty()) {
            return HashedRewriteResult.PassThrough(stack, LedgerMissReason.MISS)
        }
        if (candidates.any { it is CanonicalResolution.Ambiguous }) {
            return HashedRewriteResult.PassThrough(stack, LedgerMissReason.AMBIGUOUS)
        }
        val unique = candidates.filterIsInstance<CanonicalResolution.Unique>().map { it.patch }.distinct()
        if (unique.size != 1) {
            return HashedRewriteResult.PassThrough(stack, LedgerMissReason.AMBIGUOUS)
        }
        return HashedRewriteResult.Hit(
            HashedStack.ActualItem(actual.item(), actual.count(), unique.single()),
        )
    }

    fun retainGenerations(generations: ProjectionGenerationWindow) {
        val iterator = mappings.entries.iterator()
        while (iterator.hasNext()) {
            val entry = iterator.next()
            entry.value.keys.removeIf { !generations.accepts(it) }
            if (entry.value.isEmpty()) {
                iterator.remove()
            }
        }
    }

    fun clear() {
        mappings.clear()
    }

    fun copy(): HashedPatchLedger = HashedPatchLedger(capacity).also { result ->
        mappings.forEach { (signature, perGeneration) ->
            result.mappings[signature] = HashMap(perGeneration)
        }
    }

    private fun evictEldest() {
        val iterator = mappings.entries.iterator()
        if (!iterator.hasNext()) return
        iterator.next()
        iterator.remove()
    }

    private sealed interface CanonicalResolution {
        data class Unique(val patch: HashedPatchMap) : CanonicalResolution
        data object Ambiguous : CanonicalResolution
    }
}

internal sealed interface CreativeRestoreResult {
    data class Restored(val stack: ItemStack) : CreativeRestoreResult
    data object Unmanaged : CreativeRestoreResult
    data class Rejected(val reason: CreativeRejectReason) : CreativeRestoreResult
}

internal enum class CreativeRejectReason {
    MALFORMED_TOKEN,
    UNKNOWN_TOKEN,
    AMBIGUOUS_TOKEN,
    GENERATION_EXPIRED,
    MATERIAL_CHANGED,
    COMPONENTS_CHANGED,
    INVALID_COUNT,
    MANAGED_WITHOUT_TOKEN,
}

private class CreativeProjectionLedger(
    private val capacity: Int,
) {
    private val mappings = LinkedHashMap<CreativeSignature, CreativeEntry>(16, 0.75F, true)

    init {
        require(capacity > 0) { "Creative ledger capacity must be positive" }
    }

    fun record(
        token: UUID,
        canonical: ItemStack,
        projected: ItemStack,
        generation: ProjectionGeneration,
    ) {
        val signature = CreativeSignature(token, projected.typeHolder(), projected.componentsPatch)
        val existing = mappings[signature]
        if (existing != null) {
            val canonicalPatch = canonical.componentsPatch
            val sameProjection =
                existing.generation == generation &&
                    existing.canonicalItem == canonical.typeHolder() &&
                    existing.canonicalPatch == canonicalPatch
            mappings[signature] = if (sameProjection && !existing.ambiguous) {
                existing
            } else {
                existing.copy(ambiguous = true)
            }
            return
        }
        while (mappings.size >= capacity) {
            val iterator = mappings.entries.iterator()
            if (!iterator.hasNext()) break
            iterator.next()
            iterator.remove()
        }
        val canonicalPatch = canonical.componentsPatch
        val canonicalProbe = ItemStack(canonical.typeHolder(), 1, canonicalPatch)
        mappings[signature] = CreativeEntry(
            generation = generation,
            canonicalItem = canonical.typeHolder(),
            canonicalPatch = canonicalPatch,
            canonicalMaxCount = canonicalProbe.maxStackSize,
            ambiguous = false,
        )
    }

    fun restore(
        source: ItemStack,
        generations: ProjectionGenerationWindow,
        managedViewScanner: NmsManagedViewScanner,
    ): CreativeRestoreResult {
        if (source.isEmpty) {
            return CreativeRestoreResult.Unmanaged
        }
        val tokenResult = NmsViewTokenCodec.read(source)
        if (tokenResult is ViewTokenResult.Missing) {
            return if (managedViewScanner.containsManagedMarker(source)) {
                CreativeRestoreResult.Rejected(CreativeRejectReason.MANAGED_WITHOUT_TOKEN)
            } else {
                CreativeRestoreResult.Unmanaged
            }
        }
        if (tokenResult is ViewTokenResult.Malformed) {
            return CreativeRestoreResult.Rejected(CreativeRejectReason.MALFORMED_TOKEN)
        }
        val token = (tokenResult as ViewTokenResult.Present).token
        val tokenEntries = mappings.keys.filter { signature -> signature.token == token }
        if (tokenEntries.isEmpty()) {
            return CreativeRestoreResult.Rejected(CreativeRejectReason.UNKNOWN_TOKEN)
        }
        if (tokenEntries.none { signature -> signature.projectedItem == source.typeHolder() }) {
            return CreativeRestoreResult.Rejected(CreativeRejectReason.MATERIAL_CHANGED)
        }
        val signature = CreativeSignature(token, source.typeHolder(), source.componentsPatch)
        val entry = mappings[signature]
            ?: return CreativeRestoreResult.Rejected(CreativeRejectReason.COMPONENTS_CHANGED)
        if (entry.ambiguous) {
            return CreativeRestoreResult.Rejected(CreativeRejectReason.AMBIGUOUS_TOKEN)
        }
        if (!generations.accepts(entry.generation)) {
            mappings.remove(signature)
            return CreativeRestoreResult.Rejected(CreativeRejectReason.GENERATION_EXPIRED)
        }
        val allowedMax = minOf(entry.canonicalMaxCount, source.maxStackSize)
        if (source.count !in 1..allowedMax) {
            return CreativeRestoreResult.Rejected(CreativeRejectReason.INVALID_COUNT)
        }
        return CreativeRestoreResult.Restored(
            ItemStack(entry.canonicalItem, source.count, entry.canonicalPatch),
        )
    }

    fun retainGenerations(generations: ProjectionGenerationWindow) {
        mappings.entries.removeIf { !generations.accepts(it.value.generation) }
    }

    fun clear() = mappings.clear()

    fun copy(): CreativeProjectionLedger = CreativeProjectionLedger(capacity).also { result ->
        result.mappings.putAll(mappings)
    }

    private data class CreativeEntry(
        val generation: ProjectionGeneration,
        val canonicalItem: Holder<Item>,
        val canonicalPatch: DataComponentPatch,
        val canonicalMaxCount: Int,
        val ambiguous: Boolean,
    )

    private data class CreativeSignature(
        val token: UUID,
        val projectedItem: Holder<Item>,
        val projectedPatch: DataComponentPatch,
    )
}

internal sealed interface CustomClickRestoreResult {
    data object Unmanaged : CustomClickRestoreResult
    data class Restored(val payload: Optional<Tag>) : CustomClickRestoreResult
    data class Rejected(val reason: CustomClickRejectReason) : CustomClickRestoreResult
}

internal enum class CustomClickRejectReason {
    MISSING_TOKEN,
    MALFORMED_TOKEN,
    UNKNOWN_TOKEN,
    AMBIGUOUS_TOKEN,
    GENERATION_EXPIRED,
    ACTION_CHANGED,
    PAYLOAD_CHANGED,
}

internal enum class CustomClickMode(val id: Int) {
    DIRECT(1),
    ADDITIONS(2),
    ;

    companion object {
        fun fromId(id: Int): CustomClickMode? = entries.firstOrNull { mode -> mode.id == id }
    }
}

private class CustomClickPayloadLedger(
    private val capacity: Int,
) {
    private val mappings = LinkedHashMap<UUID, Entry>(16, 0.75F, true)
    private val protectedActions = LinkedHashMap<Identifier, MutableSet<ProjectionGeneration>>()

    init {
        require(capacity > 0) { "Custom click ledger capacity must be positive" }
    }

    fun record(
        token: UUID,
        id: Identifier,
        canonical: Tag,
        projected: Tag,
        generation: ProjectionGeneration,
        mode: CustomClickMode,
    ) {
        val actionGenerations = protectedActions[id]
            ?: run {
                requireProjectionInput(protectedActions.size < capacity) {
                    "Custom click protected action capacity is exhausted"
                }
                HashSet<ProjectionGeneration>(2).also { protectedActions[id] = it }
            }
        actionGenerations += generation
        val existing = mappings[token]
        if (existing != null) {
            val same =
                existing.id == id &&
                    existing.canonical == canonical &&
                    existing.projected == projected &&
                    existing.generation == generation &&
                    existing.mode == mode
            mappings[token] = if (same && !existing.ambiguous) {
                existing
            } else {
                existing.copy(ambiguous = true)
            }
            return
        }
        while (mappings.size >= capacity) {
            val iterator = mappings.entries.iterator()
            if (!iterator.hasNext()) break
            iterator.next()
            iterator.remove()
        }
        mappings[token] = Entry(
            id = id,
            canonical = canonical.copy(),
            projected = projected.copy(),
            generation = generation,
            mode = mode,
            ambiguous = false,
        )
    }

    fun restore(
        id: Identifier,
        payload: Optional<Tag>,
        generations: ProjectionGenerationWindow,
    ): CustomClickRestoreResult {
        if (payload.isEmpty) return missingCapability(id, generations)
        val source = payload.orElseThrow()
        return when (val tokenResult = NmsCustomClickTokenCodec.read(source)) {
            CustomClickTokenResult.Missing -> missingCapability(id, generations)
            CustomClickTokenResult.Malformed -> CustomClickRestoreResult.Rejected(CustomClickRejectReason.MALFORMED_TOKEN)
            is CustomClickTokenResult.Present -> restore(id, source, tokenResult, generations)
        }
    }

    private fun restore(
        id: Identifier,
        source: Tag,
        tokenResult: CustomClickTokenResult.Present,
        generations: ProjectionGenerationWindow,
    ): CustomClickRestoreResult {
        val entry = mappings[tokenResult.token]
            ?: return CustomClickRestoreResult.Rejected(CustomClickRejectReason.UNKNOWN_TOKEN)
        if (entry.ambiguous) return CustomClickRestoreResult.Rejected(CustomClickRejectReason.AMBIGUOUS_TOKEN)
        if (!generations.accepts(entry.generation)) {
            mappings.remove(tokenResult.token)
            return CustomClickRestoreResult.Rejected(CustomClickRejectReason.GENERATION_EXPIRED)
        }
        if (entry.id != id) return CustomClickRestoreResult.Rejected(CustomClickRejectReason.ACTION_CHANGED)
        if (entry.mode != tokenResult.mode) {
            return CustomClickRestoreResult.Rejected(CustomClickRejectReason.PAYLOAD_CHANGED)
        }

        val restored = when (entry.mode) {
            CustomClickMode.DIRECT -> {
                if (source != NmsCustomClickTokenCodec.direct(tokenResult.token)) {
                    return CustomClickRestoreResult.Rejected(CustomClickRejectReason.PAYLOAD_CHANGED)
                }
                entry.canonical.copy()
            }
            CustomClickMode.ADDITIONS -> {
                val received = (source as? CompoundTag)?.copy()
                    ?: return CustomClickRestoreResult.Rejected(CustomClickRejectReason.PAYLOAD_CHANGED)
                received.remove(NmsCustomClickTokenCodec.ACTION_KEY)
                val projected = entry.projected as? CompoundTag
                    ?: return CustomClickRestoreResult.Rejected(CustomClickRejectReason.PAYLOAD_CHANGED)
                for (key in projected.keySet()) {
                    if (received.get(key) != projected.get(key)) {
                        return CustomClickRestoreResult.Rejected(CustomClickRejectReason.PAYLOAD_CHANGED)
                    }
                }
                val canonical = entry.canonical as? CompoundTag
                    ?: return CustomClickRestoreResult.Rejected(CustomClickRejectReason.PAYLOAD_CHANGED)
                projected.keySet().forEach(received::remove)
                canonical.forEach { key, value -> received.put(key, value.copy()) }
                received
            }
        }
        // Access-order lookup above already refreshed this bounded LRU entry.
        return CustomClickRestoreResult.Restored(Optional.of(restored))
    }

    private fun missingCapability(
        id: Identifier,
        generations: ProjectionGenerationWindow,
    ): CustomClickRestoreResult = if (
        protectedActions[id]?.any(generations::accepts) == true
    ) {
        CustomClickRestoreResult.Rejected(CustomClickRejectReason.MISSING_TOKEN)
    } else {
        CustomClickRestoreResult.Unmanaged
    }

    fun retainGenerations(generations: ProjectionGenerationWindow) {
        mappings.entries.removeIf { entry -> !generations.accepts(entry.value.generation) }
        protectedActions.entries.removeIf { entry ->
            entry.value.removeIf { generation -> !generations.accepts(generation) }
            entry.value.isEmpty()
        }
    }

    fun clear() {
        mappings.clear()
        protectedActions.clear()
    }

    fun copy(): CustomClickPayloadLedger = CustomClickPayloadLedger(capacity).also { result ->
        result.mappings.putAll(mappings)
        protectedActions.forEach { (id, generations) ->
            result.protectedActions[id] = HashSet(generations)
        }
    }

    private data class Entry(
        val id: Identifier,
        val canonical: Tag,
        val projected: Tag,
        val generation: ProjectionGeneration,
        val mode: CustomClickMode,
        val ambiguous: Boolean,
    )
}

internal object NmsCustomClickTokenCodec {
    const val ACTION_KEY = "itemerness_click"
    private const val FORMAT_KEY = "format"
    private const val MODE_KEY = "mode"
    private const val TOKEN_KEY = "token"
    private const val FORMAT = 1
    private const val REJECTED_MARKER = "rejected"

    fun direct(token: UUID): CompoundTag = CompoundTag().apply {
        put(ACTION_KEY, tokenTag(token, CustomClickMode.DIRECT))
    }

    fun additions(source: CompoundTag, token: UUID): CompoundTag = source.copy().apply {
        put(ACTION_KEY, tokenTag(token, CustomClickMode.ADDITIONS))
    }

    fun rejected(): CompoundTag = CompoundTag().apply {
        putString(ACTION_KEY, REJECTED_MARKER)
    }

    fun rejectedAdditions(source: CompoundTag): CompoundTag = source.copy().apply {
        putString(ACTION_KEY, REJECTED_MARKER)
    }

    fun read(source: Tag): CustomClickTokenResult {
        val compound = source as? CompoundTag ?: return CustomClickTokenResult.Missing
        if (!compound.contains(ACTION_KEY)) return CustomClickTokenResult.Missing
        val capability = compound.getCompound(ACTION_KEY).orElse(null)
            ?: return CustomClickTokenResult.Malformed
        if (capability.keySet() != setOf(FORMAT_KEY, MODE_KEY, TOKEN_KEY)) {
            return CustomClickTokenResult.Malformed
        }
        if ((capability.get(FORMAT_KEY) as? IntTag)?.value() != FORMAT) {
            return CustomClickTokenResult.Malformed
        }
        val mode = (capability.get(MODE_KEY) as? IntTag)?.value()?.let(CustomClickMode::fromId)
            ?: return CustomClickTokenResult.Malformed
        val tokenTag = capability.get(TOKEN_KEY) as? IntArrayTag ?: return CustomClickTokenResult.Malformed
        if (tokenTag.size() != 4) return CustomClickTokenResult.Malformed
        val token = tokenTag.asIntArray().orElse(null) ?: return CustomClickTokenResult.Malformed
        return CustomClickTokenResult.Present(UUIDUtil.uuidFromIntArray(token), mode)
    }

    private fun tokenTag(token: UUID, mode: CustomClickMode): CompoundTag = CompoundTag().apply {
        putInt(FORMAT_KEY, FORMAT)
        putInt(MODE_KEY, mode.id)
        putIntArray(TOKEN_KEY, UUIDUtil.uuidToIntArray(token))
    }
}

internal sealed interface CustomClickTokenResult {
    data object Missing : CustomClickTokenResult
    data object Malformed : CustomClickTokenResult
    data class Present(val token: UUID, val mode: CustomClickMode) : CustomClickTokenResult
}

internal object NmsViewTokenCodec {
    const val VIEW_KEY = "itemerness_view"
    private const val FORMAT_KEY = "format"
    private const val TOKEN_KEY = "token"
    private const val FORMAT = 1

    fun attach(source: ItemStack, token: UUID): ItemStack {
        val result = source.copy()
        val customData = result.get(DataComponents.CUSTOM_DATA)?.copyTag() ?: CompoundTag()
        customData.put(
            VIEW_KEY,
            CompoundTag().apply {
                putInt(FORMAT_KEY, FORMAT)
                putIntArray(TOKEN_KEY, UUIDUtil.uuidToIntArray(token))
            },
        )
        CustomData.set(DataComponents.CUSTOM_DATA, result, customData)
        return result
    }

    fun read(source: ItemStack): ViewTokenResult {
        val customData = source.get(DataComponents.CUSTOM_DATA) ?: return ViewTokenResult.Missing
        val tag = customData.getUnsafe()
        if (!tag.contains(VIEW_KEY)) return ViewTokenResult.Missing
        val view = tag.getCompound(VIEW_KEY).orElse(null) ?: return ViewTokenResult.Malformed
        if (view.size() != 2 || view.keySet() != setOf(FORMAT_KEY, TOKEN_KEY)) {
            return ViewTokenResult.Malformed
        }
        if ((view.get(FORMAT_KEY) as? IntTag)?.value() != FORMAT) {
            return ViewTokenResult.Malformed
        }
        val tokenTag = view.get(TOKEN_KEY) as? IntArrayTag ?: return ViewTokenResult.Malformed
        if (tokenTag.size() != 4) return ViewTokenResult.Malformed
        val token = tokenTag.asIntArray().orElse(null) ?: return ViewTokenResult.Malformed
        return ViewTokenResult.Present(UUIDUtil.uuidFromIntArray(token))
    }
}

internal sealed interface ViewTokenResult {
    data object Missing : ViewTokenResult
    data object Malformed : ViewTokenResult
    data class Present(val token: UUID) : ViewTokenResult
}

internal class NmsManagedViewScanner(
    registryAccess: RegistryAccess,
) {
    private val ops = registryAccess.createSerializationContext(NbtOps.INSTANCE)

    fun containsManagedMarker(source: ItemStack): Boolean = try {
        if (source.isEmpty) return false
        val encoded = ItemStack.CODEC.encodeStart(ops, source).result().orElse(null) as? CompoundTag
            ?: return true
        ScanBudget().scan(encoded)
    } catch (_: RuntimeException) {
        // An untrusted structure that exceeds inspection bounds is treated as managed and rejected.
        true
    }

    private class ScanBudget {
        private var nodes = 0
        private var stringBytes = 0

        fun scan(source: CompoundTag): Boolean {
            check(measureWireBytes(source) <= MAX_WIRE_BYTES) {
                "Managed marker scan exceeded its byte bound"
            }
            return scanTag(source, depth = 0)
        }

        private fun scanTag(source: Tag, depth: Int): Boolean {
            check(depth <= MAX_DEPTH) { "Managed marker scan exceeded its depth bound" }
            nodes++
            check(nodes <= MAX_NODES) { "Managed marker scan exceeded its node bound" }
            return when (source) {
                is CompoundTag -> {
                    check(source.size() <= MAX_COMPOUND_ENTRIES) {
                        "Managed marker scan exceeded its compound bound"
                    }
                    for (key in source.keySet()) {
                        val value = requireNotNull(source.get(key))
                        consumeString(key, MAX_KEY_BYTES)
                        if (
                            key == NmsCanonicalItemCodec.ROOT_KEY ||
                            key == NmsViewTokenCodec.VIEW_KEY
                        ) {
                            return true
                        }
                        if (scanTag(value, depth + 1)) return true
                    }
                    false
                }
                is ListTag -> {
                    check(source.size <= MAX_LIST_ELEMENTS) {
                        "Managed marker scan exceeded its list bound"
                    }
                    for (value in source) {
                        if (scanTag(value, depth + 1)) return true
                    }
                    false
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
            check(bytes <= perValueLimit) { "Managed marker scan exceeded its string bound" }
            stringBytes += bytes
            check(stringBytes <= MAX_TOTAL_STRING_BYTES) {
                "Managed marker scan exceeded its total string bound"
            }
        }

        private fun measureWireBytes(source: CompoundTag): Int {
            val counter = BoundedCountingOutputStream(MAX_WIRE_BYTES)
            DataOutputStream(counter).use { output -> NbtIo.write(source, output) }
            return counter.count
        }

        private class BoundedCountingOutputStream(
            private val limit: Int,
        ) : OutputStream() {
            var count: Int = 0
                private set

            override fun write(value: Int) = consume(1)

            override fun write(bytes: ByteArray, offset: Int, length: Int) = consume(length)

            private fun consume(length: Int) {
                check(length >= 0 && count <= limit - length) {
                    "Managed marker scan exceeded its byte bound"
                }
                count += length
            }
        }

        private companion object {
            const val MAX_DEPTH = 32
            const val MAX_NODES = 8_192
            const val MAX_COMPOUND_ENTRIES = 1_024
            const val MAX_LIST_ELEMENTS = 4_096
            const val MAX_KEY_BYTES = 1_024
            const val MAX_STRING_BYTES = 65_535
            const val MAX_TOTAL_STRING_BYTES = 256 * 1_024
            const val MAX_WIRE_BYTES = 2 * 1_024 * 1_024
        }
    }
}

private data class HashedItemSignature(
    val item: Holder<Item>,
    val patch: HashedPatchMap,
)

private fun HashedPatchMap.freeze(): HashedPatchMap {
    val added = HashMap<DataComponentType<*>, Int>(addedComponents().size)
    added.putAll(addedComponents())
    val removed = HashSet<DataComponentType<*>>(removedComponents())
    return HashedPatchMap(Collections.unmodifiableMap(added), Collections.unmodifiableSet(removed))
}

internal class ProjectionGenerationWindow {
    var current: ProjectionGeneration? = null
        private set
    private var previous: ProjectionGeneration? = null

    fun observe(generation: ProjectionGeneration): Boolean {
        if (generation == current || generation == previous) return false
        previous = current
        current = generation
        return true
    }

    fun accepts(generation: ProjectionGeneration): Boolean =
        generation == current || generation == previous

    fun clear() {
        current = null
        previous = null
    }

    fun copy(): ProjectionGenerationWindow = ProjectionGenerationWindow().also { result ->
        result.current = current
        result.previous = previous
    }
}
