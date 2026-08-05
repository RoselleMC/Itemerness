package com.iroselle.itemerness.bukkit.projection

import com.iroselle.itemerness.bukkit.FoliaScheduler
import java.util.LinkedHashSet
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import org.bukkit.entity.Player
import org.bukkit.plugin.Plugin

/** Coalesces refresh requests and re-enters every Bukkit object through its owning scheduler. */
internal class VisibleSurfaceRefreshCoordinator(
    private val plugin: Plugin,
    private val scheduler: FoliaScheduler,
    private val viewerPublished: (Player) -> Unit,
    private val projectionRefresh: (Player) -> Unit = {},
    private val viewerAvailable: (UUID) -> Boolean = { true },
) : AutoCloseable {
    private val stateLock = Any()
    private val pending = LinkedHashSet<UUID>()
    private val inFlight = LinkedHashSet<UUID>()
    private val scheduled = AtomicBoolean()
    private val closed = AtomicBoolean()

    fun request(viewerId: UUID): Boolean {
        if (closed.get() || !viewerAvailable(viewerId)) return false
        val accepted = synchronized(stateLock) {
            when {
                closed.get() -> false
                !viewerAvailable(viewerId) -> false
                viewerId in pending -> true
                pending.size >= MAX_PENDING_VIEWERS -> false
                else -> pending.add(viewerId)
            }
        }
        if (!accepted) return false
        if (scheduleDrain()) return true
        synchronized(stateLock) { pending.remove(viewerId) }
        return false
    }

    fun requestAll(): Boolean {
        if (closed.get()) return false
        return scheduler.tryRunGlobal {
            if (closed.get()) return@tryRunGlobal
            synchronized(stateLock) {
                plugin.server.onlinePlayers.asSequence()
                    .map(Player::getUniqueId)
                    .take(MAX_PENDING_VIEWERS - pending.size)
                    .forEach(pending::add)
            }
            if (!scheduleDrain()) synchronized(stateLock) { pending.clear() }
        }
    }

    override fun close() {
        closed.set(true)
        synchronized(stateLock) {
            pending.clear()
            inFlight.clear()
        }
    }

    private fun scheduleDrain(): Boolean {
        if (closed.get()) return false
        if (!scheduled.compareAndSet(false, true)) return true
        val accepted = scheduler.tryRunGlobalDelayed(delayTicks = 1) { drain() }
        if (!accepted) scheduled.set(false)
        return accepted
    }

    private fun drain() {
        scheduled.set(false)
        if (closed.get()) return
        val batch = synchronized(stateLock) {
            val capacity = (MAX_IN_FLIGHT_VIEWERS - inFlight.size).coerceAtLeast(0)
            pending.asSequence().take(minOf(MAX_VIEWERS_PER_TICK, capacity)).toList().also { selected ->
                selected.forEach(pending::remove)
                inFlight.addAll(selected)
            }
        }
        batch.forEach { viewerId ->
            val player = plugin.server.getPlayer(viewerId)
            if (player == null) {
                finish(viewerId)
                return@forEach
            }
            try {
                scheduler.runForEntity(player, retired = { finish(viewerId) }) {
                    try {
                        if (closed.get()) return@runForEntity
                        viewerPublished(player)
                        projectionRefresh(player)
                    } finally {
                        finish(viewerId)
                    }
                }
            } catch (_: RuntimeException) {
                // Plugin shutdown may reject a task after the request was accepted.
                finish(viewerId)
            }
        }
        schedulePendingIfCapacity()
    }

    private fun finish(viewerId: UUID) {
        synchronized(stateLock) { inFlight.remove(viewerId) }
        schedulePendingIfCapacity()
    }

    private fun schedulePendingIfCapacity() {
        val ready = synchronized(stateLock) {
            !closed.get() && pending.isNotEmpty() && inFlight.size < MAX_IN_FLIGHT_VIEWERS
        }
        if (ready) scheduleDrain()
    }

    private companion object {
        const val MAX_VIEWERS_PER_TICK = 128
        const val MAX_IN_FLIGHT_VIEWERS = 256
        const val MAX_PENDING_VIEWERS = 4_096
    }
}
