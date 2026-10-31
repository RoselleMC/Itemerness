package com.iroselle.itemerness.editor.agent

import com.iroselle.itemerness.api.BooleanDataValue
import com.iroselle.itemerness.api.CompoundDataValue
import com.iroselle.itemerness.api.DataKey
import com.iroselle.itemerness.api.DecimalDataValue
import com.iroselle.itemerness.api.IntegerDataValue
import com.iroselle.itemerness.api.ItemDataValue
import com.iroselle.itemerness.api.ItemDefinition
import com.iroselle.itemerness.api.ItemKey
import com.iroselle.itemerness.api.ListDataValue
import com.iroselle.itemerness.api.LongDataValue
import com.iroselle.itemerness.api.NamespacedKeyDataValue
import com.iroselle.itemerness.api.PreviewParameter
import com.iroselle.itemerness.api.PreviewParameterType
import com.iroselle.itemerness.api.PreviewScenario
import com.iroselle.itemerness.api.StringDataValue
import com.iroselle.itemerness.api.UuidDataValue
import com.iroselle.itemerness.editor.protocol.JsonValue
import com.iroselle.itemerness.editor.protocol.ProjectDocumentCodec

/**
 * Plugin-computed preview data. The platform owns provider registrations, authorization and the
 * execution deadline; the compiler only consumes typed values and reports their origin.
 */
interface PreviewDataSource {
    /** Scenarios every active provider offers for [item]; failing providers are reported, not dropped. */
    fun scenarios(item: PreviewDataItem): List<ProviderScenarios>

    fun provide(item: PreviewDataItem, selection: ScenarioSelection): ProvidedPreviewData
}

/** The draft definition a provider computes from, with its definition-scope data and data key rules. */
class PreviewDataItem(
    val definition: ItemDefinition,
    definitionData: Map<DataKey, ItemDataValue>,
    val decoded: ProjectDocumentCodec.Decoded,
    val locale: String,
) {
    val itemKey: ItemKey get() = definition.key
    val definitionData: Map<DataKey, ItemDataValue> = java.util.Map.copyOf(definitionData)
}

class ScenarioSelection(val plugin: String, val scenario: String, val parameters: JsonValue.Obj)

sealed interface ProviderScenarios {
    val plugin: String

    class Offered(override val plugin: String, val revision: String, scenarios: List<PreviewScenario>) : ProviderScenarios {
        val scenarios: List<PreviewScenario> = java.util.List.copyOf(scenarios)
    }

    class Failed(override val plugin: String, val code: String, val detail: String) : ProviderScenarios
}

sealed interface ProvidedPreviewData {
    val plugin: String
    val scenario: String

    class Applied(
        override val plugin: String,
        override val scenario: String,
        val revision: String,
        values: Map<DataKey, ItemDataValue>,
        messages: List<String>,
    ) : ProvidedPreviewData {
        val values: Map<DataKey, ItemDataValue> = java.util.Map.copyOf(values)
        val messages: List<String> = java.util.List.copyOf(messages)
    }

    class Failed(
        override val plugin: String,
        override val scenario: String,
        val revision: String?,
        val code: String,
        val detail: String,
    ) : ProvidedPreviewData
}

/** Converts between the wire form of scenario parameters and typed values. */
object PreviewParameters {
    const val MAXIMUM_VALUES: Int = 256

    /**
     * Validates [json] against the declared [parameters]. Unknown parameters, wrong types, values
     * outside bounds or choices, and missing required parameters are rejected with a message.
     */
    fun decode(parameters: List<PreviewParameter>, json: JsonValue.Obj): Map<String, ItemDataValue> {
        val declared = parameters.associateBy(PreviewParameter::id)
        json.entries.keys.firstOrNull { it !in declared }?.let { throw IllegalArgumentException("Unknown parameter $it") }
        return parameters.mapNotNull { parameter ->
            val value = json.entries[parameter.id]?.takeUnless(::isNull)
            if (value == null) {
                require(parameter.optional) { "Parameter ${parameter.id} is required" }
                null
            } else {
                parameter.id to decodeValue(parameter, value, parameter.id)
            }
        }.toMap()
    }

    private fun tagged(value: JsonValue, path: String, kind: String): JsonValue.Obj {
        val obj = value as? JsonValue.Obj ?: throw IllegalArgumentException("$path must be a typed value")
        val actual = (obj.entries["kind"] as? JsonValue.Text)?.value
        require(actual == kind) { "$path must be a $kind value" }
        return obj
    }

    private fun decodeValue(parameter: PreviewParameter, value: JsonValue, path: String): ItemDataValue =
        when (val type = parameter.type) {
            is PreviewParameterType.ListOf -> {
                val values = (tagged(value, path, "list").entries["values"] as? JsonValue.Arr
                    ?: throw IllegalArgumentException("$path must hold a list")).values
                require(values.size <= type.maximumSize) { "$path holds at most ${type.maximumSize} elements" }
                val element = PreviewParameter("element", parameter.label, type.element, optional = false, choices = parameter.choices,
                    minimum = parameter.minimum, maximum = parameter.maximum)
                ListDataValue(values.mapIndexed { index, entry -> decodeValue(element, entry, "$path[$index]") })
            }
            is PreviewParameterType.Compound -> {
                val entries = (tagged(value, path, "compound").entries["entries"] as? JsonValue.Obj
                    ?: throw IllegalArgumentException("$path must hold fields")).entries
                val fields = type.fields.associateBy(PreviewParameter::id)
                entries.keys.firstOrNull { it !in fields }?.let { throw IllegalArgumentException("Unknown field $path.$it") }
                CompoundDataValue(type.fields.mapNotNull { field ->
                    val entry = entries[field.id]?.takeUnless(::isNull)
                    if (entry == null) {
                        require(field.optional) { "Field $path.${field.id} is required" }
                        null
                    } else {
                        field.id to decodeValue(field, entry, "$path.${field.id}")
                    }
                }.toMap())
            }
            else -> scalar(parameter, type, value, path)
        }

    private fun isNull(value: JsonValue): Boolean =
        value == JsonValue.Null || ((value as? JsonValue.Obj)?.entries?.get("kind") as? JsonValue.Text)?.value == "null"

    private fun scalar(parameter: PreviewParameter, type: PreviewParameterType, value: JsonValue, path: String): ItemDataValue {
        fun literal(kind: String): String = (tagged(value, path, kind).entries["value"] as? JsonValue.Text
            ?: throw IllegalArgumentException("$path must hold a $kind")).value
        fun bounded(number: Double): Double = number.also {
            parameter.minimum?.let { minimum -> require(number >= minimum) { "$path must be at least ${plain(minimum)}" } }
            parameter.maximum?.let { maximum -> require(number <= maximum) { "$path must be at most ${plain(maximum)}" } }
        }
        fun text(): String = literal("string").also { text ->
            require(text.length <= 1024) { "$path is longer than 1024 characters" }
            require(parameter.choices.isEmpty() || text in parameter.choices) { "$path must be one of the offered choices" }
        }
        return when (type) {
            PreviewParameterType.IntegerType -> {
                val number = literal("integer").toLongOrNull() ?: throw IllegalArgumentException("$path must be an integer")
                require(number in Int.MIN_VALUE..Int.MAX_VALUE) { "$path must be a 32-bit integer" }
                bounded(number.toDouble())
                IntegerDataValue(number.toInt())
            }
            PreviewParameterType.LongType -> {
                val number = literal("integer").toLongOrNull() ?: throw IllegalArgumentException("$path must be a whole number")
                bounded(number.toDouble())
                LongDataValue(number)
            }
            PreviewParameterType.DecimalType -> {
                val number = literal("decimal").toDoubleOrNull()?.takeIf(Double::isFinite) ?: throw IllegalArgumentException("$path must be a decimal")
                DecimalDataValue(bounded(number))
            }
            PreviewParameterType.BooleanType -> BooleanDataValue((tagged(value, path, "boolean").entries["value"] as? JsonValue.Bool
                ?: throw IllegalArgumentException("$path must be true or false")).value)
            PreviewParameterType.TextType -> StringDataValue(text())
            PreviewParameterType.KeyType -> NamespacedKeyDataValue(
                try { ItemKey.parse(text()) } catch (failure: IllegalArgumentException) { throw IllegalArgumentException("$path must be a namespaced key") },
            )
            else -> error("Not a scalar parameter type")
        }
    }

    private fun plain(number: Double): String = if (number == Math.rint(number)) number.toLong().toString() else number.toString()

    fun scenarioJson(scenario: PreviewScenario): JsonValue = JsonValue.Obj(linkedMapOf(
        "id" to JsonValue.Text(scenario.id),
        "label" to JsonValue.Text(scenario.label),
        "description" to (scenario.description?.let(JsonValue::Text) ?: JsonValue.Null),
        "parameters" to JsonValue.Arr(scenario.parameters.map(::parameterJson)),
    ))

    private fun parameterJson(parameter: PreviewParameter): JsonValue = JsonValue.Obj(linkedMapOf(
        "id" to JsonValue.Text(parameter.id),
        "label" to JsonValue.Text(parameter.label),
        "type" to typeJson(parameter.type),
        "optional" to JsonValue.Bool(parameter.optional),
        "choices" to JsonValue.Arr(parameter.choices.map(JsonValue::Text)),
        "minimum" to (parameter.minimum?.let(JsonValue::Num) ?: JsonValue.Null),
        "maximum" to (parameter.maximum?.let(JsonValue::Num) ?: JsonValue.Null),
        "defaultValue" to (parameter.defaultValue?.let(::valueJson) ?: JsonValue.Null),
    ))

    private fun typeJson(type: PreviewParameterType): JsonValue = when (type) {
        PreviewParameterType.IntegerType -> JsonValue.Obj(mapOf("kind" to JsonValue.Text("integer")))
        PreviewParameterType.LongType -> JsonValue.Obj(mapOf("kind" to JsonValue.Text("long")))
        PreviewParameterType.DecimalType -> JsonValue.Obj(mapOf("kind" to JsonValue.Text("decimal")))
        PreviewParameterType.BooleanType -> JsonValue.Obj(mapOf("kind" to JsonValue.Text("boolean")))
        PreviewParameterType.TextType -> JsonValue.Obj(mapOf("kind" to JsonValue.Text("string")))
        PreviewParameterType.KeyType -> JsonValue.Obj(mapOf("kind" to JsonValue.Text("namespaced-key")))
        is PreviewParameterType.ListOf -> JsonValue.Obj(mapOf(
            "kind" to JsonValue.Text("list"),
            "element" to typeJson(type.element),
            "maximumSize" to JsonValue.Num(type.maximumSize.toDouble()),
        ))
        is PreviewParameterType.Compound -> JsonValue.Obj(mapOf(
            "kind" to JsonValue.Text("compound"),
            "fields" to JsonValue.Arr(type.fields.map(::parameterJson)),
        ))
    }

    /** A value in the document's tagged data value form, which the editor's typed value fields edit. */
    fun valueJson(value: ItemDataValue): JsonValue {
        fun tag(kind: String, vararg entries: Pair<String, JsonValue>) = JsonValue.Obj(linkedMapOf("kind" to JsonValue.Text(kind), *entries))
        return when (value) {
            is BooleanDataValue -> tag("boolean", "value" to JsonValue.Bool(value.value))
            is IntegerDataValue -> tag("integer", "value" to JsonValue.Text(value.value.toString()))
            is LongDataValue -> tag("integer", "value" to JsonValue.Text(value.value.toString()))
            is DecimalDataValue -> tag("decimal", "value" to JsonValue.Text(value.value.toBigDecimal().stripTrailingZeros().toPlainString()))
            is StringDataValue -> tag("string", "value" to JsonValue.Text(value.value))
            is UuidDataValue -> tag("string", "value" to JsonValue.Text(value.value.toString()))
            is NamespacedKeyDataValue -> tag("string", "value" to JsonValue.Text(value.value.toString()))
            is ListDataValue -> tag("list", "values" to JsonValue.Arr(value.values.map(::valueJson)))
            is CompoundDataValue -> tag("compound", "entries" to JsonValue.Obj(value.entries.mapValues { (_, entry) -> valueJson(entry) }))
        }
    }
}
