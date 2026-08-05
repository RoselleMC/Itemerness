package com.iroselle.itemerness.bukkit.access

import com.iroselle.itemerness.api.ApiAction
import com.iroselle.itemerness.bukkit.config.StrictYaml
import com.iroselle.itemerness.bukkit.config.StrictYamlException
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test
import java.io.StringReader

class AccessPolicyTest {
    @Test
    fun `bundled policy has safe defaults and no grants`() {
        val resource = checkNotNull(javaClass.classLoader.getResourceAsStream("access.yml"))
        val policy = resource.bufferedReader().use { reader ->
            AccessPolicyLoader.from(StrictYaml.load(reader, "access.yml"), "access.yml")
        }

        assertEquals(AccessDecision.ALLOW, policy.defaults.getValue(ApiAction.IDENTIFY))
        assertEquals(AccessDecision.ALLOW, policy.defaults.getValue(ApiAction.CREATE))
        assertEquals(AccessDecision.SCHEMA_POLICY, policy.defaults.getValue(ApiAction.READ_DATA))
        assertEquals(AccessDecision.DENY, policy.defaults.getValue(ApiAction.EDIT_DATA))
        assertEquals(AccessDecision.DENY, policy.defaults.getValue(ApiAction.WRITE_VIEWER_FACT))
        assertEquals(AccessDecision.ALLOW, policy.defaults.getValue(ApiAction.REQUEST_REFRESH))
        assertEquals(emptyList<AccessGrant>(), policy.grants)
    }

    @Test
    fun `matching grant overrides a deny only for its action and namespaces`() {
        val policy = policy(
            grants = """
                - plugin: ExampleConsumer
                  actions: [create, read-data, edit-data, write-viewer-fact]
                  item-namespaces: [itemerness]
                  data-namespaces: [example]
                  viewer-fact-namespaces: [example]
            """.trimIndent(),
        )

        assertEquals(
            AccessDecision.ALLOW,
            policy.decide("exampleconsumer", ApiAction.EDIT_DATA, "itemerness", "example"),
        )
        assertEquals(
            AccessDecision.ALLOW,
            policy.decide("ExampleConsumer", ApiAction.CREATE, "itemerness"),
        )
        assertEquals(
            AccessDecision.DENY,
            policy.decide("ExampleConsumer", ApiAction.EDIT_DATA, "other", "example"),
        )
        assertEquals(
            AccessDecision.DENY,
            policy.decide("ExampleConsumer", ApiAction.EDIT_DATA, "itemerness", "private"),
        )
        assertEquals(
            AccessDecision.DENY,
            policy.decide("Impostor", ApiAction.EDIT_DATA, "itemerness", "example"),
        )
        assertEquals(
            AccessDecision.DENY,
            policy.decide("ExampleConsumer", ApiAction.REQUEST_REFRESH, "itemerness"),
        )
        assertEquals(
            AccessDecision.ALLOW,
            policy.decide("ExampleConsumer", ApiAction.WRITE_VIEWER_FACT, "example"),
        )
        assertEquals(
            AccessDecision.DENY,
            policy.decide("ExampleConsumer", ApiAction.WRITE_VIEWER_FACT, "private"),
        )
    }

    @Test
    fun `loader rejects ambiguous or unsafe grant input`() {
        assertThrows(StrictYamlException::class.java) {
            policy(
                grants = """
                    - plugin: Example Consumer
                      actions: [edit-data]
                      item-namespaces: [itemerness]
                      data-namespaces: [example]
                """.trimIndent(),
            )
        }
        assertThrows(StrictYamlException::class.java) {
            policy(
                grants = """
                    - plugin: ExampleConsumer
                      actions: [edit-data, edit-data]
                      item-namespaces: [itemerness]
                      data-namespaces: [example]
                """.trimIndent(),
            )
        }
        assertThrows(StrictYamlException::class.java) {
            policy(
                grants = """
                    - plugin: ExampleConsumer
                      actions: [edit-data]
                      item-namespaces: ['Bad Namespace']
                      data-namespaces: [example]
                """.trimIndent(),
            )
        }
    }

    @Test
    fun `schema policy cannot be assigned to a write action`() {
        val yaml = baseYaml("[]").replace("edit-data: deny", "edit-data: schema-policy")
        assertThrows(StrictYamlException::class.java) {
            AccessPolicyLoader.from(StrictYaml.load(StringReader(yaml), "test.yml"), "test.yml")
        }
    }

    @Test
    fun `policy collections are immutable defensive copies`() {
        val actions = linkedSetOf(ApiAction.CREATE)
        val items = linkedSetOf("itemerness")
        val data = linkedSetOf("example")
        val grant = AccessGrant("ExampleConsumer", actions, items, data)
        actions += ApiAction.EDIT_DATA
        items += "other"
        data += "private"

        assertEquals(setOf(ApiAction.CREATE), grant.actions)
        assertEquals(setOf("itemerness"), grant.itemNamespaces)
        assertEquals(setOf("example"), grant.dataNamespaces)
        assertThrows(UnsupportedOperationException::class.java) {
            @Suppress("UNCHECKED_CAST")
            (grant.actions as MutableSet<ApiAction>) += ApiAction.EDIT_DATA
        }
    }

    private fun policy(grants: String): AccessPolicy {
        val yaml = baseYaml(grants)
        return AccessPolicyLoader.from(StrictYaml.load(StringReader(yaml), "test.yml"), "test.yml")
    }

    private fun baseYaml(grants: String): String {
        val prefix = """
            config-version: 1
            api:
              defaults:
                identify: allow
                create: deny
                read-data: schema-policy
                edit-data: deny
                write-viewer-fact: deny
                request-refresh: deny
              grants:
        """.trimIndent()
        return if (grants == "[]") {
            "$prefix []\n"
        } else {
            "$prefix\n${grants.prependIndent("    ")}\n"
        }
    }
}
