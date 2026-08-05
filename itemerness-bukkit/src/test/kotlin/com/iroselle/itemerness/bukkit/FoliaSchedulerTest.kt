package com.iroselle.itemerness.bukkit

import io.papermc.paper.command.CommandBlockHolder
import java.lang.reflect.Method
import java.lang.reflect.Proxy
import java.util.UUID
import java.util.concurrent.atomic.AtomicInteger
import net.kyori.adventure.text.Component
import org.bukkit.World
import org.bukkit.block.Block
import org.bukkit.block.BlockState
import org.bukkit.block.data.BlockData
import org.bukkit.command.BlockCommandSender
import org.bukkit.command.CommandSender
import org.bukkit.command.ConsoleCommandSender
import org.bukkit.entity.Entity
import org.bukkit.plugin.Plugin
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertInstanceOf
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class FoliaSchedulerTest {
    @Test
    fun `reply targets retain immutable identity instead of Bukkit objects`() {
        val runtime = RecordingReplyRuntime()
        val scheduler = scheduler(runtime)
        val entityId = UUID.randomUUID()
        val entityTarget = scheduler.captureCommandReplyTarget(entity(entityId, 41))

        assertEquals(CommandReplyTarget.EntityTarget(entityId, 41), entityTarget)
        assertNoBukkitFields(entityTarget)

        val originalBlock = BlockModel(
            worldId = UUID.randomUUID(),
            x = 12,
            y = 64,
            z = -9,
            blockData = "minecraft:command_block[conditional=false,facing=north]",
            command = "itemerness validate",
        )
        val blockTarget = scheduler.captureCommandReplyTarget(originalBlock.sender)

        assertEquals(
            CommandReplyTarget.BlockTarget(
                worldId = originalBlock.worldId,
                x = originalBlock.x,
                y = originalBlock.y,
                z = originalBlock.z,
                blockData = originalBlock.blockData,
                command = originalBlock.command,
            ),
            blockTarget,
        )
        assertNoBukkitFields(blockTarget)
    }

    @Test
    fun `entity replies resolve a fresh matching generation in global then entity context`() {
        val runtime = RecordingReplyRuntime()
        val scheduler = scheduler(runtime)
        val entityId = UUID.randomUUID()
        val originalMessages = ArrayList<Component>()
        val resolvedMessages = ArrayList<Component>()
        val target = scheduler.captureCommandReplyTarget(entity(entityId, 7, originalMessages))
        runtime.entity = entity(entityId, 7, resolvedMessages)

        scheduler.sendCommandReply(target, Component.text("complete"))

        assertEquals(listOf("global", "find-entity", "entity"), runtime.stages)
        assertTrue(originalMessages.isEmpty(), "The captured entity must not be retained as the recipient")
        assertEquals(listOf(Component.text("complete")), resolvedMessages)
    }

    @Test
    fun `entity replacement and missing entity retire without receiving an old reply`() {
        val runtime = RecordingReplyRuntime()
        val scheduler = scheduler(runtime)
        val entityId = UUID.randomUUID()
        val target = scheduler.captureCommandReplyTarget(entity(entityId, 7))
        val replacementMessages = ArrayList<Component>()
        val retired = AtomicInteger()
        runtime.entity = entity(entityId, 8, replacementMessages)

        scheduler.sendCommandReply(target, Component.text("stale"), retired::incrementAndGet)

        assertEquals(1, retired.get())
        assertTrue(replacementMessages.isEmpty())

        runtime.stages.clear()
        runtime.entity = null
        scheduler.sendCommandReply(target, Component.text("missing"), retired::incrementAndGet)
        assertEquals(2, retired.get())
        assertEquals(listOf("global", "find-entity"), runtime.stages)
    }

    @Test
    fun `block replies resolve current world and command block in its region`() {
        val runtime = RecordingReplyRuntime()
        val scheduler = scheduler(runtime)
        val original = BlockModel(
            worldId = UUID.randomUUID(),
            x = 2,
            y = 70,
            z = 5,
            blockData = "minecraft:repeating_command_block[conditional=false,facing=up]",
            command = "itemerness reload",
        )
        val target = scheduler.captureCommandReplyTarget(original.sender)
        val resolved = original.copy()
        runtime.world = resolved.world

        scheduler.sendCommandReply(target, Component.text("published"))

        assertEquals(listOf("global", "find-world", "region"), runtime.stages)
        assertTrue(original.outputs.isEmpty(), "The captured block sender must not be retained")
        assertEquals(listOf(Component.text("published")), resolved.outputs)
        assertEquals(listOf(RegionCall(original.worldId, 2, 70, 5)), runtime.regionCalls)
    }

    @Test
    fun `changed block identity and unsupported sender retire`() {
        val runtime = RecordingReplyRuntime()
        val scheduler = scheduler(runtime)
        val original = BlockModel(
            worldId = UUID.randomUUID(),
            x = 1,
            y = 2,
            z = 3,
            blockData = "minecraft:command_block[conditional=false,facing=north]",
            command = "itemerness validate",
        )
        val target = scheduler.captureCommandReplyTarget(original.sender)
        val replacement = original.copy(command = "say replacement")
        runtime.world = replacement.world
        val retired = AtomicInteger()

        scheduler.sendCommandReply(target, Component.text("stale"), retired::incrementAndGet)

        assertEquals(1, retired.get())
        assertTrue(replacement.outputs.isEmpty())

        val unsupported = scheduler.captureCommandReplyTarget(proxy(CommandSender::class.java) { _, _ -> null })
        assertInstanceOf(CommandReplyTarget.UnresolvableTarget::class.java, unsupported)
        scheduler.sendCommandReply(unsupported, Component.text("ignored"), retired::incrementAndGet)
        assertEquals(2, retired.get())
    }

    @Test
    fun `console replies resolve the live console on the global scheduler`() {
        val consoleMessages = ArrayList<Component>()
        val runtime = RecordingReplyRuntime(console = console(consoleMessages))
        val scheduler = scheduler(runtime)
        val target = scheduler.captureCommandReplyTarget(console())

        scheduler.sendCommandReply(target, Component.text("done"))

        assertEquals(CommandReplyTarget.ConsoleTarget, target)
        assertEquals(listOf("global", "console"), runtime.stages)
        assertEquals(listOf(Component.text("done")), consoleMessages)
    }

    @Test
    fun `scheduler submission rejection retires exactly once`() {
        val entityId = UUID.randomUUID()
        val runtime = RecordingReplyRuntime(
            entity = entity(entityId, 9),
            acceptGlobal = false,
        )
        val scheduler = scheduler(runtime)
        val retired = AtomicInteger()

        scheduler.sendCommandReply(
            CommandReplyTarget.EntityTarget(entityId, 9),
            Component.text("ignored"),
            retired::incrementAndGet,
        )
        assertEquals(1, retired.get())

        runtime.acceptGlobal = true
        runtime.acceptEntity = false
        scheduler.sendCommandReply(
            CommandReplyTarget.EntityTarget(entityId, 9),
            Component.text("ignored"),
            retired::incrementAndGet,
        )
        assertEquals(2, retired.get())
    }

    private fun scheduler(runtime: CommandReplyRuntime): FoliaScheduler = FoliaScheduler(
        proxy(Plugin::class.java) { _, _ -> null },
        runtime,
    )

    private fun assertNoBukkitFields(target: CommandReplyTarget) {
        val forbidden = listOf(
            CommandSender::class.java,
            Entity::class.java,
            Block::class.java,
            World::class.java,
        )
        assertFalse(
            target.javaClass.declaredFields.any { field -> forbidden.any { type -> type.isAssignableFrom(field.type) } },
            "${target.javaClass.simpleName} retains a Bukkit object",
        )
    }

    private class RecordingReplyRuntime(
        var entity: Entity? = null,
        var world: World? = null,
        private val console: ConsoleCommandSender = console(),
        var acceptGlobal: Boolean = true,
        var acceptEntity: Boolean = true,
        var acceptRegion: Boolean = true,
    ) : CommandReplyRuntime {
        val stages = ArrayList<String>()
        val regionCalls = ArrayList<RegionCall>()

        override fun executeGlobal(action: () -> Unit): Boolean {
            stages += "global"
            if (!acceptGlobal) return false
            action()
            return true
        }

        override fun findEntity(entityId: UUID): Entity? {
            stages += "find-entity"
            return entity
        }

        override fun executeEntity(entity: Entity, retired: () -> Unit, action: () -> Unit): Boolean {
            stages += "entity"
            if (!acceptEntity) return false
            action()
            return true
        }

        override fun findWorld(worldId: UUID): World? {
            stages += "find-world"
            return world?.takeIf { it.uid == worldId }
        }

        override fun executeRegion(world: World, x: Int, y: Int, z: Int, action: () -> Unit): Boolean {
            stages += "region"
            if (!acceptRegion) return false
            regionCalls += RegionCall(world.uid, x, y, z)
            action()
            return true
        }

        override fun consoleSender(): ConsoleCommandSender {
            stages += "console"
            return console
        }
    }

    private data class RegionCall(
        val worldId: UUID,
        val x: Int,
        val y: Int,
        val z: Int,
    )

    private data class BlockModel(
        val worldId: UUID,
        val x: Int,
        val y: Int,
        val z: Int,
        var blockData: String,
        var command: String,
    ) {
        val outputs = ArrayList<Component>()
        private val state: BlockState = proxy(
            BlockState::class.java,
            CommandBlockHolder::class.java,
        ) { method, arguments ->
            when {
                method.name == "getCommand" -> command
                method.name == "lastOutput" && arguments.size == 1 -> {
                    outputs += arguments.single() as Component
                    null
                }
                method.name == "lastOutput" -> outputs.lastOrNull()
                method.name == "update" -> true
                else -> defaultValue(method)
            }
        }
        private val data: BlockData = proxy(BlockData::class.java) { method, _ ->
            if (method.name == "getAsString") blockData else defaultValue(method)
        }
        val block: Block = proxy(Block::class.java) { method, _ ->
            when (method.name) {
                "getWorld" -> world
                "getX" -> x
                "getY" -> y
                "getZ" -> z
                "getState" -> state
                "getBlockData" -> data
                else -> defaultValue(method)
            }
        }
        val world: World = proxy(World::class.java) { method, arguments ->
            when (method.name) {
                "getUID" -> worldId
                "getBlockAt" -> {
                    assertEquals(listOf(x, y, z), arguments.toList())
                    block
                }
                else -> defaultValue(method)
            }
        }
        val sender: BlockCommandSender = proxy(BlockCommandSender::class.java) { method, _ ->
            if (method.name == "getBlock") block else defaultValue(method)
        }
    }

    private companion object {
        fun entity(
            entityId: UUID,
            runtimeEntityId: Int,
            messages: MutableList<Component> = ArrayList(),
        ): Entity = proxy(Entity::class.java) { method, arguments ->
            when (method.name) {
                "getUniqueId" -> entityId
                "getEntityId" -> runtimeEntityId
                "sendMessage" -> {
                    arguments.filterIsInstance<Component>().forEach(messages::add)
                    null
                }
                else -> defaultValue(method)
            }
        }

        fun console(messages: MutableList<Component> = ArrayList()): ConsoleCommandSender =
            proxy(ConsoleCommandSender::class.java) { method, arguments ->
                if (method.name == "sendMessage") {
                    arguments.filterIsInstance<Component>().forEach(messages::add)
                    null
                } else {
                    defaultValue(method)
                }
            }

        fun <T> proxy(
            first: Class<T>,
            vararg additional: Class<*>,
            invocation: (Method, List<Any?>) -> Any?,
        ): T = first.cast(
            Proxy.newProxyInstance(
                first.classLoader,
                arrayOf(first, *additional),
            ) { proxy, method, arguments ->
                when (method.name) {
                    "toString" -> "TestProxy(${first.simpleName})"
                    "hashCode" -> System.identityHashCode(proxy)
                    "equals" -> proxy === arguments?.singleOrNull()
                    else -> invocation(method, arguments?.toList().orEmpty())
                }
            },
        )

        fun defaultValue(method: Method): Any? = when (method.returnType) {
            java.lang.Boolean.TYPE -> false
            java.lang.Byte.TYPE -> 0.toByte()
            java.lang.Short.TYPE -> 0.toShort()
            java.lang.Integer.TYPE -> 0
            java.lang.Long.TYPE -> 0L
            java.lang.Float.TYPE -> 0F
            java.lang.Double.TYPE -> 0.0
            java.lang.Character.TYPE -> '\u0000'
            else -> null
        }
    }
}
