package com.iroselle.itemerness.bukkit

import com.iroselle.itemerness.bukkit.spi.BukkitCanonicalItemBridgeFactory
import com.iroselle.itemerness.projection.ProjectionAdapterFactory
import java.util.ServiceLoader
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class NmsProviderDiscoveryTest {
    @Test
    fun `all exact providers load without resolving an unselected server ABI`() {
        val expected = setOf("1.21.11", "26.1.1", "26.1.2", "26.2")

        val projectionVersions = ServiceLoader.load(
            ProjectionAdapterFactory::class.java,
            ProjectionAdapterFactory::class.java.classLoader,
        ).map { factory -> factory.descriptor.minecraftVersion.value }.toSet()
        val bridgeVersions = ServiceLoader.load(
            BukkitCanonicalItemBridgeFactory::class.java,
            BukkitCanonicalItemBridgeFactory::class.java.classLoader,
        ).map { factory -> factory.descriptor.minecraftVersion.value }.toSet()

        assertEquals(expected, projectionVersions)
        assertEquals(expected, bridgeVersions)
    }
}
