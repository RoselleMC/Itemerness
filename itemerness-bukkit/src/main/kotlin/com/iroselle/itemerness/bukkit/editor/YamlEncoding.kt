package com.iroselle.itemerness.bukkit.editor

import com.iroselle.itemerness.api.*
import com.iroselle.itemerness.core.catalog.SourceDataValue
import org.yaml.snakeyaml.DumperOptions
import org.yaml.snakeyaml.Yaml
import java.math.BigDecimal
import java.util.Locale

internal object YamlEncoding {
    fun mapping(vararg fields: Pair<String, Any?>): Map<String, Any?> = linkedMapOf(*fields).filterValues { it != null }
    fun enum(value: Enum<*>): String = value.name.lowercase(Locale.ROOT).replace('_', '-')
    fun document(vararg fields: Pair<String, Any?>): Map<String, Any?> = mapping("schema-version" to 1, *fields)
    fun exactNumber(value: BigDecimal): Number = if (value.stripTrailingZeros().scale() <= 0) value.toBigIntegerExact() else value
    fun dump(value: Map<String, Any?>): String = Yaml(DumperOptions().apply {
        defaultFlowStyle = DumperOptions.FlowStyle.BLOCK
        indent = 2
        indicatorIndent = 0
        splitLines = false
        width = 120
    }).dump(copyTree(value))

    // Source collections may be sets or shared empty instances. YAML uses sequences, never
    // Java-specific collection tags or aliases, which the production loader rejects.
    private fun copyTree(value: Any?): Any? = when (value) {
        is Map<*, *> -> value.entries.associateTo(LinkedHashMap()) { (key, child) -> key to copyTree(child) }
        is Collection<*> -> value.mapTo(ArrayList(), ::copyTree)
        else -> value
    }

    fun source(value: SourceDataValue): Any? = when (value) {
        SourceDataValue.NullValue -> null
        is SourceDataValue.BooleanValue -> value.value
        is SourceDataValue.IntegerValue -> value.value
        is SourceDataValue.DecimalValue -> value.value
        is SourceDataValue.StringValue -> value.value
        is SourceDataValue.ListValue -> value.values.map(::source)
        is SourceDataValue.CompoundValue -> value.entries.mapValues { source(it.value) }
    }

    fun typed(value: ItemDataValue): Any = when (value) {
        is BooleanDataValue -> value.value
        is IntegerDataValue -> value.value
        is LongDataValue -> value.value
        is DecimalDataValue -> value.value
        is StringDataValue -> value.value
        is UuidDataValue -> value.value.toString()
        is NamespacedKeyDataValue -> value.value.toString()
        is ListDataValue -> value.values.map(::typed)
        is CompoundDataValue -> value.entries.mapValues { typed(it.value) }
    }
}
