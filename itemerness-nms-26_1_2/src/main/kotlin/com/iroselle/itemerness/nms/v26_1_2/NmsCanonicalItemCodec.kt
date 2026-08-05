package com.iroselle.itemerness.nms.v26_1_2

import com.iroselle.itemerness.api.ItemKey
import com.iroselle.itemerness.projection.BooleanProjectionValue
import com.iroselle.itemerness.projection.CanonicalDataSchemaVersion
import com.iroselle.itemerness.projection.CanonicalDataSchemas
import com.iroselle.itemerness.projection.CanonicalItemFingerprint
import com.iroselle.itemerness.projection.CanonicalItemSnapshot
import com.iroselle.itemerness.projection.DecimalProjectionValue
import com.iroselle.itemerness.projection.IntegerProjectionValue
import com.iroselle.itemerness.projection.KeyProjectionValue
import com.iroselle.itemerness.projection.ListProjectionValue
import com.iroselle.itemerness.projection.LongProjectionValue
import com.iroselle.itemerness.projection.ProjectionCompound
import com.iroselle.itemerness.projection.ProjectionValue
import com.iroselle.itemerness.projection.StringProjectionValue
import com.iroselle.itemerness.projection.UuidProjectionValue
import java.io.ByteArrayOutputStream
import java.io.DataOutputStream
import java.math.BigDecimal
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.UUID
import net.minecraft.core.UUIDUtil
import net.minecraft.core.component.DataComponents
import net.minecraft.core.registries.BuiltInRegistries
import net.minecraft.nbt.ByteTag
import net.minecraft.nbt.CompoundTag
import net.minecraft.nbt.DoubleTag
import net.minecraft.nbt.FloatTag
import net.minecraft.nbt.IntArrayTag
import net.minecraft.nbt.IntTag
import net.minecraft.nbt.ListTag
import net.minecraft.nbt.LongTag
import net.minecraft.nbt.ShortTag
import net.minecraft.nbt.StringTag
import net.minecraft.nbt.Tag
import net.minecraft.world.item.ItemStack

internal class NmsCanonicalItemCodec {
    fun decode(source: ItemStack): CanonicalDecodeResult {
        if (source.isEmpty) {
            return CanonicalDecodeResult.Missing
        }

        val customData = source.get(DataComponents.CUSTOM_DATA) ?: return CanonicalDecodeResult.Missing
        if (!customData.contains(ROOT_KEY)) {
            return CanonicalDecodeResult.Missing
        }

        val root = readRoot(customData)
            ?: return CanonicalDecodeResult.Invalid("The itemerness root is not a compound")

        return try {
            CanonicalDecodeResult.Decoded(decodeRoot(source, root))
        } catch (failure: RuntimeException) {
            CanonicalDecodeResult.Invalid(failure.message ?: "Invalid canonical data")
        }
    }

    @Suppress("DEPRECATION")
    private fun readRoot(customData: net.minecraft.world.item.component.CustomData): CompoundTag? {
        // CustomData is immutable by contract. This read-only view avoids copying unrelated
        // foreign data before the bounded Itemerness root has been validated.
        return customData.getUnsafe().getCompound(ROOT_KEY).orElse(null)
    }

    private fun decodeRoot(source: ItemStack, root: CompoundTag): CanonicalItemSnapshot {
        require(root.size() <= MAX_ROOT_ENTRIES && root.keySet().all(ROOT_FIELDS::contains)) {
            "Canonical root contains unsupported fields"
        }
        val budget = DecodeBudget(MAX_VALUE_NODES, MAX_TOTAL_UTF8_BYTES)
        budget.consume()

        require((root.get(FORMAT_KEY) as? IntTag)?.value() == SUPPORTED_FORMAT) {
            "Unsupported or missing canonical format"
        }
        val itemId = (root.get(ID_KEY) as? StringTag)?.value()
        requireNotNull(itemId) {
            "Missing canonical item id"
        }
        budget.consumeString(itemId, MAX_ITEM_ID_LENGTH, "Canonical item id")
        val itemKey = ItemKey.parse(itemId)

        val pendingName = requireNotNull(source.get(DataComponents.ITEM_NAME)?.string) {
            "Missing canonical pending name"
        }
        require(pendingName.isNotBlank()) { "Canonical pending name is blank" }
        budget.consumeString(pendingName, MAX_PENDING_NAME_LENGTH, "Canonical pending name")

        val createdAgainstRevision = (root.get(CREATED_REVISION_KEY) as? LongTag)?.value()
        require(createdAgainstRevision != null && createdAgainstRevision >= 0) {
            "Missing or invalid canonical creation revision"
        }

        val dataSchemasTag = root.get(DATA_SCHEMAS_KEY) as? CompoundTag
        requireNotNull(dataSchemasTag) { "Missing canonical data schema versions" }
        val dataSchemas = decodeDataSchemas(dataSchemasTag, budget)

        val instanceId = root.get(INSTANCE_ID_KEY)?.let { tag ->
            budget.consume()
            require(tag is IntArrayTag && tag.size() == UUID_INT_COUNT) {
                "Canonical instance id is not a UUID int array"
            }
            val value = tag.asIntArray().orElse(null)
            require(value != null) {
                "Canonical instance id is not a UUID int array"
            }
            UUIDUtil.uuidFromIntArray(value)
        }
        val dataTag = if (root.contains(DATA_KEY)) {
            requireNotNull(root.get(DATA_KEY) as? CompoundTag) {
                "Canonical data is not a compound"
            }
        } else {
            CompoundTag()
        }
        val data = decodeCompound(
            dataTag,
            depth = 0,
            budget = budget,
            requireNamespacedKeys = true,
        )
        val materialId = BuiltInRegistries.ITEM.getKey(source.item).toString()
        val materialKey = ItemKey.parse(materialId)

        return CanonicalItemSnapshot(
            itemKey = itemKey,
            materialKey = materialKey,
            count = source.count,
            pendingName = pendingName,
            createdAgainstRevision = createdAgainstRevision,
            dataSchemas = dataSchemas,
            instanceId = instanceId,
            data = data,
            fingerprint = CanonicalItemFingerprint(
                fingerprint(
                    itemKey,
                    materialKey,
                    source.count,
                    pendingName,
                    createdAgainstRevision,
                    dataSchemas,
                    instanceId,
                    data,
                ),
            ),
        )
    }

    private fun decodeDataSchemas(
        source: CompoundTag,
        budget: DecodeBudget,
    ): CanonicalDataSchemas {
        require(source.size() <= MAX_SCHEMA_ENTRIES) {
            "Canonical data schema map exceeds the entry limit"
        }
        budget.consume()
        val entries = source.keySet().sorted().map { key ->
            budget.consumeString(key, MAX_KEY_LENGTH, "Canonical data schema key")
            val schemaKey = ItemKey.parse(key)
            val versionTag = source.get(key)
            require(versionTag is IntTag && versionTag.value() >= 0) {
                "Canonical data schema version is not a non-negative integer"
            }
            budget.consume()
            CanonicalDataSchemaVersion(schemaKey, versionTag.value())
        }
        return CanonicalDataSchemas(entries)
    }

    private fun decodeCompound(
        source: CompoundTag,
        depth: Int,
        budget: DecodeBudget,
        requireNamespacedKeys: Boolean = false,
    ): ProjectionCompound {
        require(depth <= MAX_DEPTH) { "Canonical data exceeds the maximum depth" }
        require(source.size() <= MAX_COMPOUND_ENTRIES) {
            "Canonical compound exceeds the entry limit"
        }
        budget.consume()

        val entries = source.keySet().sorted().map { key ->
            budget.consumeString(key, MAX_KEY_LENGTH, "Canonical compound key")
            require(key.isNotBlank() && key.none(Char::isISOControl)) {
                "Canonical compound contains an invalid key"
            }
            if (requireNamespacedKeys) {
                ItemKey.parse(key)
            }
            val tag = requireNotNull(source.get(key)) { "Canonical compound entry is missing" }
            ProjectionCompound.Entry(key, decodeValue(tag, depth + 1, budget))
        }
        return ProjectionCompound(entries)
    }

    private fun decodeValue(
        tag: Tag,
        depth: Int,
        budget: DecodeBudget,
    ): ProjectionValue {
        require(depth <= MAX_DEPTH) { "Canonical data exceeds the maximum depth" }
        if (tag is CompoundTag) {
            return decodeCompound(tag, depth, budget)
        }
        budget.consume()

        return when (tag) {
            is ByteTag -> when (tag.value()) {
                0.toByte() -> BooleanProjectionValue(false)
                1.toByte() -> BooleanProjectionValue(true)
                else -> IntegerProjectionValue(tag.intValue())
            }
            is ShortTag -> IntegerProjectionValue(tag.intValue())
            is IntTag -> IntegerProjectionValue(tag.value())
            is LongTag -> LongProjectionValue(tag.value())
            is FloatTag -> DecimalProjectionValue(decimal(tag.value()))
            is DoubleTag -> DecimalProjectionValue(decimal(tag.value()))
            is StringTag -> {
                budget.consumeString(tag.value(), MAX_STRING_LENGTH, "Canonical string")
                StringProjectionValue(tag.value())
            }
            is IntArrayTag -> {
                require(tag.size() == UUID_INT_COUNT) {
                    "Only UUID int arrays are supported in canonical data"
                }
                val value = tag.asIntArray().orElse(null)
                require(value != null) {
                    "Only UUID int arrays are supported in canonical data"
                }
                UuidProjectionValue(UUIDUtil.uuidFromIntArray(value))
            }
            is ListTag -> {
                require(tag.size <= MAX_LIST_ELEMENTS) { "Canonical list exceeds the element limit" }
                ListProjectionValue(tag.map { element -> decodeValue(element, depth + 1, budget) })
            }
            else -> error("Unsupported canonical NBT type: ${tag.type.name}")
        }
    }

    private fun decimal(value: Double): BigDecimal {
        require(value.isFinite()) { "Canonical decimal must be finite" }
        return BigDecimal.valueOf(value)
    }

    private fun decimal(value: Float): BigDecimal {
        require(value.isFinite()) { "Canonical decimal must be finite" }
        return BigDecimal(value.toString())
    }

    private fun fingerprint(
        itemKey: ItemKey,
        materialKey: ItemKey,
        count: Int,
        pendingName: String,
        createdAgainstRevision: Long,
        dataSchemas: CanonicalDataSchemas,
        instanceId: UUID?,
        data: ProjectionCompound,
    ): ByteArray {
        val serialized = ByteArrayOutputStream().use { bytes ->
            DataOutputStream(bytes).use { output ->
                output.writeByte(FINGERPRINT_FORMAT)
                output.writeString(itemKey.toString())
                output.writeString(materialKey.toString())
                output.writeInt(count)
                output.writeString(pendingName)
                output.writeLong(createdAgainstRevision)
                output.writeInt(dataSchemas.entries.size)
                dataSchemas.entries.forEach { schema ->
                    output.writeString(schema.schemaKey.toString())
                    output.writeInt(schema.version)
                }
                output.writeBoolean(instanceId != null)
                instanceId?.let { id ->
                    output.writeLong(id.mostSignificantBits)
                    output.writeLong(id.leastSignificantBits)
                }
                output.writeValue(data)
            }
            bytes.toByteArray()
        }
        return MessageDigest.getInstance("SHA-256").digest(serialized)
    }

    private fun DataOutputStream.writeValue(value: ProjectionValue) {
        when (value) {
            is BooleanProjectionValue -> {
                writeByte(VALUE_BOOLEAN)
                writeBoolean(value.value)
            }
            is IntegerProjectionValue -> {
                writeByte(VALUE_INTEGER)
                writeInt(value.value)
            }
            is LongProjectionValue -> {
                writeByte(VALUE_LONG)
                writeLong(value.value)
            }
            is DecimalProjectionValue -> {
                writeByte(VALUE_DECIMAL)
                writeString(value.value.toString())
            }
            is StringProjectionValue -> {
                writeByte(VALUE_STRING)
                writeString(value.value)
            }
            is UuidProjectionValue -> {
                writeByte(VALUE_UUID)
                writeLong(value.value.mostSignificantBits)
                writeLong(value.value.leastSignificantBits)
            }
            is KeyProjectionValue -> {
                writeByte(VALUE_KEY)
                writeString(value.value.toString())
            }
            is ListProjectionValue -> {
                writeByte(VALUE_LIST)
                writeInt(value.values.size)
                value.values.forEach { element -> writeValue(element) }
            }
            is ProjectionCompound -> {
                writeByte(VALUE_COMPOUND)
                val entries = value.entries.sortedBy(ProjectionCompound.Entry::key)
                writeInt(entries.size)
                entries.forEach { entry ->
                    writeString(entry.key)
                    writeValue(entry.value)
                }
            }
        }
    }

    private fun DataOutputStream.writeString(value: String) {
        val bytes = value.toByteArray(StandardCharsets.UTF_8)
        writeInt(bytes.size)
        write(bytes)
    }

    private class DecodeBudget(
        private var remainingNodes: Int,
        private var remainingUtf8Bytes: Int,
    ) {
        fun consume() {
            require(remainingNodes-- > 0) { "Canonical data exceeds the node limit" }
        }

        fun consumeString(
            value: String,
            maximumLength: Int,
            fieldName: String,
        ) {
            require(value.length <= maximumLength) {
                "$fieldName exceeds the character limit"
            }
            val utf8Bytes = value.toByteArray(StandardCharsets.UTF_8).size
            require(utf8Bytes <= remainingUtf8Bytes) {
                "Canonical data exceeds the UTF-8 byte limit"
            }
            remainingUtf8Bytes -= utf8Bytes
        }
    }

    companion object {
        const val ROOT_KEY = "itemerness"
        private const val FORMAT_KEY = "format"
        private const val ID_KEY = "id"
        private const val CREATED_REVISION_KEY = "created_against_revision"
        private const val DATA_SCHEMAS_KEY = "data_schemas"
        private const val INSTANCE_ID_KEY = "instance_id"
        private const val DATA_KEY = "data"
        private val ROOT_FIELDS = setOf(
            FORMAT_KEY,
            ID_KEY,
            CREATED_REVISION_KEY,
            DATA_SCHEMAS_KEY,
            INSTANCE_ID_KEY,
            DATA_KEY,
        )
        private const val SUPPORTED_FORMAT = 1
        private const val UUID_INT_COUNT = 4
        private const val MAX_ROOT_ENTRIES = 6
        private const val MAX_SCHEMA_ENTRIES = 64
        private const val MAX_DEPTH = 16
        private const val MAX_VALUE_NODES = 2_048
        private const val MAX_TOTAL_UTF8_BYTES = 262_144
        private const val MAX_COMPOUND_ENTRIES = 256
        private const val MAX_LIST_ELEMENTS = 256
        private const val MAX_KEY_LENGTH = 128
        private const val MAX_ITEM_ID_LENGTH = 256
        private const val MAX_PENDING_NAME_LENGTH = 1_024
        private const val MAX_STRING_LENGTH = 8_192
        private const val FINGERPRINT_FORMAT = 1
        private const val VALUE_BOOLEAN = 1
        private const val VALUE_INTEGER = 2
        private const val VALUE_LONG = 3
        private const val VALUE_DECIMAL = 4
        private const val VALUE_STRING = 5
        private const val VALUE_UUID = 6
        private const val VALUE_KEY = 7
        private const val VALUE_LIST = 8
        private const val VALUE_COMPOUND = 9
    }
}

internal sealed interface CanonicalDecodeResult {
    data object Missing : CanonicalDecodeResult

    data class Invalid(
        val reason: String,
    ) : CanonicalDecodeResult

    data class Decoded(
        val snapshot: CanonicalItemSnapshot,
    ) : CanonicalDecodeResult
}
