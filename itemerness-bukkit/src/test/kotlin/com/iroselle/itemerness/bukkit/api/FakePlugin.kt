package com.iroselle.itemerness.bukkit.api

import org.bukkit.plugin.Plugin
import java.lang.reflect.Proxy
import java.util.concurrent.atomic.AtomicBoolean

internal class FakePlugin(
    private val pluginName: String,
    enabled: Boolean = true,
) {
    private val enabledState = AtomicBoolean(enabled)

    val instance: Plugin = Proxy.newProxyInstance(
        Plugin::class.java.classLoader,
        arrayOf(Plugin::class.java),
    ) { proxy, method, args ->
        when (method.name) {
            "getName" -> pluginName
            "isEnabled" -> enabledState.get()
            "equals" -> proxy === args?.firstOrNull()
            "hashCode" -> System.identityHashCode(proxy)
            "toString" -> "FakePlugin($pluginName)"
            else -> primitiveDefault(method.returnType)
        }
    } as Plugin

    fun setEnabled(value: Boolean) {
        enabledState.set(value)
    }
}

private fun primitiveDefault(type: Class<*>): Any? = when (type) {
    java.lang.Boolean.TYPE -> false
    java.lang.Byte.TYPE -> 0.toByte()
    java.lang.Short.TYPE -> 0.toShort()
    java.lang.Integer.TYPE -> 0
    java.lang.Long.TYPE -> 0L
    java.lang.Float.TYPE -> 0.0f
    java.lang.Double.TYPE -> 0.0
    java.lang.Character.TYPE -> '\u0000'
    else -> null
}
