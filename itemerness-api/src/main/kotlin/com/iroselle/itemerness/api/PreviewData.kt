package com.iroselle.itemerness.api

/**
 * Supplies the instance data a plugin would compute for an item, so editor previews can show it
 * without copying computed values into the catalog.
 *
 * A provider is the plugin's own runtime calculation, called with a draft definition and a
 * scenario instead of a live stack. It returns typed values; Itemerness formats, lays out and
 * renders them exactly as it renders the same values written through `editDomainInstance`.
 *
 * Calls run on the editor API's asynchronous worker, never on a region thread, and must finish
 * within a short deadline. Implementations must therefore be pure over their inputs and an
 * immutable snapshot of the plugin's own configuration: no world, entity, player, inventory or
 * `ItemStack` access, no scheduling onto a region thread and waiting for it, and safe concurrent
 * use. Results exist only for one preview compilation; they are never saved to a draft, exported
 * or applied to an item.
 */
interface PreviewDataProvider {
    /**
     * Changes whenever the provider's configuration changes, for example on reload. It is part of
     * every preview cache key, so earlier previews become stale instead of being shown as current.
     */
    val revision: String

    /** The scenarios offered for [item]. A provider without scenarios for an item returns none. */
    fun scenarios(item: PreviewItem): List<PreviewScenario>

    /** Computes the values for one scenario. Parameters are already validated against its declaration. */
    fun provide(request: PreviewDataRequest): PreviewDataResult
}

/**
 * A read-only view of the draft definition being previewed, including unsaved editor changes.
 *
 * Compute from this object rather than from the deployed definition with the same key; otherwise
 * the preview silently shows the deployed item.
 */
interface PreviewItem {
    val definition: ItemDefinition

    /**
     * Reads one definition-scope value of the draft, schema defaults included, with the same
     * per-key authorization as `readData`.
     */
    fun readData(key: DataKey): ApiCallResult<ItemDataValue?>
}

/** One named configuration of inputs, such as a base template or an enhanced build. */
class PreviewScenario(
    val id: String,
    val label: String,
    parameters: List<PreviewParameter> = emptyList(),
    val description: String? = null,
) {
    val parameters: List<PreviewParameter> = java.util.List.copyOf(parameters)

    init {
        require(ID.matches(id)) { "Preview scenario ids are lowercase identifiers: $id" }
        require(label.isNotBlank() && label.length <= MAX_TEXT) { "Preview scenario labels must be 1-$MAX_TEXT characters" }
        require(description == null || description.length <= MAX_DESCRIPTION) { "Preview scenario descriptions are at most $MAX_DESCRIPTION characters" }
        require(this.parameters.size <= MAX_PARAMETERS) { "A preview scenario has at most $MAX_PARAMETERS parameters" }
        require(this.parameters.map(PreviewParameter::id).toSet().size == this.parameters.size) { "Preview parameter ids must be unique" }
    }

    internal companion object {
        val ID = Regex("[a-z0-9][a-z0-9._/-]{0,63}")
        const val MAX_TEXT = 128
        const val MAX_DESCRIPTION = 1024
        const val MAX_PARAMETERS = 32
    }
}

/**
 * A typed scenario input. Omitted optional parameters are absent from the request, so the provider
 * applies its own default; [defaultValue] is only what the editor shows as a hint.
 */
class PreviewParameter(
    val id: String,
    val label: String,
    val type: PreviewParameterType,
    val optional: Boolean = true,
    /** Allowed values for text and key parameters (or their list elements); the editor offers them instead of free text. */
    choices: List<String> = emptyList(),
    /** Inclusive bounds for numeric parameters (or their list elements). */
    val minimum: Double? = null,
    val maximum: Double? = null,
    val defaultValue: ItemDataValue? = null,
) {
    val choices: List<String> = java.util.List.copyOf(choices)

    init {
        require(PreviewScenario.ID.matches(id)) { "Preview parameter ids are lowercase identifiers: $id" }
        require(label.isNotBlank() && label.length <= PreviewScenario.MAX_TEXT) { "Preview parameter labels must be 1-${PreviewScenario.MAX_TEXT} characters" }
        require(this.choices.size <= MAX_CHOICES && this.choices.all { it.isNotEmpty() && it.length <= PreviewScenario.MAX_TEXT }) {
            "A preview parameter has at most $MAX_CHOICES choices of 1-${PreviewScenario.MAX_TEXT} characters"
        }
        // On a list parameter, choices and bounds apply to its elements.
        val element = (type as? PreviewParameterType.ListOf)?.element ?: type
        require(this.choices.isEmpty() || element == PreviewParameterType.TextType || element == PreviewParameterType.KeyType) {
            "Choices apply to text and key parameters"
        }
        require((minimum == null && maximum == null) || element.numeric) { "Bounds apply to numeric parameters" }
        require(minimum == null || maximum == null || minimum <= maximum) { "Preview parameter minimum exceeds maximum" }
    }

    private companion object {
        const val MAX_CHOICES = 256
    }
}

/** The value shapes a scenario parameter may take; they mirror data key types. */
sealed interface PreviewParameterType {
    val numeric: kotlin.Boolean get() = false

    data object IntegerType : PreviewParameterType { override val numeric: kotlin.Boolean get() = true }
    data object LongType : PreviewParameterType { override val numeric: kotlin.Boolean get() = true }
    data object DecimalType : PreviewParameterType { override val numeric: kotlin.Boolean get() = true }
    data object BooleanType : PreviewParameterType
    data object TextType : PreviewParameterType
    data object KeyType : PreviewParameterType

    class ListOf(val element: PreviewParameterType, val maximumSize: Int = 64) : PreviewParameterType {
        init {
            require(maximumSize in 1..256) { "Preview list parameters hold 1-256 elements" }
            require(element !is ListOf) { "Preview list parameters cannot nest lists" }
        }
    }

    class Compound(fields: List<PreviewParameter>) : PreviewParameterType {
        val fields: List<PreviewParameter> = java.util.List.copyOf(fields)

        init {
            require(this.fields.isNotEmpty() && this.fields.size <= 16) { "Preview compound parameters have 1-16 fields" }
            require(this.fields.map(PreviewParameter::id).toSet().size == this.fields.size) { "Compound field ids must be unique" }
            require(this.fields.none { it.type is Compound || it.type is ListOf }) { "Compound fields are scalars" }
        }
    }
}

class PreviewDataRequest(
    val item: PreviewItem,
    val scenario: String,
    parameters: Map<String, ItemDataValue>,
    /** The viewer locale being previewed, for providers whose values depend on it. */
    val locale: String,
) {
    val parameters: Map<String, ItemDataValue> = java.util.Map.copyOf(parameters)
}

/**
 * Computed instance values keyed by data key. Return only values that are set: a key without a
 * value is simply absent, as on a fresh stack. Each key must be writable by the provider's plugin.
 */
class PreviewDataResult(
    values: Map<DataKey, ItemDataValue>,
    /** Short plain-text notes shown with the preview, for example a parameter the provider ignored. */
    messages: List<String> = emptyList(),
) {
    val values: Map<DataKey, ItemDataValue> = java.util.Map.copyOf(values)
    val messages: List<String> = java.util.List.copyOf(messages)
}

/** The live registration of a provider; [unregister] is idempotent. Plugin disable also ends it. */
interface PreviewDataRegistration {
    fun unregister()
}
