package com.iroselle.itemerness.bukkit.access

import com.iroselle.itemerness.api.ApiAction
import com.iroselle.itemerness.api.ApiCallResult
import com.iroselle.itemerness.api.ApiDenialReason
import com.iroselle.itemerness.api.DataKey
import com.iroselle.itemerness.api.ItemKey
import com.iroselle.itemerness.bukkit.api.AuthenticatedPluginCaller
import com.iroselle.itemerness.bukkit.catalog.DataKeyIntegration
import com.iroselle.itemerness.bukkit.catalog.DataReadAccess
import com.iroselle.itemerness.bukkit.catalog.LoadedCatalogSource
import com.iroselle.itemerness.core.catalog.DataScope
import org.bukkit.plugin.Plugin
import java.util.Collections
import java.util.TreeMap

internal fun interface OwnerAccessResolver {
    /** Called only after the plugin lifecycle identity and both namespace grants have been checked. */
    fun isOwner(
        callerPluginName: String,
        itemKey: ItemKey,
        dataKey: DataKey,
    ): Boolean
}

internal class DataAccessRule(
    val scope: DataScope,
    val readAccess: DataReadAccess,
    writePrincipals: Collection<String>,
) {
    val writePrincipals: Set<String> =
        Collections.unmodifiableSet(LinkedHashSet(writePrincipals))
}

internal class DataAccessRuleIndex private constructor(
    rules: Map<DataKey, DataAccessRule>,
) {
    private val rules: Map<DataKey, DataAccessRule> =
        Collections.unmodifiableMap(TreeMap(rules))

    operator fun get(key: DataKey): DataAccessRule? = rules[key]

    companion object {
        fun from(source: LoadedCatalogSource): DataAccessRuleIndex {
            val scopes = TreeMap<DataKey, DataScope>()
            source.source.schemas.forEach { schema ->
                schema.keys.forEach { definition ->
                    val key = DataKey.parse(definition.id)
                    val previous = scopes.putIfAbsent(key, definition.scope)
                    require(previous == null || previous == definition.scope) {
                        "Data key $key changes scope across schema versions"
                    }
                }
            }
            val rules = source.dataKeyIntegrations.mapKeys { (key, _) -> DataKey(key) }.mapValues { (key, integration) ->
                val scope = requireNotNull(scopes[key]) {
                    "Integration policy exists for unknown data key $key"
                }
                integration.toRule(scope)
            }
            require(scopes.keys == rules.keys) {
                "Every data key must have exactly one integration policy"
            }
            return DataAccessRuleIndex(rules)
        }

        internal fun of(rules: Map<DataKey, DataAccessRule>): DataAccessRuleIndex =
            DataAccessRuleIndex(rules)
    }
}

internal class DataAccessAuthorizer(
    private val ownerPlugin: Plugin,
    private val accessPolicy: AccessPolicy,
    private val rules: DataAccessRuleIndex,
    private val ownerResolver: OwnerAccessResolver? = null,
) {
    fun authorizeRead(
        caller: AuthenticatedPluginCaller,
        itemKey: ItemKey,
        dataKey: DataKey,
    ): ApiCallResult<Unit> {
        inactiveCaller(caller)?.let { return it }
        if (
            accessPolicy.decide(
                callerPluginName = caller.pluginName,
                action = ApiAction.READ_DATA,
                itemNamespace = itemKey.namespace,
                dataNamespace = dataKey.id.namespace,
            ) == AccessDecision.DENY
        ) {
            return denied(ApiDenialReason.ACTION_DENIED, "read-data is not granted for these namespaces")
        }
        val rule = rules[dataKey]
            ?: return denied(ApiDenialReason.DATA_KEY_NOT_FOUND, "The data key is not present in the active catalog")
        return when (rule.readAccess) {
            DataReadAccess.PUBLIC -> ApiCallResult.Success(Unit)
            DataReadAccess.INTERNAL -> if (caller.isSamePlugin(ownerPlugin)) {
                ApiCallResult.Success(Unit)
            } else {
                denied(ApiDenialReason.DATA_KEY_READ_DENIED, "The data key is internal")
            }
            DataReadAccess.OWNER_ONLY -> {
                val resolver = ownerResolver
                    ?: return denied(
                        ApiDenialReason.OWNER_CONTEXT_REQUIRED,
                        "Owner-only data requires an explicit ownership resolver",
                    )
                val isOwner = runCatching {
                    resolver.isOwner(caller.pluginName, itemKey, dataKey)
                }.getOrDefault(false)
                if (isOwner) {
                    ApiCallResult.Success(Unit)
                } else {
                    denied(ApiDenialReason.NOT_OWNER, "The authenticated caller does not own this data")
                }
            }
        }
    }

    fun authorizeInstanceWrite(
        caller: AuthenticatedPluginCaller,
        itemKey: ItemKey,
        dataKey: DataKey,
    ): ApiCallResult<Unit> {
        inactiveCaller(caller)?.let { return it }
        if (
            accessPolicy.decide(
                callerPluginName = caller.pluginName,
                action = ApiAction.EDIT_DATA,
                itemNamespace = itemKey.namespace,
                dataNamespace = dataKey.id.namespace,
            ) == AccessDecision.DENY
        ) {
            return denied(ApiDenialReason.ACTION_DENIED, "edit-data is not granted for these namespaces")
        }
        val rule = rules[dataKey]
            ?: return denied(ApiDenialReason.DATA_KEY_NOT_FOUND, "The data key is not present in the active catalog")
        if (rule.scope == DataScope.DEFINITION) {
            return denied(
                ApiDenialReason.DEFINITION_DATA_IMMUTABLE,
                "Definition-scoped data cannot be modified through an instance operation",
            )
        }
        val writerAllowed = rule.writePrincipals.any { principal ->
            when {
                principal == "internal" -> caller.isSamePlugin(ownerPlugin)
                principal == "definition" -> false
                principal.startsWith("plugin:") ->
                    normalizePluginName(principal.substringAfter(':')) == normalizePluginName(caller.pluginName)
                else -> false
            }
        }
        return if (writerAllowed) {
            ApiCallResult.Success(Unit)
        } else {
            denied(ApiDenialReason.DATA_KEY_WRITE_DENIED, "The data-key writer policy denies this caller")
        }
    }

    private fun inactiveCaller(caller: AuthenticatedPluginCaller): ApiCallResult.Denied? =
        if (caller.isActive()) {
            null
        } else {
            denied(ApiDenialReason.CALLER_NOT_ACTIVE, "The bound Bukkit plugin is no longer active")
        }

    private fun denied(
        reason: ApiDenialReason,
        detail: String,
    ): ApiCallResult.Denied = ApiCallResult.Denied(reason, detail)
}

private fun DataKeyIntegration.toRule(scope: DataScope): DataAccessRule =
    DataAccessRule(
        scope = scope,
        readAccess = readAccess,
        writePrincipals = writePrincipals,
    )
