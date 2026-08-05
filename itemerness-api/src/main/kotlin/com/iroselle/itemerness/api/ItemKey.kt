package com.iroselle.itemerness.api

/** A stable, namespaced identifier for an Itemerness item definition. */
data class ItemKey(
    val namespace: String,
    val value: String,
) {
    init {
        require(NAMESPACE_PATTERN.matches(namespace)) {
            "Item namespace must match ${NAMESPACE_PATTERN.pattern}: $namespace"
        }
        require(VALUE_PATTERN.matches(value)) {
            "Item value must match ${VALUE_PATTERN.pattern}: $value"
        }
    }

    override fun toString(): String = "$namespace:$value"

    companion object {
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
