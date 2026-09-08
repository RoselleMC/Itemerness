package com.iroselle.itemerness.core.catalog

import com.iroselle.itemerness.api.ItemInstanceMode
import com.iroselle.itemerness.api.ItemKey
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class EnchantmentComponentsTest {
    @Test
    fun `explicit attribute clearing is distinct from omitted components`() {
        assertTrue(definition(compile()).baseComponents.isEmpty())
        val cleared = definition(compile("minecraft:attribute_modifiers" to SourceDataValue.ListValue(emptyList())))
        assertEquals(listOf(BaseItemComponent.EmptyAttributeModifiers), cleared.baseComponents)
        for (value in listOf(
            SourceDataValue.CompoundValue(emptyMap()), SourceDataValue.NullValue,
            SourceDataValue.ListValue(listOf(SourceDataValue.CompoundValue(emptyMap()))),
        )) assertFalse(compile("minecraft:attribute_modifiers" to value).successful)
    }

    @Test
    fun `both enchantment components support empty clears and levels beyond ordinary vanilla limits`() {
        for (id in enchantmentIds) {
            val empty = definition(compile(id to SourceDataValue.CompoundValue(emptyMap()))).baseComponents.single()
            assertTrue((empty as BaseItemComponent.EnchantmentLevels).levels.isEmpty())
            val entries = mapOf("minecraft:sharpness" to SourceDataValue.IntegerValue(255), "custom:skill/one" to SourceDataValue.IntegerValue(1))
            val component = definition(compile(id to SourceDataValue.CompoundValue(entries))).baseComponents.single() as BaseItemComponent.EnchantmentLevels
            assertEquals(mapOf(ItemKey.parse("minecraft:sharpness") to 255, ItemKey.parse("custom:skill/one") to 1), component.levels)
        }
    }

    @Test
    fun `enchantment level maps remain immutable and stored semantics remain distinct`() {
        val mutable = mutableMapOf(ItemKey.parse("minecraft:sharpness") to 1)
        val applied = BaseItemComponent.Enchantments(mutable)
        mutable.clear()
        assertEquals(1, applied.levels.size)
        assertThrows(UnsupportedOperationException::class.java) { (applied.levels as MutableMap).clear() }
        assertEquals(applied, BaseItemComponent.Enchantments(applied.levels))
        assertNotEquals(applied, BaseItemComponent.StoredEnchantments(applied.levels))
    }

    @Test
    fun `enchantment mappings reject malformed values and preserve the sixty four entry budget`() {
        for (id in enchantmentIds) {
            for (value in listOf(
                SourceDataValue.IntegerValue(0), SourceDataValue.IntegerValue(256), SourceDataValue.IntegerValue(-1),
                SourceDataValue.DecimalValue("1".toBigDecimal()), SourceDataValue.StringValue("1"), SourceDataValue.NullValue,
            )) assertFalse(compile(id to SourceDataValue.CompoundValue(mapOf("minecraft:sharpness" to value))).successful, "$id $value")
            assertFalse(compile(id to SourceDataValue.ListValue(emptyList())).successful)
            assertFalse(compile(id to SourceDataValue.CompoundValue(mapOf("invalid" to SourceDataValue.IntegerValue(1)))).successful)
            for (count in listOf(64, 65)) {
                val value = SourceDataValue.CompoundValue((0 until count).associate { "custom:level-$it" to SourceDataValue.IntegerValue(1) })
                assertEquals(count == 64, compile(id to value).successful, "$id count $count")
            }
        }
    }

    private fun compile(vararg values: Pair<String, SourceDataValue>): CatalogCompilation = CatalogCompiler().compile(CatalogSource(
        schemas = emptyList(),
        items = listOf(ItemDefinitionSource(
            id = "example:component-test", enabled = true, material = "minecraft:paper",
            instance = ItemInstanceSource(ItemInstanceMode.FUNGIBLE, null, emptyList()),
            baseComponents = values.map { (id, value) -> BaseItemComponentSource(id, value) },
        )),
    ))

    private fun definition(compilation: CatalogCompilation): CatalogItemDefinition {
        assertTrue(compilation.successful, compilation.diagnostics.toString())
        return compilation.candidate!!.materialize(1).findItem(ItemKey.parse("example:component-test")) as CatalogItemDefinition
    }

    private val enchantmentIds = listOf("minecraft:enchantments", "minecraft:stored_enchantments")
}
