package com.iroselle.itemerness.bukkit.command

import com.iroselle.itemerness.api.DataKey
import com.iroselle.itemerness.api.ItemKey
import com.mojang.brigadier.CommandDispatcher
import com.mojang.brigadier.LiteralMessage
import com.mojang.brigadier.StringReader
import com.mojang.brigadier.arguments.ArgumentType
import com.mojang.brigadier.arguments.IntegerArgumentType
import com.mojang.brigadier.context.CommandContext
import com.mojang.brigadier.exceptions.CommandSyntaxException
import com.mojang.brigadier.exceptions.SimpleCommandExceptionType
import com.mojang.brigadier.suggestion.Suggestions
import com.mojang.brigadier.suggestion.SuggestionsBuilder
import com.mojang.brigadier.tree.ArgumentCommandNode
import io.papermc.paper.command.brigadier.CommandSourceStack
import io.papermc.paper.command.brigadier.argument.resolvers.selector.PlayerSelectorArgumentResolver
import java.lang.reflect.Proxy
import java.util.UUID
import java.util.concurrent.CompletableFuture
import org.bukkit.NamespacedKey
import org.bukkit.command.CommandSender
import org.bukkit.entity.Player
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertInstanceOf
import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class OnlinePlayerCommandsTest {
    @Test
    fun `complete command tree accepts Unicode players in every shared target path`() {
        val fixture = Fixture()
        val commands = listOf(
            "give 夏咕咕 example:item 2" to "give",
            "inspect 夏咕咕 mainhand view zh_cn raw" to "inspect",
            "data get 夏咕咕 offhand example:value" to "read",
            "data set 夏咕咕 mainhand example:value string:value with spaces" to "write",
            "data unset 夏咕咕 mainhand example:value" to "unset",
            "refresh 夏咕咕" to "refresh",
        )

        commands.forEach { (command, action) ->
            assertEquals(1, fixture.execute(command), command)
            assertEquals(action, fixture.actions.calls.last().action)
            assertSame(fixture.target, fixture.actions.calls.last().target)
        }
        assertEquals(listOf(ITEM, 2), fixture.actions.calls[0].arguments)
        assertEquals(listOf(InventorySlot.MAIN_HAND, "zh_cn", true), fixture.actions.calls[1].arguments)
        assertEquals(
            listOf(InventorySlot.MAIN_HAND, DATA, "string:value with spaces"),
            fixture.actions.calls[3].arguments,
        )
    }

    @Test
    fun `ASCII quoted escaped names and selectors still use the native resolver`() {
        val fixture = Fixture()
        listOf("Player_2", "Élodie", "Name名字_2", "\"夏咕咕\"", "'夏咕咕'", "\"夏\\\"咕\\\\咕\"", "@p")
            .forEach { name ->
                assertEquals(1, fixture.execute("give $name example:item"))
                assertSame(fixture.target, fixture.actions.calls.last().target)
                assertEquals(listOf(ITEM, 1), fixture.actions.calls.last().arguments)
            }
        assertEquals(7, fixture.native.resolutions)
        assertTrue(fixture.native.contextualParses > 0)
    }

    @Test
    fun `failed native resolution does not fall back to another identity or action`() {
        val fixture = Fixture()
        listOf("不在线", "Offline").forEach { name ->
            val failure = assertThrows(CommandSyntaxException::class.java) {
                fixture.execute("give $name example:item")
            }
            assertSame(UNKNOWN_PLAYER, failure.type)
        }
        assertEquals(2, fixture.native.resolutions)
        assertTrue(fixture.actions.calls.isEmpty())
    }

    @Test
    fun `UUID input retains the native players-only rejection and cursor`() {
        val fixture = Fixture()
        val input = "itemerness give $ID example:item"
        val nativeReader = StringReader(input).also { it.cursor = input.indexOf(ID.toString()) }
        val baseline = assertThrows(CommandSyntaxException::class.java) {
            fixture.native.parse(nativeReader, fixture.source)
        }
        val failure = assertThrows(CommandSyntaxException::class.java) {
            fixture.dispatcher.execute(input, fixture.source)
        }

        assertSame(ONLY_PLAYERS_ALLOWED, baseline.type)
        assertSame(baseline.type, failure.type)
        assertEquals(baseline.input, failure.input)
        assertEquals(0, failure.cursor)
        assertEquals(baseline.cursor, failure.cursor)
        assertEquals(0, fixture.native.resolutions)
        assertTrue(fixture.actions.calls.isEmpty())
    }

    @Test
    fun `give permission and native selector permission are not bypassed`() {
        val fixture = Fixture()
        fixture.permissions.remove(Permissions.GIVE)
        assertThrows(CommandSyntaxException::class.java) { fixture.execute("give 夏咕咕 example:item") }
        assertEquals(0, fixture.native.resolutions)

        fixture.permissions.add(Permissions.GIVE)
        fixture.permissions.remove(SELECTOR_PERMISSION)
        val failure = assertThrows(CommandSyntaxException::class.java) { fixture.execute("give @p example:item") }
        assertSame(SELECTOR_DENIED, failure.type)
        assertTrue(fixture.actions.calls.isEmpty())
        assertEquals(1, fixture.execute("give 夏咕咕 example:item"))
    }

    @Test
    fun `native name bounds and typed item quantity errors do not invoke actions`() {
        val fixture = Fixture()
        listOf(
            "give ${"名".repeat(17)} example:item",
            "give 名字/name example:item",
            "give 名字:name example:item",
            "give \"夏咕咕 example:item",
            "give 夏咕咕 Invalid:item",
            "give 夏咕咕 example:item 0",
            "give 夏咕咕 example:item 100",
            "give 夏咕咕 example:item 1.5",
            "give 夏咕咕 example:item nope",
            "give 夏咕咕 example:item 1 extra",
        ).forEach { command ->
            assertThrows(CommandSyntaxException::class.java, { fixture.execute(command) }, command)
        }
        assertTrue(fixture.actions.calls.isEmpty())
        assertEquals(0, fixture.native.resolutions)

        val command = "itemerness give 夏咕咕 example:item 100"
        val failure = assertThrows(CommandSyntaxException::class.java) {
            fixture.dispatcher.execute(command, fixture.source)
        }
        assertEquals(command, failure.input)
        assertEquals(command.indexOf("100"), failure.cursor)
    }

    @Test
    fun `Unicode player input retains following item slot key and locale completions`() {
        val fixture = Fixture()
        assertEquals(listOf("example:item"), fixture.suggestions("give 夏咕咕 example:"))
        assertEquals(listOf("example:item"), fixture.suggestions("give \"夏咕咕\" example:"))
        assertEquals(listOf("mainhand"), fixture.suggestions("inspect 夏咕咕 main"))
        assertEquals(listOf("example:value"), fixture.suggestions("data get 夏咕咕 mainhand example:"))
        assertEquals(listOf("zh_cn"), fixture.suggestions("inspect 夏咕咕 mainhand view zh"))
        assertEquals(setOf("夏咕咕", "夏\"咕\\咕"), fixture.suggestions("give 夏").toSet())
        assertEquals(listOf("@p"), fixture.suggestions("give @"))

        val give = fixture.dispatcher.root.getChild("itemerness").getChild("give")
        assertEquals(setOf("player"), give.children.map { it.name }.toSet())
        val player = give.getChild("player") as ArgumentCommandNode<CommandSourceStack, *>
        assertInstanceOf(OnlinePlayerArgument::class.java, player.type)
        val item = player.getChild("item-id") as ArgumentCommandNode<CommandSourceStack, *>
        val amount = item.getChild("amount") as ArgumentCommandNode<CommandSourceStack, *>
        val amountType = assertInstanceOf(IntegerArgumentType::class.java, amount.type)
        assertEquals(1, amountType.minimum)
        assertEquals(99, amountType.maximum)
        assertFalse(fixture.native.suggestionCalls.isEmpty())
        assertTrue(fixture.actions.calls.isEmpty())
    }

    private class Fixture {
        val target = proxy(Player::class.java) { method, _ -> error("Unexpected player access: $method") }
        val permissions = mutableSetOf(
            Permissions.GIVE, Permissions.INSPECT, Permissions.INSPECT_RAW,
            Permissions.DATA_READ, Permissions.DATA_WRITE, Permissions.REFRESH, SELECTOR_PERMISSION,
        )
        private val sender = proxy(CommandSender::class.java) { method, arguments ->
            when (method) {
                "hasPermission" -> arguments!![0] in permissions
                else -> error("Unexpected sender access: $method")
            }
        }
        val source = proxy(CommandSourceStack::class.java) { method, _ ->
            when (method) {
                "getSender" -> sender
                else -> error("Unexpected source access: $method")
            }
        }
        val native = NativePlayerFixture(target)
        val actions = RecordingActions()
        val dispatcher = CommandDispatcher<CommandSourceStack>().also {
            it.root.addChild(ItemernessCommands(
                actions = actions,
                catalog = Catalog,
                playerArgument = { native },
                restriction = { predicate -> predicate },
                namespacedKeyArgument = { NamespacedKeyFixture },
            ).build())
        }

        fun execute(command: String): Int = dispatcher.execute("itemerness $command", source)

        fun suggestions(command: String): List<String> {
            val input = "itemerness $command"
            return dispatcher.getCompletionSuggestions(dispatcher.parse(input, source)).join().list.map { it.text }
        }
    }

    // A public-API fixture for the native boundary, not evidence of Minecraft authentication or runtime parsing.
    private class NativePlayerFixture(private val target: Player) : ArgumentType<PlayerSelectorArgumentResolver> {
        var contextualParses = 0
        var resolutions = 0
        val suggestionCalls = mutableListOf<String>()
        private val names = setOf("夏咕咕", "Élodie", "Player_2", "Name名字_2", "夏\"咕\\咕")

        override fun parse(reader: StringReader): PlayerSelectorArgumentResolver = parseNative(reader)

        override fun <S> parse(reader: StringReader, source: S): PlayerSelectorArgumentResolver {
            contextualParses++
            return parseNative(reader)
        }

        private fun parseNative(reader: StringReader): PlayerSelectorArgumentResolver {
            val start = reader.cursor
            val selector = reader.canRead() && reader.peek() == '@'
            val name = if (selector) {
                while (reader.canRead() && reader.peek() != ' ') reader.skip()
                reader.string.substring(start, reader.cursor)
            } else reader.readString()
            val uuid = runCatching { UUID.fromString(name) }.getOrNull()
            if (uuid != null) {
                reader.cursor = 0
                throw ONLY_PLAYERS_ALLOWED.createWithContext(reader)
            }
            if ((selector && name != "@p") || (!selector && (name.isEmpty() || name.length > 16))) {
                reader.cursor = start
                throw INVALID_PLAYER.createWithContext(reader)
            }
            return PlayerSelectorArgumentResolver { source ->
                resolutions++
                if (selector && !source.sender.hasPermission(SELECTOR_PERMISSION)) throw SELECTOR_DENIED.create()
                if (selector || name in names) listOf(target) else throw UNKNOWN_PLAYER.create()
            }
        }

        override fun <S> listSuggestions(
            context: CommandContext<S>,
            builder: SuggestionsBuilder,
        ): CompletableFuture<Suggestions> {
            suggestionCalls += builder.remaining
            (names + "@p").filter { it.startsWith(builder.remaining) }.forEach(builder::suggest)
            return builder.buildFuture()
        }
    }

    private object NamespacedKeyFixture : ArgumentType<NamespacedKey> {
        override fun parse(reader: StringReader): NamespacedKey {
            val start = reader.cursor
            while (reader.canRead() && reader.peek() != ' ') reader.skip()
            return NamespacedKey.fromString(reader.string.substring(start, reader.cursor)) ?: run {
                reader.cursor = start
                throw INVALID_KEY.createWithContext(reader)
            }
        }
    }

    private data class Call(val action: String, val target: Player, val arguments: List<Any?> = emptyList())

    private class RecordingActions : ItemernessCommandActions {
        val calls = mutableListOf<Call>()

        override fun reload(sender: CommandSender, checkOnly: Boolean) = error("Unexpected reload")
        override fun validate(sender: CommandSender, format: ValidationOutput) = error("Unexpected validate")
        override fun inspectHand(sender: CommandSender, locale: String?, raw: Boolean) = error("Unexpected hand")
        override fun refreshAll(sender: CommandSender) = error("Unexpected refresh all")

        override fun give(sender: CommandSender, target: Player, itemKey: ItemKey, amount: Int) {
            calls += Call("give", target, listOf(itemKey, amount))
        }

        override fun inspectSlot(sender: CommandSender, target: Player, slot: InventorySlot, locale: String?, raw: Boolean) {
            calls += Call("inspect", target, listOf(slot, locale, raw))
        }

        override fun readData(sender: CommandSender, target: Player, slot: InventorySlot, key: DataKey) {
            calls += Call("read", target, listOf(slot, key))
        }

        override fun writeData(sender: CommandSender, target: Player, slot: InventorySlot, key: DataKey, literal: String) {
            calls += Call("write", target, listOf(slot, key, literal))
        }

        override fun unsetData(sender: CommandSender, target: Player, slot: InventorySlot, key: DataKey) {
            calls += Call("unset", target, listOf(slot, key))
        }

        override fun refreshPlayer(sender: CommandSender, target: Player) {
            calls += Call("refresh", target)
        }
    }

    private object Catalog : CommandCatalogView {
        override fun itemKeys() = listOf(ITEM)
        override fun dataKeys() = listOf(DATA)
        override fun locales() = listOf("en_us", "zh_cn")
    }

    private companion object {
        val ID: UUID = UUID.fromString("123e4567-e89b-12d3-a456-426614174000")
        val ITEM = ItemKey.parse("example:item")
        val DATA = DataKey.parse("example:value")
        const val SELECTOR_PERMISSION = "minecraft.command.selector"
        val INVALID_PLAYER = SimpleCommandExceptionType(LiteralMessage("Invalid native player"))
        val ONLY_PLAYERS_ALLOWED = SimpleCommandExceptionType(LiteralMessage("Only players may be affected by this command"))
        val UNKNOWN_PLAYER = SimpleCommandExceptionType(LiteralMessage("Unknown online player"))
        val SELECTOR_DENIED = SimpleCommandExceptionType(LiteralMessage("Selector permission denied"))
        val INVALID_KEY = SimpleCommandExceptionType(LiteralMessage("Invalid namespaced key"))

        @Suppress("UNCHECKED_CAST")
        fun <T> proxy(type: Class<T>, handler: (String, Array<out Any?>?) -> Any?): T =
            Proxy.newProxyInstance(type.classLoader, arrayOf(type)) { proxy, method, arguments ->
                when (method.name) {
                    "equals" -> proxy === arguments?.get(0)
                    "hashCode" -> System.identityHashCode(proxy)
                    "toString" -> type.simpleName
                    else -> handler(method.name, arguments)
                }
            } as T
    }
}
