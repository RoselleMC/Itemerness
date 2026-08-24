package com.iroselle.itemerness.bukkit

import io.papermc.paper.threadedregions.scheduler.ScheduledTask
import io.papermc.paper.command.CommandBlockHolder
import java.util.UUID
import java.util.concurrent.TimeUnit
import org.bukkit.Location
import org.bukkit.World
import org.bukkit.command.BlockCommandSender
import org.bukkit.command.CommandSender
import org.bukkit.command.ConsoleCommandSender
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
    private val commandReplies: CommandReplyRuntime = BukkitCommandReplyRuntime(plugin),
) {
    /**
     * Captures the ownership information needed to reply after an asynchronous command action.
     *
     * Command execution already runs in the sender's owning context. Capture only immutable
     * identity here; the live Bukkit sender is resolved again when a reply is ready.
     */
    fun captureCommandReplyTarget(sender: CommandSender): CommandReplyTarget = when (sender) {
        is Entity -> CommandReplyTarget.EntityTarget(sender.uniqueId, sender.entityId)
        is BlockCommandSender -> {
            val block = sender.block
            val command = (block.state as? CommandBlockHolder)?.command
            if (command == null) {
                CommandReplyTarget.UnresolvableTarget(sender.javaClass.name)
            } else {
                CommandReplyTarget.BlockTarget(
                    worldId = block.world.uid,
                    x = block.x,
                    y = block.y,
                    z = block.z,
                    blockData = block.blockData.asString,
                    command = command,
                )
            }
        }
        is ConsoleCommandSender -> CommandReplyTarget.ConsoleTarget
        else -> CommandReplyTarget.UnresolvableTarget(sender.javaClass.name)
    }

    fun runGlobal(action: () -> Unit): ScheduledTask =
        plugin.server.globalRegionScheduler.run(plugin) { action() }

    fun runGlobalDelayed(
        delayTicks: Long,
        action: () -> Unit,
    ): ScheduledTask = plugin.server.globalRegionScheduler.runDelayed(plugin, { action() }, delayTicks)

    fun repeatGlobal(
        initialDelayTicks: Long,
        periodTicks: Long,
        action: () -> Unit,
    ): ScheduledTask = plugin.server.globalRegionScheduler.runAtFixedRate(
        plugin,
        { action() },
        initialDelayTicks,
        periodTicks,
    )

    fun runAt(
        location: Location,
        action: () -> Unit,
    ): ScheduledTask = plugin.server.regionScheduler.run(plugin, location) { action() }

    fun runForEntity(
        entity: Entity,
        retired: () -> Unit,
        action: () -> Unit,
    ): ScheduledTask? {
        val task = entity.scheduler.run(plugin, { action() }, Runnable(retired))
        if (task == null) retired()
        return task
    }

    fun runForEntityDelayed(
        entity: Entity,
        delayTicks: Long,
        retired: () -> Unit,
        action: () -> Unit,
    ): ScheduledTask? {
        val task = entity.scheduler.runDelayed(plugin, { action() }, Runnable(retired), delayTicks)
        if (task == null) retired()
        return task
    }

    fun runAsync(action: () -> Unit): ScheduledTask =
        plugin.server.asyncScheduler.runNow(plugin) { action() }

    fun runAsyncDelayed(
        delayMillis: Long,
        action: () -> Unit,
    ): ScheduledTask = plugin.server.asyncScheduler.runDelayed(
        plugin,
        { action() },
        delayMillis,
        TimeUnit.MILLISECONDS,
    )

    fun repeatAsync(
        initialDelayMillis: Long,
        periodMillis: Long,
        action: () -> Unit,
    ): ScheduledTask = plugin.server.asyncScheduler.runAtFixedRate(
        plugin,
        { action() },
        initialDelayMillis,
        periodMillis,
        TimeUnit.MILLISECONDS,
    )

    /** Best-effort command boundary used when plugin retirement can race task submission. */
    fun tryRunGlobal(action: () -> Unit): Boolean = scheduleOrNull { runGlobal(action) } != null

    /** Best-effort delayed global boundary for refresh work racing plugin retirement. */
    fun tryRunGlobalDelayed(
        delayTicks: Long,
        action: () -> Unit,
    ): Boolean = scheduleOrNull { runGlobalDelayed(delayTicks, action) } != null

    /** Best-effort async command boundary used when plugin retirement can race task submission. */
    fun tryRunAsync(action: () -> Unit): Boolean = scheduleOrNull { runAsync(action) } != null

    fun tryRunAsyncTask(action: () -> Unit): ScheduledTask? = scheduleOrNull { runAsync(action) }

    fun tryRunAsyncDelayed(
        delayMillis: Long,
        action: () -> Unit,
    ): ScheduledTask? = scheduleOrNull { runAsyncDelayed(delayMillis, action) }

    fun tryRepeatAsync(
        initialDelayMillis: Long,
        periodMillis: Long,
        action: () -> Unit,
    ): ScheduledTask? = scheduleOrNull { repeatAsync(initialDelayMillis, periodMillis, action) }

    /** Best-effort entity command boundary; a rejected task is reported through [retired]. */
    fun tryRunForEntity(
        entity: Entity,
        retired: () -> Unit,
        action: () -> Unit,
    ): Boolean {
        val task = scheduleOrNull {
            entity.scheduler.run(plugin, { action() }, Runnable(retired))
        }
        if (task == null) retired()
        return task != null
    }

    /** Resolves a fresh sender and emits a reply only from that sender's current owning context. */
    fun sendCommandReply(
        target: CommandReplyTarget,
        message: net.kyori.adventure.text.Component,
        retired: () -> Unit = {},
    ) {
        when (target) {
            is CommandReplyTarget.EntityTarget -> {
                if (!commandReplies.executeGlobal {
                        val entity = commandReplies.findEntity(target.entityId)
                        if (entity == null) {
                            retired()
                            return@executeGlobal
                        }
                        if (!commandReplies.executeEntity(entity, retired) {
                                if (entity.uniqueId != target.entityId || entity.entityId != target.runtimeEntityId) {
                                    retired()
                                } else {
                                    entity.sendMessage(message)
                                }
                            }
                        ) {
                            retired()
                        }
                    }
                ) {
                    retired()
                }
            }
            is CommandReplyTarget.BlockTarget -> {
                if (!commandReplies.executeGlobal {
                        val world = commandReplies.findWorld(target.worldId)
                        if (world == null) {
                            retired()
                            return@executeGlobal
                        }
                        if (!commandReplies.executeRegion(world, target.x, target.y, target.z) {
                                val block = world.getBlockAt(target.x, target.y, target.z)
                                val state = block.state
                                val holder = state as? CommandBlockHolder
                                if (
                                    block.blockData.asString != target.blockData ||
                                    holder == null ||
                                    holder.command != target.command
                                ) {
                                    retired()
                                    return@executeRegion
                                }
                                holder.lastOutput(message)
                                if (!state.update(false, false)) retired()
                            }
                        ) {
                            retired()
                        }
                    }
                ) {
                    retired()
                }
            }
            CommandReplyTarget.ConsoleTarget -> {
                if (!commandReplies.executeGlobal {
                        commandReplies.consoleSender().sendMessage(message)
                    }
                ) {
                    retired()
                }
            }
            is CommandReplyTarget.UnresolvableTarget -> retired()
        }
    }

    private fun scheduleOrNull(supplier: () -> ScheduledTask?): ScheduledTask? = try {
        supplier()
    } catch (_: RuntimeException) {
        null
    }
}

internal sealed interface CommandReplyTarget {
    data class EntityTarget(
        val entityId: UUID,
        val runtimeEntityId: Int,
    ) : CommandReplyTarget

    data class BlockTarget(
        val worldId: UUID,
        val x: Int,
        val y: Int,
        val z: Int,
        val blockData: String,
        val command: String,
    ) : CommandReplyTarget

    data object ConsoleTarget : CommandReplyTarget

    data class UnresolvableTarget(
        val senderType: String,
    ) : CommandReplyTarget
}

/** Small testable boundary around the live objects used only while resolving one reply. */
internal interface CommandReplyRuntime {
    fun executeGlobal(action: () -> Unit): Boolean

    fun findEntity(entityId: UUID): Entity?

    fun executeEntity(
        entity: Entity,
        retired: () -> Unit,
        action: () -> Unit,
    ): Boolean

    fun findWorld(worldId: UUID): World?

    fun executeRegion(
        world: World,
        x: Int,
        y: Int,
        z: Int,
        action: () -> Unit,
    ): Boolean

    fun consoleSender(): ConsoleCommandSender
}

private class BukkitCommandReplyRuntime(
    private val plugin: Plugin,
) : CommandReplyRuntime {
    override fun executeGlobal(action: () -> Unit): Boolean = try {
        plugin.server.globalRegionScheduler.run(plugin) { action() }
        true
    } catch (_: RuntimeException) {
        false
    }

    override fun findEntity(entityId: UUID): Entity? = plugin.server.getEntity(entityId)

    override fun executeEntity(
        entity: Entity,
        retired: () -> Unit,
        action: () -> Unit,
    ): Boolean = try {
        entity.scheduler.run(plugin, { action() }, Runnable(retired)) != null
    } catch (_: RuntimeException) {
        false
    }

    override fun findWorld(worldId: UUID): World? = plugin.server.getWorld(worldId)

    override fun executeRegion(
        world: World,
        x: Int,
        y: Int,
        z: Int,
        action: () -> Unit,
    ): Boolean = try {
        plugin.server.regionScheduler.run(
            plugin,
            Location(world, x.toDouble(), y.toDouble(), z.toDouble()),
        ) { action() }
        true
    } catch (_: RuntimeException) {
        false
    }

    override fun consoleSender(): ConsoleCommandSender = plugin.server.consoleSender
}
