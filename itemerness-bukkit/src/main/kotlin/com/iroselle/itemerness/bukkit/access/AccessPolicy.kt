package com.iroselle.itemerness.bukkit.access

import com.iroselle.itemerness.api.ApiAction
import com.iroselle.itemerness.api.ItemKey
import com.iroselle.itemerness.bukkit.config.StrictYaml
import com.iroselle.itemerness.bukkit.config.StrictYamlException
import com.iroselle.itemerness.bukkit.config.YamlObject
import java.nio.file.Path
import java.util.Collections
import java.util.EnumMap
import java.util.LinkedHashSet
import java.util.Locale

internal enum class AccessDecision {
    ALLOW,
    DENY,
    SCHEMA_POLICY,
}

internal class AccessGrant(
    pluginName: String,
    actions: Collection<ApiAction>,
    itemNamespaces: Collection<String>,
    dataNamespaces: Collection<String>,
    viewerFactNamespaces: Collection<String> = emptyList(),
) {
    val pluginName: String = pluginName
    val actions: Set<ApiAction> = immutableSet(actions)
    val itemNamespaces: Set<String> = immutableSet(itemNamespaces)
    val dataNamespaces: Set<String> = immutableSet(dataNamespaces)
    val viewerFactNamespaces: Set<String> = immutableSet(viewerFactNamespaces)
    private val normalizedPluginName: String = normalizePluginName(pluginName)

    init {
        require(pluginName.isNotBlank()) { "Plugin name must not be blank" }
        require(actions.isNotEmpty()) { "Grant actions must not be empty" }
        require(actions.all { it == ApiAction.WRITE_VIEWER_FACT } || itemNamespaces.isNotEmpty()) {
            "Grant item namespaces must not be empty for item actions"
        }
        require(actions.none { it == ApiAction.READ_DATA || it == ApiAction.EDIT_DATA } || dataNamespaces.isNotEmpty()) {
            "Grant data namespaces must not be empty for data actions"
        }
        require(ApiAction.WRITE_VIEWER_FACT !in actions || viewerFactNamespaces.isNotEmpty()) {
            "Grant viewer fact namespaces must not be empty for viewer-fact writes"
        }
    }

    fun matches(
        callerPluginName: String,
        action: ApiAction,
        itemNamespace: String?,
        dataNamespace: String?,
    ): Boolean {
        if (normalizedPluginName != normalizePluginName(callerPluginName) || action !in actions) {
            return false
        }
        return when (action) {
            ApiAction.WRITE_VIEWER_FACT ->
                itemNamespace != null && itemNamespace in viewerFactNamespaces

            ApiAction.READ_DATA,
            ApiAction.EDIT_DATA,
            -> itemNamespace != null &&
                itemNamespace in itemNamespaces &&
                dataNamespace != null &&
                dataNamespace in dataNamespaces

            else -> itemNamespace != null && itemNamespace in itemNamespaces
        }
    }
}

internal class AccessPolicy(
    defaults: Map<ApiAction, AccessDecision>,
    grants: Collection<AccessGrant>,
) {
    val defaults: Map<ApiAction, AccessDecision>
    val grants: List<AccessGrant> = java.util.List.copyOf(grants)

    init {
        require(defaults.keys == ApiAction.entries.toSet()) {
            "Access defaults must define every API action"
        }
        require(defaults.filterKeys { it != ApiAction.READ_DATA }.values.none { it == AccessDecision.SCHEMA_POLICY }) {
            "schema-policy is only valid for read-data"
        }
        val copy = EnumMap<ApiAction, AccessDecision>(ApiAction::class.java)
        copy.putAll(defaults)
        this.defaults = Collections.unmodifiableMap(copy)
    }

    /** Matching grants take precedence over the default for that action. */
    fun decide(
        callerPluginName: String,
        action: ApiAction,
        itemNamespace: String?,
        dataNamespace: String? = null,
    ): AccessDecision {
        if (grants.any { it.matches(callerPluginName, action, itemNamespace, dataNamespace) }) {
            return AccessDecision.ALLOW
        }
        return defaults.getValue(action)
    }
}

internal object AccessPolicyLoader {
    private const val SUPPORTED_CONFIG_VERSION = 1

    fun load(path: Path): AccessPolicy = from(StrictYaml.load(path), path.toString())

    fun from(
        document: Map<String, Any?>,
        source: String,
    ): AccessPolicy {
        val root = YamlObject.root(document, source).rejectUnknown("config-version", "api")
        val version = root.requiredInt("config-version")
        if (version != SUPPORTED_CONFIG_VERSION) {
            throw StrictYamlException("Unsupported access config version $version in $source")
        }

        val api = root.requiredObject("api").rejectUnknown("defaults", "grants")
        val defaultsNode = api.requiredObject("defaults").rejectUnknown(
            "identify",
            "create",
            "read-data",
            "edit-data",
            "write-viewer-fact",
            "request-refresh",
        )
        val defaults = ApiAction.entries.associateWith { action ->
            val key = action.configKey()
            parseDefault(action, defaultsNode.requiredString(key), "api.defaults.$key", source)
        }

        val grants = api.requiredList("grants").mapIndexed { index, value ->
            val path = "api.grants[$index]"
            if (value !is Map<*, *>) {
                throw StrictYamlException("$path in $source must be a mapping")
            }
            @Suppress("UNCHECKED_CAST")
            val grant = YamlObject.root(value as Map<String, Any?>, "$source $path").rejectUnknown(
                "plugin",
                "actions",
                "item-namespaces",
                "data-namespaces",
                "viewer-fact-namespaces",
            )
            val pluginName = grant.requiredString("plugin")
            validatePluginName(pluginName, "$path.plugin", source)
            val actionNames = stringSet(grant.requiredList("actions"), "$path.actions", source)
            val actions = actionNames.mapTo(LinkedHashSet()) { rawAction ->
                ApiAction.entries.firstOrNull { it.configKey() == rawAction }
                    ?: throw StrictYamlException("Unknown API action '$rawAction' at $path.actions in $source")
            }
            val itemNamespaces = namespaceSet(
                stringSet(grant.optionalList("item-namespaces").orEmpty(), "$path.item-namespaces", source),
                "$path.item-namespaces",
                source,
            )
            val dataNamespaces = namespaceSet(
                stringSet(grant.optionalList("data-namespaces").orEmpty(), "$path.data-namespaces", source),
                "$path.data-namespaces",
                source,
            )
            val viewerFactNamespaces = namespaceSet(
                stringSet(
                    grant.optionalList("viewer-fact-namespaces").orEmpty(),
                    "$path.viewer-fact-namespaces",
                    source,
                ),
                "$path.viewer-fact-namespaces",
                source,
            )
            if (actions.isEmpty()) throw StrictYamlException("$path.actions in $source must not be empty")
            if (actions.any { it != ApiAction.WRITE_VIEWER_FACT } && itemNamespaces.isEmpty()) {
                throw StrictYamlException("$path.item-namespaces in $source must not be empty for item actions")
            }
            if (actions.any { it == ApiAction.READ_DATA || it == ApiAction.EDIT_DATA } && dataNamespaces.isEmpty()) {
                throw StrictYamlException("$path.data-namespaces in $source must not be empty for data actions")
            }
            if (ApiAction.WRITE_VIEWER_FACT in actions && viewerFactNamespaces.isEmpty()) {
                throw StrictYamlException(
                    "$path.viewer-fact-namespaces in $source must not be empty for viewer-fact writes",
                )
            }
            AccessGrant(pluginName, actions, itemNamespaces, dataNamespaces, viewerFactNamespaces)
        }
        return AccessPolicy(defaults, grants)
    }

    private fun parseDefault(
        action: ApiAction,
        value: String,
        path: String,
        source: String,
    ): AccessDecision = when (value) {
        "allow" -> AccessDecision.ALLOW
        "deny" -> AccessDecision.DENY
        "schema-policy" -> if (action == ApiAction.READ_DATA) {
            AccessDecision.SCHEMA_POLICY
        } else {
            throw StrictYamlException("schema-policy is only valid for read-data at $path in $source")
        }
        else -> throw StrictYamlException("Unknown access default '$value' at $path in $source")
    }

    private fun stringSet(
        values: List<Any?>,
        path: String,
        source: String,
    ): Set<String> {
        val result = LinkedHashSet<String>()
        values.forEachIndexed { index, value ->
            val text = value as? String
                ?: throw StrictYamlException("$path[$index] in $source must be a string")
            if (!result.add(text)) {
                throw StrictYamlException("Duplicate value '$text' at $path in $source")
            }
        }
        return result
    }

    private fun namespaceSet(
        values: Set<String>,
        path: String,
        source: String,
    ): Set<String> {
        values.forEachIndexed { index, namespace ->
            try {
                ItemKey(namespace, "validation")
            } catch (exception: IllegalArgumentException) {
                throw StrictYamlException("Invalid namespace '$namespace' at $path[$index] in $source", exception)
            }
        }
        return values
    }

    private fun validatePluginName(
        value: String,
        path: String,
        source: String,
    ) {
        if (value.length !in 1..64 || !PLUGIN_NAME_PATTERN.matches(value)) {
            throw StrictYamlException("Invalid Bukkit plugin name '$value' at $path in $source")
        }
    }

    private val PLUGIN_NAME_PATTERN = Regex("[A-Za-z0-9_.-]+")
}

internal fun ApiAction.configKey(): String = when (this) {
    ApiAction.IDENTIFY -> "identify"
    ApiAction.CREATE -> "create"
    ApiAction.READ_DATA -> "read-data"
    ApiAction.EDIT_DATA -> "edit-data"
    ApiAction.WRITE_VIEWER_FACT -> "write-viewer-fact"
    ApiAction.REQUEST_REFRESH -> "request-refresh"
}

internal fun normalizePluginName(value: String): String = value.lowercase(Locale.ROOT)

private fun <T> immutableSet(source: Collection<T>): Set<T> =
    Collections.unmodifiableSet(LinkedHashSet(source))
