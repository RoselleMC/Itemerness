package com.iroselle.itemerness.bukkit.api

import com.iroselle.itemerness.api.ApiCallResult
import com.iroselle.itemerness.api.ApiDenialReason
import java.util.Locale
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock
import org.bukkit.plugin.Plugin

/**
 * Itemerness-owned plugin lifecycle view.
 *
 * Bukkit's plugin registry and JavaPlugin.enabled are not safe hot-path dependencies for callers
 * that use a bound facade asynchronously. Platform lifecycle events update this registry once;
 * every later authorization check reads only this lock-protected identity map.
 */
internal class PluginCallerRegistry(initiallyActive: Collection<Plugin>) {
    private val lock = ReentrantLock()
    private val activeByName = HashMap<String, Plugin>()
    private var closed = false

    init {
        initiallyActive.forEach { plugin -> activeByName[normalize(plugin.name)] = plugin }
    }

    fun authenticate(plugin: Plugin): ApiCallResult<AuthenticatedPluginCaller> = lock.withLock {
        if (closed || activeByName[normalize(plugin.name)] !== plugin) {
            return ApiCallResult.Denied(
                ApiDenialReason.CALLER_NOT_ACTIVE,
                "The caller is not in the active Bukkit plugin lifecycle generation",
            )
        }
        ApiCallResult.Success(AuthenticatedPluginCaller(plugin, this))
    }

    fun activate(plugin: Plugin) {
        lock.withLock {
            if (closed) return
            val key = normalize(plugin.name)
            val current = activeByName[key]
            if (current == null || current === plugin) activeByName[key] = plugin
        }
    }

    fun retire(plugin: Plugin) {
        lock.withLock {
            val key = normalize(plugin.name)
            if (activeByName[key] === plugin) activeByName.remove(key)
        }
    }

    fun isActive(plugin: Plugin): Boolean = lock.withLock {
        !closed && activeByName[normalize(plugin.name)] === plugin
    }

    fun close() {
        lock.withLock {
            closed = true
            activeByName.clear()
        }
    }

    private fun normalize(name: String): String = name.lowercase(Locale.ROOT)
}

/**
 * Low-cost origin check for the cooperative Bukkit API boundary.
 *
 * A plugin object is public Bukkit state, so object identity alone does not prove which plugin
 * invoked [BukkitItemernessApi.forPlugin]. The production verifier also requires the first stack
 * frame outside Itemerness to come from the candidate plugin's class loader. This prevents normal
 * cross-plugin impersonation; it is deliberately not described as a hostile in-JVM sandbox.
 */
internal fun interface CallerOriginVerifier {
    fun isCaller(plugin: Plugin): Boolean
}

internal class StackWalkerCallerOriginVerifier(
    private val itemernessClassLoader: ClassLoader?,
) : CallerOriginVerifier {
    private val walker = StackWalker.getInstance(StackWalker.Option.RETAIN_CLASS_REFERENCE)

    override fun isCaller(plugin: Plugin): Boolean {
        val expected = plugin.javaClass.classLoader
        return walker.walk { frames ->
            frames
                .map(StackWalker.StackFrame::getDeclaringClass)
                .filter { type -> type.classLoader !== itemernessClassLoader }
                .findFirst()
                .map { type -> type.classLoader === expected }
                .orElse(false)
        }
    }
}

internal class AuthenticatedPluginCaller internal constructor(
    private val plugin: Plugin,
    private val registry: PluginCallerRegistry,
) {
    val pluginName: String = plugin.name

    fun isActive(): Boolean = registry.isActive(plugin)

    fun isSamePlugin(candidate: Plugin): Boolean = plugin === candidate

    internal companion object {
        fun authenticate(
            plugin: Plugin,
            registry: PluginCallerRegistry,
        ): ApiCallResult<AuthenticatedPluginCaller> = registry.authenticate(plugin)
    }
}
