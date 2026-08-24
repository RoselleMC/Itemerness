package com.iroselle.itemerness.nms.v26_2

import com.iroselle.itemerness.api.BooleanDataValue
import com.iroselle.itemerness.api.CompoundDataValue
import com.iroselle.itemerness.api.DecimalDataValue
import com.iroselle.itemerness.api.IntegerDataValue
import com.iroselle.itemerness.api.ItemDataValue
import com.iroselle.itemerness.api.ItemDefinition
import com.iroselle.itemerness.api.ItemInstanceMode
import com.iroselle.itemerness.api.ItemKey
import com.iroselle.itemerness.api.ListDataValue
import com.iroselle.itemerness.api.LongDataValue
import com.iroselle.itemerness.api.NamespacedKeyDataValue
import com.iroselle.itemerness.api.StringDataValue
import com.iroselle.itemerness.api.UuidDataValue
import com.iroselle.itemerness.bukkit.spi.PendingItemName
import com.iroselle.itemerness.core.catalog.CanonicalItemInstance
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
import com.iroselle.itemerness.projection.ProjectionPdcFallbackPlan
import com.iroselle.itemerness.projection.ProjectionPdcScalarType
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
import net.minecraft.network.chat.Component
import net.minecraft.network.chat.FontDescription
import net.minecraft.network.chat.contents.PlainTextContents
import net.minecraft.resources.Identifier
import net.minecraft.world.item.ItemStack
import net.minecraft.world.item.component.CustomData

internal class NmsCanonicalItemCodec {
    /**
     * Stable canonical identity used by connection-private view capabilities. Physical count and
     * tooltip ownership are intentionally excluded: vanilla merchant predicates are positive
     * component subsets, so unrelated inventory components may change tooltip ownership without
     * changing the managed item identity required by the offer.
     */
    fun identityFingerprint(snapshot: CanonicalItemSnapshot): ByteArray = fingerprint(
        itemKey = snapshot.itemKey,
        materialKey = snapshot.materialKey,
        count = 1,
        pendingName = snapshot.pendingName,
        createdAgainstRevision = snapshot.createdAgainstRevision,
        instanceRevision = snapshot.instanceRevision,
        dataSchemas = snapshot.dataSchemas,
        instanceId = snapshot.instanceId,
        data = snapshot.data,
        pdcFallbackData = ProjectionCompound(),
        canManageVanillaTooltipLines = false,
    )

    fun create(
        definition: ItemDefinition,
        instance: CanonicalItemInstance,
        pendingName: PendingItemName,
        amount: Int,
    ): ItemStack {
        validateWriteRequest(definition, instance, amount)
        val materialId = Identifier.parse(definition.material.toString())
        require(BuiltInRegistries.ITEM.containsKey(materialId)) {
            "Unknown item material: ${definition.material}"
        }
        val result = ItemStack(BuiltInRegistries.ITEM.getValue(materialId), amount)
        require(amount <= result.maxStackSize) {
            "Item amount $amount exceeds the material stack size ${result.maxStackSize}"
        }
        writeCanonical(result, instance, pendingName, CompoundTag())
        return result
    }

    fun rewrite(
        source: ItemStack,
        definition: ItemDefinition,
        instance: CanonicalItemInstance,
        pendingName: PendingItemName,
    ): ItemStack {
        require(!source.isEmpty) { "Cannot rewrite an empty item stack" }
        validateWriteRequest(definition, instance, source.count)
        require(source.count <= source.maxStackSize) {
            "Canonical item amount ${source.count} exceeds the material stack size ${source.maxStackSize}"
        }
        val actualMaterial = ItemKey.parse(BuiltInRegistries.ITEM.getKey(source.item).toString())
        require(actualMaterial == definition.material) {
            "Canonical material $actualMaterial does not match ${definition.material}"
        }
        val result = source.copy()
        val customData = result.get(DataComponents.CUSTOM_DATA)?.copyTag() ?: CompoundTag()
        writeCanonical(result, instance, pendingName, customData)
        return result
    }

    fun decode(
        source: ItemStack,
        pdcFallbackPlan: ProjectionPdcFallbackPlan = ProjectionPdcFallbackPlan.EMPTY,
    ): CanonicalDecodeResult {
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
            CanonicalDecodeResult.Decoded(
                decodeRoot(
                    source,
                    root,
                    customData,
                    pdcFallbackPlan,
                ),
            )
        } catch (failure: RuntimeException) {
            CanonicalDecodeResult.Invalid(failure.message ?: "Invalid canonical data")
        }
    }

    fun canonicalSnbt(source: ItemStack): String? {
        if (source.isEmpty) return null
        val customData = source.get(DataComponents.CUSTOM_DATA) ?: return null
        if (!customData.contains(ROOT_KEY)) return null
        return readRoot(customData)?.toString()
    }

    @Suppress("DEPRECATION")
    private fun readRoot(customData: net.minecraft.world.item.component.CustomData): CompoundTag? {
        // CustomData is immutable by contract. This read-only view avoids copying unrelated
        // foreign data before the bounded Itemerness root has been validated.
        return customData.getUnsafe().getCompound(ROOT_KEY).orElse(null)
    }

    private fun decodeRoot(
        source: ItemStack,
        root: CompoundTag,
        customData: CustomData,
        pdcFallbackPlan: ProjectionPdcFallbackPlan,
    ): CanonicalItemSnapshot {
        require(source.count in 1..source.maxStackSize) {
            "Canonical item count is outside the material stack-size bound"
        }
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

        val pendingName = decodePendingName(source)
        require(pendingName.isNotBlank()) { "Canonical pending name is blank" }
        budget.consumeString(pendingName, MAX_PENDING_NAME_LENGTH, "Canonical pending name")

        val createdAgainstRevision = (root.get(CREATED_REVISION_KEY) as? LongTag)?.value()
        require(createdAgainstRevision != null && createdAgainstRevision >= 0) {
            "Missing or invalid canonical creation revision"
        }
        val instanceRevision = (root.get(INSTANCE_REVISION_KEY) as? LongTag)?.value()
        require(instanceRevision != null && instanceRevision >= 0) {
            "Missing or invalid canonical instance revision"
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
        val pdcFallbackData = decodePdcFallbacks(
            customData = customData,
            plan = pdcFallbackPlan,
            itemKey = itemKey,
            canonicalDataKeys = data.entries.mapTo(HashSet(), ProjectionCompound.Entry::key),
        )
        val materialId = BuiltInRegistries.ITEM.getKey(source.item).toString()
        val materialKey = ItemKey.parse(materialId)
        val canManageVanillaTooltipLines = NmsVanillaTooltipLines.canManage(source)

        return CanonicalItemSnapshot(
            itemKey = itemKey,
            materialKey = materialKey,
            count = source.count,
            pendingName = pendingName,
            createdAgainstRevision = createdAgainstRevision,
            instanceRevision = instanceRevision,
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
                    instanceRevision,
                    dataSchemas,
                    instanceId,
                    data,
                    pdcFallbackData,
                    canManageVanillaTooltipLines,
                ),
            ),
            canManageVanillaTooltipLines = canManageVanillaTooltipLines,
            pdcFallbackData = pdcFallbackData,
        )
    }

    @Suppress("DEPRECATION")
    private fun decodePdcFallbacks(
        customData: CustomData,
        plan: ProjectionPdcFallbackPlan,
        itemKey: ItemKey,
        canonicalDataKeys: Set<String>,
    ): ProjectionCompound {
        if (plan.entries.isEmpty()) return ProjectionCompound()
        val eligible = plan.entries.filter { fallback ->
            itemKey in fallback.itemKeys && fallback.dataKey.toString() !in canonicalDataKeys
        }
        if (eligible.isEmpty()) return ProjectionCompound()
        val pdc = customData.getUnsafe().getCompound(PDC_CUSTOM_DATA_KEY).orElse(null)
            ?: return ProjectionCompound()
        val resolved = LinkedHashMap<String, ProjectionValue>()
        eligible.forEach { fallback ->
            val target = fallback.dataKey.toString()
            if (target in resolved) return@forEach
            val tag = pdc.get(fallback.pdcKey.toString()) ?: return@forEach
            resolved[target] = decodePdcScalar(tag, fallback.type, fallback.pdcKey.toString())
        }
        return ProjectionCompound(
            resolved.map { (key, value) -> ProjectionCompound.Entry(key, value) },
        )
    }

    private fun decodePdcScalar(
        tag: Tag,
        type: ProjectionPdcScalarType,
        key: String,
    ): ProjectionValue = when (type) {
        ProjectionPdcScalarType.BOOLEAN -> BooleanProjectionValue(
            when ((tag as? ByteTag)?.value()) {
                0.toByte() -> false
                1.toByte() -> true
                else -> error("PDC fallback $key must be encoded as byte 0 or 1")
            },
        )

        ProjectionPdcScalarType.INTEGER -> IntegerProjectionValue(
            when (tag) {
                is ByteTag -> tag.value().toInt()
                is ShortTag -> tag.value().toInt()
                is IntTag -> tag.value()
                else -> error("PDC fallback $key has the wrong physical type")
            },
        )

        ProjectionPdcScalarType.LONG -> LongProjectionValue(
            (tag as? LongTag)?.value()
                ?: error("PDC fallback $key has the wrong physical type"),
        )

        ProjectionPdcScalarType.DECIMAL -> DecimalProjectionValue(
            when (tag) {
                is FloatTag -> BigDecimal(tag.value().toString())
                is DoubleTag -> BigDecimal(tag.value().toString())
                else -> error("PDC fallback $key has the wrong physical type")
            },
        )

        ProjectionPdcScalarType.STRING -> StringProjectionValue(
            (tag as? StringTag)?.value()
                ?: error("PDC fallback $key has the wrong physical type"),
        )

        ProjectionPdcScalarType.UUID -> UuidProjectionValue(
            (tag as? IntArrayTag)
                ?.takeIf { it.size() == UUID_INT_COUNT }
                ?.asIntArray()
                ?.orElse(null)
                ?.let(UUIDUtil::uuidFromIntArray)
                ?: error("PDC fallback $key must be a UUID int array"),
        )

        ProjectionPdcScalarType.NAMESPACED_KEY -> KeyProjectionValue(
            ItemKey.parse(
                (tag as? StringTag)?.value()
                    ?: error("PDC fallback $key has the wrong physical type"),
            ),
        )
    }

    private fun decodePendingName(source: ItemStack): String {
        val component = requireNotNull(source.get(DataComponents.ITEM_NAME)) {
            "Missing canonical pending name"
        }
        val contents = component.contents as? PlainTextContents
            ?: error("Canonical pending name is not plain text")
        require(component.siblings.isEmpty()) { "Canonical pending name has siblings" }
        val style = component.style
        require(
            style.shadowColor == null &&
                !style.isBold &&
                !style.isItalic &&
                !style.isUnderlined &&
                !style.isStrikethrough &&
                !style.isObfuscated &&
                style.clickEvent == null &&
                style.hoverEvent == null &&
                style.insertion == null &&
                style.font == FontDescription.DEFAULT
        ) {
            "Canonical pending name contains unsupported style data"
        }
        return contents.text()
    }

    private fun validateWriteRequest(
        definition: ItemDefinition,
        instance: CanonicalItemInstance,
        amount: Int,
    ) {
        require(instance.itemKey == definition.key) {
            "Canonical instance ${instance.itemKey} does not match definition ${definition.key}"
        }
        require(amount > 0) { "Canonical item amount must be positive" }
        if (definition.instanceMode == ItemInstanceMode.UNIQUE) {
            require(amount == 1) { "Unique item instances cannot be stacked" }
            requireNotNull(instance.instanceId) { "Unique item instance is missing its instance ID" }
        } else {
            require(instance.instanceId == null) { "Fungible item instance must not have an instance ID" }
        }
    }

    private fun writeCanonical(
        target: ItemStack,
        instance: CanonicalItemInstance,
        pendingName: PendingItemName,
        customData: CompoundTag,
    ) {
        validateWriteBudget(instance, pendingName)
        customData.remove(NmsViewTokenCodec.VIEW_KEY)
        val root = CompoundTag().apply {
            putInt(FORMAT_KEY, SUPPORTED_FORMAT)
            putString(ID_KEY, instance.itemKey.toString())
            putLong(CREATED_REVISION_KEY, instance.createdAgainstRevision)
            putLong(INSTANCE_REVISION_KEY, instance.instanceRevision)
            put(
                DATA_SCHEMAS_KEY,
                CompoundTag().also { schemas ->
                    instance.schemaVersions.forEach { (id, version) ->
                        schemas.putInt(id.toString(), version)
                    }
                },
            )
            instance.instanceId?.let { id -> putIntArray(INSTANCE_ID_KEY, UUIDUtil.uuidToIntArray(id)) }
            put(
                DATA_KEY,
                CompoundTag().also { data ->
                    instance.data.forEach { (key, value) ->
                        data.put(key.toString(), encodeValue(value, depth = 0))
                    }
                },
            )
        }
        customData.put(ROOT_KEY, root)
        CustomData.set(DataComponents.CUSTOM_DATA, target, customData)
        target.set(DataComponents.ITEM_NAME, Component.literal(pendingName.text).withColor(pendingName.colorRgb))
        target.remove(DataComponents.CUSTOM_NAME)
        target.remove(DataComponents.LORE)
        target.remove(DataComponents.TOOLTIP_STYLE)
    }

    private fun validateWriteBudget(
        instance: CanonicalItemInstance,
        pendingName: PendingItemName,
    ) {
        val budget = DecodeBudget(MAX_VALUE_NODES, MAX_TOTAL_UTF8_BYTES)
        budget.consume()
        budget.consumeString(instance.itemKey.toString(), MAX_ITEM_ID_LENGTH, "Canonical item id")
        budget.consumeString(pendingName.text, MAX_PENDING_NAME_LENGTH, "Canonical pending name")
        require(instance.schemaVersions.size <= MAX_SCHEMA_ENTRIES) {
            "Canonical data schema map exceeds the entry limit"
        }
        budget.consume()
        instance.schemaVersions.forEach { (key, version) ->
            require(version > 0) { "Canonical data schema versions must be positive" }
            budget.consumeString(key.toString(), MAX_KEY_LENGTH, "Canonical data schema key")
            budget.consume()
        }
        if (instance.instanceId != null) budget.consume()
        validateWriteCompound(instance.data.mapKeys { (key, _) -> key.toString() }, 0, budget, true)
    }

    private fun validateWriteCompound(
        entries: Map<String, ItemDataValue>,
        depth: Int,
        budget: DecodeBudget,
        requireNamespacedKeys: Boolean = false,
    ) {
        require(depth <= MAX_DEPTH) { "Canonical data exceeds the maximum depth" }
        require(entries.size <= MAX_COMPOUND_ENTRIES) {
            "Canonical compound exceeds the entry limit"
        }
        budget.consume()
        entries.forEach { (key, value) ->
            budget.consumeString(key, MAX_KEY_LENGTH, "Canonical compound key")
            require(key.isNotBlank() && key.none(Char::isISOControl)) {
                "Canonical compound contains an invalid key"
            }
            if (requireNamespacedKeys) ItemKey.parse(key)
            validateWriteValue(value, depth + 1, budget)
        }
    }

    private fun validateWriteValue(
        value: ItemDataValue,
        depth: Int,
        budget: DecodeBudget,
    ) {
        require(depth <= MAX_DEPTH) { "Canonical data exceeds the maximum depth" }
        when (value) {
            is CompoundDataValue -> validateWriteCompound(value.entries, depth, budget)
            is ListDataValue -> {
                require(value.values.size <= MAX_LIST_ELEMENTS) {
                    "Canonical list exceeds the element limit"
                }
                budget.consume()
                value.values.forEach { child -> validateWriteValue(child, depth + 1, budget) }
            }
            is StringDataValue -> {
                budget.consume()
                budget.consumeString(value.value, MAX_STRING_LENGTH, "Canonical string")
            }
            is NamespacedKeyDataValue -> {
                budget.consume()
                budget.consumeString(value.value.toString(), MAX_STRING_LENGTH, "Canonical string")
            }
            else -> budget.consume()
        }
    }

    private fun encodeValue(
        value: ItemDataValue,
        depth: Int,
    ): Tag {
        require(depth <= MAX_DEPTH) { "Canonical data exceeds the maximum depth" }
        return when (value) {
            is BooleanDataValue -> ByteTag.valueOf(value.value)
            is IntegerDataValue -> IntTag.valueOf(value.value)
            is LongDataValue -> LongTag.valueOf(value.value)
            is DecimalDataValue -> DoubleTag.valueOf(value.value)
            is StringDataValue -> StringTag.valueOf(value.value)
            is UuidDataValue -> IntArrayTag(UUIDUtil.uuidToIntArray(value.value))
            is NamespacedKeyDataValue -> StringTag.valueOf(value.value.toString())
            is ListDataValue -> ListTag().also { list ->
                require(value.values.size <= MAX_LIST_ELEMENTS) {
                    "Canonical list exceeds the element limit"
                }
                value.values.forEach { child ->
                    val tag = encodeValue(child, depth + 1)
                    require(list.addTag(list.size, tag)) {
                        "Canonical NBT lists must contain one physical tag type"
                    }
                }
            }
            is CompoundDataValue -> CompoundTag().also { compound ->
                require(value.entries.size <= MAX_COMPOUND_ENTRIES) {
                    "Canonical compound exceeds the entry limit"
                }
                value.entries.forEach { (key, child) ->
                    compound.put(key, encodeValue(child, depth + 1))
                }
            }
        }
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
            require(versionTag is IntTag && versionTag.value() > 0) {
                "Canonical data schema version is not a positive integer"
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
        instanceRevision: Long,
        dataSchemas: CanonicalDataSchemas,
        instanceId: UUID?,
        data: ProjectionCompound,
        pdcFallbackData: ProjectionCompound,
        canManageVanillaTooltipLines: Boolean,
    ): ByteArray {
        val serialized = ByteArrayOutputStream().use { bytes ->
            DataOutputStream(bytes).use { output ->
                output.writeByte(FINGERPRINT_FORMAT)
                output.writeString(itemKey.toString())
                output.writeString(materialKey.toString())
                output.writeInt(count)
                output.writeString(pendingName)
                output.writeLong(createdAgainstRevision)
                output.writeLong(instanceRevision)
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
                output.writeValue(pdcFallbackData)
                output.writeBoolean(canManageVanillaTooltipLines)
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
        private const val PDC_CUSTOM_DATA_KEY = "PublicBukkitValues"
        private const val FORMAT_KEY = "format"
        private const val ID_KEY = "id"
        private const val CREATED_REVISION_KEY = "created_against_revision"
        private const val INSTANCE_REVISION_KEY = "instance_revision"
        private const val DATA_SCHEMAS_KEY = "data_schemas"
        private const val INSTANCE_ID_KEY = "instance_id"
        private const val DATA_KEY = "data"
        private val ROOT_FIELDS = setOf(
            FORMAT_KEY,
            ID_KEY,
            CREATED_REVISION_KEY,
            INSTANCE_REVISION_KEY,
            DATA_SCHEMAS_KEY,
            INSTANCE_ID_KEY,
            DATA_KEY,
        )
        private const val SUPPORTED_FORMAT = 1
        private const val UUID_INT_COUNT = 4
        private const val MAX_ROOT_ENTRIES = 7
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
        private const val FINGERPRINT_FORMAT = 3
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
