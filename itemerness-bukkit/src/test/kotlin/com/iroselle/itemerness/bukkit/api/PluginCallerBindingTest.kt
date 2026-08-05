package com.iroselle.itemerness.bukkit.api

import com.iroselle.itemerness.api.ApiCallResult
import com.iroselle.itemerness.api.ApiDenialReason
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class PluginCallerBindingTest {
    @Test
    fun `registered enabled plugin binds by object identity`() {
        val real = FakePlugin("ExampleConsumer")
        val registry = PluginCallerRegistry(listOf(real.instance))

        val result = AuthenticatedPluginCaller.authenticate(real.instance, registry)

        assertTrue(result is ApiCallResult.Success)
        val caller = (result as ApiCallResult.Success).value
        assertEquals("ExampleConsumer", caller.pluginName)
        assertTrue(caller.isActive())
        assertTrue(caller.isSamePlugin(real.instance))
    }

    @Test
    fun `same-name plugin object cannot impersonate the registered plugin`() {
        val real = FakePlugin("ExampleConsumer")
        val impostor = FakePlugin("ExampleConsumer")
        val registry = PluginCallerRegistry(listOf(real.instance))

        registry.activate(impostor.instance)
        val result = AuthenticatedPluginCaller.authenticate(impostor.instance, registry)

        assertSame(ApiDenialReason.CALLER_NOT_ACTIVE, (result as ApiCallResult.Denied).reason)
        assertTrue(
            AuthenticatedPluginCaller.authenticate(real.instance, registry) is ApiCallResult.Success,
            "An active lifecycle identity must not be overwritten by an unsolicited same-name activation",
        )
    }

    @Test
    fun `retired lifecycle generation cannot bind and an existing binding is revalidated`() {
        val plugin = FakePlugin("ExampleConsumer")
        val registry = PluginCallerRegistry(listOf(plugin.instance))
        val caller = (AuthenticatedPluginCaller.authenticate(plugin.instance, registry) as ApiCallResult.Success).value

        registry.retire(plugin.instance)

        assertTrue(!caller.isActive())
        assertSame(
            ApiDenialReason.CALLER_NOT_ACTIVE,
            (AuthenticatedPluginCaller.authenticate(plugin.instance, registry) as ApiCallResult.Denied).reason,
        )

        registry.activate(FakePlugin("ExampleConsumer").instance)
        assertTrue(!caller.isActive())
    }
}
