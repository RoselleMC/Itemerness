package com.iroselle.itemerness.bukkit.catalog

import com.iroselle.itemerness.api.ItemDefinition
import com.iroselle.itemerness.api.ItemInstanceMode
import com.iroselle.itemerness.api.ItemKey
import com.iroselle.itemerness.bukkit.spi.BukkitCanonicalBridgeDescriptor
import com.iroselle.itemerness.bukkit.spi.BukkitCanonicalItemBridge
import com.iroselle.itemerness.bukkit.spi.CanonicalItemInspection
import com.iroselle.itemerness.bukkit.spi.PendingItemName
import com.iroselle.itemerness.core.catalog.BaseItemComponent
import com.iroselle.itemerness.core.catalog.BaseItemComponentSource
import com.iroselle.itemerness.core.catalog.CanonicalItemInstance
import com.iroselle.itemerness.core.catalog.CatalogCompiler
import com.iroselle.itemerness.core.catalog.CatalogSource
import com.iroselle.itemerness.core.catalog.InstanceIdGenerator
import com.iroselle.itemerness.core.catalog.ItemContentSource
import com.iroselle.itemerness.core.catalog.ItemDefinitionSource
import com.iroselle.itemerness.core.catalog.ItemInstanceSource
import com.iroselle.itemerness.core.catalog.NestedContentComponent
import com.iroselle.itemerness.core.catalog.SourceDataValue
import com.iroselle.itemerness.projection.MinecraftVersion
import org.bukkit.inventory.ItemStack
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class BukkitCatalogItemFactoryTest {
    @Test
    fun `materializes canonical nested items and splits fungible child stacks`() {
        val source = CatalogSource(
            schemas = emptyList(),
            items = listOf(
                item(
                    id = "example:token",
                    mode = ItemInstanceMode.FUNGIBLE,
                    components = listOf(
                        BaseItemComponentSource(
                            "minecraft:max_stack_size",
                            SourceDataValue.IntegerValue(2),
                        ),
                    ),
                ),
                item(
                    id = "example:satchel",
                    mode = ItemInstanceMode.UNIQUE,
                    contentComponent = NestedContentComponent.BUNDLE,
                    contents = listOf(ItemContentSource("example:token", 5)),
                ),
            ),
        )
        val compilation = CatalogCompiler().compile(source)
        assertTrue(compilation.successful, compilation.diagnostics.toString())
        val catalog = compilation.candidate!!.materialize(9)
        val bridge = RecordingBridge()
        val writer = RecordingComponentWriter()
        val factory = BukkitCatalogItemFactory(
            bridge = bridge,
            catalog = catalog,
            pendingName = { PendingItemName("[$it]", 0x777777) },
            componentWriter = writer,
        )
        val parent = catalog.findItem(ItemKey.parse("example:satchel"))!!

        val stack = factory.create(parent, catalog.createInstance(parent.key), 1) as RecordingItemStack

        assertEquals(listOf(2, 2, 1), stack.children.map(ItemStack::getAmount))
        assertEquals(2, bridge.created.size, "Only one canonical fungible child is created before bounded cloning")
        assertEquals(setOf("example:satchel", "example:token"), bridge.created.map { it.definition.key.toString() }.toSet())
        assertEquals(NestedContentComponent.BUNDLE, stack.contentComponent)
        assertEquals(2, stack.children.first().maxStackSize)
        assertThrows(IllegalArgumentException::class.java) {
            factory.create(parent, catalog.createInstance(parent.key), 2)
        }
    }

    private fun item(
        id: String,
        mode: ItemInstanceMode,
        components: List<BaseItemComponentSource> = emptyList(),
        contentComponent: NestedContentComponent? = null,
        contents: List<ItemContentSource> = emptyList(),
    ) = ItemDefinitionSource(
        id = id,
        enabled = true,
        material = if (contentComponent == NestedContentComponent.BUNDLE) "minecraft:bundle" else "minecraft:paper",
        instance = ItemInstanceSource(
            mode = mode,
            idGenerator = if (mode == ItemInstanceMode.UNIQUE) InstanceIdGenerator.UUID_V4 else null,
            schemas = emptyList(),
        ),
        baseComponents = components,
        contentComponent = contentComponent,
        contents = contents,
    )

    private class RecordingBridge : BukkitCanonicalItemBridge {
        override val descriptor = BukkitCanonicalBridgeDescriptor(
            ItemKey.parse("example:test"),
            MinecraftVersion("26.1.2"),
        )
        val created = mutableListOf<Creation>()

        override fun create(
            definition: ItemDefinition,
            instance: CanonicalItemInstance,
            pendingName: PendingItemName,
            amount: Int,
        ): ItemStack = RecordingItemStack(amount).also { created += Creation(definition, instance, pendingName) }

        override fun rewrite(
            source: ItemStack,
            definition: ItemDefinition,
            instance: CanonicalItemInstance,
            pendingName: PendingItemName,
        ): ItemStack = error("Not used")

        override fun inspect(source: ItemStack): CanonicalItemInspection = error("Not used")

        override fun canonicalSnbt(source: ItemStack): String? = null
    }

    private data class Creation(
        val definition: ItemDefinition,
        val instance: CanonicalItemInstance,
        val pendingName: PendingItemName,
    )

    private class RecordingComponentWriter : BukkitItemComponentWriter {
        override fun applyBase(stack: ItemStack, components: List<BaseItemComponent>) {
            val target = stack as RecordingItemStack
            components.filterIsInstance<BaseItemComponent.MaxStackSize>().singleOrNull()?.let { target.maximum = it.value }
            target.components = components
        }

        override fun applyContents(
            stack: ItemStack,
            component: NestedContentComponent,
            children: List<ItemStack>,
        ) {
            val target = stack as RecordingItemStack
            target.contentComponent = component
            target.children = children
        }
    }

    @Suppress("DEPRECATION")
    private class RecordingItemStack(
        private var quantity: Int,
    ) : ItemStack() {
        var maximum: Int = 64
        var components: List<BaseItemComponent> = emptyList()
        var contentComponent: NestedContentComponent? = null
        var children: List<ItemStack> = emptyList()

        override fun getAmount(): Int = quantity

        override fun setAmount(amount: Int) {
            quantity = amount
        }

        override fun getMaxStackSize(): Int = maximum

        public override fun clone(): RecordingItemStack = RecordingItemStack(quantity).also { copy ->
            copy.maximum = maximum
            copy.components = components
            copy.contentComponent = contentComponent
            copy.children = children
        }
    }
}
