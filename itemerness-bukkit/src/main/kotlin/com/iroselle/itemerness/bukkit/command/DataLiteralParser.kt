package com.iroselle.itemerness.bukkit.command

import com.iroselle.itemerness.api.BooleanDataValue
import com.iroselle.itemerness.api.CompoundDataValue
import com.iroselle.itemerness.api.DecimalDataValue
import com.iroselle.itemerness.api.IntegerDataValue
import com.iroselle.itemerness.api.ItemDataValue
import com.iroselle.itemerness.api.ItemKey
import com.iroselle.itemerness.api.ListDataValue
import com.iroselle.itemerness.api.LongDataValue
import com.iroselle.itemerness.api.NamespacedKeyDataValue
import com.iroselle.itemerness.api.StringDataValue
import com.iroselle.itemerness.api.UuidDataValue
import com.iroselle.itemerness.bukkit.config.StrictYaml
import com.iroselle.itemerness.bukkit.config.StrictYamlException
import com.iroselle.itemerness.core.catalog.CompoundFieldSource
import com.iroselle.itemerness.core.catalog.DataType
import java.io.StringReader
import java.math.BigDecimal
import java.math.BigInteger
import java.util.UUID

/** Parses the command value grammar as one bounded YAML scalar/container, then applies the schema. */
internal object DataLiteralParser {
    private const val MAX_LITERAL_CODE_POINTS = 16_384

    fun parse(
        literal: String,
        type: DataType,
    ): ItemDataValue {
        require(literal.codePointCount(0, literal.length) <= MAX_LITERAL_CODE_POINTS) {
            "Data literal exceeds the hard codepoint limit"
        }
        require('\n' !in literal && '\r' !in literal) {
            "Data literal must be a single line"
        }
        val document = StrictYaml.load(StringReader("value: $literal"), "command data literal")
        return decode(requireNotNull(document["value"]) { "Null is not a set value; use data unset" }, type, "value")
    }

    private fun decode(
        raw: Any,
        type: DataType,
        path: String,
    ): ItemDataValue = when (type) {
        DataType.BooleanType -> BooleanDataValue(raw as? Boolean ?: mismatch(path, "boolean"))
        DataType.IntegerType -> IntegerDataValue(integer(raw, path).also { value ->
            require(value in Int.MIN_VALUE.toLong()..Int.MAX_VALUE.toLong()) {
                "$path is outside the signed 32-bit range"
            }
        }.toInt())
        DataType.LongType -> LongDataValue(integer(raw, path))
        DataType.DecimalType -> DecimalDataValue(decimal(raw, path).toDouble().also { value ->
            require(value.isFinite()) { "$path must be a finite decimal" }
        })
        DataType.StringType -> StringDataValue(raw as? String ?: mismatch(path, "string"))
        DataType.UuidType -> UuidDataValue(
            runCatching { UUID.fromString(raw as? String ?: mismatch(path, "UUID string")) }
                .getOrElse { throw StrictYamlException("$path is not a valid UUID", it) },
        )
        DataType.NamespacedKeyType -> NamespacedKeyDataValue(
            runCatching { ItemKey.parse(raw as? String ?: mismatch(path, "namespaced-key string")) }
                .getOrElse { throw StrictYamlException("$path is not a valid namespaced key", it) },
        )
        is DataType.ListType -> {
            val values = raw as? List<*> ?: mismatch(path, "list")
            ListDataValue(
                values.mapIndexed { index, value ->
                    decode(requireNotNull(value) { "$path[$index] cannot be null" }, type.element, "$path[$index]")
                },
            )
        }
        is DataType.CompoundType -> decodeCompound(raw, type.fields, path)
    }

    private fun decodeCompound(
        raw: Any,
        fields: List<CompoundFieldSource>?,
        path: String,
    ): ItemDataValue {
        val values = raw as? Map<*, *> ?: mismatch(path, "compound")
        val byName = fields?.associateBy(CompoundFieldSource::name)
        if (byName != null) {
            val unknown = values.keys.filterNot { it is String && it in byName }
            require(unknown.isEmpty()) { "$path contains unknown fields: ${unknown.joinToString()}" }
        }
        val decoded = LinkedHashMap<String, ItemDataValue>()
        values.forEach { (rawName, rawValue) ->
            val name = rawName as? String ?: mismatch(path, "compound with string keys")
            if (rawValue == null) {
                val field = byName?.get(name)
                require(fields == null || field?.nullable == true) { "$path.$name cannot be null" }
                return@forEach
            }
            val fieldType = byName?.get(name)?.type
            decoded[name] = if (fields == null) {
                infer(rawValue, "$path.$name")
            } else {
                decode(rawValue, requireNotNull(fieldType) { "Unknown field $path.$name" }, "$path.$name")
            }
        }
        fields?.filterNot { it.nullable || decoded.containsKey(it.name) }?.let { missing ->
            require(missing.isEmpty()) {
                "$path is missing required fields: ${missing.joinToString { it.name }}"
            }
        }
        return CompoundDataValue(decoded)
    }

    private fun infer(
        raw: Any,
        path: String,
    ): ItemDataValue = when (raw) {
        is Boolean -> BooleanDataValue(raw)
        is Byte -> IntegerDataValue(raw.toInt())
        is Short -> IntegerDataValue(raw.toInt())
        is Int -> IntegerDataValue(raw)
        is Long -> if (raw in Int.MIN_VALUE.toLong()..Int.MAX_VALUE.toLong()) {
            IntegerDataValue(raw.toInt())
        } else {
            LongDataValue(raw)
        }
        is BigInteger -> runCatching { raw.longValueExact() }
            .getOrElse { throw StrictYamlException("$path is outside the signed 64-bit range", it) }
            .let { value ->
                if (value in Int.MIN_VALUE.toLong()..Int.MAX_VALUE.toLong()) IntegerDataValue(value.toInt()) else LongDataValue(value)
            }
        is Float,
        is Double,
        is BigDecimal,
        -> DecimalDataValue(decimal(raw, path).toDouble().also { require(it.isFinite()) { "$path must be finite" } })
        is String -> StringDataValue(raw)
        is List<*> -> {
            val values = raw.mapIndexed { index, value ->
                infer(requireNotNull(value) { "$path[$index] cannot be null" }, "$path[$index]")
            }
            require(values.map(ItemDataValue::javaClass).distinct().size <= 1) {
                "$path must contain one inferred element type"
            }
            ListDataValue(values)
        }
        is Map<*, *> -> decodeCompound(raw, null, path)
        else -> mismatch(path, "supported scalar or container")
    }

    private fun integer(
        raw: Any,
        path: String,
    ): Long = when (raw) {
        is Byte -> raw.toLong()
        is Short -> raw.toLong()
        is Int -> raw.toLong()
        is Long -> raw
        is BigInteger -> runCatching(raw::longValueExact)
            .getOrElse { throw StrictYamlException("$path is outside the signed 64-bit range", it) }
        else -> mismatch(path, "integer")
    }

    private fun decimal(
        raw: Any,
        path: String,
    ): BigDecimal = try {
        when (raw) {
            is BigDecimal -> raw
            is BigInteger -> raw.toBigDecimal()
            is Byte,
            is Short,
            is Int,
            is Long,
            is Float,
            is Double,
            -> BigDecimal(raw.toString())
            else -> mismatch(path, "decimal")
        }
    } catch (exception: NumberFormatException) {
        throw StrictYamlException("$path must be a finite decimal", exception)
    }

    private fun mismatch(
        path: String,
        expected: String,
    ): Nothing = throw StrictYamlException("$path must be $expected")
}
