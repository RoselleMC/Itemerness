package com.iroselle.itemerness.nms.v26_1_1

import java.util.Optional
import net.minecraft.advancements.AdvancementHolder
import net.minecraft.advancements.DisplayInfo
import net.minecraft.core.BlockPos
import net.minecraft.core.RegistryAccess
import net.minecraft.core.RegistrySynchronization
import net.minecraft.nbt.CompoundTag
import net.minecraft.nbt.NbtOps
import net.minecraft.network.chat.ClickEvent
import net.minecraft.network.chat.Component
import net.minecraft.network.chat.numbers.FixedFormat
import net.minecraft.network.chat.numbers.StyledFormat
import net.minecraft.network.protocol.common.ClientboundDisconnectPacket
import net.minecraft.network.protocol.common.ClientboundResourcePackPushPacket
import net.minecraft.network.protocol.common.ClientboundServerLinksPacket
import net.minecraft.network.protocol.common.ClientboundShowDialogPacket
import net.minecraft.network.protocol.configuration.ClientboundRegistryDataPacket
import net.minecraft.network.protocol.game.ClientboundBossEventPacket
import net.minecraft.network.protocol.game.ClientboundBlockEntityDataPacket
import net.minecraft.network.protocol.game.ClientboundExplodePacket
import net.minecraft.network.protocol.game.ClientboundLevelChunkWithLightPacket
import net.minecraft.network.protocol.game.ClientboundPlaceGhostRecipePacket
import net.minecraft.network.protocol.game.ClientboundPlayerCombatKillPacket
import net.minecraft.network.protocol.game.ClientboundRecipeBookAddPacket
import net.minecraft.network.protocol.game.ClientboundServerDataPacket
import net.minecraft.network.protocol.game.ClientboundSetObjectivePacket
import net.minecraft.network.protocol.game.ClientboundSetPlayerTeamPacket
import net.minecraft.network.protocol.game.ClientboundSetScorePacket
import net.minecraft.network.protocol.game.ClientboundTestInstanceBlockStatus
import net.minecraft.network.protocol.game.ClientboundTagQueryPacket
import net.minecraft.network.protocol.game.ClientboundUpdateAdvancementsPacket
import net.minecraft.network.protocol.game.ClientboundUpdateRecipesPacket
import net.minecraft.network.protocol.login.ClientboundLoginDisconnectPacket
import net.minecraft.network.protocol.status.ClientboundStatusResponsePacket
import net.minecraft.network.protocol.status.ServerStatus
import net.minecraft.server.dialog.ActionButton
import net.minecraft.server.dialog.CommonButtonData
import net.minecraft.server.dialog.CommonDialogData
import net.minecraft.server.dialog.ConfirmationDialog
import net.minecraft.server.dialog.DialogListDialog
import net.minecraft.server.dialog.Input
import net.minecraft.server.dialog.MultiActionDialog
import net.minecraft.server.dialog.NoticeDialog
import net.minecraft.server.dialog.ServerLinksDialog
import net.minecraft.server.dialog.action.StaticAction
import net.minecraft.server.dialog.action.CustomAll
import net.minecraft.server.dialog.body.ItemBody
import net.minecraft.server.dialog.body.PlainMessage
import net.minecraft.server.dialog.input.BooleanInput
import net.minecraft.server.dialog.input.NumberRangeInput
import net.minecraft.server.dialog.input.SingleOptionInput
import net.minecraft.server.dialog.input.TextInput
import net.minecraft.world.BossEvent
import net.minecraft.world.item.ItemStack
import net.minecraft.world.item.crafting.display.FurnaceRecipeDisplay
import net.minecraft.world.item.crafting.display.RecipeDisplayEntry
import net.minecraft.world.item.crafting.display.ShapedCraftingRecipeDisplay
import net.minecraft.world.item.crafting.display.ShapelessCraftingRecipeDisplay
import net.minecraft.world.item.crafting.display.SlotDisplay
import net.minecraft.world.item.crafting.display.SmithingRecipeDisplay
import net.minecraft.world.item.crafting.display.StonecutterRecipeDisplay
import net.minecraft.world.item.equipment.trim.TrimPattern
import net.minecraft.world.level.block.entity.BlockEntityType
import net.minecraft.world.scores.Objective
import net.minecraft.world.scores.PlayerTeam

/** Exact mapped-name contract for every structured carrier rebuilt by this adapter. */
internal object NmsStructuredCarrierAbi {
    fun verify() {
        record(ClientboundDisconnectPacket::class.java, "reason")
        record(ClientboundResourcePackPushPacket::class.java, "id", "url", "hash", "required", "prompt")
        record(ClientboundServerLinksPacket::class.java, "links")
        record(ClientboundShowDialogPacket::class.java, "dialog")
        record(ClientboundRegistryDataPacket::class.java, "registry", "entries")
        record(RegistrySynchronization.PackedRegistryEntry::class.java, "id", "data")
        record(ClientboundLoginDisconnectPacket::class.java, "reason")
        record(ClientboundStatusResponsePacket::class.java, "status")
        record(ServerStatus::class.java, "description", "players", "version", "favicon", "enforcesSecureChat")
        record(
            ClientboundExplodePacket::class.java,
            "center", "radius", "blockCount", "playerKnockback", "explosionParticle", "explosionSound", "blockParticles",
        )
        record(ClientboundSetScorePacket::class.java, "owner", "objectiveName", "score", "display", "numberFormat")
        record(ClientboundUpdateRecipesPacket::class.java, "itemSets", "stonecutterRecipes")
        record(ClientboundRecipeBookAddPacket::class.java, "entries", "replace")
        record(ClientboundRecipeBookAddPacket.Entry::class.java, "contents", "flags")
        record(ClientboundPlaceGhostRecipePacket::class.java, "containerId", "recipeDisplay")
        record(ClientboundPlayerCombatKillPacket::class.java, "playerId", "message")
        record(ClientboundServerDataPacket::class.java, "motd", "iconBytes")
        record(ClientboundTestInstanceBlockStatus::class.java, "status", "size")
        constructor(ClientboundTagQueryPacket::class.java, Int::class.javaPrimitiveType!!, CompoundTag::class.java)
        method(ClientboundTagQueryPacket::class.java, "getTransactionId")
        method(ClientboundTagQueryPacket::class.java, "getTag")
        constructor(
            ClientboundBlockEntityDataPacket::class.java,
            BlockPos::class.java,
            BlockEntityType::class.java,
            CompoundTag::class.java,
        )
        method(ClientboundBlockEntityDataPacket::class.java, "getPos")
        method(ClientboundBlockEntityDataPacket::class.java, "getType")
        method(ClientboundBlockEntityDataPacket::class.java, "getTag")
        ClientboundLevelChunkWithLightPacket::class.java.getField("STREAM_CODEC")
        NmsChunkPacketAccess.verifyAbi()
        ItemStack::class.java.getField("CODEC")
        method(RegistryAccess::class.java, "createSerializationContext", com.mojang.serialization.DynamicOps::class.java)
        check(NbtOps::class.java.getField("INSTANCE").get(null) === NbtOps.INSTANCE)

        method(ClientboundBossEventPacket::class.java, "dispatch", ClientboundBossEventPacket.Handler::class.java)
        method(ClientboundBossEventPacket::class.java, "createAddPacket", BossEvent::class.java)
        method(ClientboundBossEventPacket::class.java, "createUpdateNamePacket", BossEvent::class.java)
        constructor(ClientboundSetObjectivePacket::class.java, Objective::class.java, Int::class.javaPrimitiveType!!)
        listOf("getObjectiveName", "getDisplayName", "getMethod", "getRenderType", "getNumberFormat")
            .forEach { name -> method(ClientboundSetObjectivePacket::class.java, name) }
        method(ClientboundSetPlayerTeamPacket::class.java, "createAddOrModifyPacket", PlayerTeam::class.java, Boolean::class.javaPrimitiveType!!)
        listOf("getName", "getPlayers", "getParameters", "getTeamAction")
            .forEach { name -> method(ClientboundSetPlayerTeamPacket::class.java, name) }
        constructor(
            ClientboundUpdateAdvancementsPacket::class.java,
            Boolean::class.javaPrimitiveType!!,
            Collection::class.java,
            Set::class.java,
            Map::class.java,
            Boolean::class.javaPrimitiveType!!,
        )

        record(FixedFormat::class.java, "value")
        record(StyledFormat::class.java, "style")
        record(ClickEvent.ShowDialog::class.java, "dialog")
        record(ClickEvent.Custom::class.java, "id", "payload")
        record(CommonDialogData::class.java, "title", "externalTitle", "canCloseWithEscape", "pause", "afterAction", "body", "inputs")
        record(CommonButtonData::class.java, "label", "tooltip", "width")
        record(ActionButton::class.java, "button", "action")
        record(Input::class.java, "key", "control")
        record(ConfirmationDialog::class.java, "common", "yesButton", "noButton")
        record(NoticeDialog::class.java, "common", "action")
        record(MultiActionDialog::class.java, "common", "actions", "exitAction", "columns")
        record(DialogListDialog::class.java, "common", "dialogs", "exitAction", "columns", "buttonWidth")
        record(ServerLinksDialog::class.java, "common", "exitAction", "columns", "buttonWidth")
        record(PlainMessage::class.java, "contents", "width")
        record(ItemBody::class.java, "item", "description", "showDecorations", "showTooltip", "width", "height")
        record(BooleanInput::class.java, "label", "initial", "onTrue", "onFalse")
        record(NumberRangeInput::class.java, "width", "label", "labelFormat", "rangeInfo")
        record(SingleOptionInput::class.java, "width", "entries", "label", "labelVisible")
        record(SingleOptionInput.Entry::class.java, "id", "display", "initial")
        record(TextInput::class.java, "width", "label", "labelVisible", "initial", "maxLength", "multiline")
        record(StaticAction::class.java, "value")
        record(CustomAll::class.java, "id", "additions")

        record(AdvancementHolder::class.java, "id", "value")
        listOf("getIcon", "getTitle", "getDescription", "getBackground", "getType", "getX", "getY")
            .forEach { name -> method(DisplayInfo::class.java, name) }
        constructor(
            DisplayInfo::class.java,
            net.minecraft.world.item.ItemStackTemplate::class.java,
            Component::class.java,
            Component::class.java,
            Optional::class.java,
            net.minecraft.advancements.AdvancementType::class.java,
            Boolean::class.javaPrimitiveType!!,
            Boolean::class.javaPrimitiveType!!,
            Boolean::class.javaPrimitiveType!!,
        )

        record(RecipeDisplayEntry::class.java, "id", "display", "group", "category", "craftingRequirements")
        record(ShapedCraftingRecipeDisplay::class.java, "width", "height", "ingredients", "result", "craftingStation")
        record(ShapelessCraftingRecipeDisplay::class.java, "ingredients", "result", "craftingStation")
        record(FurnaceRecipeDisplay::class.java, "ingredient", "fuel", "result", "craftingStation", "duration", "experience")
        record(SmithingRecipeDisplay::class.java, "template", "base", "addition", "result", "craftingStation")
        record(StonecutterRecipeDisplay::class.java, "input", "result", "craftingStation")
        record(SlotDisplay.ItemStackSlotDisplay::class.java, "stack")
        record(SlotDisplay.Composite::class.java, "contents")
        record(SlotDisplay.DyedSlotDemo::class.java, "dye", "target")
        record(SlotDisplay.OnlyWithComponent::class.java, "source", "component")
        record(SlotDisplay.SmithingTrimDemoSlotDisplay::class.java, "base", "material", "pattern")
        record(SlotDisplay.WithAnyPotion::class.java, "display")
        record(SlotDisplay.WithRemainder::class.java, "input", "remainder")
        record(TrimPattern::class.java, "assetId", "description", "decal")
    }

    private fun record(type: Class<*>, vararg components: String) {
        check(type.isRecord) { "${type.name} is no longer a record" }
        val actual = type.recordComponents.map { component -> component.name }
        check(actual == components.toList()) {
            "${type.name} record components changed: expected ${components.toList()}, found $actual"
        }
    }

    private fun constructor(type: Class<*>, vararg parameters: Class<*>) {
        type.getConstructor(*parameters)
    }

    private fun method(type: Class<*>, name: String, vararg parameters: Class<*>) {
        type.getMethod(name, *parameters)
    }
}
