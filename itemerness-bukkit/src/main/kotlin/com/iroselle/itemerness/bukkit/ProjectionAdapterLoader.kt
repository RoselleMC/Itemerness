package com.iroselle.itemerness.bukkit

import com.iroselle.itemerness.projection.MinecraftVersion
import com.iroselle.itemerness.projection.ProjectionAdapter
import com.iroselle.itemerness.projection.ProjectionAdapterFactory
import com.iroselle.itemerness.projection.ProjectionRuntime
import java.util.ServiceLoader

internal object ProjectionAdapterLoader {
    fun load(
        minecraftVersion: String,
        runtime: ProjectionRuntime,
    ): ProjectionAdapter {
        val version = MinecraftVersion(minecraftVersion)
        val factories = ServiceLoader.load(
            ProjectionAdapterFactory::class.java,
            ProjectionAdapterFactory::class.java.classLoader,
        ).filter { factory -> factory.descriptor.minecraftVersion == version }.toList()
        check(factories.size == 1) {
            if (factories.isEmpty()) {
                "No projection adapter supports Minecraft $minecraftVersion"
            } else {
                "More than one projection adapter supports Minecraft $minecraftVersion"
            }
        }
        return factories.single().create(runtime)
    }
}
