package com.iroselle.itemerness.nms.v1_21_11

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
import com.iroselle.itemerness.core.catalog.CatalogCompiler
import com.iroselle.itemerness.core.catalog.CatalogSnapshot
import com.iroselle.itemerness.core.catalog.CatalogSource
import com.iroselle.itemerness.core.catalog.CompoundFieldSource
import com.iroselle.itemerness.core.catalog.DataGeneratorSource
import com.iroselle.itemerness.core.catalog.DataKeySource
import com.iroselle.itemerness.core.catalog.DataSchemaSource
import com.iroselle.itemerness.core.catalog.DataScope
import com.iroselle.itemerness.core.catalog.DataType
import com.iroselle.itemerness.core.catalog.InstanceIdGenerator
import com.iroselle.itemerness.core.catalog.ItemDefinitionSource
import com.iroselle.itemerness.core.catalog.ItemInstanceSource
import com.iroselle.itemerness.core.catalog.SchemaReferenceSource
import com.iroselle.itemerness.core.catalog.SourceDataValue
import com.iroselle.itemerness.projection.BooleanProjectionValue
import com.iroselle.itemerness.projection.DecimalProjectionValue
import com.iroselle.itemerness.projection.IntegerProjectionValue
import com.iroselle.itemerness.projection.KeyProjectionValue
import com.iroselle.itemerness.projection.ListProjectionValue
import com.iroselle.itemerness.projection.LongProjectionValue
import com.iroselle.itemerness.projection.ProjectionCompound
import com.iroselle.itemerness.projection.ProjectionValue
import com.iroselle.itemerness.projection.StringProjectionValue
import com.iroselle.itemerness.projection.UuidProjectionValue
import java.math.BigDecimal
import java.nio.file.Files
import java.nio.file.Path
import net.minecraft.SharedConstants
import net.minecraft.core.RegistryAccess
import net.minecraft.core.component.DataComponentMap
import net.minecraft.core.registries.BuiltInRegistries
import net.minecraft.nbt.CompoundTag
import net.minecraft.nbt.ListTag
import net.minecraft.nbt.NbtOps
import net.minecraft.nbt.TagParser
import net.minecraft.server.Bootstrap
import net.minecraft.world.item.ItemStack
import net.minecraft.world.item.Items
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertInstanceOf
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Test

class NmsBundledCanonicalItemsTest {
    @Test
    fun `bundled SNBT parses through the direct codec and restores against its schema`() {
        val source = bundledCanonicalItems()
        val parsed = TagParser.create(NbtOps.INSTANCE).parseFully(source)
        val stacks = assertInstanceOf(ListTag::class.java, parsed)
        val catalog = catalog()
        val codec = NmsCanonicalItemCodec()

        assertEquals(2, stacks.size)
        stacks.forEach { encoded ->
            val stack = ItemStack.CODEC
                .parse(OPS, assertInstanceOf(CompoundTag::class.java, encoded))
                .result()
                .orElseThrow()
            val decoded = assertInstanceOf(CanonicalDecodeResult.Decoded::class.java, codec.decode(stack)).snapshot
            val data = decoded.data.entries.associate { entry ->
                val key = DataKey.parse(entry.key)
                val definition = requireNotNull(catalog.dataKeyDefinition(decoded.itemKey, key))
                key to toDomainValue(entry.value, definition.type)
            }

            val restored = catalog.restoreInstance(
                itemKey = decoded.itemKey,
                createdAgainstRevision = decoded.createdAgainstRevision,
                instanceRevision = decoded.instanceRevision,
                schemaVersions = decoded.dataSchemas.entries.associate { it.schemaKey to it.version },
                instanceId = decoded.instanceId,
                data = data,
            )

            assertEquals("[${decoded.itemKey}]", decoded.pendingName)
            assertEquals(decoded.itemKey, restored.itemKey)
            assertTrue(
                restored.data.keys.containsAll(REQUIRED_INSTANCE_KEYS),
                "${decoded.itemKey} did not persist every non-nullable schema key",
            )
        }
    }

    private fun catalog(): CatalogSnapshot {
        val source = CatalogSource(
            schemas = listOf(commonSchema()),
            items = listOf(
                item("itemerness:travel-token", "minecraft:paper", ItemInstanceMode.FUNGIBLE),
                item("itemerness:ember-blade", "minecraft:netherite_sword", ItemInstanceMode.UNIQUE),
            ),
        )
        val compilation = CatalogCompiler().compile(source)
        assertTrue(compilation.successful, compilation.diagnostics.joinToString())
        return requireNotNull(compilation.candidate).materialize(1)
    }

    private fun item(id: String, material: String, mode: ItemInstanceMode): ItemDefinitionSource =
        ItemDefinitionSource(
            id = id,
            enabled = true,
            material = material,
            instance = ItemInstanceSource(
                mode = mode,
                idGenerator = if (mode == ItemInstanceMode.UNIQUE) InstanceIdGenerator.UUID_V4 else null,
                schemas = listOf(SchemaReferenceSource(COMMON_SCHEMA.toString(), 1)),
                generators = listOf(DataGeneratorSource.UnixMillis("itemerness:created-at")),
            ),
        )

    private fun commonSchema(): DataSchemaSource = DataSchemaSource(
        id = COMMON_SCHEMA.toString(),
        version = 1,
        keys = listOf(
            DataKeySource("itemerness:created-at", DataType.LongType, DataScope.INSTANCE),
            DataKeySource(
                "example:quality",
                DataType.NamespacedKeyType,
                DataScope.INSTANCE,
                nullable = true,
                defaultValue = SourceDataValue.StringValue("example:common"),
            ),
            DataKeySource(
                "example:attack-damage",
                DataType.DecimalType,
                DataScope.INSTANCE,
                defaultValue = SourceDataValue.DecimalValue(BigDecimal.ONE),
            ),
            DataKeySource(
                "example:required-level",
                DataType.IntegerType,
                DataScope.DEFINITION,
                defaultValue = SourceDataValue.IntegerValue(1),
                affectsStacking = false,
            ),
            DataKeySource(
                "example:bound",
                DataType.BooleanType,
                DataScope.INSTANCE,
                defaultValue = SourceDataValue.BooleanValue(false),
            ),
            DataKeySource("example:bound-player", DataType.UuidType, DataScope.INSTANCE, nullable = true),
            DataKeySource(
                "example:charges",
                DataType.IntegerType,
                DataScope.INSTANCE,
                defaultValue = SourceDataValue.IntegerValue(0),
            ),
            DataKeySource("example:region", DataType.NamespacedKeyType, DataScope.INSTANCE, nullable = true),
            DataKeySource("example:custom-label", DataType.StringType, DataScope.INSTANCE, nullable = true),
            DataKeySource(
                "example:tags",
                DataType.ListType(DataType.NamespacedKeyType),
                DataScope.INSTANCE,
                defaultValue = SourceDataValue.ListValue(emptyList()),
            ),
            DataKeySource(
                "example:sockets",
                DataType.ListType(
                    DataType.CompoundType(
                        listOf(
                            CompoundFieldSource("type", DataType.NamespacedKeyType),
                            CompoundFieldSource("accepted", DataType.ListType(DataType.NamespacedKeyType)),
                            CompoundFieldSource("inserted", DataType.NamespacedKeyType, nullable = true),
                        ),
                    ),
                ),
                DataScope.INSTANCE,
                defaultValue = SourceDataValue.ListValue(emptyList()),
            ),
            DataKeySource(
                "example:metadata",
                DataType.CompoundType(),
                DataScope.INSTANCE,
                defaultValue = SourceDataValue.CompoundValue(emptyMap()),
            ),
        ),
    )

    private fun toDomainValue(value: ProjectionValue, type: DataType): ItemDataValue = when (type) {
        DataType.BooleanType -> BooleanDataValue((value as BooleanProjectionValue).value)
        DataType.IntegerType -> IntegerDataValue((value as IntegerProjectionValue).value)
        DataType.LongType -> LongDataValue((value as LongProjectionValue).value)
        DataType.DecimalType -> DecimalDataValue((value as DecimalProjectionValue).value.toDouble())
        DataType.StringType -> StringDataValue((value as StringProjectionValue).value)
        DataType.UuidType -> UuidDataValue((value as UuidProjectionValue).value)
        DataType.NamespacedKeyType -> NamespacedKeyDataValue(
            when (value) {
                is KeyProjectionValue -> value.value
                is StringProjectionValue -> ItemKey.parse(value.value)
                else -> error("Expected a namespaced key, got ${value::class.simpleName}")
            },
        )
        is DataType.ListType -> ListDataValue(
            (value as ListProjectionValue).values.map { element -> toDomainValue(element, type.element) },
        )
        is DataType.CompoundType -> {
            val fields = type.fields?.associateBy(CompoundFieldSource::name)
            CompoundDataValue(
                (value as ProjectionCompound).entries.associate { entry ->
                    val field = requireNotNull(fields?.get(entry.key)) {
                        "Open compounds in the bundled examples must be empty"
                    }
                    entry.key to toDomainValue(entry.value, field.type)
                },
            )
        }
    }

    private fun bundledCanonicalItems(): String {
        var current = Path.of("").toAbsolutePath().normalize()
        repeat(8) {
            val candidate = current.resolve(BUNDLED_EXAMPLES_PATH)
            if (Files.isRegularFile(candidate)) return Files.readString(candidate)
            current = current.parent ?: error("Cannot locate repository root from ${Path.of("").toAbsolutePath()}")
        }
        error("Cannot locate the bundled canonical ItemStack examples: $BUNDLED_EXAMPLES_PATH")
    }

    private companion object {
        val COMMON_SCHEMA: ItemKey = ItemKey.parse("itemerness:common")
        const val BUNDLED_EXAMPLES_PATH =
            "itemerness-bukkit/src/main/resources/examples/canonical-items.snbt"
        val REQUIRED_INSTANCE_KEYS: Set<DataKey> = setOf(
            DataKey.parse("itemerness:created-at"),
            DataKey.parse("example:attack-damage"),
            DataKey.parse("example:bound"),
            DataKey.parse("example:charges"),
            DataKey.parse("example:tags"),
            DataKey.parse("example:sockets"),
            DataKey.parse("example:metadata"),
        )
        lateinit var REGISTRY_ACCESS: RegistryAccess
        val OPS get() = REGISTRY_ACCESS.createSerializationContext(NbtOps.INSTANCE)

        @JvmStatic
        @BeforeAll
        fun bootstrapMinecraft() {
            SharedConstants.tryDetectVersion()
            Bootstrap.bootStrap()
            REGISTRY_ACCESS = RegistryAccess.fromRegistryOfRegistries(BuiltInRegistries.REGISTRY)
        }
    }
}
