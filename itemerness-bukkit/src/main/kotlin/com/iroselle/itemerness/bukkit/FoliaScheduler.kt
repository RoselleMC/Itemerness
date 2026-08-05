package com.iroselle.itemerness.bukkit

import io.papermc.paper.threadedregions.scheduler.ScheduledTask
import org.bukkit.Location
import org.bukkit.entity.Entity
import org.bukkit.plugin.Plugin

/**
 * The only scheduling gateway for Bukkit-facing code.
 *
 * Callers must select the method that owns the Bukkit state they intend to touch. Async work must
 * return through [runForEntity] or [runAt] before reading or mutating entity or world state.
 */
internal class FoliaScheduler(
    private val plugin: Plugin,
) {
    fun runGlobal(action: () -> Unit): ScheduledTask =
        plugin.server.globalRegionScheduler.run(plugin) {
            action()
        }

    fun runAt(
        location: Location,
        action: () -> Unit,
    ): ScheduledTask =
        plugin.server.regionScheduler.run(plugin, location) {
            action()
        }

    fun runForEntity(
        entity: Entity,
        retired: () -> Unit,
        action: () -> Unit,
    ): ScheduledTask? =
        entity.scheduler.run(
            plugin,
            { action() },
            Runnable(retired),
        )

    fun runAsync(action: () -> Unit): ScheduledTask =
        plugin.server.asyncScheduler.runNow(plugin) {
            action()
        }
}
