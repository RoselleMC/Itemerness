package com.iroselle.itemerness.bukkit.command

import com.iroselle.itemerness.api.DataKey
import com.iroselle.itemerness.api.ItemKey
import com.mojang.brigadier.arguments.IntegerArgumentType
import com.mojang.brigadier.arguments.ArgumentType
import com.mojang.brigadier.arguments.StringArgumentType
import com.mojang.brigadier.StringReader
import com.mojang.brigadier.tree.ArgumentCommandNode
import com.mojang.brigadier.tree.CommandNode
import io.papermc.paper.command.brigadier.CommandSourceStack
import io.papermc.paper.command.brigadier.argument.resolvers.selector.PlayerSelectorArgumentResolver
import org.bukkit.command.CommandSender
import org.bukkit.entity.Player
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertInstanceOf
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Test

class ItemernessCommandsTest {
    @Test
    fun `builds the complete Brigadier administration tree`() {
        val root = commands().build()

        assertEquals("itemerness", root.name)
        assertEquals(
            setOf("reload", "validate", "give", "inspect", "data", "refresh"),
            root.children.mapTo(sortedSetOf()) { it.name },
        )
        assertNotNull(root.at("reload", "check").command)
        assertNotNull(root.at("validate", "json").command)
        assertNotNull(root.at("give", "player", "item-id").command)
        assertNotNull(root.at("inspect", "hand", "view", "locale", "raw").command)
        assertNotNull(root.at("data", "get", "player", "slot", "key").command)
        assertNotNull(root.at("data", "set", "player", "slot", "key", "value").command)
        assertNotNull(root.at("data", "unset", "player", "slot", "key").command)
        assertNotNull(root.at("refresh", "all").command)
    }

    @Test
    fun `uses typed bounded arguments and catalog suggestions`() {
        val root = commands().build()
        val item = root.at("give", "player", "item-id") as ArgumentCommandNode<CommandSourceStack, *>
        val amount = root.at("give", "player", "item-id", "amount") as ArgumentCommandNode<CommandSourceStack, *>
        val locale = root.at("inspect", "hand", "view", "locale") as ArgumentCommandNode<CommandSourceStack, *>
        val value = root.at("data", "set", "player", "slot", "key", "value") as ArgumentCommandNode<CommandSourceStack, *>
        val amountType = amount.type as IntegerArgumentType

        assertNotNull(item.customSuggestions)
        assertInstanceOf(IntegerArgumentType::class.java, amountType)
        assertEquals(1, amountType.minimum)
        assertEquals(99, amountType.maximum)
        assertNotNull(locale.customSuggestions)
        assertInstanceOf(StringArgumentType::class.java, value.type)
    }

    private fun CommandNode<CommandSourceStack>.at(vararg path: String): CommandNode<CommandSourceStack> =
        path.fold(this) { node, name -> requireNotNull(node.getChild(name)) { "Missing command path ${path.joinToString(" ")}" } }

    private fun commands(): ItemernessCommands = ItemernessCommands(
        actions = NoOpActions,
        catalog = Catalog,
        playerArgument = { TestPlayerArgument },
        restriction = { predicate -> predicate },
    )

    private object TestPlayerArgument : ArgumentType<PlayerSelectorArgumentResolver> {
        override fun parse(reader: StringReader): PlayerSelectorArgumentResolver =
            error("The command tree test does not parse player selectors")
    }

    private object Catalog : CommandCatalogView {
        override fun itemKeys(): Collection<ItemKey> = listOf(ItemKey.parse("example:item"))

        override fun dataKeys(): Collection<DataKey> = listOf(DataKey.parse("example:value"))

        override fun locales(): Collection<String> = listOf("en_us", "zh_cn")
    }

    private object NoOpActions : ItemernessCommandActions {
        override fun reload(sender: CommandSender, checkOnly: Boolean) = Unit
        override fun validate(sender: CommandSender, format: ValidationOutput) = Unit
        override fun give(sender: CommandSender, target: Player, itemKey: ItemKey, amount: Int) = Unit
        override fun inspectHand(sender: CommandSender, locale: String?, raw: Boolean) = Unit
        override fun inspectSlot(
            sender: CommandSender,
            target: Player,
            slot: InventorySlot,
            locale: String?,
            raw: Boolean,
        ) = Unit

        override fun readData(sender: CommandSender, target: Player, slot: InventorySlot, key: DataKey) = Unit
        override fun writeData(
            sender: CommandSender,
            target: Player,
            slot: InventorySlot,
            key: DataKey,
            literal: String,
        ) = Unit

        override fun unsetData(sender: CommandSender, target: Player, slot: InventorySlot, key: DataKey) = Unit
        override fun refreshPlayer(sender: CommandSender, target: Player) = Unit
        override fun refreshAll(sender: CommandSender) = Unit
    }
}
