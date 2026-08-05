package com.iroselle.itemerness.bukkit.config

internal class YamlObject private constructor(
    private val values: Map<String, Any?>,
    private val source: String,
    private val path: String,
) {
    val keys: Set<String>
        get() = values.keys

    fun contains(key: String): Boolean = key in values

    fun raw(key: String): Any? = values[key]

    fun rejectUnknown(vararg allowed: String): YamlObject {
        val unknown = values.keys - allowed.toSet()
        if (unknown.isNotEmpty()) {
            throw StrictYamlException(
                "Unknown ${if (unknown.size == 1) "key" else "keys"} " +
                    "${unknown.sorted().joinToString()} at $path in $source",
            )
        }
        return this
    }

    fun requiredObject(key: String): YamlObject {
        val value = required(key)
        if (value !is Map<*, *>) {
            throw typeError(key, "a mapping")
        }
        @Suppress("UNCHECKED_CAST")
        return YamlObject(value as Map<String, Any?>, source, childPath(key))
    }

    fun optionalObject(key: String): YamlObject? {
        if (key !in values || values[key] == null) return null
        return requiredObject(key)
    }

    fun requiredList(key: String): List<Any?> =
        required(key) as? List<*> ?: throw typeError(key, "a sequence")

    fun optionalList(key: String): List<Any?>? {
        if (key !in values || values[key] == null) return null
        return requiredList(key)
    }

    fun requiredString(key: String): String =
        required(key) as? String ?: throw typeError(key, "a string")

    fun requiredInt(key: String): Int {
        val value = required(key)
        return when (value) {
            is Byte -> value.toInt()
            is Short -> value.toInt()
            is Int -> value
            is Long -> value.takeIf { it in Int.MIN_VALUE..Int.MAX_VALUE }?.toInt()
            else -> null
        } ?: throw typeError(key, "a 32-bit integer")
    }

    fun optionalInt(key: String): Int? {
        if (key !in values || values[key] == null) return null
        return requiredInt(key)
    }

    fun requiredBoolean(key: String): Boolean =
        required(key) as? Boolean ?: throw typeError(key, "a boolean")

    fun optionalBoolean(
        key: String,
        default: Boolean,
    ): Boolean = if (key in values) requiredBoolean(key) else default

    fun child(
        key: String,
        value: Any?,
    ): YamlObject {
        if (value !is Map<*, *>) {
            throw typeError(key, "a mapping")
        }
        @Suppress("UNCHECKED_CAST")
        return YamlObject(value as Map<String, Any?>, source, childPath(key))
    }

    fun optionalString(key: String): String? {
        if (key !in values || values[key] == null) return null
        return values[key] as? String ?: throw typeError(key, "a string or null")
    }

    private fun required(key: String): Any? {
        if (key !in values) {
            throw StrictYamlException("Missing required key ${childPath(key)} in $source")
        }
        return values[key]
    }

    private fun typeError(
        key: String,
        expected: String,
    ): StrictYamlException = StrictYamlException("${childPath(key)} in $source must be $expected")

    private fun childPath(key: String): String = "$path.$key"

    companion object {
        fun root(
            values: Map<String, Any?>,
            source: String,
        ): YamlObject = YamlObject(values, source, "\$")
    }
}
