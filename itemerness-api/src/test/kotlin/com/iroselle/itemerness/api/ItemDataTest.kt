package com.iroselle.itemerness.api

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test

class ItemDataTest {
    @Test
    fun `container values defensively copy mutable inputs`() {
        val sourceList = mutableListOf<ItemDataValue>(IntegerDataValue(1))
        val sourceMap = mutableMapOf("items" to ListDataValue(sourceList))

        val value = CompoundDataValue(sourceMap)
        sourceList += IntegerDataValue(2)
        sourceMap.clear()

        assertEquals(
            mapOf("items" to ListDataValue(listOf(IntegerDataValue(1)))),
            value.entries,
        )
        assertThrows(UnsupportedOperationException::class.java) {
            (value.entries as MutableMap)["other"] = IntegerDataValue(3)
        }
    }

    @Test
    fun `decimal values reject non-finite numbers`() {
        listOf(Double.NaN, Double.POSITIVE_INFINITY, Double.NEGATIVE_INFINITY).forEach { value ->
            assertThrows(IllegalArgumentException::class.java) {
                DecimalDataValue(value)
            }
        }
    }
}
