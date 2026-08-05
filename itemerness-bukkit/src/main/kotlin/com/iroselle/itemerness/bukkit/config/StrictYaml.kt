package com.iroselle.itemerness.bukkit.config

import org.yaml.snakeyaml.LoaderOptions
import org.yaml.snakeyaml.Yaml
import org.yaml.snakeyaml.constructor.SafeConstructor
import org.yaml.snakeyaml.error.YAMLException
import java.io.Reader
import java.nio.file.Files
import java.nio.file.Path
import java.util.Collections

internal class StrictYamlException(
    message: String,
    cause: Throwable? = null,
) : IllegalArgumentException(message, cause)

/**
 * Loads untrusted catalog YAML without object construction, aliases, duplicate keys, or mutable
 * collections escaping into a published catalog candidate.
 */
internal object StrictYaml {
    private const val MAX_CODE_POINTS = 1_000_000
    private const val MAX_DEPTH = 64
    private const val MAX_NODES = 100_000

    fun load(path: Path): Map<String, Any?> =
        Files.newBufferedReader(path, Charsets.UTF_8).use { reader ->
            load(reader, path.toString())
        }

    fun load(
        reader: Reader,
        source: String,
    ): Map<String, Any?> {
        val options = LoaderOptions().apply {
            isAllowDuplicateKeys = false
            isWarnOnDuplicateKeys = false
            maxAliasesForCollections = 0
            nestingDepthLimit = MAX_DEPTH
            codePointLimit = MAX_CODE_POINTS
        }
        val loaded = try {
            Yaml(SafeConstructor(options)).load<Any?>(reader)
        } catch (exception: YAMLException) {
            throw StrictYamlException("Invalid YAML in $source: ${exception.message}", exception)
        }
        if (loaded !is Map<*, *>) {
            throw StrictYamlException("YAML root in $source must be a mapping")
        }

        val budget = NodeBudget(MAX_NODES)
        @Suppress("UNCHECKED_CAST")
        return freeze(loaded, source, "\$", 0, budget) as Map<String, Any?>
    }

    private fun freeze(
        value: Any?,
        source: String,
        path: String,
        depth: Int,
        budget: NodeBudget,
    ): Any? {
        if (depth > MAX_DEPTH) {
            throw StrictYamlException("YAML in $source exceeds the maximum depth at $path")
        }
        budget.consume(source, path)

        return when (value) {
            null,
            is String,
            is Boolean,
            is Byte,
            is Short,
            is Int,
            is Long,
            is Float,
            is Double,
            is java.math.BigInteger,
            is java.math.BigDecimal,
            -> value

            is Map<*, *> -> {
                val copy = LinkedHashMap<String, Any?>(value.size)
                value.forEach { (rawKey, child) ->
                    val key = rawKey as? String
                        ?: throw StrictYamlException("Mapping key at $path in $source must be a string")
                    copy[key] = freeze(child, source, childPath(path, key), depth + 1, budget)
                }
                Collections.unmodifiableMap(copy)
            }

            is List<*> -> {
                val copy = value.mapIndexed { index, child ->
                    freeze(child, source, "$path[$index]", depth + 1, budget)
                }
                Collections.unmodifiableList(copy)
            }

            else -> throw StrictYamlException(
                "Unsupported YAML value ${value.javaClass.name} at $path in $source",
            )
        }
    }

    private fun childPath(
        parent: String,
        key: String,
    ): String = if (key.matches(Regex("[A-Za-z0-9_-]+"))) {
        "$parent.$key"
    } else {
        "$parent['${key.replace("'", "\\'")}']"
    }

    private class NodeBudget(
        private var remaining: Int,
    ) {
        fun consume(
            source: String,
            path: String,
        ) {
            remaining -= 1
            if (remaining < 0) {
                throw StrictYamlException("YAML in $source exceeds the node limit at $path")
            }
        }
    }
}
