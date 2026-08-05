package com.iroselle.itemerness.core.catalog

import com.iroselle.itemerness.api.BooleanDataValue
import com.iroselle.itemerness.api.CompoundDataValue
import com.iroselle.itemerness.api.DataKey
import com.iroselle.itemerness.api.DecimalDataValue
import com.iroselle.itemerness.api.IntegerDataValue
import com.iroselle.itemerness.api.ItemDataValue
import com.iroselle.itemerness.api.ItemInstanceMode
import com.iroselle.itemerness.api.ItemKey
import com.iroselle.itemerness.api.ListDataValue
import com.iroselle.itemerness.api.LongDataValue
import com.iroselle.itemerness.api.NamespacedKeyDataValue
import com.iroselle.itemerness.api.StringDataValue
import com.iroselle.itemerness.api.UuidDataValue
import java.math.BigDecimal
import java.util.TreeMap
import java.util.UUID

class CatalogCompiler {
    fun compile(source: CatalogSource): CatalogCompilation {
        val diagnostics = DiagnosticCollector()
        val schemas = compileSchemas(source.schemas, diagnostics)
        validateItemGraph(source.items, diagnostics)
        val items = compileItems(source.items, schemas, diagnostics)
        val resultDiagnostics = diagnostics.snapshot()
        val candidate = if (resultDiagnostics.isEmpty()) {
            CatalogCandidate(items.enabled, items.validation, schemas)
        } else {
            null
        }
        return CatalogCompilation(candidate, resultDiagnostics)
    }

    private fun compileSchemas(
        sources: List<DataSchemaSource>,
        diagnostics: DiagnosticCollector,
    ): Map<SchemaVersion, DataSchemaDefinition> {
        val schemas = TreeMap<SchemaVersion, DataSchemaDefinition>()
        sources.forEachIndexed { index, source ->
            val path = "schemas[$index]"
            val schemaId = diagnostics.parseItemKey(source.id, "$path.id")
            if (source.sourceFormatVersion != SUPPORTED_SOURCE_FORMAT) {
                diagnostics.add(
                    CatalogDiagnosticCode.INVALID_SCHEMA,
                    "$path.source-format-version",
                    "Unsupported data schema source format ${source.sourceFormatVersion}",
                )
            }
            if (source.version <= 0) {
                diagnostics.add(CatalogDiagnosticCode.INVALID_SCHEMA, "$path.version", "Schema version must be positive")
            }
            if (schemaId == null || source.version <= 0) {
                return@forEachIndexed
            }
            val identity = SchemaVersion(schemaId, source.version)
            if (schemas.containsKey(identity)) {
                diagnostics.add(CatalogDiagnosticCode.DUPLICATE_ID, path, "Duplicate schema $identity")
                return@forEachIndexed
            }

            val keys = TreeMap<DataKey, DataKeyDefinition>()
            val seenKeys = HashSet<DataKey>()
            source.keys.forEachIndexed { keyIndex, keySource ->
                val keyPath = "$path.keys[$keyIndex]"
                val keyId = diagnostics.parseDataKey(keySource.id, "$keyPath.id") ?: return@forEachIndexed
                if (!seenKeys.add(keyId)) {
                    diagnostics.add(CatalogDiagnosticCode.DUPLICATE_ID, keyPath, "Duplicate data key $keyId in $identity")
                    return@forEachIndexed
                }
                compileDataKey(keySource, keyId, keyPath, diagnostics)?.let { keys[keyId] = it }
            }
            schemas[identity] = DataSchemaDefinition(identity, keys)
        }
        return schemas
    }

    private fun compileDataKey(
        source: DataKeySource,
        key: DataKey,
        path: String,
        diagnostics: DiagnosticCollector,
    ): DataKeyDefinition? {
        val type = normalizeType(source.type, "$path.type", 1, diagnostics) ?: return null
        val constraints = compileConstraints(source.constraints, type, "$path.constraints", diagnostics)
            ?: return null

        val rawDefault = source.defaultValue
        val hasDefault = rawDefault != null
        var defaultValue: ItemDataValue? = null
        if (rawDefault != null) {
            val decoded = DataValueDecoder.decode(
                source = rawDefault,
                type = type,
                nullable = source.nullable,
                constraints = constraints,
                path = "$path.default",
                diagnostics = diagnostics,
            )
            if (decoded.valid) {
                defaultValue = decoded.value
            }
        }

        return DataKeyDefinition(
            key = key,
            type = type,
            scope = source.scope,
            nullable = source.nullable,
            hasDefault = hasDefault,
            defaultValue = defaultValue,
            affectsStacking = source.affectsStacking,
            presentationReadable = source.presentationReadable,
            constraints = constraints,
        )
    }

    private fun normalizeType(
        type: DataType,
        path: String,
        depth: Int,
        diagnostics: DiagnosticCollector,
    ): DataType? {
        if (depth > MAX_TYPE_DEPTH) {
            diagnostics.add(
                CatalogDiagnosticCode.INVALID_SCHEMA,
                path,
                "Data type nesting exceeds the hard limit of $MAX_TYPE_DEPTH",
            )
            return null
        }
        return when (type) {
            is DataType.ListType -> normalizeType(type.element, "$path.element", depth + 1, diagnostics)
                ?.let(DataType::ListType)

            is DataType.CompoundType -> {
                val fields = type.fields ?: return DataType.CompoundType()
                val names = HashSet<String>()
                val normalized = ArrayList<CompoundFieldSource>(fields.size)
                fields.forEachIndexed { index, field ->
                    val fieldPath = "$path.fields[$index]"
                    if (!isValidCompoundKey(field.name)) {
                        diagnostics.add(
                            CatalogDiagnosticCode.INVALID_SCHEMA,
                            "$fieldPath.name",
                            "Compound field names must be non-blank, control-free, and at most $MAX_COMPOUND_KEY_LENGTH characters",
                        )
                        return@forEachIndexed
                    }
                    if (!names.add(field.name)) {
                        diagnostics.add(CatalogDiagnosticCode.DUPLICATE_ID, fieldPath, "Duplicate compound field ${field.name}")
                        return@forEachIndexed
                    }
                    normalizeType(field.type, "$fieldPath.type", depth + 1, diagnostics)?.let { normalizedType ->
                        normalized += field.copy(type = normalizedType)
                    }
                }
                if (normalized.size == fields.size) {
                    DataType.CompoundType(normalized.sortedBy(CompoundFieldSource::name))
                } else {
                    null
                }
            }

            else -> type
        }
    }

    private fun compileConstraints(
        source: DataConstraintsSource,
        type: DataType,
        path: String,
        diagnostics: DiagnosticCollector,
    ): CompiledDataConstraints? {
        val initialCount = diagnostics.size
        val numeric = type == DataType.IntegerType || type == DataType.LongType || type == DataType.DecimalType
        if (!numeric && (source.minimum != null || source.maximum != null)) {
            diagnostics.add(CatalogDiagnosticCode.INVALID_CONSTRAINT, path, "Numeric bounds require a numeric data type")
        }
        if (source.minimum != null && source.maximum != null && source.minimum > source.maximum) {
            diagnostics.add(CatalogDiagnosticCode.INVALID_CONSTRAINT, path, "Minimum must not exceed maximum")
        }
        if ((type == DataType.IntegerType || type == DataType.LongType) &&
            listOfNotNull(source.minimum, source.maximum).any { it.stripTrailingZeros().scale() > 0 }
        ) {
            diagnostics.add(CatalogDiagnosticCode.INVALID_CONSTRAINT, path, "Integer bounds must be whole numbers")
        }
        val representableRange = when (type) {
            DataType.IntegerType -> BigDecimal.valueOf(Int.MIN_VALUE.toLong())..BigDecimal.valueOf(Int.MAX_VALUE.toLong())
            DataType.LongType -> BigDecimal.valueOf(Long.MIN_VALUE)..BigDecimal.valueOf(Long.MAX_VALUE)
            else -> null
        }
        if (representableRange != null && listOfNotNull(source.minimum, source.maximum).any { it !in representableRange }) {
            diagnostics.add(CatalogDiagnosticCode.INVALID_CONSTRAINT, path, "Numeric bounds exceed the data type range")
        }
        if (type == DataType.DecimalType &&
            listOfNotNull(source.minimum, source.maximum).any { !it.toDouble().isFinite() }
        ) {
            diagnostics.add(CatalogDiagnosticCode.INVALID_CONSTRAINT, path, "Decimal bounds must be finite")
        }
        if (source.scale != null && type != DataType.DecimalType) {
            diagnostics.add(CatalogDiagnosticCode.INVALID_CONSTRAINT, "$path.scale", "Scale is only valid for decimal data")
        }
        validateLimit(source.scale, MAX_DECIMAL_SCALE, "$path.scale", "decimal scale", diagnostics)
        if (source.maximumCodePoints != null && type != DataType.StringType) {
            diagnostics.add(CatalogDiagnosticCode.INVALID_CONSTRAINT, "$path.maximum-codepoints", "Codepoint limits require string data")
        }
        validateLimit(
            source.maximumCodePoints,
            MAX_STRING_CODEPOINTS,
            "$path.maximum-codepoints",
            "string codepoint limit",
            diagnostics,
        )
        if (source.maximumElements != null && type !is DataType.ListType) {
            diagnostics.add(CatalogDiagnosticCode.INVALID_CONSTRAINT, "$path.maximum-elements", "Element limits require list data")
        }
        validateLimit(source.maximumElements, MAX_CONTAINER_ELEMENTS, "$path.maximum-elements", "list element limit", diagnostics)
        if (source.maximumEntries != null && type !is DataType.CompoundType) {
            diagnostics.add(CatalogDiagnosticCode.INVALID_CONSTRAINT, "$path.maximum-entries", "Entry limits require compound data")
        }
        validateLimit(source.maximumEntries, MAX_CONTAINER_ELEMENTS, "$path.maximum-entries", "compound entry limit", diagnostics)
        if (source.maximumDepth != null && type !is DataType.ListType && type !is DataType.CompoundType) {
            diagnostics.add(CatalogDiagnosticCode.INVALID_CONSTRAINT, "$path.maximum-depth", "Depth limits require container data")
        }
        validateLimit(source.maximumDepth, MAX_VALUE_DEPTH, "$path.maximum-depth", "value depth limit", diagnostics)

        if (diagnostics.size != initialCount) {
            return null
        }

        val withoutAllowed = CompiledDataConstraints(
            minimum = source.minimum,
            maximum = source.maximum,
            scale = source.scale,
            maximumCodePoints = source.maximumCodePoints,
            maximumElements = source.maximumElements,
            maximumEntries = source.maximumEntries,
            maximumDepth = source.maximumDepth,
            allowedValues = emptyList(),
        )
        val allowed = ArrayList<ItemDataValue>()
        source.allowedValues.forEachIndexed { index, raw ->
            val decoded = DataValueDecoder.decode(
                source = raw,
                type = type,
                nullable = false,
                constraints = withoutAllowed,
                path = "$path.allowed[$index]",
                diagnostics = diagnostics,
            )
            decoded.value?.let(allowed::add)
        }
        if (allowed.size != allowed.distinct().size) {
            diagnostics.add(CatalogDiagnosticCode.INVALID_CONSTRAINT, "$path.allowed", "Allowed values must not contain duplicates")
        }
        if (diagnostics.size != initialCount) {
            return null
        }
        return CompiledDataConstraints(
            minimum = source.minimum,
            maximum = source.maximum,
            scale = source.scale,
            maximumCodePoints = source.maximumCodePoints,
            maximumElements = source.maximumElements,
            maximumEntries = source.maximumEntries,
            maximumDepth = source.maximumDepth,
            allowedValues = allowed,
        )
    }

    private fun compileItems(
        sources: List<ItemDefinitionSource>,
        schemas: Map<SchemaVersion, DataSchemaDefinition>,
        diagnostics: DiagnosticCollector,
    ): CompiledItemSet {
        val allItemIds = HashSet<ItemKey>()
        val enabledItems = TreeMap<ItemKey, CatalogItemDefinition>()
        val validationItems = TreeMap<ItemKey, CatalogItemDefinition>()
        sources.forEachIndexed { index, source ->
            val path = "items[$index]"
            if (source.sourceFormatVersion != SUPPORTED_SOURCE_FORMAT) {
                diagnostics.add(
                    CatalogDiagnosticCode.INVALID_SCHEMA,
                    "$path.source-format-version",
                    "Unsupported item source format ${source.sourceFormatVersion}",
                )
            }
            val itemKey = diagnostics.parseItemKey(source.id, "$path.id")
            val material = diagnostics.parseItemKey(source.material, "$path.material")
            if (itemKey == null || material == null) {
                return@forEachIndexed
            }
            if (!allItemIds.add(itemKey)) {
                diagnostics.add(CatalogDiagnosticCode.DUPLICATE_ID, path, "Duplicate item definition $itemKey")
                return@forEachIndexed
            }
            val definition = compileItem(source, itemKey, material, path, schemas, diagnostics)
            if (definition != null) {
                validationItems[itemKey] = definition
                if (source.enabled) {
                    enabledItems[itemKey] = definition
                }
            }
        }
        return CompiledItemSet(enabledItems, validationItems)
    }

    private data class CompiledItemSet(
        val enabled: Map<ItemKey, CatalogItemDefinition>,
        val validation: Map<ItemKey, CatalogItemDefinition>,
    )

    private fun validateItemGraph(
        sources: List<ItemDefinitionSource>,
        diagnostics: DiagnosticCollector,
    ) {
        data class Node(val index: Int, val source: ItemDefinitionSource, val key: ItemKey)

        val nodes = TreeMap<ItemKey, Node>()
        sources.forEachIndexed { index, source ->
            val key = runCatching { ItemKey.parse(source.id) }.getOrNull() ?: return@forEachIndexed
            nodes.putIfAbsent(key, Node(index, source, key))
        }
        val edges = TreeMap<ItemKey, List<ItemKey>>()
        nodes.values.forEach { node ->
            if (node.source.contents.size > MAX_CONTENT_ENTRIES) {
                diagnostics.add(
                    CatalogDiagnosticCode.INVALID_CONTENT,
                    "items[${node.index}].contents",
                    "An item may contain at most $MAX_CONTENT_ENTRIES content entries",
                )
            }
            if (node.source.contents.isNotEmpty() && node.source.contentComponent == null) {
                diagnostics.add(
                    CatalogDiagnosticCode.INVALID_CONTENT,
                    "items[${node.index}].contents",
                    "Nested contents require a bundle or container component",
                )
            }
            if (node.source.contents.isEmpty() && node.source.contentComponent != null) {
                diagnostics.add(
                    CatalogDiagnosticCode.INVALID_CONTENT,
                    "items[${node.index}].contents",
                    "A nested content component requires at least one content entry",
                )
            }
            val references = node.source.contents.mapIndexedNotNull { contentIndex, content ->
                val reference = runCatching { ItemKey.parse(content.item) }.getOrNull() ?: return@mapIndexedNotNull null
                val target = nodes[reference]
                if (target == null) {
                    diagnostics.add(
                        CatalogDiagnosticCode.MISSING_REFERENCE,
                        "items[${node.index}].contents[$contentIndex].item",
                        "Item ${node.key} references missing nested item $reference",
                    )
                } else if (node.source.enabled && !target.source.enabled) {
                    diagnostics.add(
                        CatalogDiagnosticCode.INVALID_CONTENT,
                        "items[${node.index}].contents[$contentIndex].item",
                        "Enabled item ${node.key} cannot contain disabled item $reference",
                    )
                }
                reference.takeIf(nodes::containsKey)
            }.distinct().sorted()
            edges[node.key] = references
        }

        val cyclicGroups = stronglyConnectedComponents(nodes.keys, edges).filter { group ->
            group.size > 1 || edges[group.single()].orEmpty().contains(group.single())
        }
        val cyclicNodes = cyclicGroups.flatten().toSet()
        cyclicGroups.sortedBy { it.first() }.forEach { group ->
            val first = nodes.getValue(group.first())
            diagnostics.add(
                CatalogDiagnosticCode.CYCLIC_REFERENCE,
                "items[${first.index}].contents",
                "Nested item reference cycle contains: ${group.joinToString()}",
            )
        }
        if (cyclicNodes.isNotEmpty()) return

        val depthMemo = HashMap<ItemKey, Int>()
        val countMemo = HashMap<ItemKey, Long>()
        fun depth(key: ItemKey): Int = depthMemo.getOrPut(key) {
            1 + (edges[key].orEmpty().maxOfOrNull(::depth) ?: 0)
        }
        fun count(key: ItemKey): Long = countMemo.getOrPut(key) {
            val node = nodes.getValue(key)
            var total = 1L
            node.source.contents.forEach { content ->
                val child = runCatching { ItemKey.parse(content.item) }.getOrNull()
                if (child != null && child in nodes) {
                    total = saturatingAdd(total, saturatingMultiply(content.amount.toLong().coerceAtLeast(0), count(child)))
                }
            }
            total
        }
        nodes.values.forEach { node ->
            val nestedDepth = depth(node.key)
            if (nestedDepth > MAX_CONTENT_DEPTH) {
                diagnostics.add(
                    CatalogDiagnosticCode.INVALID_CONTENT,
                    "items[${node.index}].contents",
                    "Nested item depth $nestedDepth exceeds the limit of $MAX_CONTENT_DEPTH",
                )
            }
            val nestedCount = count(node.key)
            if (nestedCount > MAX_CONTENT_ITEMS) {
                diagnostics.add(
                    CatalogDiagnosticCode.INVALID_CONTENT,
                    "items[${node.index}].contents",
                    "Nested item count exceeds the limit of $MAX_CONTENT_ITEMS",
                )
            }
        }
    }

    private fun stronglyConnectedComponents(
        keys: Set<ItemKey>,
        edges: Map<ItemKey, List<ItemKey>>,
    ): List<List<ItemKey>> {
        var nextIndex = 0
        val indexes = HashMap<ItemKey, Int>()
        val lowLinks = HashMap<ItemKey, Int>()
        val stack = ArrayDeque<ItemKey>()
        val onStack = HashSet<ItemKey>()
        val groups = ArrayList<List<ItemKey>>()

        fun visit(key: ItemKey) {
            indexes[key] = nextIndex
            lowLinks[key] = nextIndex
            nextIndex++
            stack.addLast(key)
            onStack += key
            edges[key].orEmpty().forEach { child ->
                if (child !in indexes) {
                    visit(child)
                    lowLinks[key] = minOf(lowLinks.getValue(key), lowLinks.getValue(child))
                } else if (child in onStack) {
                    lowLinks[key] = minOf(lowLinks.getValue(key), indexes.getValue(child))
                }
            }
            if (lowLinks.getValue(key) == indexes.getValue(key)) {
                val group = ArrayList<ItemKey>()
                do {
                    val member = stack.removeLast()
                    onStack -= member
                    group += member
                } while (member != key)
                groups += group.sorted()
            }
        }
        keys.sorted().forEach { key -> if (key !in indexes) visit(key) }
        return groups
    }

    private fun saturatingAdd(left: Long, right: Long): Long =
        if (left >= CONTENT_COUNT_SENTINEL - right) CONTENT_COUNT_SENTINEL else left + right

    private fun saturatingMultiply(left: Long, right: Long): Long =
        if (left == 0L || right == 0L) 0L
        else if (left >= CONTENT_COUNT_SENTINEL / right) CONTENT_COUNT_SENTINEL
        else left * right

    private fun compileItem(
        source: ItemDefinitionSource,
        itemKey: ItemKey,
        material: ItemKey,
        path: String,
        schemas: Map<SchemaVersion, DataSchemaDefinition>,
        diagnostics: DiagnosticCollector,
    ): CatalogItemDefinition? {
        val initialCount = diagnostics.size
        val schemaVersions = TreeMap<ItemKey, Int>()
        val keys = TreeMap<DataKey, DataKeyDefinition>()
        source.instance.schemas.forEachIndexed { index, reference ->
            val referencePath = "$path.instance.schemas[$index]"
            val schemaId = diagnostics.parseItemKey(reference.id, "$referencePath.id") ?: return@forEachIndexed
            if (schemaId.toString().length > CanonicalStorageLimits.MAX_KEY_LENGTH) {
                diagnostics.add(
                    CatalogDiagnosticCode.BUDGET_EXCEEDED,
                    "$referencePath.id",
                    "Canonical schema keys cannot exceed ${CanonicalStorageLimits.MAX_KEY_LENGTH} characters",
                )
            }
            if (reference.version <= 0) {
                diagnostics.add(CatalogDiagnosticCode.INVALID_SCHEMA, "$referencePath.version", "Schema version must be positive")
                return@forEachIndexed
            }
            if (schemaVersions.putIfAbsent(schemaId, reference.version) != null) {
                diagnostics.add(CatalogDiagnosticCode.DUPLICATE_ID, referencePath, "Schema $schemaId is referenced more than once")
                return@forEachIndexed
            }
            val schema = schemas[SchemaVersion(schemaId, reference.version)]
            if (schema == null) {
                diagnostics.add(
                    CatalogDiagnosticCode.MISSING_REFERENCE,
                    referencePath,
                    "Missing data schema $schemaId@${reference.version}",
                )
                return@forEachIndexed
            }
            schema.keys.forEach { (key, definition) ->
                if (keys.putIfAbsent(key, definition) != null) {
                    diagnostics.add(
                        CatalogDiagnosticCode.DUPLICATE_ID,
                        referencePath,
                        "Data key $key is defined by more than one referenced schema",
                    )
                }
            }
        }
        if (schemaVersions.size > CanonicalStorageLimits.MAX_SCHEMA_ENTRIES) {
            diagnostics.add(
                CatalogDiagnosticCode.BUDGET_EXCEEDED,
                "$path.instance.schemas",
                "Canonical items cannot reference more than ${CanonicalStorageLimits.MAX_SCHEMA_ENTRIES} schemas",
            )
        }
        if (keys.size > CanonicalStorageLimits.MAX_COMPOUND_ENTRIES) {
            diagnostics.add(
                CatalogDiagnosticCode.BUDGET_EXCEEDED,
                "$path.instance.schemas",
                "Canonical items cannot aggregate more than ${CanonicalStorageLimits.MAX_COMPOUND_ENTRIES} data keys",
            )
        }
        keys.keys.filter { it.toString().length > CanonicalStorageLimits.MAX_KEY_LENGTH }.forEach { key ->
            diagnostics.add(
                CatalogDiagnosticCode.BUDGET_EXCEEDED,
                "$path.instance.schemas",
                "Canonical data key $key exceeds ${CanonicalStorageLimits.MAX_KEY_LENGTH} characters",
            )
        }

        when (source.instance.mode) {
            ItemInstanceMode.FUNGIBLE -> if (source.instance.idGenerator != null) {
                diagnostics.add(
                    CatalogDiagnosticCode.INVALID_INSTANCE_MODE,
                    "$path.instance.id-generator",
                    "Fungible items must not generate instance IDs",
                )
            }

            ItemInstanceMode.UNIQUE -> if (source.instance.idGenerator != InstanceIdGenerator.UUID_V4) {
                diagnostics.add(
                    CatalogDiagnosticCode.INVALID_INSTANCE_MODE,
                    "$path.instance.id-generator",
                    "Unique items require the UUID_V4 instance ID generator",
                )
            }
        }

        val definitionData = TreeMap<DataKey, ItemDataValue>()
        val instanceDefaults = TreeMap<DataKey, ItemDataValue>()
        keys.values.forEach { definition ->
            if (definition.hasDefault && definition.defaultValue != null) {
                when (definition.scope) {
                    DataScope.DEFINITION -> definitionData[definition.key] = definition.defaultValue
                    DataScope.INSTANCE -> instanceDefaults[definition.key] = definition.defaultValue
                }
            }
        }
        applyAssignments(
            assignments = source.definitionData,
            expectedScope = DataScope.DEFINITION,
            values = definitionData,
            keys = keys,
            path = "$path.definition-data",
            diagnostics = diagnostics,
        )
        val explicitlyDefaulted = applyAssignments(
            assignments = source.instance.defaults,
            expectedScope = DataScope.INSTANCE,
            values = instanceDefaults,
            keys = keys,
            path = "$path.instance.defaults",
            diagnostics = diagnostics,
        )
        val generators = compileGenerators(
            sources = source.instance.generators,
            explicitlyDefaulted = explicitlyDefaulted,
            keys = keys,
            path = "$path.instance.generate-on-create",
            diagnostics = diagnostics,
        )
        keys.values.forEach { definition ->
            if (definition.scope == DataScope.INSTANCE && !definition.affectsStacking) {
                diagnostics.add(
                    CatalogDiagnosticCode.INVALID_SCHEMA,
                    "$path.instance.schemas",
                    "Instance data key ${definition.key} must affect stacking until merge semantics are defined",
                )
            }
            if (!definition.nullable) {
                val present = when (definition.scope) {
                    DataScope.DEFINITION -> definition.key in definitionData
                    DataScope.INSTANCE -> definition.key in instanceDefaults || definition.key in generators
                }
                if (!present) {
                    diagnostics.add(
                        CatalogDiagnosticCode.INVALID_SCHEMA,
                        "$path.instance",
                        "Required ${definition.scope.name.lowercase()} data key ${definition.key} has no value source",
                    )
                }
            }
        }
        val baseComponents = compileBaseComponents(source.baseComponents, source.instance.mode, path, diagnostics)
        val contents = compileContents(source.contents, path, diagnostics)

        if (diagnostics.size != initialCount) {
            return null
        }
        return CatalogItemDefinition(
            key = itemKey,
            material = material,
            instanceMode = source.instance.mode,
            instanceIdGenerator = source.instance.idGenerator,
            schemaVersions = schemaVersions,
            definitionData = definitionData,
            instanceDefaults = instanceDefaults,
            dataKeys = keys,
            generators = generators,
            baseComponents = baseComponents,
            contentComponent = source.contentComponent,
            contents = contents,
        )
    }

    private fun compileBaseComponents(
        sources: List<BaseItemComponentSource>,
        instanceMode: ItemInstanceMode,
        path: String,
        diagnostics: DiagnosticCollector,
    ): List<BaseItemComponent> {
        val components = TreeMap<ItemKey, BaseItemComponent>()
        sources.forEachIndexed { index, source ->
            val componentPath = "$path.base.components[$index]"
            val id = diagnostics.parseItemKey(source.id, "$componentPath.id") ?: return@forEachIndexed
            if (components.containsKey(id)) {
                diagnostics.add(CatalogDiagnosticCode.DUPLICATE_ID, componentPath, "Duplicate base component $id")
                return@forEachIndexed
            }
            compileBaseComponent(id, source.value, "$componentPath.value", diagnostics)?.let { components[id] = it }
        }

        val maxStackSize = components.values.filterIsInstance<BaseItemComponent.MaxStackSize>().singleOrNull()?.value
        val maxDamage = components.values.filterIsInstance<BaseItemComponent.MaxDamage>().singleOrNull()?.value
        val damage = components.values.filterIsInstance<BaseItemComponent.Damage>().singleOrNull()?.value
        if (maxStackSize != null && maxStackSize > 1 && maxDamage != null) {
            diagnostics.add(
                CatalogDiagnosticCode.INVALID_COMPONENT,
                "$path.base.components",
                "minecraft:max_stack_size greater than one cannot be combined with minecraft:max_damage",
            )
        }
        if (damage != null && maxDamage != null && damage > maxDamage) {
            diagnostics.add(
                CatalogDiagnosticCode.INVALID_COMPONENT,
                "$path.base.components",
                "minecraft:damage must not exceed minecraft:max_damage",
            )
        }
        if (instanceMode == ItemInstanceMode.UNIQUE && maxStackSize != null && maxStackSize != 1) {
            diagnostics.add(
                CatalogDiagnosticCode.INVALID_COMPONENT,
                "$path.base.components",
                "Unique items may only override minecraft:max_stack_size to one",
            )
        }
        return immutableList(components.values)
    }

    private fun compileBaseComponent(
        id: ItemKey,
        value: SourceDataValue,
        path: String,
        diagnostics: DiagnosticCollector,
    ): BaseItemComponent? = when (id.toString()) {
        "minecraft:max_stack_size" -> integerComponent(value, path, 1, 99, diagnostics)
            ?.let(BaseItemComponent::MaxStackSize)
        "minecraft:max_damage" -> integerComponent(value, path, 1, Int.MAX_VALUE, diagnostics)
            ?.let(BaseItemComponent::MaxDamage)
        "minecraft:damage" -> integerComponent(value, path, 0, Int.MAX_VALUE, diagnostics)
            ?.let(BaseItemComponent::Damage)
        "minecraft:repair_cost" -> integerComponent(value, path, 0, Int.MAX_VALUE, diagnostics)
            ?.let(BaseItemComponent::RepairCost)
        "minecraft:unbreakable" -> {
            val enabled = when (value) {
                is SourceDataValue.BooleanValue -> value.value
                is SourceDataValue.CompoundValue -> if (value.entries.isEmpty()) true else null
                else -> null
            }
            if (enabled == null) {
                diagnostics.add(CatalogDiagnosticCode.INVALID_COMPONENT, path, "Expected true or an empty mapping")
                null
            } else if (!enabled) {
                diagnostics.add(CatalogDiagnosticCode.INVALID_COMPONENT, path, "Omit minecraft:unbreakable instead of setting it to false")
                null
            } else {
                BaseItemComponent.Unbreakable
            }
        }
        "minecraft:enchantment_glint_override" -> booleanComponent(value, path, diagnostics)
            ?.let(BaseItemComponent::EnchantmentGlintOverride)
        "minecraft:item_model" -> keyComponent(value, path, diagnostics)?.let(BaseItemComponent::ItemModel)
        "minecraft:rarity" -> stringComponent(value, path, diagnostics)?.let { raw ->
            runCatching { VanillaRarity.valueOf(raw.uppercase()) }.getOrElse {
                diagnostics.add(CatalogDiagnosticCode.INVALID_COMPONENT, path, "Rarity must be common, uncommon, rare, or epic")
                null
            }?.let(BaseItemComponent::Rarity)
        }
        "minecraft:custom_model_data" -> compileCustomModelData(value, path, diagnostics)
        "minecraft:food" -> compileFood(value, path, diagnostics)
        "minecraft:use_cooldown" -> compileUseCooldown(value, path, diagnostics)
        "minecraft:consumable" -> compileConsumable(value, path, diagnostics)
        else -> {
            val reserved = id.toString() in RESERVED_BASE_COMPONENTS
            diagnostics.add(
                CatalogDiagnosticCode.INVALID_COMPONENT,
                path,
                if (reserved) "Component $id is owned by Itemerness and cannot be configured as a base component"
                else "Unsupported base component $id",
            )
            null
        }
    }

    private fun compileCustomModelData(
        value: SourceDataValue,
        path: String,
        diagnostics: DiagnosticCollector,
    ): BaseItemComponent.CustomModelData? {
        val entries = compoundComponent(value, path, setOf("floats", "flags", "strings", "colors"), diagnostics) ?: return null
        val floats = listComponent(entries["floats"], "$path.floats", diagnostics)?.mapIndexedNotNull { index, child ->
            numberComponent(
                child,
                "$path.floats[$index]",
                -Float.MAX_VALUE.toDouble(),
                Float.MAX_VALUE.toDouble(),
                diagnostics,
            )?.toFloat()
        }.orEmpty()
        val flags = listComponent(entries["flags"], "$path.flags", diagnostics)?.mapIndexedNotNull { index, child ->
            booleanComponent(child, "$path.flags[$index]", diagnostics)
        }.orEmpty()
        val strings = listComponent(entries["strings"], "$path.strings", diagnostics)?.mapIndexedNotNull { index, child ->
            stringComponent(child, "$path.strings[$index]", diagnostics)?.also { text ->
                if (text.codePointCount(0, text.length) > MAX_COMPONENT_STRING_CODEPOINTS || text.codePoints().anyMatch(Character::isISOControl)) {
                    diagnostics.add(CatalogDiagnosticCode.INVALID_COMPONENT, "$path.strings[$index]", "Custom model strings must be control-free and at most $MAX_COMPONENT_STRING_CODEPOINTS codepoints")
                }
            }?.takeIf { it.codePointCount(0, it.length) <= MAX_COMPONENT_STRING_CODEPOINTS && it.codePoints().noneMatch(Character::isISOControl) }
        }.orEmpty()
        val colors = listComponent(entries["colors"], "$path.colors", diagnostics)?.mapIndexedNotNull { index, child ->
            stringComponent(child, "$path.colors[$index]", diagnostics)?.let { raw ->
                val normalized = raw.removePrefix("#")
                if (!HEX_COLOR.matches(normalized)) {
                    diagnostics.add(CatalogDiagnosticCode.INVALID_COMPONENT, "$path.colors[$index]", "Color must use RRGGBB or #RRGGBB")
                    null
                } else {
                    normalized.toInt(16)
                }
            }
        }.orEmpty()
        if (listOf(floats.size, flags.size, strings.size, colors.size).any { it > MAX_COMPONENT_LIST_SIZE }) {
            diagnostics.add(CatalogDiagnosticCode.INVALID_COMPONENT, path, "Custom model data lists may contain at most $MAX_COMPONENT_LIST_SIZE values each")
            return null
        }
        return BaseItemComponent.CustomModelData(floats, flags, strings, colors)
    }

    private fun compileFood(
        value: SourceDataValue,
        path: String,
        diagnostics: DiagnosticCollector,
    ): BaseItemComponent.Food? {
        val entries = compoundComponent(value, path, setOf("nutrition", "saturation", "can-always-eat"), diagnostics) ?: return null
        val nutrition = integerComponent(entries["nutrition"], "$path.nutrition", 0, Int.MAX_VALUE, diagnostics)
        val saturation = numberComponent(entries["saturation"], "$path.saturation", 0.0, Float.MAX_VALUE.toDouble(), diagnostics)?.toFloat()
        val always = booleanComponent(entries["can-always-eat"], "$path.can-always-eat", diagnostics)
        return if (nutrition != null && saturation != null && always != null) BaseItemComponent.Food(nutrition, saturation, always) else null
    }

    private fun compileUseCooldown(
        value: SourceDataValue,
        path: String,
        diagnostics: DiagnosticCollector,
    ): BaseItemComponent.UseCooldown? {
        val entries = compoundComponent(value, path, setOf("seconds", "cooldown-group"), diagnostics) ?: return null
        val seconds = numberComponent(entries["seconds"], "$path.seconds", Float.MIN_VALUE.toDouble(), Float.MAX_VALUE.toDouble(), diagnostics)?.toFloat()
        val group = entries["cooldown-group"]?.let { keyComponent(it, "$path.cooldown-group", diagnostics) }
        return seconds?.let { BaseItemComponent.UseCooldown(it, group) }
    }

    private fun compileConsumable(
        value: SourceDataValue,
        path: String,
        diagnostics: DiagnosticCollector,
    ): BaseItemComponent.Consumable? {
        val entries = compoundComponent(
            value,
            path,
            setOf("consume-seconds", "animation", "sound", "has-consume-particles"),
            diagnostics,
        ) ?: return null
        val seconds = numberComponent(entries["consume-seconds"], "$path.consume-seconds", 0.0, Float.MAX_VALUE.toDouble(), diagnostics)?.toFloat()
        val animation = stringComponent(entries["animation"], "$path.animation", diagnostics)?.let { raw ->
            runCatching { VanillaUseAnimation.valueOf(raw.uppercase().replace('-', '_')) }.getOrElse {
                diagnostics.add(CatalogDiagnosticCode.INVALID_COMPONENT, "$path.animation", "Unsupported vanilla use animation '$raw'")
                null
            }
        }
        val sound = keyComponent(entries["sound"], "$path.sound", diagnostics)
        val particles = booleanComponent(entries["has-consume-particles"], "$path.has-consume-particles", diagnostics)
        return if (seconds != null && animation != null && sound != null && particles != null) {
            BaseItemComponent.Consumable(seconds, animation, sound, particles)
        } else null
    }

    private fun compileContents(
        sources: List<ItemContentSource>,
        path: String,
        diagnostics: DiagnosticCollector,
    ): List<ItemContentDefinition> = sources.mapIndexedNotNull { index, source ->
        val contentPath = "$path.contents[$index]"
        val item = diagnostics.parseItemKey(source.item, "$contentPath.item")
        if (source.amount !in 1..MAX_CONTENT_AMOUNT) {
            diagnostics.add(CatalogDiagnosticCode.INVALID_CONTENT, "$contentPath.amount", "Content amount must be between 1 and $MAX_CONTENT_AMOUNT")
        }
        if (item != null && source.amount in 1..MAX_CONTENT_AMOUNT) ItemContentDefinition(item, source.amount) else null
    }

    private fun integerComponent(
        value: SourceDataValue?,
        path: String,
        minimum: Int,
        maximum: Int,
        diagnostics: DiagnosticCollector,
    ): Int? {
        val integer = (value as? SourceDataValue.IntegerValue)?.value
        if (integer == null || integer !in minimum.toLong()..maximum.toLong()) {
            diagnostics.add(CatalogDiagnosticCode.INVALID_COMPONENT, path, "Expected an integer between $minimum and $maximum")
            return null
        }
        return integer.toInt()
    }

    private fun booleanComponent(
        value: SourceDataValue?,
        path: String,
        diagnostics: DiagnosticCollector,
    ): Boolean? = (value as? SourceDataValue.BooleanValue)?.value ?: run {
        diagnostics.add(CatalogDiagnosticCode.INVALID_COMPONENT, path, "Expected a boolean")
        null
    }

    private fun stringComponent(
        value: SourceDataValue?,
        path: String,
        diagnostics: DiagnosticCollector,
    ): String? = (value as? SourceDataValue.StringValue)?.value ?: run {
        diagnostics.add(CatalogDiagnosticCode.INVALID_COMPONENT, path, "Expected a string")
        null
    }

    private fun keyComponent(
        value: SourceDataValue?,
        path: String,
        diagnostics: DiagnosticCollector,
    ): ItemKey? = stringComponent(value, path, diagnostics)?.let { diagnostics.parseItemKey(it, path) }

    private fun numberComponent(
        value: SourceDataValue?,
        path: String,
        minimum: Double,
        maximum: Double,
        diagnostics: DiagnosticCollector,
    ): Double? {
        val number = when (value) {
            is SourceDataValue.DecimalValue -> value.value.toDouble()
            is SourceDataValue.IntegerValue -> value.value.toDouble()
            else -> null
        }
        if (number == null || !number.isFinite() || number !in minimum..maximum) {
            diagnostics.add(CatalogDiagnosticCode.INVALID_COMPONENT, path, "Expected a finite number between $minimum and $maximum")
            return null
        }
        return number
    }

    private fun listComponent(
        value: SourceDataValue?,
        path: String,
        diagnostics: DiagnosticCollector,
    ): List<SourceDataValue>? {
        if (value == null) return emptyList()
        return (value as? SourceDataValue.ListValue)?.values ?: run {
            diagnostics.add(CatalogDiagnosticCode.INVALID_COMPONENT, path, "Expected a list")
            null
        }
    }

    private fun compoundComponent(
        value: SourceDataValue,
        path: String,
        allowed: Set<String>,
        diagnostics: DiagnosticCollector,
    ): Map<String, SourceDataValue>? {
        val entries = (value as? SourceDataValue.CompoundValue)?.entries ?: run {
            diagnostics.add(CatalogDiagnosticCode.INVALID_COMPONENT, path, "Expected a mapping")
            return null
        }
        entries.keys.filterNot(allowed::contains).sorted().forEach { unknown ->
            diagnostics.add(CatalogDiagnosticCode.INVALID_COMPONENT, "$path.$unknown", "Unknown component field '$unknown'")
        }
        return entries.takeIf { entries.keys.all(allowed::contains) }
    }

    private fun applyAssignments(
        assignments: List<DataAssignmentSource>,
        expectedScope: DataScope,
        values: MutableMap<DataKey, ItemDataValue>,
        keys: Map<DataKey, DataKeyDefinition>,
        path: String,
        diagnostics: DiagnosticCollector,
    ): Set<DataKey> {
        val assigned = HashSet<DataKey>()
        assignments.forEachIndexed { index, assignment ->
            val assignmentPath = "$path[$index]"
            val key = diagnostics.parseDataKey(assignment.key, "$assignmentPath.key") ?: return@forEachIndexed
            if (!assigned.add(key)) {
                diagnostics.add(CatalogDiagnosticCode.DUPLICATE_ID, assignmentPath, "Data key $key is assigned more than once")
                return@forEachIndexed
            }
            val definition = keys[key]
            if (definition == null) {
                diagnostics.add(CatalogDiagnosticCode.MISSING_REFERENCE, assignmentPath, "Data key $key is not in a referenced schema")
                return@forEachIndexed
            }
            if (definition.scope != expectedScope) {
                diagnostics.add(
                    CatalogDiagnosticCode.INVALID_SCOPE,
                    assignmentPath,
                    "Data key $key has ${definition.scope.name.lowercase()} scope, not ${expectedScope.name.lowercase()} scope",
                )
                return@forEachIndexed
            }
            val decoded = DataValueDecoder.decode(
                source = assignment.value,
                type = definition.type,
                nullable = definition.nullable,
                constraints = definition.constraints,
                path = "$assignmentPath.value",
                diagnostics = diagnostics,
            )
            if (decoded.valid) {
                if (decoded.value == null) {
                    values.remove(key)
                } else {
                    values[key] = decoded.value
                }
            }
        }
        return assigned
    }

    private fun compileGenerators(
        sources: List<DataGeneratorSource>,
        explicitlyDefaulted: Set<DataKey>,
        keys: Map<DataKey, DataKeyDefinition>,
        path: String,
        diagnostics: DiagnosticCollector,
    ): Map<DataKey, CompiledDataGenerator> {
        val generators = TreeMap<DataKey, CompiledDataGenerator>()
        sources.forEachIndexed { index, source ->
            val generatorPath = "$path[$index]"
            val key = diagnostics.parseDataKey(source.key, "$generatorPath.key") ?: return@forEachIndexed
            if (generators.containsKey(key)) {
                diagnostics.add(CatalogDiagnosticCode.DUPLICATE_ID, generatorPath, "Data key $key has more than one generator")
                return@forEachIndexed
            }
            if (key in explicitlyDefaulted) {
                diagnostics.add(
                    CatalogDiagnosticCode.INVALID_GENERATOR,
                    generatorPath,
                    "Data key $key cannot have both an item default and a creation generator",
                )
                return@forEachIndexed
            }
            val definition = keys[key]
            if (definition == null) {
                diagnostics.add(CatalogDiagnosticCode.MISSING_REFERENCE, generatorPath, "Data key $key is not in a referenced schema")
                return@forEachIndexed
            }
            if (definition.scope != DataScope.INSTANCE) {
                diagnostics.add(CatalogDiagnosticCode.INVALID_SCOPE, generatorPath, "Creation generators require instance-scoped data")
                return@forEachIndexed
            }
            val generator = when (source) {
                is DataGeneratorSource.UnixMillis -> compileUnixMillis(definition, generatorPath, diagnostics)
                is DataGeneratorSource.RandomDecimal -> compileRandomDecimal(source, definition, generatorPath, diagnostics)
            }
            if (generator != null) {
                generators[key] = generator
            }
        }
        return generators
    }

    private fun compileUnixMillis(
        definition: DataKeyDefinition,
        path: String,
        diagnostics: DiagnosticCollector,
    ): CompiledDataGenerator? {
        if (definition.type != DataType.LongType) {
            diagnostics.add(CatalogDiagnosticCode.INVALID_GENERATOR, path, "The unix-millis generator requires long data")
            return null
        }
        if (definition.constraints.allowedValues.isNotEmpty()) {
            diagnostics.add(CatalogDiagnosticCode.INVALID_GENERATOR, path, "Generated values cannot use an allowed-value set")
            return null
        }
        return CompiledDataGenerator.UnixMillis
    }

    private fun compileRandomDecimal(
        source: DataGeneratorSource.RandomDecimal,
        definition: DataKeyDefinition,
        path: String,
        diagnostics: DiagnosticCollector,
    ): CompiledDataGenerator? {
        val initialCount = diagnostics.size
        if (definition.type != DataType.DecimalType) {
            diagnostics.add(CatalogDiagnosticCode.INVALID_GENERATOR, path, "The random-decimal generator requires decimal data")
        }
        if (source.minimum >= source.maximum) {
            diagnostics.add(CatalogDiagnosticCode.INVALID_GENERATOR, path, "Random minimum must be less than maximum")
        }
        if (source.scale < 0 || source.scale > MAX_DECIMAL_SCALE) {
            diagnostics.add(
                CatalogDiagnosticCode.INVALID_GENERATOR,
                "$path.scale",
                "Random scale must be between 0 and $MAX_DECIMAL_SCALE",
            )
        }
        if (definition.constraints.scale != null && source.scale > definition.constraints.scale) {
            diagnostics.add(CatalogDiagnosticCode.INVALID_GENERATOR, "$path.scale", "Random scale exceeds the data key scale")
        }
        if (definition.constraints.allowedValues.isNotEmpty()) {
            diagnostics.add(CatalogDiagnosticCode.INVALID_GENERATOR, path, "Generated values cannot use an allowed-value set")
        }
        listOf(source.minimum, source.maximum).forEachIndexed { index, bound ->
            val doubleValue = bound.toDouble()
            if (!doubleValue.isFinite()) {
                diagnostics.add(CatalogDiagnosticCode.INVALID_GENERATOR, path, "Random bounds must be finite")
            } else if (definition.type == DataType.DecimalType) {
                DataValueValidator.validate(definition, DecimalDataValue(doubleValue)).forEach { violation ->
                    diagnostics.add(
                        CatalogDiagnosticCode.INVALID_GENERATOR,
                        "$path.${if (index == 0) "minimum" else "maximum"}",
                        violation,
                    )
                }
            }
        }
        return if (diagnostics.size == initialCount) {
            CompiledDataGenerator.RandomDecimal(source.minimum, source.maximum, source.scale)
        } else {
            null
        }
    }

    private fun validateLimit(
        value: Int?,
        hardMaximum: Int,
        path: String,
        description: String,
        diagnostics: DiagnosticCollector,
    ) {
        if (value != null && value !in 0..hardMaximum) {
            diagnostics.add(
                CatalogDiagnosticCode.INVALID_CONSTRAINT,
                path,
                "$description must be between 0 and $hardMaximum",
            )
        }
    }

    private companion object {
        const val MAX_TYPE_DEPTH = 16
        const val SUPPORTED_SOURCE_FORMAT = 1
        const val MAX_COMPOUND_KEY_LENGTH = 128
        const val MAX_DECIMAL_SCALE = 12
        const val MAX_STRING_CODEPOINTS = 8192
        const val MAX_CONTAINER_ELEMENTS = 256
        const val MAX_VALUE_DEPTH = 16
        const val MAX_COMPONENT_STRING_CODEPOINTS = 256
        const val MAX_COMPONENT_LIST_SIZE = 64
        const val MAX_CONTENT_ENTRIES = 64
        const val MAX_CONTENT_AMOUNT = 99
        const val MAX_CONTENT_DEPTH = 8
        const val MAX_CONTENT_ITEMS = 256L
        const val CONTENT_COUNT_SENTINEL = MAX_CONTENT_ITEMS + 1
        val HEX_COLOR = Regex("[0-9a-fA-F]{6}")
        val RESERVED_BASE_COMPONENTS = setOf(
            "minecraft:custom_data",
            "minecraft:custom_name",
            "minecraft:item_name",
            "minecraft:lore",
            "minecraft:tooltip_display",
            "minecraft:tooltip_style",
            "minecraft:bundle_contents",
            "minecraft:container",
            "minecraft:charged_projectiles",
            "minecraft:use_remainder",
        )

        fun isValidCompoundKey(value: String): Boolean =
            value.isNotBlank() &&
                value.length <= MAX_COMPOUND_KEY_LENGTH &&
                value.codePoints().allMatch { !Character.isISOControl(it) }
    }
}

class CatalogCompilation internal constructor(
    val candidate: CatalogCandidate?,
    diagnostics: Collection<CatalogDiagnostic>,
) {
    val diagnostics: List<CatalogDiagnostic> = java.util.List.copyOf(diagnostics)
    val successful: Boolean get() = candidate != null
}

data class CatalogDiagnostic(
    val code: CatalogDiagnosticCode,
    val path: String,
    val message: String,
)

enum class CatalogDiagnosticCode {
    INVALID_ID,
    DUPLICATE_ID,
    BUDGET_EXCEEDED,
    INVALID_SCHEMA,
    INVALID_CONSTRAINT,
    INVALID_VALUE,
    MISSING_REFERENCE,
    INVALID_SCOPE,
    INVALID_INSTANCE_MODE,
    INVALID_GENERATOR,
    INVALID_COMPONENT,
    INVALID_CONTENT,
    CYCLIC_REFERENCE,
}

private class DiagnosticCollector {
    private val diagnostics = ArrayList<CatalogDiagnostic>()

    val size: Int get() = diagnostics.size

    fun add(code: CatalogDiagnosticCode, path: String, message: String) {
        diagnostics += CatalogDiagnostic(code, path, message)
    }

    fun parseItemKey(value: String, path: String): ItemKey? = try {
        ItemKey.parse(value)
    } catch (exception: IllegalArgumentException) {
        add(CatalogDiagnosticCode.INVALID_ID, path, exception.message ?: "Invalid namespaced key")
        null
    }

    fun parseDataKey(value: String, path: String): DataKey? =
        parseItemKey(value, path)?.let(::DataKey)

    fun snapshot(): List<CatalogDiagnostic> = java.util.List.copyOf(diagnostics)
}

private data class DecodedValue(
    val valid: Boolean,
    val value: ItemDataValue?,
)

private object DataValueDecoder {
    fun decode(
        source: SourceDataValue,
        type: DataType,
        nullable: Boolean,
        constraints: CompiledDataConstraints,
        path: String,
        diagnostics: DiagnosticCollector,
    ): DecodedValue {
        if (source == SourceDataValue.NullValue) {
            return if (nullable) {
                DecodedValue(true, null)
            } else {
                diagnostics.add(CatalogDiagnosticCode.INVALID_VALUE, path, "Null is not allowed")
                DecodedValue(false, null)
            }
        }
        val initialCount = diagnostics.size
        val value = decodeTyped(source, type, path, 0, ValueBudget(), diagnostics)
        if (value != null) {
            DataValueValidator.validate(type, constraints, value).forEach { violation ->
                diagnostics.add(CatalogDiagnosticCode.INVALID_VALUE, path, violation)
            }
        }
        return DecodedValue(diagnostics.size == initialCount, value)
    }

    private fun decodeTyped(
        source: SourceDataValue,
        type: DataType,
        path: String,
        depth: Int,
        budget: ValueBudget,
        diagnostics: DiagnosticCollector,
    ): ItemDataValue? {
        if (!budget.consume() || depth > HARD_VALUE_DEPTH) {
            diagnostics.add(CatalogDiagnosticCode.INVALID_VALUE, path, "Value exceeds the hard structural budget")
            return null
        }
        return when (type) {
            DataType.BooleanType -> (source as? SourceDataValue.BooleanValue)?.let { BooleanDataValue(it.value) }
                ?: typeMismatch(path, "boolean", diagnostics)

            DataType.IntegerType -> {
                val number = (source as? SourceDataValue.IntegerValue)?.value
                    ?: return typeMismatch(path, "integer", diagnostics)
                if (number !in Int.MIN_VALUE.toLong()..Int.MAX_VALUE.toLong()) {
                    diagnostics.add(CatalogDiagnosticCode.INVALID_VALUE, path, "Integer value is outside the 32-bit range")
                    null
                } else {
                    IntegerDataValue(number.toInt())
                }
            }

            DataType.LongType -> (source as? SourceDataValue.IntegerValue)?.let { LongDataValue(it.value) }
                ?: typeMismatch(path, "long", diagnostics)

            DataType.DecimalType -> when (source) {
                is SourceDataValue.DecimalValue -> decimal(source.value, path, diagnostics)
                is SourceDataValue.IntegerValue -> DecimalDataValue(source.value.toDouble())
                else -> typeMismatch(path, "decimal", diagnostics)
            }

            DataType.StringType -> (source as? SourceDataValue.StringValue)?.let { StringDataValue(it.value) }
                ?: typeMismatch(path, "string", diagnostics)

            DataType.UuidType -> decodeUuid(source, path, diagnostics)
            DataType.NamespacedKeyType -> decodeNamespacedKey(source, path, diagnostics)
            is DataType.ListType -> decodeList(source, type, path, depth, budget, diagnostics)
            is DataType.CompoundType -> decodeCompound(source, type, path, depth, budget, diagnostics)
        }
    }

    private fun decodeList(
        source: SourceDataValue,
        type: DataType.ListType,
        path: String,
        depth: Int,
        budget: ValueBudget,
        diagnostics: DiagnosticCollector,
    ): ItemDataValue? {
        val list = source as? SourceDataValue.ListValue ?: return typeMismatch(path, "list", diagnostics)
        if (list.values.size > HARD_CONTAINER_ELEMENTS) {
            diagnostics.add(CatalogDiagnosticCode.INVALID_VALUE, path, "List exceeds the hard element limit")
            return null
        }
        val values = ArrayList<ItemDataValue>(list.values.size)
        list.values.forEachIndexed { index, raw ->
            if (raw == SourceDataValue.NullValue) {
                diagnostics.add(CatalogDiagnosticCode.INVALID_VALUE, "$path[$index]", "Lists cannot contain null values")
            } else {
                decodeTyped(raw, type.element, "$path[$index]", depth + 1, budget, diagnostics)?.let(values::add)
            }
        }
        return if (values.size == list.values.size) ListDataValue(values) else null
    }

    private fun decodeCompound(
        source: SourceDataValue,
        type: DataType.CompoundType,
        path: String,
        depth: Int,
        budget: ValueBudget,
        diagnostics: DiagnosticCollector,
    ): ItemDataValue? {
        val compound = source as? SourceDataValue.CompoundValue ?: return typeMismatch(path, "compound", diagnostics)
        if (compound.entries.size > HARD_CONTAINER_ELEMENTS) {
            diagnostics.add(CatalogDiagnosticCode.INVALID_VALUE, path, "Compound exceeds the hard entry limit")
            return null
        }
        val values = TreeMap<String, ItemDataValue>()
        val fields = type.fields
        if (fields == null) {
            compound.entries.forEach { (name, raw) ->
                if (!isValidCompoundKey(name)) {
                    diagnostics.add(CatalogDiagnosticCode.INVALID_VALUE, "$path.$name", "Invalid compound entry name")
                } else if (raw != SourceDataValue.NullValue) {
                    decodeOpen(raw, "$path.$name", depth + 1, budget, diagnostics)?.let { values[name] = it }
                }
            }
            return CompoundDataValue(values)
        }

        val fieldsByName = fields.associateBy(CompoundFieldSource::name)
        compound.entries.keys.filterNot(fieldsByName::containsKey).forEach { unknown ->
            diagnostics.add(CatalogDiagnosticCode.INVALID_VALUE, "$path.$unknown", "Unknown compound field")
        }
        fields.forEach { field ->
            val raw = compound.entries[field.name]
            if (raw == null || raw == SourceDataValue.NullValue) {
                if (!field.nullable) {
                    diagnostics.add(CatalogDiagnosticCode.INVALID_VALUE, "$path.${field.name}", "Required compound field is missing")
                }
            } else {
                decodeTyped(raw, field.type, "$path.${field.name}", depth + 1, budget, diagnostics)?.let {
                    values[field.name] = it
                }
            }
        }
        return CompoundDataValue(values)
    }

    private fun decodeOpen(
        source: SourceDataValue,
        path: String,
        depth: Int,
        budget: ValueBudget,
        diagnostics: DiagnosticCollector,
    ): ItemDataValue? {
        if (!budget.consume() || depth > HARD_VALUE_DEPTH) {
            diagnostics.add(CatalogDiagnosticCode.INVALID_VALUE, path, "Value exceeds the hard structural budget")
            return null
        }
        return when (source) {
            SourceDataValue.NullValue -> null
            is SourceDataValue.BooleanValue -> BooleanDataValue(source.value)
            is SourceDataValue.IntegerValue -> if (source.value in Int.MIN_VALUE.toLong()..Int.MAX_VALUE.toLong()) {
                IntegerDataValue(source.value.toInt())
            } else {
                LongDataValue(source.value)
            }

            is SourceDataValue.DecimalValue -> decimal(source.value, path, diagnostics)
            is SourceDataValue.StringValue -> StringDataValue(source.value)
            is SourceDataValue.ListValue -> {
                if (source.values.size > HARD_CONTAINER_ELEMENTS) {
                    diagnostics.add(CatalogDiagnosticCode.INVALID_VALUE, path, "List exceeds the hard element limit")
                    return null
                }
                val values = ArrayList<ItemDataValue>(source.values.size)
                source.values.forEachIndexed { index, raw ->
                    if (raw == SourceDataValue.NullValue) {
                        diagnostics.add(CatalogDiagnosticCode.INVALID_VALUE, "$path[$index]", "Lists cannot contain null values")
                    } else {
                        decodeOpen(raw, "$path[$index]", depth + 1, budget, diagnostics)?.let(values::add)
                    }
                }
                if (values.map { it.javaClass }.distinct().size > 1) {
                    diagnostics.add(CatalogDiagnosticCode.INVALID_VALUE, path, "Open compound lists must have one inferred element type")
                }
                if (values.size == source.values.size) ListDataValue(values) else null
            }

            is SourceDataValue.CompoundValue -> {
                if (source.entries.size > HARD_CONTAINER_ELEMENTS) {
                    diagnostics.add(CatalogDiagnosticCode.INVALID_VALUE, path, "Compound exceeds the hard entry limit")
                    return null
                }
                val values = TreeMap<String, ItemDataValue>()
                source.entries.forEach { (name, raw) ->
                    if (!isValidCompoundKey(name)) {
                        diagnostics.add(CatalogDiagnosticCode.INVALID_VALUE, "$path.$name", "Invalid compound entry name")
                    } else if (raw != SourceDataValue.NullValue) {
                        decodeOpen(raw, "$path.$name", depth + 1, budget, diagnostics)?.let { values[name] = it }
                    }
                }
                CompoundDataValue(values)
            }
        }
    }

    private fun decodeUuid(
        source: SourceDataValue,
        path: String,
        diagnostics: DiagnosticCollector,
    ): ItemDataValue? {
        val text = (source as? SourceDataValue.StringValue)?.value ?: return typeMismatch(path, "UUID", diagnostics)
        return try {
            UuidDataValue(UUID.fromString(text))
        } catch (_: IllegalArgumentException) {
            diagnostics.add(CatalogDiagnosticCode.INVALID_VALUE, path, "Invalid UUID: $text")
            null
        }
    }

    private fun decodeNamespacedKey(
        source: SourceDataValue,
        path: String,
        diagnostics: DiagnosticCollector,
    ): ItemDataValue? {
        val text = (source as? SourceDataValue.StringValue)?.value
            ?: return typeMismatch(path, "namespaced key", diagnostics)
        return try {
            NamespacedKeyDataValue(ItemKey.parse(text))
        } catch (exception: IllegalArgumentException) {
            diagnostics.add(CatalogDiagnosticCode.INVALID_VALUE, path, exception.message ?: "Invalid namespaced key")
            null
        }
    }

    private fun decimal(
        value: BigDecimal,
        path: String,
        diagnostics: DiagnosticCollector,
    ): ItemDataValue? {
        val number = value.toDouble()
        if (!number.isFinite()) {
            diagnostics.add(CatalogDiagnosticCode.INVALID_VALUE, path, "Decimal value must be finite")
            return null
        }
        return DecimalDataValue(number)
    }

    private fun typeMismatch(
        path: String,
        expected: String,
        diagnostics: DiagnosticCollector,
    ): ItemDataValue? {
        diagnostics.add(CatalogDiagnosticCode.INVALID_VALUE, path, "Expected $expected data")
        return null
    }

    private class ValueBudget {
        private var remaining = HARD_VALUE_NODES

        fun consume(): Boolean = --remaining >= 0
    }

    private const val HARD_VALUE_NODES = 4096
    private const val HARD_VALUE_DEPTH = 16
    private const val HARD_CONTAINER_ELEMENTS = 256
    private const val MAX_COMPOUND_KEY_LENGTH = 128

    private fun isValidCompoundKey(value: String): Boolean =
        value.isNotBlank() &&
            value.length <= MAX_COMPOUND_KEY_LENGTH &&
            value.codePoints().allMatch { !Character.isISOControl(it) }
}

internal object DataValueValidator {
    fun validate(definition: DataKeyDefinition, value: ItemDataValue): List<String> =
        validate(definition.type, definition.constraints, value)

    fun validate(
        type: DataType,
        constraints: CompiledDataConstraints,
        value: ItemDataValue,
    ): List<String> {
        val physicalFailures = CanonicalStorageValidator.validateValue(value)
        if (physicalFailures.isNotEmpty()) return physicalFailures
        val violations = ArrayList<String>()
        validateType(type, value, 0, ValidationBudget(), violations)
        val number = when (value) {
            is IntegerDataValue -> BigDecimal.valueOf(value.value.toLong())
            is LongDataValue -> BigDecimal.valueOf(value.value)
            is DecimalDataValue -> BigDecimal.valueOf(value.value)
            else -> null
        }
        if (number != null) {
            if (constraints.minimum != null && number < constraints.minimum) {
                violations += "Value is less than the minimum ${constraints.minimum}"
            }
            if (constraints.maximum != null && number > constraints.maximum) {
                violations += "Value is greater than the maximum ${constraints.maximum}"
            }
        }
        if (value is DecimalDataValue && constraints.scale != null) {
            val scale = BigDecimal.valueOf(value.value).stripTrailingZeros().scale().coerceAtLeast(0)
            if (scale > constraints.scale) {
                violations += "Decimal scale $scale exceeds ${constraints.scale}"
            }
        }
        if (value is StringDataValue) {
            val codePoints = value.value.codePointCount(0, value.value.length)
            val maximum = constraints.maximumCodePoints ?: HARD_STRING_CODEPOINTS
            if (codePoints > maximum) {
                violations += "String contains $codePoints codepoints; maximum is $maximum"
            }
        }
        if (value is ListDataValue) {
            val maximum = constraints.maximumElements ?: HARD_CONTAINER_ELEMENTS
            if (value.values.size > maximum) {
                violations += "List contains ${value.values.size} elements; maximum is $maximum"
            }
        }
        if (value is CompoundDataValue) {
            val maximum = constraints.maximumEntries ?: HARD_CONTAINER_ELEMENTS
            if (value.entries.size > maximum) {
                violations += "Compound contains ${value.entries.size} entries; maximum is $maximum"
            }
        }
        if ((value is ListDataValue || value is CompoundDataValue) && constraints.maximumDepth != null) {
            val depth = containerDepth(value)
            if (depth > constraints.maximumDepth) {
                violations += "Value depth $depth exceeds ${constraints.maximumDepth}"
            }
        }
        if (constraints.allowedValues.isNotEmpty() && value !in constraints.allowedValues) {
            violations += "Value is not in the allowed set"
        }
        return violations
    }

    private fun validateType(
        type: DataType,
        value: ItemDataValue,
        depth: Int,
        budget: ValidationBudget,
        violations: MutableList<String>,
    ) {
        if (depth > HARD_VALUE_DEPTH || !budget.consume()) {
            violations += "Value exceeds the hard structural budget"
            return
        }
        if (value is StringDataValue && value.value.codePointCount(0, value.value.length) > HARD_STRING_CODEPOINTS) {
            violations += "String exceeds the hard codepoint limit"
        }
        if (value is ListDataValue && value.values.size > HARD_CONTAINER_ELEMENTS) {
            violations += "List exceeds the hard element limit"
        }
        if (value is CompoundDataValue && value.entries.size > HARD_CONTAINER_ELEMENTS) {
            violations += "Compound exceeds the hard entry limit"
        }
        when (type) {
            DataType.BooleanType -> if (value !is BooleanDataValue) violations += "Expected boolean data"
            DataType.IntegerType -> if (value !is IntegerDataValue) violations += "Expected integer data"
            DataType.LongType -> if (value !is LongDataValue) violations += "Expected long data"
            DataType.DecimalType -> if (value !is DecimalDataValue) violations += "Expected decimal data"
            DataType.StringType -> if (value !is StringDataValue) violations += "Expected string data"
            DataType.UuidType -> if (value !is UuidDataValue) violations += "Expected UUID data"
            DataType.NamespacedKeyType -> if (value !is NamespacedKeyDataValue) violations += "Expected namespaced key data"
            is DataType.ListType -> if (value is ListDataValue) {
                value.values.forEach { validateType(type.element, it, depth + 1, budget, violations) }
            } else {
                violations += "Expected list data"
            }

            is DataType.CompoundType -> if (value is CompoundDataValue) {
                val fields = type.fields
                if (fields == null) {
                    value.entries.values.forEach { validateOpenValue(it, depth + 1, budget, violations) }
                } else {
                    val byName = fields.associateBy(CompoundFieldSource::name)
                    value.entries.filterKeys { it !in byName }.keys.forEach { violations += "Unknown compound field $it" }
                    fields.forEach { field ->
                        val fieldValue = value.entries[field.name]
                        if (fieldValue == null) {
                            if (!field.nullable) violations += "Required compound field ${field.name} is missing"
                        } else {
                            validateType(field.type, fieldValue, depth + 1, budget, violations)
                        }
                    }
                }
            } else {
                violations += "Expected compound data"
            }
        }
    }

    private fun validateOpenValue(
        value: ItemDataValue,
        depth: Int,
        budget: ValidationBudget,
        violations: MutableList<String>,
    ) {
        if (depth > HARD_VALUE_DEPTH || !budget.consume()) {
            violations += "Value exceeds the hard structural budget"
            return
        }
        when (value) {
            is StringDataValue -> if (value.value.codePointCount(0, value.value.length) > HARD_STRING_CODEPOINTS) {
                violations += "String exceeds the hard codepoint limit"
            }

            is ListDataValue -> {
                if (value.values.size > HARD_CONTAINER_ELEMENTS) violations += "List exceeds the hard element limit"
                if (value.values.map { it.javaClass }.distinct().size > 1) {
                    violations += "Open compound lists must have one inferred element type"
                }
                value.values.forEach { validateOpenValue(it, depth + 1, budget, violations) }
            }

            is CompoundDataValue -> {
                if (value.entries.size > HARD_CONTAINER_ELEMENTS) violations += "Compound exceeds the hard entry limit"
                value.entries.values.forEach { validateOpenValue(it, depth + 1, budget, violations) }
            }

            else -> Unit
        }
    }

    private fun containerDepth(value: ItemDataValue): Int = when (value) {
        is ListDataValue -> 1 + (value.values.maxOfOrNull(::containerDepth) ?: 0)
        is CompoundDataValue -> 1 + (value.entries.values.maxOfOrNull(::containerDepth) ?: 0)
        else -> 0
    }

    private const val HARD_STRING_CODEPOINTS = 8192
    private const val HARD_CONTAINER_ELEMENTS = 256
    private const val HARD_VALUE_DEPTH = 16
    private const val HARD_VALUE_NODES = 4096

    private class ValidationBudget {
        private var remaining = HARD_VALUE_NODES

        fun consume(): Boolean = --remaining >= 0
    }
}
