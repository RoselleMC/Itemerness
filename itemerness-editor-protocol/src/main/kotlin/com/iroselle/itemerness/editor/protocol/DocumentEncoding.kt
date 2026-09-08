package com.iroselle.itemerness.editor.protocol

import com.iroselle.itemerness.api.BooleanDataValue
import com.iroselle.itemerness.api.CompoundDataValue
import com.iroselle.itemerness.api.DecimalDataValue
import com.iroselle.itemerness.api.IntegerDataValue
import com.iroselle.itemerness.api.ItemDataValue
import com.iroselle.itemerness.api.ListDataValue
import com.iroselle.itemerness.api.LongDataValue
import com.iroselle.itemerness.api.NamespacedKeyDataValue
import com.iroselle.itemerness.api.StringDataValue
import com.iroselle.itemerness.api.UuidDataValue
import com.iroselle.itemerness.core.catalog.DataType
import com.iroselle.itemerness.core.catalog.SourceDataValue

internal object DocumentEncoding {
    fun obj(vararg values: Pair<String, Any?>): JsonValue.Obj = JsonValue.Obj(values.associate { (key, value) -> key to json(value) })

    fun json(value: Any?): JsonValue = when (value) {
        null -> JsonValue.Null
        is JsonValue -> value
        is String -> JsonValue.Text(value)
        is Boolean -> JsonValue.Bool(value)
        is Int -> JsonValue.Num(value.toDouble())
        is Double -> JsonValue.Num(value)
        is Enum<*> -> JsonValue.Text(value.name)
        is Collection<*> -> JsonValue.Arr(value.map(::json))
        is Map<*, *> -> JsonValue.Obj(value.entries.associate { (key, child) -> require(key is String); key to json(child) })
        else -> error("Unsupported document encoding value ${value.javaClass.simpleName}")
    }

    fun type(type: DataType): JsonValue = when (type) {
        DataType.BooleanType -> obj("kind" to "boolean")
        DataType.IntegerType -> obj("kind" to "integer")
        DataType.LongType -> obj("kind" to "long")
        DataType.DecimalType -> obj("kind" to "decimal")
        DataType.StringType -> obj("kind" to "string")
        DataType.UuidType -> obj("kind" to "uuid")
        DataType.NamespacedKeyType -> obj("kind" to "namespacedKey")
        is DataType.ListType -> obj("kind" to "list", "element" to type(type.element))
        is DataType.CompoundType -> obj("kind" to "compound", "fields" to type.fields?.map { field ->
            obj("name" to field.name, "type" to type(field.type), "nullable" to field.nullable)
        })
    }

    fun sourceValue(value: SourceDataValue): JsonValue = when (value) {
        SourceDataValue.NullValue -> obj("kind" to "null")
        is SourceDataValue.BooleanValue -> obj("kind" to "boolean", "value" to value.value)
        is SourceDataValue.IntegerValue -> obj("kind" to "integer", "value" to value.value.toString())
        is SourceDataValue.DecimalValue -> obj("kind" to "decimal", "value" to value.value.toString())
        is SourceDataValue.StringValue -> obj("kind" to "string", "value" to value.value)
        is SourceDataValue.ListValue -> obj("kind" to "list", "values" to value.values.map(::sourceValue))
        is SourceDataValue.CompoundValue -> obj("kind" to "compound", "entries" to value.entries.mapValues { sourceValue(it.value) })
    }

    fun typedValue(value: ItemDataValue): JsonValue = when (value) {
        is BooleanDataValue -> obj("kind" to "boolean", "value" to value.value)
        is IntegerDataValue -> obj("kind" to "integer", "value" to value.value.toString())
        is LongDataValue -> obj("kind" to "integer", "value" to value.value.toString())
        is DecimalDataValue -> obj("kind" to "decimal", "value" to value.value.toString())
        is StringDataValue -> obj("kind" to "string", "value" to value.value)
        is UuidDataValue -> obj("kind" to "string", "value" to value.value.toString())
        is NamespacedKeyDataValue -> obj("kind" to "string", "value" to value.value.toString())
        is ListDataValue -> obj("kind" to "list", "values" to value.values.map(::typedValue))
        is CompoundDataValue -> obj("kind" to "compound", "entries" to value.entries.mapValues { typedValue(it.value) })
    }
}
