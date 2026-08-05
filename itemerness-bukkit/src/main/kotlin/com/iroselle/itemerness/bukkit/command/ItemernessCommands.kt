package com.iroselle.itemerness.bukkit.command

import com.iroselle.itemerness.api.DataKey
import com.iroselle.itemerness.api.ItemKey
import com.mojang.brigadier.Command
import com.mojang.brigadier.LiteralMessage
import com.mojang.brigadier.arguments.IntegerArgumentType
import com.mojang.brigadier.arguments.ArgumentType
import com.mojang.brigadier.arguments.StringArgumentType
import com.mojang.brigadier.builder.ArgumentBuilder
import com.mojang.brigadier.builder.LiteralArgumentBuilder
import com.mojang.brigadier.context.CommandContext
import com.mojang.brigadier.exceptions.DynamicCommandExceptionType
import com.mojang.brigadier.suggestion.SuggestionProvider
import io.papermc.paper.command.brigadier.CommandSourceStack
import io.papermc.paper.command.brigadier.Commands
import io.papermc.paper.command.brigadier.argument.ArgumentTypes
import io.papermc.paper.command.brigadier.argument.CustomArgumentType
import io.papermc.paper.command.brigadier.argument.resolvers.selector.PlayerSelectorArgumentResolver
import io.papermc.paper.plugin.lifecycle.event.types.LifecycleEvents
import java.util.function.Predicate
import org.bukkit.NamespacedKey
import org.bukkit.entity.Player
import org.bukkit.plugin.Plugin

internal class ItemernessCommands(
    private val actions: ItemernessCommandActions,
    private val catalog: CommandCatalogView,
    private val playerArgument: () -> ArgumentType<PlayerSelectorArgumentResolver> = ArgumentTypes::player,
    private val restriction: (Predicate<CommandSourceStack>) -> Predicate<CommandSourceStack> = Commands::restricted,
) {
    fun register(plugin: Plugin) {
        plugin.lifecycleManager.registerEventHandler(LifecycleEvents.COMMANDS) { event ->
            event.registrar().register(
                build(),
                "Itemerness administration",
                listOf("itn"),
            )
        }
    }

    internal fun build() = Commands.literal("itemerness")
        .then(reload())
        .then(validate())
        .then(give())
        .then(inspect())
        .then(data())
        .then(refresh())
        .build()

    private fun reload() = Commands.literal("reload")
        .requires(restricted(Permissions.RELOAD))
        .executes { context -> execute { actions.reload(context.source.sender, false) } }
        .then(
            Commands.literal("check")
                .executes { context -> execute { actions.reload(context.source.sender, true) } },
        )

    private fun validate() = Commands.literal("validate")
        .requires(restricted(Permissions.VALIDATE))
        .executes { context -> execute { actions.validate(context.source.sender, ValidationOutput.TEXT) } }
        .then(
            Commands.literal("text")
                .executes { context -> execute { actions.validate(context.source.sender, ValidationOutput.TEXT) } },
        )
        .then(
            Commands.literal("json")
                .executes { context -> execute { actions.validate(context.source.sender, ValidationOutput.JSON) } },
        )

    private fun give() = Commands.literal("give")
        .requires(restricted(Permissions.GIVE))
        .then(
            Commands.argument("player", playerArgument())
                .then(
                    Commands.argument("item-id", ItemKeyArgument)
                        .suggests(suggestions { catalog.itemKeys().map(ItemKey::toString) })
                        .executes { context -> give(context, 1) }
                        .then(
                            Commands.argument("amount", IntegerArgumentType.integer(1, 99))
                                .executes { context ->
                                    give(context, IntegerArgumentType.getInteger(context, "amount"))
                                },
                        ),
                ),
        )

    private fun give(
        context: CommandContext<CommandSourceStack>,
        amount: Int,
    ): Int = execute {
        actions.give(
            context.source.sender,
            player(context),
            context.getArgument("item-id", ItemKey::class.java),
            amount,
        )
    }

    private fun inspect(): LiteralArgumentBuilder<CommandSourceStack> = Commands.literal("inspect")
        .requires(permission(Permissions.INSPECT))
        .then(inspectHand())
        .then(
            Commands.argument("player", playerArgument())
                .then(
                    Commands.argument("slot", StringArgumentType.word())
                        .suggests(suggestions { InventorySlot.entries.map(InventorySlot::argument) })
                        .executes { context -> inspectSlot(context, null, false) }
                        .then(
                            Commands.literal("raw")
                                .requires(restricted(Permissions.INSPECT_RAW))
                                .executes { context -> inspectSlot(context, null, true) },
                        )
                        .then(
                            Commands.literal("view")
                                .then(
                                    Commands.argument("locale", StringArgumentType.word())
                                        .suggests(suggestions(catalog::locales))
                                        .executes { context -> inspectSlot(context, locale(context), false) }
                                        .then(
                                            Commands.literal("raw")
                                                .requires(restricted(Permissions.INSPECT_RAW))
                                                .executes { context -> inspectSlot(context, locale(context), true) },
                                        ),
                                ),
                        ),
                ),
        )

    private fun inspectHand(): LiteralArgumentBuilder<CommandSourceStack> = Commands.literal("hand")
        .executes { context -> inspectHand(context, null, false) }
        .then(
            Commands.literal("raw")
                .requires(restricted(Permissions.INSPECT_RAW))
                .executes { context -> inspectHand(context, null, true) },
        )
        .then(
            Commands.literal("view")
                .then(
                    Commands.argument("locale", StringArgumentType.word())
                        .suggests(suggestions(catalog::locales))
                        .executes { context -> inspectHand(context, locale(context), false) }
                        .then(
                            Commands.literal("raw")
                                .requires(restricted(Permissions.INSPECT_RAW))
                                .executes { context -> inspectHand(context, locale(context), true) },
                        ),
                ),
        )

    private fun inspectHand(
        context: CommandContext<CommandSourceStack>,
        locale: String?,
        raw: Boolean,
    ): Int = execute {
        actions.inspectHand(context.source.sender, locale, raw)
    }

    private fun inspectSlot(
        context: CommandContext<CommandSourceStack>,
        locale: String?,
        raw: Boolean,
    ): Int = execute {
        actions.inspectSlot(
            context.source.sender,
            player(context),
            slot(context),
            locale,
            raw,
        )
    }

    private fun data() = Commands.literal("data")
        .then(
            Commands.literal("get")
                .requires(permission(Permissions.DATA_READ))
                .then(dataTarget { context ->
                    execute {
                        actions.readData(
                            context.source.sender,
                            player(context),
                            slot(context),
                            context.getArgument("key", DataKey::class.java),
                        )
                    }
                }),
        )
        .then(
            Commands.literal("set")
                .requires(restricted(Permissions.DATA_WRITE))
                .then(dataSetTarget()),
        )
        .then(
            Commands.literal("unset")
                .requires(restricted(Permissions.DATA_WRITE))
                .then(dataTarget { context ->
                    execute {
                        actions.unsetData(
                            context.source.sender,
                            player(context),
                            slot(context),
                            context.getArgument("key", DataKey::class.java),
                        )
                    }
                }),
        )

    private fun dataTarget(
        terminal: (CommandContext<CommandSourceStack>) -> Int,
    ): ArgumentBuilder<CommandSourceStack, *> = Commands.argument("player", playerArgument())
        .then(
            Commands.argument("slot", StringArgumentType.word())
                .suggests(suggestions { InventorySlot.entries.map(InventorySlot::argument) })
                .then(
                    Commands.argument("key", DataKeyArgument)
                        .suggests(suggestions { catalog.dataKeys().map(DataKey::toString) })
                        .executes(terminal),
                ),
        )

    private fun dataSetTarget(): ArgumentBuilder<CommandSourceStack, *> =
        Commands.argument("player", playerArgument())
            .then(
                Commands.argument("slot", StringArgumentType.word())
                    .suggests(suggestions { InventorySlot.entries.map(InventorySlot::argument) })
                    .then(
                        Commands.argument("key", DataKeyArgument)
                            .suggests(suggestions { catalog.dataKeys().map(DataKey::toString) })
                            .then(
                                Commands.argument("value", StringArgumentType.greedyString())
                                    .executes { context ->
                                        execute {
                                            actions.writeData(
                                                context.source.sender,
                                                player(context),
                                                slot(context),
                                                context.getArgument("key", DataKey::class.java),
                                                StringArgumentType.getString(context, "value"),
                                            )
                                        }
                                    },
                            ),
                    ),
            )

    private fun refresh() = Commands.literal("refresh")
        .then(
            Commands.literal("all")
                .requires(restricted(Permissions.REFRESH_ALL))
                .executes { context -> execute { actions.refreshAll(context.source.sender) } },
        )
        .then(
            Commands.argument("player", playerArgument())
                .requires(restricted(Permissions.REFRESH))
                .executes { context ->
                    execute { actions.refreshPlayer(context.source.sender, player(context)) }
                },
        )

    private fun player(context: CommandContext<CommandSourceStack>): Player {
        val resolver = context.getArgument("player", PlayerSelectorArgumentResolver::class.java)
        val players = resolver.resolve(context.source)
        return players.single()
    }

    private fun slot(context: CommandContext<CommandSourceStack>): InventorySlot {
        val value = StringArgumentType.getString(context, "slot")
        return InventorySlot.parse(value) ?: throw INVALID_SLOT.create(value)
    }

    private fun locale(context: CommandContext<CommandSourceStack>): String =
        StringArgumentType.getString(context, "locale")

    private fun suggestions(values: () -> Collection<String>) =
        SuggestionProvider<CommandSourceStack> { _, builder ->
            val remaining = builder.remainingLowerCase
            values().asSequence()
                .distinct()
                .sorted()
                .filter { value -> value.lowercase().startsWith(remaining) }
                .forEach(builder::suggest)
            builder.buildFuture()
        }

    private fun permission(node: String): Predicate<CommandSourceStack> =
        Predicate { source -> source.sender.hasPermission(node) }

    private fun restricted(node: String): Predicate<CommandSourceStack> =
        restriction(permission(node))

    private inline fun execute(action: () -> Unit): Int {
        action()
        return Command.SINGLE_SUCCESS
    }

    private object ItemKeyArgument : CustomArgumentType.Converted<ItemKey, NamespacedKey> {
        override fun getNativeType() = ArgumentTypes.namespacedKey()

        override fun convert(nativeType: NamespacedKey): ItemKey =
            ItemKey(nativeType.namespace, nativeType.key)
    }

    private object DataKeyArgument : CustomArgumentType.Converted<DataKey, NamespacedKey> {
        override fun getNativeType() = ArgumentTypes.namespacedKey()

        override fun convert(nativeType: NamespacedKey): DataKey =
            DataKey(ItemKey(nativeType.namespace, nativeType.key))
    }

    private companion object {
        val INVALID_SLOT = DynamicCommandExceptionType { value ->
            LiteralMessage("Unknown inventory slot: $value")
        }
    }
}

internal object Permissions {
    const val RELOAD = "itemerness.command.reload"
    const val VALIDATE = "itemerness.command.validate"
    const val GIVE = "itemerness.command.give"
    const val INSPECT = "itemerness.command.inspect"
    const val INSPECT_RAW = "itemerness.command.inspect.raw-nbt"
    const val DATA_READ = "itemerness.command.data.read"
    const val DATA_WRITE = "itemerness.command.data.write"
    const val REFRESH = "itemerness.command.refresh"
    const val REFRESH_ALL = "itemerness.command.refresh.all"
}
