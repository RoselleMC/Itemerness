package com.iroselle.itemerness.bukkit.projection

import com.iroselle.itemerness.bukkit.FoliaScheduler
import io.papermc.paper.threadedregions.scheduler.EntityScheduler
import io.papermc.paper.threadedregions.scheduler.GlobalRegionScheduler
import io.papermc.paper.threadedregions.scheduler.ScheduledTask
import java.lang.reflect.Proxy
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import java.util.function.Consumer
import org.bukkit.Server
import org.bukkit.entity.Player
import org.bukkit.plugin.Plugin
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class VisibleSurfaceRefreshCoordinatorTest {
    @Test
    fun `slow entity schedulers cannot grow refresh work beyond the in-flight bound`() {
        val entityActions = CopyOnWriteArrayList<Consumer<ScheduledTask>>()
        val globalSchedules = AtomicInteger()
        val published = AtomicInteger()
        val refreshed = CopyOnWriteArrayList<Player>()
        val task = refreshProxy<ScheduledTask> { proxy, method, arguments ->
            when (method.name) {
                "equals" -> proxy === arguments?.singleOrNull()
                "hashCode" -> System.identityHashCode(proxy)
                else -> refreshDefault(method.returnType)
            }
        }
        val entityScheduler = refreshProxy<EntityScheduler> { _, method, arguments ->
            when (method.name) {
                "run" -> {
                    @Suppress("UNCHECKED_CAST")
                    entityActions += arguments!![1] as Consumer<ScheduledTask>
                    task
                }
                else -> refreshDefault(method.returnType)
            }
        }
        val players = HashMap<UUID, Player>()
        repeat(1_000) { index ->
            val viewerId = UUID(0, index.toLong() + 1)
            players[viewerId] = refreshProxy { proxy, method, arguments ->
                when (method.name) {
                    "getUniqueId" -> viewerId
                    "getScheduler" -> entityScheduler
                    "equals" -> proxy === arguments?.singleOrNull()
                    "hashCode" -> System.identityHashCode(proxy)
                    else -> refreshDefault(method.returnType)
                }
            }
        }
        val global = refreshProxy<GlobalRegionScheduler> { _, method, _ ->
            when (method.name) {
                "runDelayed" -> {
                    globalSchedules.incrementAndGet()
                    task
                }
                else -> refreshDefault(method.returnType)
            }
        }
        val server = refreshProxy<Server> { proxy, method, arguments ->
            when (method.name) {
                "getGlobalRegionScheduler" -> global
                "getPlayer" -> players[arguments?.single() as UUID]
                "equals" -> proxy === arguments?.singleOrNull()
                "hashCode" -> System.identityHashCode(proxy)
                else -> refreshDefault(method.returnType)
            }
        }
        val plugin = refreshProxy<Plugin> { proxy, method, arguments ->
            when (method.name) {
                "getServer" -> server
                "getName" -> "VisibleSurfaceRefreshCoordinatorTest"
                "isEnabled" -> true
                "equals" -> proxy === arguments?.singleOrNull()
                "hashCode" -> System.identityHashCode(proxy)
                else -> refreshDefault(method.returnType)
            }
        }
        val coordinator = VisibleSurfaceRefreshCoordinator(
            plugin = plugin,
            scheduler = FoliaScheduler(plugin),
            viewerPublished = { published.incrementAndGet() },
            projectionRefresh = { player -> refreshed += player },
        )

        players.keys.forEach { viewerId -> assertTrue(coordinator.request(viewerId)) }
        repeat(8) { invokeRefreshDrain(coordinator) }

        assertEquals(256, entityActions.size)
        assertEquals(256, refreshSetSize(coordinator, "inFlight"))
        assertEquals(744, refreshSetSize(coordinator, "pending"))

        entityActions.first().accept(task)
        invokeRefreshDrain(coordinator)

        assertEquals(257, entityActions.size)
        assertEquals(256, refreshSetSize(coordinator, "inFlight"))
        assertEquals(743, refreshSetSize(coordinator, "pending"))
        assertEquals(1, published.get())
        assertEquals(1, refreshed.size)
        assertTrue(players.values.any { player -> player === refreshed.single() })
        assertTrue(globalSchedules.get() >= 2)
        coordinator.close()
    }
}

private fun invokeRefreshDrain(coordinator: VisibleSurfaceRefreshCoordinator) {
    coordinator.javaClass.getDeclaredMethod("drain").also { it.isAccessible = true }.invoke(coordinator)
}

private fun refreshSetSize(
    coordinator: VisibleSurfaceRefreshCoordinator,
    fieldName: String,
): Int = coordinator.javaClass.getDeclaredField(fieldName).let { field ->
    field.isAccessible = true
    @Suppress("UNCHECKED_CAST")
    (field.get(coordinator) as Set<UUID>).size
}

private inline fun <reified T> refreshProxy(
    crossinline handler: (Any, java.lang.reflect.Method, Array<out Any?>?) -> Any?,
): T = Proxy.newProxyInstance(
    T::class.java.classLoader,
    arrayOf(T::class.java),
) { instance, method, arguments -> handler(instance, method, arguments) } as T

private fun refreshDefault(type: Class<*>): Any? = when (type) {
    java.lang.Boolean.TYPE -> false
    java.lang.Byte.TYPE -> 0.toByte()
    java.lang.Short.TYPE -> 0.toShort()
    java.lang.Integer.TYPE -> 0
    java.lang.Long.TYPE -> 0L
    java.lang.Float.TYPE -> 0F
    java.lang.Double.TYPE -> 0.0
    java.lang.Character.TYPE -> '\u0000'
    java.lang.Void.TYPE -> null
    else -> null
}
