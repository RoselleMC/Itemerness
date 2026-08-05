package com.iroselle.itemerness.core.presentation

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
import java.math.BigDecimal
import java.text.DecimalFormat
import java.text.DecimalFormatSymbols
import java.util.Locale

internal class MessageResolver(
    private val catalog: PresentationCatalogSnapshot,
    requestedLocale: String,
) {
    val locale: String = if (requestedLocale in catalog.locales) requestedLocale else catalog.defaultLocale
    private val chain: List<LocaleSource> = buildList {
        val visited = HashSet<String>()
        var current: String? = locale
        while (current != null && visited.add(current)) {
            val source = catalog.locales[current] ?: break
            add(source)
            current = source.fallback
        }
        if (none { it.locale == catalog.defaultLocale }) {
            catalog.locales[catalog.defaultLocale]?.let(::add)
        }
    }

    fun resolve(key: String, arguments: Map<String, String> = emptyMap()): String? {
        val raw = chain.firstNotNullOfOrNull { it.messages[key] } ?: return null
        if (arguments.isEmpty()) return raw
        return PLACEHOLDER_PATTERN.replace(raw) { match -> arguments[match.groupValues[1]] ?: match.value }
    }

    private companion object {
        val PLACEHOLDER_PATTERN = Regex("\\{([a-zA-Z0-9_.-]+)}")
    }
}

internal class ValueFormatter(
    private val catalog: PresentationCatalogSnapshot,
    private val messages: MessageResolver,
) {
    fun format(value: ItemDataValue, format: ItemKey? = null): Result<String> = runCatching {
        if (format == null) defaultFormat(value) else applyFormat(value, format, LinkedHashSet())
    }

    private fun applyFormat(value: ItemDataValue, id: ItemKey, active: MutableSet<ItemKey>): String {
        check(active.add(id)) { "Formatter recursion detected at $id" }
        try {
            return when (val format = requireNotNull(catalog.formats[id]) { "Unknown formatter $id" }) {
                is FormatSource.IntegerFormat -> {
                    val number = when (value) {
                        is IntegerDataValue -> value.value.toLong()
                        is LongDataValue -> value.value
                        else -> error("Formatter $id requires integer data")
                    }
                    decimalFormat(format.pattern).format(number)
                }

                is FormatSource.DecimalFormat -> {
                    val number = when (value) {
                        is DecimalDataValue -> value.value
                        is IntegerDataValue -> value.value.toDouble()
                        is LongDataValue -> value.value.toDouble()
                        else -> error("Formatter $id requires decimal data")
                    }
                    val scaled = number * format.multiply
                    require(scaled.isFinite()) { "Formatter $id produced a non-finite number" }
                    val suffix = format.suffixMessage?.let {
                        requireNotNull(messages.resolve(it)) { "Missing message $it" }
                    }.orEmpty()
                    decimalFormat(format.pattern).format(scaled) + suffix
                }

                is FormatSource.BooleanFormat -> {
                    val boolean = (value as? BooleanDataValue)?.value ?: error("Formatter $id requires boolean data")
                    val key = if (boolean) format.trueMessage else format.falseMessage
                    requireNotNull(messages.resolve(key)) { "Missing message $key" }
                }

                is FormatSource.NamespacedKeyFormat -> {
                    val key = (value as? NamespacedKeyDataValue)?.value ?: error("Formatter $id requires namespaced-key data")
                    when (format.mode) {
                        NamespacedKeyFormatMode.PATH -> key.value
                        NamespacedKeyFormatMode.MESSAGE -> {
                            val pattern = requireNotNull(format.messagePattern) { "Formatter $id has no message pattern" }
                            val messageKey = pattern
                                .replace("{namespace}", key.namespace)
                                .replace("{path}", key.value)
                            messages.resolve(messageKey) ?: when (format.missingValue) {
                                MissingKeyValue.PATH -> key.value
                                MissingKeyValue.FULL_KEY -> key.toString()
                                MissingKeyValue.ERROR -> error("Missing value message $messageKey")
                            }
                        }
                    }
                }

                is FormatSource.ListFormat -> {
                    val list = (value as? ListDataValue)?.values ?: error("Formatter $id requires list data")
                    val elementFormat = ItemKey.parse(format.elementFormat)
                    val separator = requireNotNull(messages.resolve(format.separatorMessage)) {
                        "Missing message ${format.separatorMessage}"
                    }
                    list.joinToString(separator) { applyFormat(it, elementFormat, active) }
                }
            }
        } finally {
            active.remove(id)
        }
    }

    private fun defaultFormat(value: ItemDataValue): String = when (value) {
        is BooleanDataValue -> value.value.toString()
        is IntegerDataValue -> value.value.toString()
        is LongDataValue -> value.value.toString()
        is DecimalDataValue -> BigDecimal.valueOf(value.value).stripTrailingZeros().toPlainString()
        is StringDataValue -> value.value
        is UuidDataValue -> value.value.toString()
        is NamespacedKeyDataValue -> value.value.toString()
        is ListDataValue -> value.values.joinToString(", ") { defaultFormat(it) }
        is CompoundDataValue -> value.entries.entries.joinToString(", ") { (key, nested) -> "$key=${defaultFormat(nested)}" }
    }

    private fun decimalFormat(pattern: String): DecimalFormat {
        val locale = Locale.forLanguageTag(messages.locale.replace('_', '-'))
        return DecimalFormat(pattern, DecimalFormatSymbols.getInstance(locale)).apply {
            isParseBigDecimal = true
            roundingMode = java.math.RoundingMode.HALF_UP
        }
    }
}

internal fun comparePresentationValues(left: ItemDataValue?, right: ItemDataValue?): Int? {
    if (left == null || right == null) return null
    val leftNumber = numericValue(left)
    val rightNumber = numericValue(right)
    if (leftNumber != null && rightNumber != null) return leftNumber.compareTo(rightNumber)
    return when {
        left is StringDataValue && right is StringDataValue -> left.value.compareTo(right.value)
        left is NamespacedKeyDataValue && right is NamespacedKeyDataValue -> left.value.compareTo(right.value)
        left is UuidDataValue && right is UuidDataValue -> left.value.compareTo(right.value)
        left is BooleanDataValue && right is BooleanDataValue -> left.value.compareTo(right.value)
        else -> null
    }
}

private fun numericValue(value: ItemDataValue): BigDecimal? = when (value) {
    is IntegerDataValue -> BigDecimal.valueOf(value.value.toLong())
    is LongDataValue -> BigDecimal.valueOf(value.value)
    is DecimalDataValue -> BigDecimal.valueOf(value.value)
    else -> null
}
