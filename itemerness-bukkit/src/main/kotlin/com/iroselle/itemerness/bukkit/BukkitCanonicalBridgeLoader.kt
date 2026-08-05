package com.iroselle.itemerness.bukkit

import com.iroselle.itemerness.bukkit.spi.BukkitCanonicalItemBridge
import com.iroselle.itemerness.bukkit.spi.BukkitCanonicalItemBridgeFactory
import com.iroselle.itemerness.projection.MinecraftVersion
import java.util.ServiceLoader

internal object BukkitCanonicalBridgeLoader {
    fun load(minecraftVersion: String): BukkitCanonicalItemBridge {
        val factories = ServiceLoader.load(
            BukkitCanonicalItemBridgeFactory::class.java,
            BukkitCanonicalItemBridgeFactory::class.java.classLoader,
        ).toList()
        return select(factories, MinecraftVersion(minecraftVersion)).create()
    }

    internal fun select(
        factories: Collection<BukkitCanonicalItemBridgeFactory>,
        minecraftVersion: MinecraftVersion,
    ): BukkitCanonicalItemBridgeFactory {
        val matches = factories.filter { factory ->
            factory.descriptor.minecraftVersion == minecraftVersion
        }
        check(matches.size == 1) {
            when {
                matches.isEmpty() -> "No canonical item bridge supports Minecraft ${minecraftVersion.value}"
                else -> "More than one canonical item bridge supports Minecraft ${minecraftVersion.value}"
            }
        }
        return matches.single()
    }
}
