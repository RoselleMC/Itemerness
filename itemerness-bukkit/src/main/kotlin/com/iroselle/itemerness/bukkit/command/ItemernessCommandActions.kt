package com.iroselle.itemerness.bukkit.command

import com.iroselle.itemerness.api.DataKey
import com.iroselle.itemerness.api.ItemKey
import org.bukkit.command.CommandSender
import org.bukkit.entity.Player

internal interface ItemernessCommandActions {
    fun reload(
        sender: CommandSender,
        checkOnly: Boolean,
    )

    fun validate(
        sender: CommandSender,
        format: ValidationOutput,
    )

    fun give(
        sender: CommandSender,
        target: Player,
        itemKey: ItemKey,
        amount: Int,
    )

    fun inspectHand(
        sender: CommandSender,
        locale: String?,
        raw: Boolean,
    )

    fun inspectSlot(
        sender: CommandSender,
        target: Player,
        slot: InventorySlot,
        locale: String?,
        raw: Boolean,
    )

    fun readData(
        sender: CommandSender,
        target: Player,
        slot: InventorySlot,
        key: DataKey,
    )

    fun writeData(
        sender: CommandSender,
        target: Player,
        slot: InventorySlot,
        key: DataKey,
        literal: String,
    )

    fun unsetData(
        sender: CommandSender,
        target: Player,
        slot: InventorySlot,
        key: DataKey,
    )

    fun refreshPlayer(
        sender: CommandSender,
        target: Player,
    )

    fun refreshAll(sender: CommandSender)
}

internal enum class ValidationOutput {
    TEXT,
    JSON,
}

internal enum class InventorySlot(
    val argument: String,
) {
    MAIN_HAND("mainhand"),
    OFF_HAND("offhand"),
    HELMET("helmet"),
    CHESTPLATE("chestplate"),
    LEGGINGS("leggings"),
    BOOTS("boots"),
    ;

    companion object {
        fun parse(value: String): InventorySlot? = entries.firstOrNull { it.argument == value }
    }
}
