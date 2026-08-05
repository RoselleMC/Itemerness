package com.iroselle.itemerness.bukkit.command

import com.iroselle.itemerness.api.CompoundDataValue
import com.iroselle.itemerness.api.IntegerDataValue
import com.iroselle.itemerness.api.ListDataValue
import com.iroselle.itemerness.api.NamespacedKeyDataValue
import com.iroselle.itemerness.api.StringDataValue
import com.iroselle.itemerness.bukkit.config.StrictYamlException
import com.iroselle.itemerness.core.catalog.CompoundFieldSource
import com.iroselle.itemerness.core.catalog.DataType
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test

class DataLiteralParserTest {
    @Test
    fun `parses typed scalar and list literals`() {
        assertEquals(
            NamespacedKeyDataValue(com.iroselle.itemerness.api.ItemKey.parse("example:rare")),
            DataLiteralParser.parse("example:rare", DataType.NamespacedKeyType),
        )
        assertEquals(
            ListDataValue(listOf(IntegerDataValue(1), IntegerDataValue(2))),
            DataLiteralParser.parse("[1, 2]", DataType.ListType(DataType.IntegerType)),
        )
        assertEquals(StringDataValue("true"), DataLiteralParser.parse("\"true\"", DataType.StringType))
    }

    @Test
    fun `parses closed compound and omits nullable null`() {
        val type = DataType.CompoundType(
            listOf(
                CompoundFieldSource("required", DataType.IntegerType),
                CompoundFieldSource("optional", DataType.StringType, nullable = true),
            ),
        )

        assertEquals(
            CompoundDataValue(mapOf("required" to IntegerDataValue(7))),
            DataLiteralParser.parse("{required: 7, optional: null}", type),
        )
    }

    @Test
    fun `rejects coercion null mixed open lists and multiline input`() {
        assertThrows(StrictYamlException::class.java) {
            DataLiteralParser.parse("1", DataType.StringType)
        }
        assertThrows(IllegalArgumentException::class.java) {
            DataLiteralParser.parse("null", DataType.StringType)
        }
        assertThrows(IllegalArgumentException::class.java) {
            DataLiteralParser.parse("{values: [1, text]}", DataType.CompoundType())
        }
        assertThrows(IllegalArgumentException::class.java) {
            DataLiteralParser.parse("one\ntwo", DataType.StringType)
        }
    }

    @Test
    fun `rejects duplicate mappings and out of range integers`() {
        assertThrows(StrictYamlException::class.java) {
            DataLiteralParser.parse("{same: 1, same: 2}", DataType.CompoundType())
        }
        assertThrows(IllegalArgumentException::class.java) {
            DataLiteralParser.parse("2147483648", DataType.IntegerType)
        }
    }
}
