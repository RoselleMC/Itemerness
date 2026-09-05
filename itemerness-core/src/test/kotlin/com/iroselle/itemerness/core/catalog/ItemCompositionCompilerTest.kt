package com.iroselle.itemerness.core.catalog

import com.iroselle.itemerness.api.ItemInstanceMode
import com.iroselle.itemerness.api.ItemKey
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class ItemCompositionCompilerTest {
    private val compiler = CatalogCompiler()

    @Test
    fun `compiles the closed base component model`() {
        val source = catalog(
            item(
                "example:blade",
                components = listOf(
                    component("minecraft:max_stack_size", integer(1)),
                    component("minecraft:max_damage", integer(900)),
                    component(
                        "minecraft:enchantments",
                        compound("minecraft:efficiency" to integer(2)),
                    ),
                    component("minecraft:damage", integer(12)),
                    component("minecraft:unbreakable", boolean(true)),
                    component("minecraft:enchantment_glint_override", boolean(false)),
                    component("minecraft:item_model", string("example:ember_blade")),
                    component("minecraft:rarity", string("epic")),
                    component("minecraft:repair_cost", integer(4)),
                    component(
                        "minecraft:food",
                        compound(
                            "nutrition" to integer(4),
                            "saturation" to decimal("1.5"),
                            "can-always-eat" to boolean(true),
                        ),
                    ),
                ),
            ),
        )

        val compilation = compiler.compile(source)

        assertTrue(compilation.successful, compilation.diagnostics.toString())
        val definition = compilation.candidate!!.materialize(1)
            .findItem(ItemKey.parse("example:blade")) as CatalogItemDefinition
        assertEquals(10, definition.baseComponents.size)
        assertEquals(BaseItemComponent.MaxDamage(900), definition.baseComponents.filterIsInstance<BaseItemComponent.MaxDamage>().single())
        assertEquals(
            mapOf(ItemKey.parse("minecraft:efficiency") to 2),
            definition.baseComponents.filterIsInstance<BaseItemComponent.Enchantments>().single().levels,
        )
        assertEquals(BaseItemComponent.Food(4, 1.5f, true), definition.baseComponents.filterIsInstance<BaseItemComponent.Food>().single())
    }

    @Test
    fun `rejects reserved unsupported and contradictory components`() {
        val source = catalog(
            item(
                "example:bad",
                mode = ItemInstanceMode.FUNGIBLE,
                components = listOf(
                    component("minecraft:lore", SourceDataValue.ListValue(emptyList())),
                    component("minecraft:attribute_modifiers", compound()),
                    component("minecraft:max_stack_size", integer(64)),
                    component("minecraft:max_damage", integer(100)),
                ),
            ),
        )

        val compilation = compiler.compile(source)

        assertFalse(compilation.successful)
        assertEquals(3, compilation.diagnostics.count { it.code == CatalogDiagnosticCode.INVALID_COMPONENT })
        assertTrue(compilation.diagnostics.any { "owned by Itemerness" in it.message })
        assertTrue(compilation.diagnostics.any { "Only an empty attribute modifier list" in it.message })
        assertTrue(compilation.diagnostics.any { "cannot be combined" in it.message })
    }

    @Test
    fun `detects self and multi item cycles with deterministic diagnostics`() {
        val self = compiler.compile(
            catalog(
                item(
                    "example:self",
                    mode = ItemInstanceMode.FUNGIBLE,
                    contentComponent = NestedContentComponent.BUNDLE,
                    contents = listOf(ItemContentSource("example:self", 1)),
                ),
            ),
        )
        assertFalse(self.successful)
        assertEquals(
            "Nested item reference cycle contains: example:self",
            self.diagnostics.single { it.code == CatalogDiagnosticCode.CYCLIC_REFERENCE }.message,
        )

        fun cycle(items: List<ItemDefinitionSource>) = compiler.compile(catalog(*items.toTypedArray()))
            .diagnostics.single { it.code == CatalogDiagnosticCode.CYCLIC_REFERENCE }.message
        val a = item(
            "example:a",
            mode = ItemInstanceMode.FUNGIBLE,
            contentComponent = NestedContentComponent.BUNDLE,
            contents = listOf(ItemContentSource("example:b", 1)),
        )
        val b = item(
            "example:b",
            mode = ItemInstanceMode.FUNGIBLE,
            contentComponent = NestedContentComponent.BUNDLE,
            contents = listOf(ItemContentSource("example:a", 1)),
        )
        assertEquals(cycle(listOf(a, b)), cycle(listOf(b, a)))
        assertEquals("Nested item reference cycle contains: example:a, example:b", cycle(listOf(a, b)))
    }

    @Test
    fun `validates nested references enabled state and expansion budget`() {
        val disabledChild = item("example:child", enabled = false, mode = ItemInstanceMode.FUNGIBLE)
        val enabledParent = item(
            "example:parent",
            mode = ItemInstanceMode.FUNGIBLE,
            contentComponent = NestedContentComponent.BUNDLE,
            contents = listOf(ItemContentSource("example:child", 1)),
        )
        val disabledCompilation = compiler.compile(catalog(enabledParent, disabledChild))
        assertTrue(disabledCompilation.diagnostics.any { "cannot contain disabled" in it.message })

        val missing = compiler.compile(
            catalog(
                item(
                    "example:parent",
                    mode = ItemInstanceMode.FUNGIBLE,
                    contentComponent = NestedContentComponent.BUNDLE,
                    contents = listOf(ItemContentSource("example:missing", 1)),
                ),
            ),
        )
        assertTrue(missing.diagnostics.any { it.code == CatalogDiagnosticCode.MISSING_REFERENCE })

        val leaf = item("example:leaf", mode = ItemInstanceMode.FUNGIBLE)
        val large = item(
            "example:large",
            mode = ItemInstanceMode.FUNGIBLE,
            contentComponent = NestedContentComponent.BUNDLE,
            contents = listOf(
                ItemContentSource("example:leaf", 99),
                ItemContentSource("example:leaf", 99),
                ItemContentSource("example:leaf", 99),
            ),
        )
        val oversized = compiler.compile(catalog(large, leaf))
        assertTrue(oversized.diagnostics.any { "Nested item count exceeds" in it.message })
    }

    private fun catalog(vararg items: ItemDefinitionSource): CatalogSource = CatalogSource(emptyList(), items.toList())

    private fun item(
        id: String,
        enabled: Boolean = true,
        mode: ItemInstanceMode = ItemInstanceMode.UNIQUE,
        components: List<BaseItemComponentSource> = emptyList(),
        contentComponent: NestedContentComponent? = null,
        contents: List<ItemContentSource> = emptyList(),
    ): ItemDefinitionSource = ItemDefinitionSource(
        id = id,
        enabled = enabled,
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

    private fun component(id: String, value: SourceDataValue) = BaseItemComponentSource(id, value)
    private fun integer(value: Long) = SourceDataValue.IntegerValue(value)
    private fun boolean(value: Boolean) = SourceDataValue.BooleanValue(value)
    private fun string(value: String) = SourceDataValue.StringValue(value)
    private fun decimal(value: String) = SourceDataValue.DecimalValue(value.toBigDecimal())
    private fun compound(vararg entries: Pair<String, SourceDataValue>) = SourceDataValue.CompoundValue(mapOf(*entries))
}
