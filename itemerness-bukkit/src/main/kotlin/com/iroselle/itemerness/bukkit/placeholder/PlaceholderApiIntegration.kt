package com.iroselle.itemerness.bukkit.placeholder

import org.bukkit.event.EventHandler
import org.bukkit.event.EventPriority
import org.bukkit.event.HandlerList
import org.bukkit.event.Listener
import org.bukkit.event.server.PluginEnableEvent
import org.bukkit.event.server.PluginDisableEvent
import org.bukkit.plugin.Plugin

/**
 * Owns the optional PlaceholderAPI registration without forcing PAPI classes to load when the
 * dependency is absent. [start] and [close] are called by the Itemerness plugin lifecycle.
 */
internal class PlaceholderApiIntegration(
    private val plugin: Plugin,
    private val snapshots: PlaceholderSnapshotStore,
    catalogRevision: () -> Long? = { null },
) : Listener, AutoCloseable {
    private val lifecycle = PlaceholderRegistrationLifecycle(
        available = {
            plugin.server.pluginManager.isPluginEnabled(PLACEHOLDER_API_PLUGIN_NAME)
        },
        registrar = PlaceholderRegistrar {
            PlaceholderApiBoundary.register(plugin.pluginMeta.version, snapshots, catalogRevision)
        },
    )
    private var started = false

    fun start() {
        if (started) {
            return
        }
        started = true
        plugin.server.pluginManager.registerEvents(this, plugin)
        lifecycle.tryRegister()
    }

    @EventHandler(priority = EventPriority.MONITOR)
    fun onPluginEnable(event: PluginEnableEvent) {
        if (event.plugin.name == PLACEHOLDER_API_PLUGIN_NAME) {
            lifecycle.tryRegister()
        }
    }

    @EventHandler(priority = EventPriority.MONITOR)
    fun onPluginDisable(event: PluginDisableEvent) {
        if (event.plugin.name == PLACEHOLDER_API_PLUGIN_NAME) {
            lifecycle.invalidate()
        }
    }

    override fun close() {
        var primary: Throwable? = null
        fun attempt(action: () -> Unit) {
            try {
                action()
            } catch (failure: Throwable) {
                val current = primary
                if (current == null) primary = failure else if (failure !== current) current.addSuppressed(failure)
            }
        }
        if (started) {
            started = false
            attempt { HandlerList.unregisterAll(this) }
        }
        attempt(lifecycle::close)
        attempt(snapshots::clear)
        primary?.let { throw it }
    }

    private companion object {
        const val PLACEHOLDER_API_PLUGIN_NAME = "PlaceholderAPI"
    }
}

internal fun interface PlaceholderRegistration {
    fun unregister()
}

internal fun interface PlaceholderRegistrar {
    fun register(): PlaceholderRegistration?
}

/** Thread-safe idempotence for startup, late-enable retries, and shutdown. */
internal class PlaceholderRegistrationLifecycle(
    private val available: () -> Boolean,
    private val registrar: PlaceholderRegistrar,
) : AutoCloseable {
    private var registration: PlaceholderRegistration? = null
    private var closed = false

    @Synchronized
    fun tryRegister(): Boolean {
        if (closed) return false
        if (registration != null) {
            return true
        }
        if (!available()) {
            return false
        }
        registration = registrar.register()
        return registration != null
    }

    fun invalidate() {
        val previous = synchronized(this) {
            registration.also { registration = null }
        }
        previous?.unregister()
    }

    override fun close() {
        val previous = synchronized(this) {
            if (closed) return
            closed = true
            registration.also { registration = null }
        }
        previous?.unregister()
    }
}

/** This class is reached only after Bukkit reports that PlaceholderAPI is enabled. */
private object PlaceholderApiBoundary {
    fun register(
        pluginVersion: String,
        snapshots: PlaceholderSnapshotLookup,
        catalogRevision: () -> Long?,
    ): PlaceholderRegistration? {
        val expansion = ItemernessPlaceholderExpansion(pluginVersion, snapshots, catalogRevision)
        if (!expansion.register()) {
            return null
        }
        return PlaceholderRegistration(expansion::unregister)
    }
}
