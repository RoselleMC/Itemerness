package com.iroselle.itemerness.nms.v26_2

import java.io.DataOutputStream
import java.io.OutputStream
import java.nio.charset.StandardCharsets
import java.util.UUID
import net.minecraft.core.RegistryAccess
import net.minecraft.nbt.CompoundTag
import net.minecraft.nbt.ListTag
import net.minecraft.nbt.NbtIo
import net.minecraft.nbt.NbtOps
import net.minecraft.nbt.StringTag
import net.minecraft.nbt.Tag
import net.minecraft.world.item.ItemStack

/**
 * Finds exact 26.2 ItemStack compounds in arbitrary NBT and projects only canonical items.
 *
 * `components.minecraft:custom_data.itemerness` is the semantic type marker, not a heuristic:
 * Itemerness exclusively owns that exact path. A compound without it (including near-shaped
 * compounds) is copied byte-for-byte. Once present, malformed item fields are fail-closed by
 * stripping only the reserved marker, so arbitrary tag-query data cannot expose canonical state.
 */
internal class NmsCanonicalNbtProjector(
    private val itemProjector: NmsRecursiveItemProjector,
) {
    fun newSession(
        viewerId: UUID,
        registryAccess: RegistryAccess,
        budget: TraversalBudget = TraversalBudget(),
        itemProjection: (ItemStack) -> ItemStack = { item -> itemProjector.project(item, viewerId) },
    ): Session = Session(registryAccess, budget, itemProjection)

    inner class Session internal constructor(
        registryAccess: RegistryAccess,
        private val budget: TraversalBudget,
        private val itemProjection: (ItemStack) -> ItemStack,
    ) {
        private val ops = registryAccess.createSerializationContext(NbtOps.INSTANCE)

        fun project(source: CompoundTag): NmsCompoundProjection {
            val result = project(source as Tag)
            return NmsCompoundProjection(result.tag as CompoundTag, result.changed)
        }

        fun project(source: Tag): NmsTagProjection {
            budget.consumeInputBytes(measureWireBytes(source, budget.remainingInputBytes()))
            val result = projectTag(source, depth = 0)
            budget.consumeOutputBytes(measureWireBytes(result.tag, budget.remainingOutputBytes()))
            return NmsTagProjection(result.tag, result.changed)
        }

        private fun projectTag(source: Tag, depth: Int): TagProjection {
            budget.enterNode(depth)
            return when (source) {
                is CompoundTag -> projectCompound(source, depth)
                is ListTag -> projectList(source, depth)
                is StringTag -> {
                    budget.consumeString(source.value(), budget.limits.nbtStringBytes, "NBT string")
                    TagProjection(source.copy(), changed = false)
                }
                else -> TagProjection(source.copy(), changed = false)
            }
        }

        private fun projectCompound(source: CompoundTag, depth: Int): TagProjection {
            requireProjectionInput(source.size() <= budget.limits.nbtCompoundEntries) {
                "NBT compound exceeds the entry limit"
            }
            if (hasReservedItemMarker(source)) {
                budget.enterCandidate()
                val copied = copyCompound(source, depth)
                return projectCandidate(copied, depth)
            }

            var changed = false
            val result = CompoundTag()
            source.forEach { key, value ->
                budget.consumeString(key, budget.limits.nbtKeyBytes, "NBT key")
                val projected = projectTag(value, depth + 1)
                result.put(key, projected.tag)
                changed = changed || projected.changed
            }
            return TagProjection(result, changed)
        }

        private fun copyCompound(source: CompoundTag, depth: Int): CompoundTag {
            val result = CompoundTag()
            source.forEach { key, value ->
                budget.consumeString(key, budget.limits.nbtKeyBytes, "NBT key")
                result.put(key, copyValidated(value, depth + 1))
            }
            return result
        }

        private fun copyValidated(source: Tag, depth: Int): Tag {
            budget.enterNode(depth)
            return when (source) {
                is CompoundTag -> {
                    requireProjectionInput(source.size() <= budget.limits.nbtCompoundEntries) {
                        "NBT compound exceeds the entry limit"
                    }
                    copyCompound(source, depth)
                }
                is ListTag -> {
                    requireProjectionInput(source.size <= budget.limits.nbtListElements) {
                        "NBT list exceeds the element limit"
                    }
                    ListTag().also { result ->
                        source.forEach { child -> result.add(copyValidated(child, depth + 1)) }
                    }
                }
                is StringTag -> {
                    budget.consumeString(source.value(), budget.limits.nbtStringBytes, "NBT string")
                    source.copy()
                }
                else -> source.copy()
            }
        }

        private fun projectList(source: ListTag, depth: Int): TagProjection {
            requireProjectionInput(source.size <= budget.limits.nbtListElements) {
                "NBT list exceeds the element limit"
            }
            var changed = false
            val result = ListTag()
            source.forEach { child ->
                val projected = projectTag(child, depth + 1)
                result.add(projected.tag)
                changed = changed || projected.changed
            }
            return TagProjection(result, changed)
        }

        private fun projectCandidate(source: CompoundTag, depth: Int): TagProjection {
            val decoded = ItemStack.CODEC.parse(ops, source).result().orElse(null)
                ?: return sanitizeCandidate(source, depth)
            if (decoded.isEmpty || decoded.count !in 1..decoded.maxStackSize) {
                return sanitizeCandidate(source, depth)
            }
            budget.decodeItem()
            val projected = itemProjection(decoded)
            if (projected === decoded) {
                return TagProjection(source, changed = false)
            }
            val encoded = ItemStack.CODEC.encodeStart(ops, projected).result().orElse(null) as? CompoundTag
                ?: return sanitizeCandidate(source, depth)

            val merged = source.copy()
            ITEM_STACK_FIELDS.forEach(merged::remove)
            encoded.forEach { key, value -> merged.put(key, value.copy()) }
            validateOutput(merged, depth)
            return TagProjection(merged, changed = merged != source)
        }

        private fun sanitizeCandidate(source: CompoundTag, depth: Int): TagProjection {
            val sanitized = source.copy()
            val components = sanitized.get(COMPONENTS_KEY) as CompoundTag
            val customData = components.get(CUSTOM_DATA_COMPONENT_KEY) as CompoundTag
            customData.remove(NmsCanonicalItemCodec.ROOT_KEY)
            customData.remove(NmsViewTokenCodec.VIEW_KEY)
            MALFORMED_PRESENTATION_COMPONENTS.forEach(components::remove)

            // The outer item-shaped compound failed its codec, but its remaining foreign data may
            // still contain valid nested ItemStacks. Re-enter the recursive walker without a second
            // wire-size charge; the root node was already consumed by the original candidate path.
            val nested = projectCompound(sanitized, depth)
            return TagProjection(nested.tag, changed = true)
        }

        private fun validateOutput(source: Tag, depth: Int) {
            budget.enterOutputNode(depth)
            when (source) {
                is CompoundTag -> {
                    requireProjectionInput(source.size() <= budget.limits.nbtCompoundEntries) {
                        "Projected NBT compound exceeds the entry limit"
                    }
                    source.forEach { key, value ->
                        budget.consumeOutputString(key, budget.limits.nbtKeyBytes, "Projected NBT key")
                        validateOutput(value, depth + 1)
                    }
                }
                is ListTag -> {
                    requireProjectionInput(source.size <= budget.limits.nbtListElements) {
                        "Projected NBT list exceeds the element limit"
                    }
                    source.forEach { child -> validateOutput(child, depth + 1) }
                }
                is StringTag -> budget.consumeOutputString(
                    source.value(),
                    budget.limits.nbtStringBytes,
                    "Projected NBT string",
                )
                else -> Unit
            }
        }

        private fun hasReservedItemMarker(source: CompoundTag): Boolean {
            val components = source.get(COMPONENTS_KEY) as? CompoundTag ?: return false
            val customData = components.get(CUSTOM_DATA_COMPONENT_KEY) as? CompoundTag ?: return false
            // Presence is the discriminator. A value of the wrong NBT type is still an
            // Itemerness-owned marker and must take the malformed-candidate sanitization path.
            return customData.contains(NmsCanonicalItemCodec.ROOT_KEY)
        }
    }

    private data class TagProjection(
        val tag: Tag,
        val changed: Boolean,
    )

    internal class TraversalBudget(
        internal val limits: NmsProjectionLimits = NmsProjectionLimits.DEFAULT,
    ) {
        private var nodes = 0
        private var candidates = 0
        private var decodedItems = 0
        private var stringBytes = 0
        private var inputBytes = 0
        private var outputBytes = 0
        private var outputNodes = 0
        private var outputStringBytes = 0

        fun enterNode(depth: Int) {
            requireProjectionInput(depth <= limits.nbtDepth) { "NBT traversal exceeds the depth limit" }
            nodes++
            requireProjectionInput(nodes <= limits.nbtNodes) { "NBT traversal exceeds the node limit" }
        }

        fun enterCandidate() {
            candidates++
            requireProjectionInput(candidates <= limits.nbtCandidates) {
                "NBT traversal exceeds the item candidate limit"
            }
        }

        fun decodeItem() {
            decodedItems++
            requireProjectionInput(decodedItems <= limits.nbtDecodedItems) {
                "NBT traversal exceeds the decoded item limit"
            }
        }

        fun enterOutputNode(depth: Int) {
            requireProjectionInput(depth <= limits.nbtDepth) { "Projected NBT exceeds the depth limit" }
            outputNodes++
            requireProjectionInput(outputNodes <= limits.nbtNodes) { "Projected NBT exceeds the node limit" }
        }

        fun consumeString(value: String, perStringLimit: Int, description: String) {
            val bytes = value.toByteArray(StandardCharsets.UTF_8).size
            requireProjectionInput(bytes <= perStringLimit) { "$description exceeds the UTF-8 byte limit" }
            stringBytes += bytes
            requireProjectionInput(stringBytes <= limits.nbtTotalStringBytes) {
                "NBT traversal exceeds the total string byte limit"
            }
        }

        fun consumeOutputString(value: String, perStringLimit: Int, description: String) {
            val bytes = value.toByteArray(StandardCharsets.UTF_8).size
            requireProjectionInput(bytes <= perStringLimit) { "$description exceeds the UTF-8 byte limit" }
            outputStringBytes += bytes
            requireProjectionInput(outputStringBytes <= limits.nbtTotalStringBytes) {
                "Projected NBT exceeds the total string byte limit"
            }
        }

        fun consumeInputBytes(bytes: Int) {
            inputBytes += bytes
            requireProjectionInput(inputBytes <= limits.nbtInputBytes) {
                "NBT traversal exceeds the input byte limit"
            }
        }

        fun consumeOutputBytes(bytes: Int) {
            outputBytes += bytes
            requireProjectionInput(outputBytes <= limits.nbtOutputBytes) {
                "NBT traversal exceeds the output byte limit"
            }
        }

        fun remainingInputBytes(): Int = limits.nbtInputBytes - inputBytes

        fun remainingOutputBytes(): Int = limits.nbtOutputBytes - outputBytes
    }

    private class BoundedCountingOutputStream(
        private val limit: Int,
    ) : OutputStream() {
        var count: Int = 0
            private set

        override fun write(value: Int) {
            reserve(1)
        }

        override fun write(bytes: ByteArray, offset: Int, length: Int) {
            require(offset >= 0 && length >= 0 && offset + length <= bytes.size)
            reserve(length)
        }

        private fun reserve(length: Int) {
            requireProjectionInput(length <= limit - count) { "NBT payload exceeds the wire byte limit" }
            count += length
        }
    }

    private companion object {
        const val ID_KEY = "id"
        const val COUNT_KEY = "count"
        const val COMPONENTS_KEY = "components"
        const val CUSTOM_DATA_COMPONENT_KEY = "minecraft:custom_data"
        val ITEM_STACK_FIELDS = setOf(ID_KEY, COUNT_KEY, COMPONENTS_KEY)
        val MALFORMED_PRESENTATION_COMPONENTS = setOf(
            "minecraft:custom_name",
            "minecraft:item_name",
            "minecraft:lore",
            "minecraft:tooltip_display",
            "minecraft:tooltip_style",
            "minecraft:item_model",
        )

        fun measureWireBytes(tag: Tag, limit: Int): Int {
            requireProjectionInput(limit >= 0) { "NBT payload exceeds the aggregate byte limit" }
            val output = BoundedCountingOutputStream(limit)
            DataOutputStream(output).use { data -> NbtIo.writeAnyTag(tag, data) }
            return output.count
        }
    }
}

internal data class NmsCompoundProjection(
    val tag: CompoundTag,
    val changed: Boolean,
)

internal data class NmsTagProjection(
    val tag: Tag,
    val changed: Boolean,
)
