package com.iroselle.itemerness.bukkit.api

import com.iroselle.itemerness.api.ApiCallResult
import org.bukkit.plugin.Plugin

/** Bukkit service entrypoint that binds API access to one active plugin lifecycle generation. */
interface BukkitItemernessApi {
    /**
     * Binds [plugin] by object identity and direct caller class loader to Itemerness's current
     * Bukkit lifecycle generation. A name, a borrowed plugin object, or another same-name object
     * is insufficient. A dynamically enabled plugin must bind after its PluginEnableEvent has
     * completed; old facades retire on disable.
     *
     * This is a cooperative plugin-governance boundary, not a hostile in-process JVM sandbox.
     */
    fun forPlugin(plugin: Plugin): ApiCallResult<BoundBukkitItemernessApi>
}
