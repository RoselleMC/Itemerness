package com.iroselle.itemerness.bukkit

import com.iroselle.itemerness.api.ItemernessApi
import com.iroselle.itemerness.core.DefaultItemRegistry
import org.bukkit.plugin.ServicePriority
import org.bukkit.plugin.java.JavaPlugin

class ItemernessPlugin : JavaPlugin() {
    private var registry: DefaultItemRegistry? = null

    override fun onEnable() {
        check(registry == null) {
            "Itemerness has already been enabled"
        }

        saveDefaultConfig()
        BundledResources.extract(this)

        val registry = DefaultItemRegistry()
        server.servicesManager.register(
            ItemernessApi::class.java,
            registry,
            this,
            ServicePriority.Normal,
        )
        this.registry = registry
    }

    override fun onDisable() {
        server.servicesManager.unregisterAll(this)
        registry?.clear()
        registry = null
    }
}
