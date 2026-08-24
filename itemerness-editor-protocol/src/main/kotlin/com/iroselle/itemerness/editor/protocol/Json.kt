package com.iroselle.itemerness.editor.protocol

import java.math.BigDecimal
import java.util.Collections

/**
 * A small, strict JSON model.
 *
 * The editor protocol needs three things a general-purpose JSON binding does not give for free:
 * rejection of unknown fields, so a typo in a document is an error rather than silently dropped
 * data; bounded parsing, because a project document arrives over a network from a control plane;
 * and RFC 8785 canonical output, because the browser and this module must hash the same document
 * to the same string or the snapshot fence that stops a stale preview becomes a coin flip.
 *
 * Serialization is written by hand for the same reason the YAML loader and the font-metrics codec
 * are: the format is a contract, and a contract should be readable in one file.
 */
sealed interface JsonValue {
    data object Null : JsonValue

    data class Bool(val value: Boolean) : JsonValue

    /** Numbers keep their source text so canonical output never re-derives a different form. */
    data class Num(val value: Double) : JsonValue

    data class Text(val value: String) : JsonValue

    class Arr(values: List<JsonValue>) : JsonValue {
        val values: List<JsonValue> = java.util.List.copyOf(values)

        override fun equals(other: Any?): Boolean = other is Arr && values == other.values

        override fun hashCode(): Int = values.hashCode()

        override fun toString(): String = "Arr($values)"
    }

    class Obj(entries: Map<String, JsonValue>) : JsonValue {
        val entries: Map<String, JsonValue> = Collections.unmodifiableMap(LinkedHashMap(entries))

        override fun equals(other: Any?): Boolean = other is Obj && entries == other.entries

        override fun hashCode(): Int = entries.hashCode()

        override fun toString(): String = "Obj($entries)"
    }
}

class JsonException(message: String, cause: Throwable? = null) : RuntimeException(message, cause)

/** Parser limits. A control plane is authenticated, not trusted with unbounded recursion. */
object JsonLimits {
    const val MAXIMUM_DEPTH: Int = 64
    const val MAXIMUM_STRING_LENGTH: Int = 1 shl 20
    const val MAXIMUM_ELEMENTS: Int = 1 shl 20
}

object Json {
    fun parse(text: String): JsonValue {
        val parser = JsonParser(text)
        val value = parser.parseValue(0)
        parser.skipWhitespace()
        if (!parser.exhausted) parser.fail("trailing content")
        return value
    }

    /** RFC 8785 canonical form: sorted keys, no insignificant whitespace, ECMAScript numbers. */
    fun canonicalize(value: JsonValue): String = buildString { writeCanonical(value, this) }

    private fun writeCanonical(value: JsonValue, out: StringBuilder) {
        when (value) {
            is JsonValue.Null -> out.append("null")
            is JsonValue.Bool -> out.append(if (value.value) "true" else "false")
            is JsonValue.Num -> out.append(EcmaScriptNumbers.toString(value.value))
            is JsonValue.Text -> writeString(value.value, out)
            is JsonValue.Arr -> {
                out.append('[')
                value.values.forEachIndexed { index, element ->
                    if (index > 0) out.append(',')
                    writeCanonical(element, out)
                }
                out.append(']')
            }

            is JsonValue.Obj -> {
                out.append('{')
                // Kotlin's natural String ordering compares UTF-16 code units, which is what
                // RFC 8785 requires and what JavaScript's default sort produces.
                value.entries.keys.sorted().forEachIndexed { index, key ->
                    if (index > 0) out.append(',')
                    writeString(key, out)
                    out.append(':')
                    writeCanonical(value.entries.getValue(key), out)
                }
                out.append('}')
            }
        }
    }

    private fun writeString(value: String, out: StringBuilder) {
        out.append('"')
        for (character in value) {
            when (character) {
                '"' -> out.append("\\\"")
                '\\' -> out.append("\\\\")
                '\b' -> out.append("\\b")
                '\u000C' -> out.append("\\f")
                '\n' -> out.append("\\n")
                '\r' -> out.append("\\r")
                '\t' -> out.append("\\t")
                else ->
                    if (character < ' ') {
                        out.append("\\u").append(String.format("%04x", character.code))
                    } else {
                        out.append(character)
                    }
            }
        }
        out.append('"')
    }
}

/**
 * ECMAScript `Number::toString`.
 *
 * `Double.toString` on the JVM already produces the shortest round-tripping digits, but formats
 * them differently: `1.0` where JavaScript writes `1`, and `1.0E21` where JavaScript writes
 * `1e+21`. Canonical hashing cannot tolerate either difference, so the digits are reused and the
 * layout is redone according to the ECMAScript rule.
 */
internal object EcmaScriptNumbers {
    fun toString(value: Double): String {
        if (value.isNaN() || value.isInfinite()) throw JsonException("Non-finite numbers are not representable")
        if (value == 0.0) return "0"
        val negative = value < 0
        val magnitude = Math.abs(value)

        val (digits, pointPosition) = shortestDigits(magnitude)
        val length = digits.length
        val body =
            when {
                pointPosition in length..21 -> digits + "0".repeat(pointPosition - length)
                pointPosition in 1..21 -> digits.substring(0, pointPosition) + "." + digits.substring(pointPosition)
                pointPosition in -5..0 -> "0." + "0".repeat(-pointPosition) + digits
                else -> {
                    val exponent = pointPosition - 1
                    val mantissa = if (length == 1) digits else digits.substring(0, 1) + "." + digits.substring(1)
                    mantissa + "e" + (if (exponent >= 0) "+" else "-") + Math.abs(exponent)
                }
            }
        return if (negative) "-$body" else body
    }

    /**
     * Returns the shortest round-tripping digits and the position of the decimal point relative to
     * the start of those digits, so the value is `0.<digits> * 10^pointPosition`.
     */
    private fun shortestDigits(magnitude: Double): Pair<String, Int> {
        val text = java.lang.Double.toString(magnitude)
        val exponentIndex = text.indexOf('E')
        val mantissa = if (exponentIndex < 0) text else text.substring(0, exponentIndex)
        val exponent = if (exponentIndex < 0) 0 else text.substring(exponentIndex + 1).toInt()
        val dotIndex = mantissa.indexOf('.')
        val integerPart = mantissa.substring(0, dotIndex)
        val fractionPart = mantissa.substring(dotIndex + 1)

        val raw = (integerPart + fractionPart).trimStart('0')
        val leadingZeros = (integerPart + fractionPart).length - raw.length
        val digits = raw.trimEnd('0').ifEmpty { "0" }
        // Point position counted from the start of the significant digits.
        return digits to (integerPart.length + exponent - leadingZeros)
    }
}

private class JsonParser(private val source: String) {
    private var position = 0
    private var elements = 0

    val exhausted: Boolean get() = position >= source.length

    fun fail(detail: String): Nothing = throw JsonException("Invalid JSON at offset $position: $detail")

    fun skipWhitespace() {
        while (position < source.length) {
            when (source[position]) {
                ' ', '\t', '\n', '\r' -> position++
                else -> return
            }
        }
    }

    fun parseValue(depth: Int): JsonValue {
        if (depth > JsonLimits.MAXIMUM_DEPTH) fail("nesting exceeds ${JsonLimits.MAXIMUM_DEPTH}")
        if (++elements > JsonLimits.MAXIMUM_ELEMENTS) fail("document has too many values")
        skipWhitespace()
        if (exhausted) fail("unexpected end of document")
        return when (val character = source[position]) {
            '{' -> parseObject(depth)
            '[' -> parseArray(depth)
            '"' -> JsonValue.Text(parseString())
            't' -> literal("true", JsonValue.Bool(true))
            'f' -> literal("false", JsonValue.Bool(false))
            'n' -> literal("null", JsonValue.Null)
            else ->
                if (character == '-' || character in '0'..'9') {
                    parseNumber()
                } else {
                    fail("unexpected character '$character'")
                }
        }
    }

    private fun literal(text: String, value: JsonValue): JsonValue {
        if (!source.startsWith(text, position)) fail("expected $text")
        position += text.length
        return value
    }

    private fun parseObject(depth: Int): JsonValue {
        position++
        val entries = LinkedHashMap<String, JsonValue>()
        skipWhitespace()
        if (!exhausted && source[position] == '}') {
            position++
            return JsonValue.Obj(entries)
        }
        while (true) {
            skipWhitespace()
            if (exhausted || source[position] != '"') fail("expected an object key")
            val key = parseString()
            skipWhitespace()
            if (exhausted || source[position] != ':') fail("expected ':'")
            position++
            val value = parseValue(depth + 1)
            // A duplicate key means two writers disagree about the document; the last one silently
            // winning is how a review approves content that never ships.
            if (entries.put(key, value) != null) fail("duplicate object key \"$key\"")
            skipWhitespace()
            if (exhausted) fail("unterminated object")
            when (source[position]) {
                ',' -> position++
                '}' -> {
                    position++
                    return JsonValue.Obj(entries)
                }

                else -> fail("expected ',' or '}'")
            }
        }
    }

    private fun parseArray(depth: Int): JsonValue {
        position++
        val values = ArrayList<JsonValue>()
        skipWhitespace()
        if (!exhausted && source[position] == ']') {
            position++
            return JsonValue.Arr(values)
        }
        while (true) {
            values += parseValue(depth + 1)
            skipWhitespace()
            if (exhausted) fail("unterminated array")
            when (source[position]) {
                ',' -> position++
                ']' -> {
                    position++
                    return JsonValue.Arr(values)
                }

                else -> fail("expected ',' or ']'")
            }
        }
    }

    private fun parseString(): String {
        position++
        val builder = StringBuilder()
        while (true) {
            if (exhausted) fail("unterminated string")
            if (builder.length > JsonLimits.MAXIMUM_STRING_LENGTH) fail("string is too long")
            when (val character = source[position++]) {
                '"' -> return builder.toString()
                '\\' -> {
                    if (exhausted) fail("unterminated escape")
                    when (val escape = source[position++]) {
                        '"' -> builder.append('"')
                        '\\' -> builder.append('\\')
                        '/' -> builder.append('/')
                        'b' -> builder.append('\b')
                        'f' -> builder.append('\u000C')
                        'n' -> builder.append('\n')
                        'r' -> builder.append('\r')
                        't' -> builder.append('\t')
                        'u' -> {
                            if (position + 4 > source.length) fail("truncated unicode escape")
                            val code = source.substring(position, position + 4)
                            position += 4
                            builder.append(code.toIntOrNull(16)?.toChar() ?: fail("invalid unicode escape"))
                        }

                        else -> fail("invalid escape '\\$escape'")
                    }
                }

                else -> {
                    if (character < ' ') fail("unescaped control character")
                    builder.append(character)
                }
            }
        }
    }

    private fun parseNumber(): JsonValue {
        val start = position
        if (!exhausted && source[position] == '-') position++
        if (exhausted) fail("truncated number")
        if (source[position] == '0') {
            position++
        } else {
            if (source[position] !in '1'..'9') fail("invalid number")
            while (!exhausted && source[position] in '0'..'9') position++
        }
        if (!exhausted && source[position] == '.') {
            position++
            if (exhausted || source[position] !in '0'..'9') fail("invalid fraction")
            while (!exhausted && source[position] in '0'..'9') position++
        }
        if (!exhausted && (source[position] == 'e' || source[position] == 'E')) {
            position++
            if (!exhausted && (source[position] == '+' || source[position] == '-')) position++
            if (exhausted || source[position] !in '0'..'9') fail("invalid exponent")
            while (!exhausted && source[position] in '0'..'9') position++
        }
        val text = source.substring(start, position)
        val value = text.toDoubleOrNull() ?: fail("number is out of range")
        if (!value.isFinite()) fail("number is out of range")
        return JsonValue.Num(value)
    }
}

/** Strict accessors, mirroring the YAML loader's fail-closed style. */
class JsonObject internal constructor(
    private val value: JsonValue.Obj,
    private val path: String,
) {
    val keys: Set<String> get() = value.entries.keys

    fun contains(key: String): Boolean = key in value.entries

    fun rejectUnknown(vararg allowed: String): JsonObject {
        val unknown = value.entries.keys - allowed.toSet()
        if (unknown.isNotEmpty()) {
            throw JsonException("Unknown ${if (unknown.size == 1) "key" else "keys"} ${unknown.sorted().joinToString()} at $path")
        }
        return this
    }

    fun requiredObject(key: String): JsonObject {
        val child = required(key)
        if (child !is JsonValue.Obj) throw typeError(key, "an object")
        return JsonObject(child, "$path.$key")
    }

    fun optionalObject(key: String): JsonObject? =
        if (isAbsent(key)) null else requiredObject(key)

    fun requiredArray(key: String): List<JsonValue> {
        val child = required(key)
        if (child !is JsonValue.Arr) throw typeError(key, "an array")
        return child.values
    }

    fun optionalArray(key: String): List<JsonValue>? = if (isAbsent(key)) null else requiredArray(key)

    fun requiredObjects(key: String): List<JsonObject> =
        requiredArray(key).mapIndexed { index, element ->
            if (element !is JsonValue.Obj) throw JsonException("Expected an object at $path.$key[$index]")
            JsonObject(element, "$path.$key[$index]")
        }

    fun optionalObjects(key: String): List<JsonObject> = if (isAbsent(key)) emptyList() else requiredObjects(key)

    fun requiredString(key: String): String {
        val child = required(key)
        if (child !is JsonValue.Text) throw typeError(key, "a string")
        return child.value
    }

    fun optionalString(key: String): String? = if (isAbsent(key)) null else requiredString(key)

    fun requiredStrings(key: String): List<String> =
        requiredArray(key).mapIndexed { index, element ->
            if (element !is JsonValue.Text) throw JsonException("Expected a string at $path.$key[$index]")
            element.value
        }

    fun optionalStrings(key: String): List<String> = if (isAbsent(key)) emptyList() else requiredStrings(key)

    fun requiredInt(key: String): Int {
        val number = requiredDouble(key)
        if (number != Math.floor(number) || number < Int.MIN_VALUE || number > Int.MAX_VALUE) {
            throw typeError(key, "a 32-bit integer")
        }
        return number.toInt()
    }

    fun optionalInt(key: String): Int? = if (isAbsent(key)) null else requiredInt(key)

    fun requiredDouble(key: String): Double {
        val child = required(key)
        if (child !is JsonValue.Num) throw typeError(key, "a number")
        return child.value
    }

    fun optionalDouble(key: String): Double? = if (isAbsent(key)) null else requiredDouble(key)

    fun requiredBoolean(key: String): Boolean {
        val child = required(key)
        if (child !is JsonValue.Bool) throw typeError(key, "a boolean")
        return child.value
    }

    fun optionalBoolean(key: String, fallback: Boolean): Boolean =
        if (isAbsent(key)) fallback else requiredBoolean(key)

    /** 64-bit integers travel as decimal strings; a JSON number would lose precision past 2^53. */
    fun requiredLongString(key: String): Long =
        requiredString(key).toLongOrNull() ?: throw typeError(key, "a 64-bit integer in decimal form")

    fun requiredDecimalString(key: String): BigDecimal =
        try {
            BigDecimal(requiredString(key))
        } catch (exception: NumberFormatException) {
            throw typeError(key, "a decimal literal")
        }

    fun optionalDecimalString(key: String): BigDecimal? = if (isAbsent(key)) null else requiredDecimalString(key)

    fun raw(key: String): JsonValue? = value.entries[key]

    private fun isAbsent(key: String): Boolean {
        val child = value.entries[key] ?: return true
        return child is JsonValue.Null
    }

    private fun required(key: String): JsonValue =
        value.entries[key]?.takeIf { it !is JsonValue.Null }
            ?: throw JsonException("Missing required key $path.$key")

    private fun typeError(key: String, expected: String): JsonException =
        JsonException("Expected $expected at $path.$key")

    companion object {
        fun of(value: JsonValue, path: String = "$"): JsonObject {
            if (value !is JsonValue.Obj) throw JsonException("Expected an object at $path")
            return JsonObject(value, path)
        }

        fun parse(text: String, path: String = "$"): JsonObject = of(Json.parse(text), path)
    }
}
