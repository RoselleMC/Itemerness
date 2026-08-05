package com.iroselle.itemerness.nms.v26_1_2

import com.iroselle.itemerness.api.ItemInstanceMode
import com.iroselle.itemerness.api.ItemKey
import com.iroselle.itemerness.api.CompoundDataValue
import com.iroselle.itemerness.api.DataKey
import com.iroselle.itemerness.api.StringDataValue
import com.iroselle.itemerness.bukkit.spi.PendingItemName
import com.iroselle.itemerness.core.catalog.CatalogCompiler
import com.iroselle.itemerness.core.catalog.CanonicalItemInstance
import com.iroselle.itemerness.core.catalog.CatalogSource
import com.iroselle.itemerness.core.catalog.DataAssignmentSource
import com.iroselle.itemerness.core.catalog.DataKeySource
import com.iroselle.itemerness.core.catalog.DataSchemaSource
import com.iroselle.itemerness.core.catalog.DataScope
import com.iroselle.itemerness.core.catalog.DataType
import com.iroselle.itemerness.core.catalog.ItemDefinitionSource
import com.iroselle.itemerness.core.catalog.ItemInstanceSource
import com.iroselle.itemerness.core.catalog.SchemaReferenceSource
import com.iroselle.itemerness.core.catalog.SourceDataValue
import net.minecraft.core.component.DataComponents
import net.minecraft.nbt.CompoundTag
import net.minecraft.resources.Identifier
import net.minecraft.SharedConstants
import net.minecraft.server.Bootstrap
import net.minecraft.core.component.DataComponentMap
import net.minecraft.world.item.component.CustomData
import net.minecraft.world.item.Items
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Test

class NmsCanonicalWriteTest {
    @Test
    fun `creates a clean canonical stack and round trips its bounded data`() {
        val (definition, instance) = definitionAndInstance()
        val codec = NmsCanonicalItemCodec()

        val stack = codec.create(
            definition,
            instance,
            PendingItemName("[example:token]", 0x555555),
            amount = 4,
        )
        val decoded = codec.decode(stack) as CanonicalDecodeResult.Decoded

        assertEquals(4, decoded.snapshot.count)
        assertEquals(ItemKey.parse("example:token"), decoded.snapshot.itemKey)
        assertEquals(0, decoded.snapshot.instanceRevision)
        assertEquals("[example:token]", stack.get(DataComponents.ITEM_NAME)?.string)
        assertNull(stack.get(DataComponents.CUSTOM_NAME))
        assertNull(stack.get(DataComponents.LORE))
        assertNull(stack.get(DataComponents.TOOLTIP_STYLE))
        assertTrue(stack.get(DataComponents.CUSTOM_DATA)?.contains(NmsCanonicalItemCodec.ROOT_KEY) == true)
    }

    @Test
    fun `rewrite preserves foreign custom data but removes canonical presentation`() {
        val (definition, instance) = definitionAndInstance()
        val codec = NmsCanonicalItemCodec()
        val source = codec.create(definition, instance, PendingItemName("[example:token]", 0x555555), 1)
        val custom = source.get(DataComponents.CUSTOM_DATA)?.copyTag() ?: CompoundTag()
        custom.putString("foreign", "kept")
        custom.putString(NmsViewTokenCodec.VIEW_KEY, "stale-internal-state")
        CustomData.set(DataComponents.CUSTOM_DATA, source, custom)
        source.set(DataComponents.CUSTOM_NAME, net.minecraft.network.chat.Component.literal("client-only"))
        source.set(DataComponents.ITEM_MODEL, Identifier.parse("example:catalog-model"))

        val rewritten = codec.rewrite(
            source,
            definition,
            instance,
            PendingItemName("pending example:token", 0xAAAAAA),
        )

        assertEquals("kept", rewritten.get(DataComponents.CUSTOM_DATA)?.copyTag()?.getString("foreign")?.orElseThrow())
        assertFalse(rewritten.get(DataComponents.CUSTOM_DATA)?.contains(NmsViewTokenCodec.VIEW_KEY) == true)
        assertEquals("pending example:token", rewritten.get(DataComponents.ITEM_NAME)?.string)
        assertNull(rewritten.get(DataComponents.CUSTOM_NAME))
        assertEquals("example:catalog-model", rewritten.get(DataComponents.ITEM_MODEL)?.toString())
        assertTrue(source !== rewritten)
        assertEquals("client-only", source.get(DataComponents.CUSTOM_NAME)?.string)
    }

    @Test
    fun `writer rejects values that its bounded decoder could not read`() {
        val source = ItemDefinitionSource(
            id = "example:oversized",
            enabled = true,
            material = "minecraft:paper",
            instance = ItemInstanceSource(
                mode = ItemInstanceMode.FUNGIBLE,
                schemas = listOf(SchemaReferenceSource("example:oversized", 1)),
                defaults = listOf(
                    DataAssignmentSource(
                        "example:payload",
                        SourceDataValue.CompoundValue(
                            mapOf("seed" to SourceDataValue.StringValue("bounded")),
                        ),
                    ),
                ),
            ),
        )
        val schema = DataSchemaSource(
            id = "example:oversized",
            version = 1,
            keys = listOf(
                DataKeySource(
                    id = "example:payload",
                    type = DataType.CompoundType(),
                    scope = DataScope.INSTANCE,
                ),
            ),
        )
        val compilation = CatalogCompiler().compile(CatalogSource(listOf(schema), listOf(source)))
        val snapshot = checkNotNull(compilation.candidate) { compilation.diagnostics.joinToString() }
            .materialize(1)
        val definition = checkNotNull(snapshot.findItem(ItemKey.parse("example:oversized")))
        val validInstance = snapshot.createInstance(definition.key)
        val oversized = CompoundDataValue(
            (0 until 33).associate { index ->
                "value-$index" to StringDataValue("x".repeat(8_192))
            },
        )
        val constructor = CanonicalItemInstance::class.java.declaredConstructors.single { candidate ->
            candidate.parameterCount == 6
        }.also { candidate -> check(candidate.trySetAccessible()) }
        val instance = constructor.newInstance(
            validInstance.itemKey,
            validInstance.createdAgainstRevision,
            validInstance.instanceRevision,
            validInstance.schemaVersions,
            validInstance.instanceId,
            mapOf(DataKey.parse("example:payload") to oversized),
        ) as CanonicalItemInstance

        val failure = assertThrows(IllegalArgumentException::class.java) {
            NmsCanonicalItemCodec().create(
                definition,
                instance,
                PendingItemName("[example:oversized]", 0x555555),
                1,
            )
        }

        assertTrue(failure.message?.contains("UTF-8 byte limit") == true)
    }

    @Test
    fun `fungible instance rejects an injected unique id contract mismatch`() {
        val (definition, instance) = definitionAndInstance()
        val uniqueSource = ItemDefinitionSource(
            id = "example:unique",
            enabled = true,
            material = "minecraft:paper",
            instance = ItemInstanceSource(
                mode = ItemInstanceMode.UNIQUE,
                idGenerator = com.iroselle.itemerness.core.catalog.InstanceIdGenerator.UUID_V4,
                schemas = listOf(SchemaReferenceSource("example:common", 1)),
                defaults = listOf(
                    DataAssignmentSource("example:charges", SourceDataValue.IntegerValue(3)),
                    DataAssignmentSource(
                        "example:tags",
                        SourceDataValue.ListValue(
                            listOf(SourceDataValue.StringValue("example:travel")),
                        ),
                    ),
                ),
            ),
        )
        val compilation = CatalogCompiler().compile(CatalogSource(schemaSources(), listOf(uniqueSource)))
        val uniqueSnapshot = checkNotNull(compilation.candidate).materialize(1)
        val uniqueDefinition = uniqueSnapshot.findItem(ItemKey.parse("example:unique"))!!
        val uniqueInstance = uniqueSnapshot.createInstance(ItemKey.parse("example:unique"))

        assertThrows(IllegalArgumentException::class.java) {
            NmsCanonicalItemCodec().create(
                uniqueDefinition,
                uniqueInstance,
                PendingItemName("[example:unique]", 0x555555),
                2,
            )
        }
        assertFalse(instance.instanceId != null)
    }

    private fun definitionAndInstance(): Pair<com.iroselle.itemerness.api.ItemDefinition, com.iroselle.itemerness.core.catalog.CanonicalItemInstance> {
        val source = ItemDefinitionSource(
            id = "example:token",
            enabled = true,
            material = "minecraft:paper",
            instance = ItemInstanceSource(
                mode = ItemInstanceMode.FUNGIBLE,
                schemas = listOf(SchemaReferenceSource("example:common", 1)),
                defaults = listOf(
                    DataAssignmentSource("example:charges", SourceDataValue.IntegerValue(3)),
                    DataAssignmentSource(
                        "example:tags",
                        SourceDataValue.ListValue(
                            listOf(SourceDataValue.StringValue("example:travel")),
                        ),
                    ),
                ),
            ),
        )
        val compilation = CatalogCompiler().compile(CatalogSource(schemaSources(), listOf(source)))
        val snapshot = checkNotNull(compilation.candidate) {
            compilation.diagnostics.joinToString()
        }.materialize(7)
        return snapshot.findItem(ItemKey.parse("example:token"))!! to
            snapshot.createInstance(ItemKey.parse("example:token"))
    }

    private fun schemaSources(): List<DataSchemaSource> = listOf(
        DataSchemaSource(
            id = "example:common",
            version = 1,
            keys = listOf(
                DataKeySource(
                    id = "example:charges",
                    type = DataType.IntegerType,
                    scope = DataScope.INSTANCE,
                ),
                DataKeySource(
                    id = "example:tags",
                    type = DataType.ListType(DataType.NamespacedKeyType),
                    scope = DataScope.INSTANCE,
                ),
            ),
        ),
    )

    companion object {
        @JvmStatic
        @BeforeAll
        fun bootstrapRegistries() {
            SharedConstants.tryDetectVersion()
            Bootstrap.bootStrap()
            Items.PAPER.builtInRegistryHolder().bindComponents(
                DataComponentMap.builder()
                    .set(DataComponents.MAX_STACK_SIZE, 64)
                    .build(),
            )
        }
    }
}
