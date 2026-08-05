package com.iroselle.itemerness.api

/** A stable, namespaced identifier for an Itemerness item definition. */
data class ItemKey(
    val namespace: String,
    val value: String,
) {
    init {
        require(namespace.length <= MAX_NAMESPACE_LENGTH) {
            "Item namespace must not exceed $MAX_NAMESPACE_LENGTH characters"
        }
        require(namespace.length + 1 + value.length <= MAX_KEY_LENGTH) {
            "Item key must not exceed $MAX_KEY_LENGTH characters"
        }
        require(NAMESPACE_PATTERN.matches(namespace)) {
            "Item namespace must match ${NAMESPACE_PATTERN.pattern}: $namespace"
        }
        require(VALUE_PATTERN.matches(value)) {
            "Item value must match ${VALUE_PATTERN.pattern}: $value"
        }
    }

    override fun toString(): String = "$namespace:$value"

    companion object {
        private const val MAX_NAMESPACE_LENGTH = 64
        private const val MAX_KEY_LENGTH = 256
        private val NAMESPACE_PATTERN = Regex("[a-z0-9._-]+")
        private val VALUE_PATTERN = Regex("[a-z0-9/._-]+")

        @JvmStatic
        fun parse(input: String): ItemKey {
            val separator = input.indexOf(':')
            require(separator > 0 && separator == input.lastIndexOf(':') && separator < input.lastIndex) {
                "Item key must use the namespace:value form: $input"
            }
            return ItemKey(
                namespace = input.substring(0, separator),
                value = input.substring(separator + 1),
            )
        }
    }
}
