package com.iroselle.itemerness.bukkit.catalog

import com.iroselle.itemerness.api.ItemInstanceMode
import com.iroselle.itemerness.api.ItemKey
import com.iroselle.itemerness.bukkit.config.StrictYaml
import com.iroselle.itemerness.bukkit.config.StrictYamlException
import com.iroselle.itemerness.bukkit.config.YamlObject
import com.iroselle.itemerness.core.catalog.CatalogSource
import com.iroselle.itemerness.core.catalog.BaseItemComponentSource
import com.iroselle.itemerness.core.catalog.CompoundFieldSource
import com.iroselle.itemerness.core.catalog.DataAssignmentSource
import com.iroselle.itemerness.core.catalog.DataConstraintsSource
import com.iroselle.itemerness.core.catalog.DataGeneratorSource
import com.iroselle.itemerness.core.catalog.DataKeySource
import com.iroselle.itemerness.core.catalog.DataSchemaSource
import com.iroselle.itemerness.core.catalog.DataScope
import com.iroselle.itemerness.core.catalog.DataType
import com.iroselle.itemerness.core.catalog.InstanceIdGenerator
import com.iroselle.itemerness.core.catalog.ItemDefinitionSource
import com.iroselle.itemerness.core.catalog.ItemContentSource
import com.iroselle.itemerness.core.catalog.ItemInstanceSource
import com.iroselle.itemerness.core.catalog.NestedContentComponent
import com.iroselle.itemerness.core.catalog.SchemaReferenceSource
import com.iroselle.itemerness.core.catalog.SourceDataValue
import java.math.BigDecimal
import java.math.BigInteger
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path
import java.util.Collections
import java.util.Locale
import kotlin.io.path.extension

internal class CatalogSourceLoader {
    fun load(dataFolder: Path): LoadedCatalogSource {
        val schemaFiles = yamlFiles(dataFolder.resolve("data-keys"))
        val itemFiles = yamlFiles(dataFolder.resolve("items"))
        val schemas = schemaFiles.map(::parseSchema)
        val parsedItems = itemFiles.flatMap(::parseItemDocument)
        return LoadedCatalogSource(
            source = CatalogSource(schemas, parsedItems.map(ParsedItem::source)),
            dataKeyIntegrations = parseIntegrations(schemaFiles),
            itemDocuments = Collections.unmodifiableMap(
                parsedItems.associateTo(LinkedHashMap()) { item -> item.key to item.document },
            ),
        )
    }

    private fun yamlFiles(root: Path): List<Path> {
        if (!Files.isDirectory(root, LinkOption.NOFOLLOW_LINKS)) {
            throw StrictYamlException("Catalog directory does not exist or is not a directory: $root")
        }
        val files = Files.walk(root).use { paths ->
            paths.peek { path ->
                if (path != root && Files.isSymbolicLink(path)) {
                    throw StrictYamlException("Catalog paths must not be symbolic links: $path")
                }
            }.filter { path ->
                Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS) &&
                    path.extension.lowercase() in YAML_EXTENSIONS
            }.sorted().toList()
        }
        if (files.size > MAX_FILES_PER_DOMAIN) {
            throw StrictYamlException("Catalog directory $root exceeds the file limit")
        }
        val totalBytes = files.sumOf(Files::size)
        if (totalBytes > MAX_BYTES_PER_DOMAIN) {
            throw StrictYamlException("Catalog directory $root exceeds the byte limit")
        }
        return files
    }

    private fun parseSchema(path: Path): DataSchemaSource {
        val root = YamlObject.root(StrictYaml.load(path), path.toString()).rejectUnknown(
            "schema-version",
            "id",
            "keys",
        )
        // In the v1 file contract schema-version is the business version persisted in canonical
        // data. The YAML syntax version is fixed independently by this loader implementation.
        val businessVersion = root.requiredInt("schema-version")
        val id = root.requiredString("id")
        val keys = root.requiredObject("keys")
        return DataSchemaSource(
            id = id,
            version = businessVersion,
            sourceFormatVersion = SUPPORTED_SOURCE_FORMAT,
            keys = keys.keys.map { key -> parseDataKey(key, keys.child(key, keys.raw(key)), path) },
        )
    }

    private fun parseDataKey(
        id: String,
        node: YamlObject,
        source: Path,
    ): DataKeySource {
        node.rejectUnknown(
            "type",
            "scope",
            "nullable",
            "default",
            "affects-stacking",
            "presentation-readable",
            "constraints",
            "read-sources",
            "access",
            "placeholder-api",
        )
        val type = parseType(node.raw("type"), "$source keys.$id.type")
        val scope = when (node.requiredString("scope")) {
            "definition" -> DataScope.DEFINITION
            "instance" -> DataScope.INSTANCE
            else -> throw StrictYamlException("Unsupported data scope for $id in $source")
        }
        validateReadSources(id, type, scope, node.requiredList("read-sources"), source)
        val access = node.requiredObject("access")
        validateAccess(id, scope, access, source)
        validatePlaceholder(
            id,
            type,
            access.requiredString("read"),
            node.requiredObject("placeholder-api"),
            source,
        )

        return DataKeySource(
            id = id,
            type = type,
            scope = scope,
            nullable = node.optionalBoolean("nullable", false),
            defaultValue = if (node.contains("default")) sourceValue(node.raw("default"), "$source keys.$id.default") else null,
            affectsStacking = node.optionalBoolean("affects-stacking", true),
            presentationReadable = node.optionalBoolean("presentation-readable", false),
            constraints = parseConstraints(node.optionalObject("constraints"), "$source keys.$id.constraints"),
        )
    }

    private fun parseType(
        raw: Any?,
        path: String,
    ): DataType = when (raw) {
        is String -> parseTypeName(raw, path)
        is Map<*, *> -> {
            @Suppress("UNCHECKED_CAST")
            val node = YamlObject.root(raw as Map<String, Any?>, path)
            when (node.requiredString("kind")) {
                "list" -> {
                    node.rejectUnknown("kind", "element")
                    DataType.ListType(parseType(node.raw("element"), "$path.element"))
                }

                "compound" -> {
                    node.rejectUnknown("kind", "fields")
                    val fields = node.requiredObject("fields")
                    DataType.CompoundType(
                        fields.keys.map { name ->
                            val field = fields.child(name, fields.raw(name))
                                .rejectUnknown("type", "nullable")
                            CompoundFieldSource(
                                name = name,
                                type = parseType(field.raw("type"), "$path.fields.$name.type"),
                                nullable = field.optionalBoolean("nullable", false),
                            )
                        },
                    )
                }

                else -> throw StrictYamlException("Unsupported data type kind at $path")
            }
        }

        else -> throw StrictYamlException("Data type at $path must be a string or mapping")
    }

    private fun parseTypeName(
        value: String,
        path: String,
    ): DataType {
        if (value.startsWith("list<") && value.endsWith('>')) {
            val inner = value.substring(5, value.length - 1)
            if (inner.isBlank()) throw StrictYamlException("List element type is missing at $path")
            return DataType.ListType(parseTypeName(inner, "$path.element"))
        }
        return when (value) {
            "boolean" -> DataType.BooleanType
            "integer" -> DataType.IntegerType
            "long" -> DataType.LongType
            "decimal" -> DataType.DecimalType
            "string" -> DataType.StringType
            "uuid" -> DataType.UuidType
            "namespaced-key" -> DataType.NamespacedKeyType
            "compound" -> DataType.CompoundType()
            else -> throw StrictYamlException("Unsupported data type '$value' at $path")
        }
    }

    private fun parseConstraints(
        node: YamlObject?,
        path: String,
    ): DataConstraintsSource {
        if (node == null) return DataConstraintsSource()
        node.rejectUnknown(
            "minimum",
            "maximum",
            "scale",
            "maximum-codepoints",
            "maximum-elements",
            "maximum-entries",
            "maximum-depth",
            "allowed",
        )
        return DataConstraintsSource(
            minimum = node.raw("minimum")?.let { decimal(it, "$path.minimum") },
            maximum = node.raw("maximum")?.let { decimal(it, "$path.maximum") },
            scale = node.optionalInt("scale"),
            maximumCodePoints = node.optionalInt("maximum-codepoints"),
            maximumElements = node.optionalInt("maximum-elements"),
            maximumEntries = node.optionalInt("maximum-entries"),
            maximumDepth = node.optionalInt("maximum-depth"),
            allowedValues = node.optionalList("allowed")
                ?.mapIndexed { index, value -> sourceValue(value, "$path.allowed[$index]") }
                .orEmpty(),
        )
    }

    private fun validateReadSources(
        id: String,
        type: DataType,
        scope: DataScope,
        sources: List<Any?>,
        source: Path,
    ) {
        if (sources.isEmpty()) throw StrictYamlException("read-sources for $id in $source must not be empty")
        val expectedFirst = if (scope == DataScope.DEFINITION) "catalog-definition" else "canonical-nbt"
        if (sources.first() != expectedFirst) {
            throw StrictYamlException("read-sources for $id in $source must start with $expectedFirst")
        }
        val pdcKeys = LinkedHashSet<ItemKey>()
        sources.forEachIndexed { index, value ->
            when (value) {
                "canonical-nbt",
                "catalog-definition",
                -> if (index != 0 || value != expectedFirst) {
                    throw StrictYamlException(
                        "$value for $id in $source is only valid as the first read source for its matching scope",
                    )
                }

                is Map<*, *> -> {
                    if (scope == DataScope.DEFINITION) {
                        throw StrictYamlException(
                            "Definition-scoped data key $id in $source cannot declare a PDC read source",
                        )
                    }
                    @Suppress("UNCHECKED_CAST")
                    val wrapper = YamlObject.root(value as Map<String, Any?>, "$source keys.$id.read-sources[$index]")
                        .rejectUnknown("pdc")
                    val pdc = wrapper.requiredObject("pdc").rejectUnknown("key", "mode")
                    val pdcKey = ItemKey.parse(pdc.requiredString("key"))
                    if (pdc.requiredString("mode") != "fallback-read-only" || index == 0) {
                        throw StrictYamlException("PDC source for $id in $source must be a non-primary fallback-read-only source")
                    }
                    if (!pdcKeys.add(pdcKey)) {
                        throw StrictYamlException("Duplicate PDC fallback $pdcKey for $id in $source")
                    }
                    if (type is DataType.ListType || type is DataType.CompoundType) {
                        throw StrictYamlException("PDC fallback for complex data key $id in $source is not supported")
                    }
                }

                else -> throw StrictYamlException("Unsupported read source for $id in $source")
            }
        }
    }

    private fun validateAccess(
        id: String,
        scope: DataScope,
        access: YamlObject,
        source: Path,
    ) {
        access.rejectUnknown("read", "write")
        if (access.requiredString("read") !in READ_POLICIES) {
            throw StrictYamlException("Unsupported read access for $id in $source")
        }
        val writers = access.requiredList("write")
        if (writers.isEmpty()) {
            throw StrictYamlException("Write principals for $id in $source must not be empty")
        }
        val normalizedWriters = LinkedHashSet<String>()
        writers.forEachIndexed { index, writer ->
            if (writer !is String || writer.isBlank()) {
                throw StrictYamlException("Write principal $index for $id in $source must be a non-blank string")
            }
            val normalized = when {
                writer == "internal" -> {
                    if (scope != DataScope.INSTANCE) {
                        throw StrictYamlException(
                            "Write principal 'internal' for definition-scoped data key $id in $source is incompatible with its scope",
                        )
                    }
                    writer
                }

                writer == "definition" -> {
                    if (scope != DataScope.DEFINITION) {
                        throw StrictYamlException(
                            "Write principal 'definition' for instance-scoped data key $id in $source is incompatible with its scope",
                        )
                    }
                    writer
                }

                writer.startsWith("plugin:") -> {
                    if (scope != DataScope.INSTANCE) {
                        throw StrictYamlException(
                            "Plugin write principal '$writer' for definition-scoped data key $id in $source is incompatible with its scope",
                        )
                    }
                    val pluginName = writer.substringAfter(':')
                    if (pluginName.length !in 1..MAX_PLUGIN_NAME_LENGTH || !PLUGIN_NAME_PATTERN.matches(pluginName)) {
                        throw StrictYamlException("Malformed plugin write principal '$writer' for $id in $source")
                    }
                    "plugin:${pluginName.lowercase(Locale.ROOT)}"
                }

                else -> throw StrictYamlException("Unknown write principal '$writer' for $id in $source")
            }
            if (!normalizedWriters.add(normalized)) {
                throw StrictYamlException("Duplicate write principal '$writer' for $id in $source")
            }
        }
    }

    private fun validatePlaceholder(
        id: String,
        type: DataType,
        readAccess: String,
        placeholder: YamlObject,
        source: Path,
    ) {
        placeholder.rejectUnknown("exposed", "formatter")
        val exposed = placeholder.requiredBoolean("exposed")
        placeholder.optionalString("formatter")?.let { ItemKey.parse(it) }
        if (exposed && (type is DataType.ListType || type is DataType.CompoundType)) {
            throw StrictYamlException("Complex data key $id in $source cannot be exposed through PlaceholderAPI")
        }
        if (exposed && readAccess != "public") {
            throw StrictYamlException("Non-public data key $id in $source cannot be exposed through PlaceholderAPI")
        }
    }

    private fun parseItemDocument(path: Path): List<ParsedItem> {
        val root = YamlObject.root(StrictYaml.load(path), path.toString()).rejectUnknown(
            "schema-version",
            "namespace",
            "items",
        )
        val sourceVersion = root.requiredInt("schema-version")
        val namespace = root.requiredString("namespace")
        ItemKey(namespace, "validation")
        val items = root.requiredObject("items")
        return items.keys.map { localId ->
            val id = if (':' in localId) localId else "$namespace:$localId"
            val key = ItemKey.parse(id)
            val node = items.child(localId, items.raw(localId)).rejectUnknown(
                "enabled",
                "base",
                "definition-data",
                "instance",
                "contents",
                "presentation",
            )
            val base = node.requiredObject("base").rejectUnknown("material", "components")
            val material = base.requiredString("material")
            val components = base.optionalObject("components")?.let { componentValues ->
                componentValues.keys.map { componentId ->
                    BaseItemComponentSource(
                        id = componentId,
                        value = sourceValue(componentValues.raw(componentId), "$path items.$localId.base.components.$componentId"),
                    )
                }
            }.orEmpty()
            val definitionData = assignments(node.optionalObject("definition-data"), "$path items.$localId.definition-data")
            val instance = parseInstance(node.requiredObject("instance"), "$path items.$localId.instance")
            val contents = parseContents(node.optionalList("contents"), "$path items.$localId.contents")
            node.requiredObject("presentation")
            @Suppress("UNCHECKED_CAST")
            ParsedItem(
                key = key,
                source = ItemDefinitionSource(
                    id = id,
                    enabled = node.requiredBoolean("enabled"),
                    material = material,
                    instance = instance,
                    baseComponents = components,
                    contentComponent = inferContentComponent(material, contents, "$path items.$localId.contents"),
                    contents = contents,
                    definitionData = definitionData,
                    sourceFormatVersion = sourceVersion,
                ),
                document = node.rawDocument(),
            )
        }
    }

    private fun parseInstance(
        node: YamlObject,
        path: String,
    ): ItemInstanceSource {
        node.rejectUnknown("mode", "id-generator", "schemas", "defaults", "generate-on-create")
        val mode = when (node.requiredString("mode")) {
            "fungible" -> ItemInstanceMode.FUNGIBLE
            "unique" -> ItemInstanceMode.UNIQUE
            else -> throw StrictYamlException("Unsupported instance mode at $path")
        }
        val idGenerator = when (val value = node.optionalString("id-generator")) {
            null -> null
            "uuid-v4" -> InstanceIdGenerator.UUID_V4
            else -> throw StrictYamlException("Unsupported instance ID generator '$value' at $path")
        }
        val schemas = node.requiredList("schemas").mapIndexed { index, value ->
            val text = value as? String ?: throw StrictYamlException("$path.schemas[$index] must be a string")
            val separator = text.lastIndexOf('@')
            if (separator <= 0 || separator == text.lastIndex) {
                throw StrictYamlException("$path.schemas[$index] must use namespace:key@version")
            }
            val version = text.substring(separator + 1).toIntOrNull()
                ?: throw StrictYamlException("$path.schemas[$index] has an invalid version")
            SchemaReferenceSource(text.substring(0, separator), version)
        }
        val generators = node.optionalObject("generate-on-create")?.let { values ->
            values.keys.map { key ->
                val generator = values.child(key, values.raw(key))
                when (generator.requiredString("generator")) {
                    "unix-millis" -> {
                        generator.rejectUnknown("generator")
                        DataGeneratorSource.UnixMillis(key)
                    }

                    "random-decimal" -> {
                        generator.rejectUnknown("generator", "minimum", "maximum", "scale")
                        DataGeneratorSource.RandomDecimal(
                            key = key,
                            minimum = decimal(generator.raw("minimum"), "$path.generate-on-create.$key.minimum"),
                            maximum = decimal(generator.raw("maximum"), "$path.generate-on-create.$key.maximum"),
                            scale = generator.requiredInt("scale"),
                        )
                    }

                    else -> throw StrictYamlException("Unsupported generator for $key at $path")
                }
            }
        }.orEmpty()
        return ItemInstanceSource(
            mode = mode,
            idGenerator = idGenerator,
            schemas = schemas,
            defaults = assignments(node.optionalObject("defaults"), "$path.defaults"),
            generators = generators,
        )
    }

    private fun assignments(
        values: YamlObject?,
        path: String,
    ): List<DataAssignmentSource> = values?.keys?.map { key ->
        DataAssignmentSource(key, sourceValue(values.raw(key), "$path.$key"))
    }.orEmpty()

    private fun parseContents(
        contents: List<Any?>?,
        path: String,
    ): List<ItemContentSource> = contents?.mapIndexed { index, value ->
        if (value !is Map<*, *>) throw StrictYamlException("$path[$index] must be a mapping")
        @Suppress("UNCHECKED_CAST")
        val content = YamlObject.root(value as Map<String, Any?>, "$path[$index]")
            .rejectUnknown("item", "amount")
        val amount = content.requiredInt("amount")
        if (amount !in 1..99) throw StrictYamlException("$path[$index].amount must be between 1 and 99")
        val item = content.requiredString("item")
        ItemKey.parse(item)
        ItemContentSource(item, amount)
    }.orEmpty()

    private fun inferContentComponent(
        material: String,
        contents: List<ItemContentSource>,
        path: String,
    ): NestedContentComponent? {
        if (contents.isEmpty()) return null
        val key = ItemKey.parse(material)
        if (key.namespace != "minecraft") {
            throw StrictYamlException("Nested contents require a supported minecraft bundle or container material at $path")
        }
        return when {
            key.value == "bundle" || key.value.endsWith("_bundle") -> NestedContentComponent.BUNDLE
            key.value == "shulker_box" || key.value.endsWith("_shulker_box") || key.value in CONTAINER_MATERIALS ->
                NestedContentComponent.CONTAINER
            else -> throw StrictYamlException("Material $material does not support the concise nested contents syntax at $path")
        }
    }

    private fun sourceValue(
        value: Any?,
        path: String,
    ): SourceDataValue = when (value) {
        null -> SourceDataValue.NullValue
        is Boolean -> SourceDataValue.BooleanValue(value)
        is Byte -> SourceDataValue.IntegerValue(value.toLong())
        is Short -> SourceDataValue.IntegerValue(value.toLong())
        is Int -> SourceDataValue.IntegerValue(value.toLong())
        is Long -> SourceDataValue.IntegerValue(value)
        is BigInteger -> value.longValueExactOrNull()?.let(SourceDataValue::IntegerValue)
            ?: throw StrictYamlException("Integer at $path is outside the signed 64-bit range")
        is Float -> SourceDataValue.DecimalValue(decimal(value, path))
        is Double -> SourceDataValue.DecimalValue(decimal(value, path))
        is BigDecimal -> SourceDataValue.DecimalValue(value)
        is String -> SourceDataValue.StringValue(value)
        is List<*> -> SourceDataValue.ListValue(value.mapIndexed { index, child -> sourceValue(child, "$path[$index]") })
        is Map<*, *> -> {
            val entries = LinkedHashMap<String, SourceDataValue>(value.size)
            value.forEach { (key, child) ->
                val name = key as? String ?: throw StrictYamlException("Compound key at $path must be a string")
                entries[name] = sourceValue(child, "$path.$name")
            }
            SourceDataValue.CompoundValue(entries)
        }
        else -> throw StrictYamlException("Unsupported value type ${value.javaClass.name} at $path")
    }

    private fun decimal(
        value: Any?,
        path: String,
    ): BigDecimal = try {
        when (value) {
            is BigDecimal -> value
            is BigInteger -> value.toBigDecimal()
            is Byte,
            is Short,
            is Int,
            is Long,
            is Float,
            is Double,
            -> BigDecimal(value.toString())
            else -> throw NumberFormatException()
        }
    } catch (_: NumberFormatException) {
        throw StrictYamlException("Value at $path must be a finite decimal")
    }

    private fun BigInteger.longValueExactOrNull(): Long? = try {
        longValueExact()
    } catch (_: ArithmeticException) {
        null
    }

    private fun parseIntegrations(paths: List<Path>): Map<ItemKey, DataKeyIntegration> {
        val integrations = LinkedHashMap<ItemKey, DataKeyIntegration>()
        paths.forEach { path ->
            val root = YamlObject.root(StrictYaml.load(path), path.toString())
            val keys = root.requiredObject("keys")
            keys.keys.forEach { rawId ->
                val id = ItemKey.parse(rawId)
                val definition = keys.child(rawId, keys.raw(rawId))
                val readSources = definition.requiredList("read-sources")
                val pdcFallbacks = readSources.mapIndexedNotNull { index, raw ->
                    if (raw !is Map<*, *>) return@mapIndexedNotNull null
                    @Suppress("UNCHECKED_CAST")
                    val wrapper = YamlObject.root(
                        raw as Map<String, Any?>,
                        "$path keys.$rawId.read-sources[$index]",
                    )
                    val pdc = wrapper.requiredObject("pdc")
                    PdcFallbackSource(ItemKey.parse(pdc.requiredString("key")))
                }
                val access = definition.requiredObject("access")
                val readAccess = when (access.requiredString("read")) {
                    "public" -> DataReadAccess.PUBLIC
                    "owner-only" -> DataReadAccess.OWNER_ONLY
                    "internal" -> DataReadAccess.INTERNAL
                    else -> error("Access policy was not validated")
                }
                val writers = access.requiredList("write").map { it as String }.toSet()
                val placeholder = definition.requiredObject("placeholder-api")
                val previous = integrations.put(
                    id,
                    DataKeyIntegration(
                        readAccess = readAccess,
                        writePrincipals = Collections.unmodifiableSet(LinkedHashSet(writers)),
                        pdcFallbacks = java.util.List.copyOf(pdcFallbacks),
                        placeholderExposed = placeholder.requiredBoolean("exposed"),
                        placeholderFormatter = placeholder.optionalString("formatter")?.let(ItemKey::parse),
                    ),
                )
                if (previous != null) {
                    throw StrictYamlException("Data key $id has more than one integration policy")
                }
            }
        }
        return Collections.unmodifiableMap(integrations)
    }

    private data class ParsedItem(
        val key: ItemKey,
        val source: ItemDefinitionSource,
        val document: Map<String, Any?>,
    )

    private companion object {
        val YAML_EXTENSIONS = setOf("yml", "yaml")
        val READ_POLICIES = setOf("public", "owner-only", "internal")
        val CONTAINER_MATERIALS = setOf("chest", "trapped_chest", "barrel")
        val PLUGIN_NAME_PATTERN = Regex("[A-Za-z0-9_.-]+")
        const val SUPPORTED_SOURCE_FORMAT = 1
        const val MAX_PLUGIN_NAME_LENGTH = 64
        const val MAX_FILES_PER_DOMAIN = 1_024
        const val MAX_BYTES_PER_DOMAIN = 16L * 1024L * 1024L
    }
}

internal data class DataKeyIntegration(
    val readAccess: DataReadAccess,
    val writePrincipals: Set<String>,
    val pdcFallbacks: List<PdcFallbackSource>,
    val placeholderExposed: Boolean,
    val placeholderFormatter: ItemKey?,
)

internal enum class DataReadAccess {
    PUBLIC,
    OWNER_ONLY,
    INTERNAL,
}

internal data class PdcFallbackSource(
    val key: ItemKey,
)

internal class LoadedCatalogSource(
    val source: CatalogSource,
    dataKeyIntegrations: Map<ItemKey, DataKeyIntegration>,
    itemDocuments: Map<ItemKey, Map<String, Any?>>,
) {
    val dataKeyIntegrations: Map<ItemKey, DataKeyIntegration> = Collections.unmodifiableMap(LinkedHashMap(dataKeyIntegrations))
    val itemDocuments: Map<ItemKey, Map<String, Any?>> = Collections.unmodifiableMap(LinkedHashMap(itemDocuments))
}

private fun YamlObject.rawDocument(): Map<String, Any?> =
    Collections.unmodifiableMap(keys.associateTo(LinkedHashMap()) { key -> key to raw(key) })
