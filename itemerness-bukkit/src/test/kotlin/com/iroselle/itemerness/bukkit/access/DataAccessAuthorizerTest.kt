package com.iroselle.itemerness.bukkit.access

import com.iroselle.itemerness.api.ApiAction
import com.iroselle.itemerness.api.ApiCallResult
import com.iroselle.itemerness.api.ApiDenialReason
import com.iroselle.itemerness.api.DataKey
import com.iroselle.itemerness.api.ItemKey
import com.iroselle.itemerness.bukkit.api.AuthenticatedPluginCaller
import com.iroselle.itemerness.bukkit.api.FakePlugin
import com.iroselle.itemerness.bukkit.api.PluginCallerRegistry
import com.iroselle.itemerness.bukkit.catalog.CatalogSourceLoader
import com.iroselle.itemerness.bukkit.catalog.DataReadAccess
import com.iroselle.itemerness.core.catalog.DataScope
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption

class DataAccessAuthorizerTest {
    @TempDir
    lateinit var directory: Path

    private val itemKey = ItemKey.parse("itemerness:test")
    private val dataKey = DataKey.parse("example:value")
    private val ownerPlugin = FakePlugin("Itemerness")
    private val consumer = FakePlugin("ExampleConsumer")

    @Test
    fun `public read requires both global access and a known data key`() {
        val caller = authenticate(consumer)
        val allowed = authorizer(
            policy = allowAllPolicy(),
            rule = rule(read = DataReadAccess.PUBLIC),
        )

        assertTrue(allowed.authorizeRead(caller, itemKey, dataKey) is ApiCallResult.Success)
        assertSame(
            ApiDenialReason.DATA_KEY_NOT_FOUND,
            (allowed.authorizeRead(caller, itemKey, DataKey.parse("example:missing")) as ApiCallResult.Denied).reason,
        )

        val denied = authorizer(
            policy = policy(defaultRead = AccessDecision.DENY),
            rule = rule(read = DataReadAccess.PUBLIC),
        )
        assertSame(
            ApiDenialReason.ACTION_DENIED,
            (denied.authorizeRead(caller, itemKey, dataKey) as ApiCallResult.Denied).reason,
        )
    }

    @Test
    fun `grant must match caller action item namespace and data namespace`() {
        val grant = AccessGrant(
            pluginName = "ExampleConsumer",
            actions = setOf(ApiAction.READ_DATA),
            itemNamespaces = setOf("itemerness"),
            dataNamespaces = setOf("example"),
        )
        val policy = policy(defaultRead = AccessDecision.DENY, grants = listOf(grant))
        val authorizer = authorizer(policy, rule(read = DataReadAccess.PUBLIC))

        assertTrue(authorizer.authorizeRead(authenticate(consumer), itemKey, dataKey) is ApiCallResult.Success)

        val otherPlugin = FakePlugin("OtherConsumer")
        assertSame(
            ApiDenialReason.ACTION_DENIED,
            (authorizer.authorizeRead(authenticate(otherPlugin), itemKey, dataKey) as ApiCallResult.Denied).reason,
        )
        assertSame(
            ApiDenialReason.ACTION_DENIED,
            (
                authorizer.authorizeRead(
                    authenticate(consumer),
                    ItemKey.parse("other:test"),
                    dataKey,
                ) as ApiCallResult.Denied
                ).reason,
        )
        assertSame(
            ApiDenialReason.ACTION_DENIED,
            (
                authorizer.authorizeRead(
                    authenticate(consumer),
                    itemKey,
                    DataKey.parse("private:value"),
                ) as ApiCallResult.Denied
                ).reason,
        )
    }

    @Test
    fun `owner-only data fails closed without an explicit resolver`() {
        val caller = authenticate(consumer)
        val noResolver = authorizer(
            policy = allowAllPolicy(),
            rule = rule(read = DataReadAccess.OWNER_ONLY),
        )

        assertSame(
            ApiDenialReason.OWNER_CONTEXT_REQUIRED,
            (noResolver.authorizeRead(caller, itemKey, dataKey) as ApiCallResult.Denied).reason,
        )

        val nonOwner = authorizer(
            policy = allowAllPolicy(),
            rule = rule(read = DataReadAccess.OWNER_ONLY),
            resolver = OwnerAccessResolver { _, _, _ -> false },
        )
        assertSame(
            ApiDenialReason.NOT_OWNER,
            (nonOwner.authorizeRead(caller, itemKey, dataKey) as ApiCallResult.Denied).reason,
        )

        val owner = authorizer(
            policy = allowAllPolicy(),
            rule = rule(read = DataReadAccess.OWNER_ONLY),
            resolver = OwnerAccessResolver { plugin, item, key ->
                plugin == "ExampleConsumer" && item == itemKey && key == dataKey
            },
        )
        assertTrue(owner.authorizeRead(caller, itemKey, dataKey) is ApiCallResult.Success)
    }

    @Test
    fun `definition data is never writable through the instance authorization path`() {
        val caller = authenticate(consumer)
        val authorizer = authorizer(
            policy = allowAllPolicy(),
            rule = rule(
                scope = DataScope.DEFINITION,
                writers = setOf("plugin:ExampleConsumer", "definition"),
            ),
        )

        assertSame(
            ApiDenialReason.DEFINITION_DATA_IMMUTABLE,
            (authorizer.authorizeInstanceWrite(caller, itemKey, dataKey) as ApiCallResult.Denied).reason,
        )
    }

    @Test
    fun `instance write is the intersection of grant and per-key writer principals`() {
        val caller = authenticate(consumer)
        val editGrant = AccessGrant(
            pluginName = "ExampleConsumer",
            actions = setOf(ApiAction.EDIT_DATA),
            itemNamespaces = setOf("itemerness"),
            dataNamespaces = setOf("example"),
        )
        val granted = policy(defaultEdit = AccessDecision.DENY, grants = listOf(editGrant))

        val wrongWriter = authorizer(granted, rule(writers = setOf("plugin:OtherConsumer")))
        assertSame(
            ApiDenialReason.DATA_KEY_WRITE_DENIED,
            (wrongWriter.authorizeInstanceWrite(caller, itemKey, dataKey) as ApiCallResult.Denied).reason,
        )

        val matchingWriter = authorizer(granted, rule(writers = setOf("plugin:exampleconsumer")))
        assertTrue(matchingWriter.authorizeInstanceWrite(caller, itemKey, dataKey) is ApiCallResult.Success)
    }

    @Test
    fun `internal data accepts only the actual Itemerness plugin object`() {
        val internalCaller = authenticate(ownerPlugin)
        val consumerCaller = authenticate(consumer)
        val authorizer = authorizer(
            policy = allowAllPolicy(),
            rule = rule(read = DataReadAccess.INTERNAL, writers = setOf("internal")),
        )

        assertTrue(authorizer.authorizeRead(internalCaller, itemKey, dataKey) is ApiCallResult.Success)
        assertTrue(authorizer.authorizeInstanceWrite(internalCaller, itemKey, dataKey) is ApiCallResult.Success)
        assertSame(
            ApiDenialReason.DATA_KEY_READ_DENIED,
            (authorizer.authorizeRead(consumerCaller, itemKey, dataKey) as ApiCallResult.Denied).reason,
        )
        assertSame(
            ApiDenialReason.DATA_KEY_WRITE_DENIED,
            (authorizer.authorizeInstanceWrite(consumerCaller, itemKey, dataKey) as ApiCallResult.Denied).reason,
        )
    }

    @Test
    fun `rule collections are defensively copied`() {
        val writers = linkedSetOf("plugin:ExampleConsumer")
        val rule = rule(writers = writers)
        writers += "internal"

        assertEquals(setOf("plugin:ExampleConsumer"), rule.writePrincipals)
        assertThrows(UnsupportedOperationException::class.java) {
            @Suppress("UNCHECKED_CAST")
            (rule.writePrincipals as MutableSet<String>) += "internal"
        }
    }

    @Test
    fun `rule index derives trusted scopes from the loaded catalog`() {
        copyResource("data-keys/common.yml")
        copyResource("items/examples.yml")

        val index = DataAccessRuleIndex.from(CatalogSourceLoader().load(directory))

        assertEquals(DataScope.DEFINITION, index[DataKey.parse("example:required-level")]?.scope)
        assertEquals(DataScope.INSTANCE, index[DataKey.parse("example:charges")]?.scope)
        assertEquals(DataReadAccess.INTERNAL, index[DataKey.parse("example:metadata")]?.readAccess)
    }

    private fun authorizer(
        policy: AccessPolicy,
        rule: DataAccessRule,
        resolver: OwnerAccessResolver? = null,
    ): DataAccessAuthorizer = DataAccessAuthorizer(
        ownerPlugin = ownerPlugin.instance,
        accessPolicy = policy,
        rules = DataAccessRuleIndex.of(mapOf(dataKey to rule)),
        ownerResolver = resolver,
    )

    private fun rule(
        scope: DataScope = DataScope.INSTANCE,
        read: DataReadAccess = DataReadAccess.PUBLIC,
        writers: Collection<String> = setOf("plugin:ExampleConsumer"),
    ): DataAccessRule = DataAccessRule(scope, read, writers)

    private fun allowAllPolicy(): AccessPolicy = policy(
        defaultRead = AccessDecision.SCHEMA_POLICY,
        defaultEdit = AccessDecision.ALLOW,
    )

    private fun policy(
        defaultRead: AccessDecision = AccessDecision.SCHEMA_POLICY,
        defaultEdit: AccessDecision = AccessDecision.ALLOW,
        grants: Collection<AccessGrant> = emptyList(),
    ): AccessPolicy = AccessPolicy(
        defaults = ApiAction.entries.associateWith { action ->
            when (action) {
                ApiAction.READ_DATA -> defaultRead
                ApiAction.EDIT_DATA -> defaultEdit
                else -> AccessDecision.ALLOW
            }
        },
        grants = grants,
    )

    private fun authenticate(plugin: FakePlugin): AuthenticatedPluginCaller {
        val result = AuthenticatedPluginCaller.authenticate(
            plugin.instance,
            PluginCallerRegistry(listOf(plugin.instance)),
        )
        return (result as ApiCallResult.Success).value
    }

    private fun copyResource(path: String) {
        val destination = directory.resolve(path)
        Files.createDirectories(destination.parent)
        checkNotNull(javaClass.classLoader.getResourceAsStream(path)).use { input ->
            Files.copy(input, destination, StandardCopyOption.REPLACE_EXISTING)
        }
    }
}
