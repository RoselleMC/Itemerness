package com.iroselle.itemerness.nms.v26_1_2

import java.util.Optional
import java.util.UUID
import net.minecraft.advancements.Advancement
import net.minecraft.advancements.AdvancementHolder
import net.minecraft.advancements.DisplayInfo
import net.minecraft.core.Holder
import net.minecraft.core.HolderSet
import net.minecraft.network.chat.ClickEvent
import net.minecraft.network.chat.Component
import net.minecraft.network.chat.numbers.FixedFormat
import net.minecraft.network.chat.numbers.NumberFormat
import net.minecraft.network.chat.numbers.StyledFormat
import net.minecraft.server.dialog.ActionButton
import net.minecraft.server.dialog.CommonButtonData
import net.minecraft.server.dialog.CommonDialogData
import net.minecraft.server.dialog.ConfirmationDialog
import net.minecraft.server.dialog.Dialog
import net.minecraft.server.dialog.DialogListDialog
import net.minecraft.server.dialog.Input
import net.minecraft.server.dialog.MultiActionDialog
import net.minecraft.server.dialog.NoticeDialog
import net.minecraft.server.dialog.ServerLinksDialog
import net.minecraft.server.dialog.action.Action
import net.minecraft.server.dialog.action.CustomAll
import net.minecraft.server.dialog.action.StaticAction
import net.minecraft.server.dialog.body.DialogBody
import net.minecraft.server.dialog.body.ItemBody
import net.minecraft.server.dialog.body.PlainMessage
import net.minecraft.server.dialog.input.BooleanInput
import net.minecraft.server.dialog.input.InputControl
import net.minecraft.server.dialog.input.NumberRangeInput
import net.minecraft.server.dialog.input.SingleOptionInput
import net.minecraft.server.dialog.input.TextInput
import net.minecraft.world.item.crafting.SelectableRecipe
import net.minecraft.world.item.crafting.StonecutterRecipe
import net.minecraft.world.item.crafting.display.FurnaceRecipeDisplay
import net.minecraft.world.item.crafting.display.RecipeDisplay
import net.minecraft.world.item.crafting.display.RecipeDisplayEntry
import net.minecraft.world.item.crafting.display.ShapedCraftingRecipeDisplay
import net.minecraft.world.item.crafting.display.ShapelessCraftingRecipeDisplay
import net.minecraft.world.item.crafting.display.SlotDisplay
import net.minecraft.world.item.crafting.display.SmithingRecipeDisplay
import net.minecraft.world.item.crafting.display.StonecutterRecipeDisplay
import net.minecraft.world.item.equipment.trim.TrimPattern

/** Projects the bounded object graphs nested behind typed 26.1.2 packet carriers. */
internal class NmsStructuredPayloadProjector(
    private val itemProjector: NmsRecursiveItemProjector,
    private val componentProjector: NmsComponentProjector,
    private val packetBudget: NmsPayloadProjectionBudget? = null,
) : NmsDialogProjectionBridge {
    init {
        componentProjector.bindDialogProjector(this)
    }

    fun projectComponent(source: Component, viewerId: UUID): Component =
        componentProjector.project(source, viewerId, budget(), depth = 0)

    fun projectComponent(
        source: Component,
        viewerId: UUID,
        budget: NmsPayloadProjectionBudget,
        depth: Int = 0,
    ): Component = componentProjector.project(source, viewerId, budget, depth)

    fun projectNumberFormat(source: NumberFormat, viewerId: UUID): NumberFormat =
        projectNumberFormat(source, viewerId, budget(), depth = 0)

    fun projectAdvancement(source: AdvancementHolder, viewerId: UUID): AdvancementHolder =
        projectAdvancement(source, viewerId, budget(), depth = 0)

    fun projectDialog(source: Holder<Dialog>, viewerId: UUID): Holder<Dialog> =
        project(source, viewerId, budget(), depth = 0)

    fun projectRecipeDisplay(source: RecipeDisplay, viewerId: UUID): RecipeDisplay =
        projectRecipeDisplay(source, viewerId, budget(), depth = 0)

    fun projectRecipeDisplayEntry(source: RecipeDisplayEntry, viewerId: UUID): RecipeDisplayEntry =
        projectRecipeDisplayEntry(source, viewerId, budget(), depth = 0)

    fun projectStonecutterRecipes(
        source: SelectableRecipe.SingleInputSet<StonecutterRecipe>,
        viewerId: UUID,
    ): SelectableRecipe.SingleInputSet<StonecutterRecipe> =
        projectStonecutterRecipes(source, viewerId, budget(), depth = 0)

    private fun budget(): NmsPayloadProjectionBudget = packetBudget ?: NmsPayloadProjectionBudget()

    override fun project(
        source: Holder<Dialog>,
        viewerId: UUID,
        budget: NmsPayloadProjectionBudget,
        depth: Int,
    ): Holder<Dialog> {
        val dialog = source.value()
        budget.enterDialog(dialog, depth)
        return try {
            val projected = projectDialogValue(dialog, viewerId, budget, depth + 1)
            if (projected === dialog) source else Holder.direct(projected)
        } finally {
            budget.leaveDialog(dialog)
        }
    }

    private fun projectNumberFormat(
        source: NumberFormat,
        viewerId: UUID,
        budget: NmsPayloadProjectionBudget,
        depth: Int,
    ): NumberFormat {
        budget.enterPayload(depth)
        return when (source) {
            is FixedFormat -> {
                val value = componentProjector.project(source.value(), viewerId, budget, depth + 1)
                if (value === source.value()) source else FixedFormat(value)
            }
            is StyledFormat -> {
                val wrapper = Component.empty().setStyle(source.style())
                val projected = componentProjector.project(wrapper, viewerId, budget, depth + 1)
                if (projected.style === source.style()) source else StyledFormat(projected.style)
            }
            else -> source
        }
    }

    fun projectAdvancement(
        source: AdvancementHolder,
        viewerId: UUID,
        budget: NmsPayloadProjectionBudget,
        depth: Int,
    ): AdvancementHolder {
        budget.enterPayload(depth)
        val value = source.value()
        if (value.display().isEmpty) {
            return source
        }
        val display = value.display().orElseThrow()
        val icon = itemProjector.project(display.icon, viewerId)
        val title = componentProjector.project(display.title, viewerId, budget, depth + 1)
        val description = componentProjector.project(display.description, viewerId, budget, depth + 1)
        if (icon === display.icon && title === display.title && description === display.description) {
            return source
        }
        val projectedDisplay = DisplayInfo(
            icon,
            title,
            description,
            display.background,
            display.type,
            display.shouldShowToast(),
            display.shouldAnnounceChat(),
            display.isHidden,
        ).also { rebuilt -> rebuilt.setLocation(display.x, display.y) }
        val projected = Advancement(
            value.parent(),
            Optional.of(projectedDisplay),
            value.rewards(),
            value.criteria(),
            value.requirements(),
            value.sendsTelemetryEvent(),
        )
        return AdvancementHolder(source.id(), projected)
    }

    private fun projectDialogValue(
        source: Dialog,
        viewerId: UUID,
        budget: NmsPayloadProjectionBudget,
        depth: Int,
    ): Dialog {
        val common = projectCommonDialog(source.common(), viewerId, budget, depth)
        return when (source) {
            is ConfirmationDialog -> {
                val yes = projectActionButton(source.yesButton(), viewerId, budget, depth)
                val no = projectActionButton(source.noButton(), viewerId, budget, depth)
                if (common === source.common() && yes === source.yesButton() && no === source.noButton()) {
                    source
                } else {
                    ConfirmationDialog(common, yes, no)
                }
            }
            is NoticeDialog -> {
                val action = projectActionButton(source.action(), viewerId, budget, depth)
                if (common === source.common() && action === source.action()) source else NoticeDialog(common, action)
            }
            is MultiActionDialog -> {
                val actions = projectActionButtons(source.actions(), viewerId, budget, depth)
                val exit = projectOptionalActionButton(source.exitAction(), viewerId, budget, depth)
                if (common === source.common() && actions === source.actions() && exit == source.exitAction()) {
                    source
                } else {
                    MultiActionDialog(common, actions, exit, source.columns())
                }
            }
            is DialogListDialog -> {
                val dialogs = projectDialogSet(source.dialogs(), viewerId, budget, depth)
                val exit = projectOptionalActionButton(source.exitAction(), viewerId, budget, depth)
                if (common === source.common() && dialogs === source.dialogs() && exit == source.exitAction()) {
                    source
                } else {
                    DialogListDialog(common, dialogs, exit, source.columns(), source.buttonWidth())
                }
            }
            is ServerLinksDialog -> {
                val exit = projectOptionalActionButton(source.exitAction(), viewerId, budget, depth)
                if (common === source.common() && exit == source.exitAction()) {
                    source
                } else {
                    ServerLinksDialog(common, exit, source.columns(), source.buttonWidth())
                }
            }
            else -> source
        }
    }

    private fun projectCommonDialog(
        source: CommonDialogData,
        viewerId: UUID,
        budget: NmsPayloadProjectionBudget,
        depth: Int,
    ): CommonDialogData {
        budget.enterPayload(depth)
        val title = componentProjector.project(source.title(), viewerId, budget, depth + 1)
        val externalTitle = projectOptionalComponent(source.externalTitle(), viewerId, budget, depth + 1)
        val body = projectDialogBodies(source.body(), viewerId, budget, depth + 1)
        val inputs = projectInputs(source.inputs(), viewerId, budget, depth + 1)
        return if (
            title === source.title() &&
            externalTitle == source.externalTitle() &&
            body === source.body() &&
            inputs === source.inputs()
        ) {
            source
        } else {
            CommonDialogData(
                title,
                externalTitle,
                source.canCloseWithEscape(),
                source.pause(),
                source.afterAction(),
                body,
                inputs,
            )
        }
    }

    private fun projectDialogBodies(
        source: List<DialogBody>,
        viewerId: UUID,
        budget: NmsPayloadProjectionBudget,
        depth: Int,
    ): List<DialogBody> {
        var changed = false
        val projected = source.map { body ->
            budget.enterPayload(depth)
            val value: DialogBody = when (body) {
                is PlainMessage -> {
                    val contents = componentProjector.project(body.contents(), viewerId, budget, depth + 1)
                    if (contents === body.contents()) body else PlainMessage(contents, body.width())
                }
                is ItemBody -> {
                    val item = itemProjector.project(body.item(), viewerId)
                    val description = projectOptionalPlainMessage(body.description(), viewerId, budget, depth + 1)
                    if (item === body.item() && description == body.description()) {
                        body
                    } else {
                        ItemBody(
                            item,
                            description,
                            body.showDecorations(),
                            body.showTooltip(),
                            body.width(),
                            body.height(),
                        )
                    }
                }
                else -> body
            }
            changed = changed || value !== body
            value
        }
        return if (!changed) source else java.util.List.copyOf(projected)
    }

    private fun projectInputs(
        source: List<Input>,
        viewerId: UUID,
        budget: NmsPayloadProjectionBudget,
        depth: Int,
    ): List<Input> {
        var changed = false
        val projected = source.map { input ->
            budget.enterPayload(depth)
            val control = projectInputControl(input.control(), viewerId, budget, depth + 1)
            if (control === input.control()) {
                input
            } else {
                changed = true
                Input(input.key(), control)
            }
        }
        return if (!changed) source else java.util.List.copyOf(projected)
    }

    private fun projectInputControl(
        source: InputControl,
        viewerId: UUID,
        budget: NmsPayloadProjectionBudget,
        depth: Int,
    ): InputControl = when (source) {
        is BooleanInput -> {
            val label = componentProjector.project(source.label(), viewerId, budget, depth)
            if (label === source.label()) source else BooleanInput(label, source.initial(), source.onTrue(), source.onFalse())
        }
        is NumberRangeInput -> {
            val label = componentProjector.project(source.label(), viewerId, budget, depth)
            if (label === source.label()) {
                source
            } else {
                NumberRangeInput(source.width(), label, source.labelFormat(), source.rangeInfo())
            }
        }
        is SingleOptionInput -> {
            val label = componentProjector.project(source.label(), viewerId, budget, depth)
            var changed = label !== source.label()
            val entries = source.entries().map { entry ->
                val display = projectOptionalComponent(entry.display(), viewerId, budget, depth)
                if (display == entry.display()) {
                    entry
                } else {
                    changed = true
                    SingleOptionInput.Entry(entry.id(), display, entry.initial())
                }
            }
            if (!changed) {
                source
            } else {
                SingleOptionInput(source.width(), java.util.List.copyOf(entries), label, source.labelVisible())
            }
        }
        is TextInput -> {
            val label = componentProjector.project(source.label(), viewerId, budget, depth)
            if (label === source.label()) {
                source
            } else {
                TextInput(
                    source.width(),
                    label,
                    source.labelVisible(),
                    source.initial(),
                    source.maxLength(),
                    source.multiline(),
                )
            }
        }
        else -> source
    }

    private fun projectActionButtons(
        source: List<ActionButton>,
        viewerId: UUID,
        budget: NmsPayloadProjectionBudget,
        depth: Int,
    ): List<ActionButton> {
        var changed = false
        val projected = source.map { button ->
            val value = projectActionButton(button, viewerId, budget, depth)
            changed = changed || value !== button
            value
        }
        return if (!changed) source else java.util.List.copyOf(projected)
    }

    private fun projectActionButton(
        source: ActionButton,
        viewerId: UUID,
        budget: NmsPayloadProjectionBudget,
        depth: Int,
    ): ActionButton {
        budget.enterPayload(depth)
        val button = source.button()
        val label = componentProjector.project(button.label(), viewerId, budget, depth + 1)
        val tooltip = projectOptionalComponent(button.tooltip(), viewerId, budget, depth + 1)
        val action = projectOptionalAction(source.action(), viewerId, budget, depth + 1)
        if (label === button.label() && tooltip == button.tooltip() && action == source.action()) {
            return source
        }
        return ActionButton(CommonButtonData(label, tooltip, button.width()), action)
    }

    private fun projectOptionalActionButton(
        source: Optional<ActionButton>,
        viewerId: UUID,
        budget: NmsPayloadProjectionBudget,
        depth: Int,
    ): Optional<ActionButton> {
        if (source.isEmpty) return source
        val original = source.orElseThrow()
        val projected = projectActionButton(original, viewerId, budget, depth)
        return if (projected === original) source else Optional.of(projected)
    }

    private fun projectOptionalAction(
        source: Optional<Action>,
        viewerId: UUID,
        budget: NmsPayloadProjectionBudget,
        depth: Int,
    ): Optional<Action> {
        if (source.isEmpty) return source
        val original = source.orElseThrow()
        val projected = when (original) {
            is StaticAction -> {
                val click = componentProjector.projectClickEvent(original.value(), viewerId, budget, depth)
                if (click === original.value()) original else StaticAction(click)
            }
            is CustomAll -> {
                if (original.additions().isEmpty) {
                    original
                } else {
                    val additions = original.additions().orElseThrow()
                    val value = componentProjector.projectTag(additions, viewerId, budget)
                    if (!value.changed) {
                        original
                    } else {
                        val projected = value.tag as net.minecraft.nbt.CompoundTag
                        CustomAll(
                            original.id(),
                            Optional.of(
                                componentProjector.registerCustomAdditions(
                                    original.id(),
                                    additions,
                                    projected,
                                ),
                            ),
                        )
                    }
                }
            }
            else -> original
        }
        return if (projected === original) source else Optional.of(projected)
    }

    private fun projectDialogSet(
        source: HolderSet<Dialog>,
        viewerId: UUID,
        budget: NmsPayloadProjectionBudget,
        depth: Int,
    ): HolderSet<Dialog> {
        var changed = false
        val projected = source.map { holder ->
            val value = project(holder, viewerId, budget, depth)
            changed = changed || value !== holder
            value
        }
        return if (!changed) source else HolderSet.direct(projected)
    }

    private fun projectOptionalPlainMessage(
        source: Optional<PlainMessage>,
        viewerId: UUID,
        budget: NmsPayloadProjectionBudget,
        depth: Int,
    ): Optional<PlainMessage> {
        if (source.isEmpty) return source
        val original = source.orElseThrow()
        val contents = componentProjector.project(original.contents(), viewerId, budget, depth)
        return if (contents === original.contents()) source else Optional.of(PlainMessage(contents, original.width()))
    }

    private fun projectOptionalComponent(
        source: Optional<Component>,
        viewerId: UUID,
        budget: NmsPayloadProjectionBudget,
        depth: Int,
    ): Optional<Component> {
        if (source.isEmpty) return source
        val original = source.orElseThrow()
        val projected = componentProjector.project(original, viewerId, budget, depth)
        return if (projected === original) source else Optional.of(projected)
    }

    fun projectRecipeDisplayEntry(
        source: RecipeDisplayEntry,
        viewerId: UUID,
        budget: NmsPayloadProjectionBudget,
        depth: Int,
    ): RecipeDisplayEntry {
        budget.enterPayload(depth)
        val display = projectRecipeDisplay(source.display(), viewerId, budget, depth + 1)
        return if (display === source.display()) {
            source
        } else {
            RecipeDisplayEntry(source.id(), display, source.group(), source.category(), source.craftingRequirements())
        }
    }

    private fun projectRecipeDisplay(
        source: RecipeDisplay,
        viewerId: UUID,
        budget: NmsPayloadProjectionBudget,
        depth: Int,
    ): RecipeDisplay {
        budget.enterPayload(depth)
        return when (source) {
            is ShapedCraftingRecipeDisplay -> {
                val ingredients = projectSlots(source.ingredients(), viewerId, budget, depth + 1)
                val result = projectSlot(source.result(), viewerId, budget, depth + 1)
                val station = projectSlot(source.craftingStation(), viewerId, budget, depth + 1)
                if (ingredients === source.ingredients() && result === source.result() && station === source.craftingStation()) {
                    source
                } else {
                    ShapedCraftingRecipeDisplay(source.width(), source.height(), ingredients, result, station)
                }
            }
            is ShapelessCraftingRecipeDisplay -> {
                val ingredients = projectSlots(source.ingredients(), viewerId, budget, depth + 1)
                val result = projectSlot(source.result(), viewerId, budget, depth + 1)
                val station = projectSlot(source.craftingStation(), viewerId, budget, depth + 1)
                if (ingredients === source.ingredients() && result === source.result() && station === source.craftingStation()) {
                    source
                } else {
                    ShapelessCraftingRecipeDisplay(ingredients, result, station)
                }
            }
            is FurnaceRecipeDisplay -> {
                val ingredient = projectSlot(source.ingredient(), viewerId, budget, depth + 1)
                val fuel = projectSlot(source.fuel(), viewerId, budget, depth + 1)
                val result = projectSlot(source.result(), viewerId, budget, depth + 1)
                val station = projectSlot(source.craftingStation(), viewerId, budget, depth + 1)
                if (
                    ingredient === source.ingredient() && fuel === source.fuel() &&
                    result === source.result() && station === source.craftingStation()
                ) {
                    source
                } else {
                    FurnaceRecipeDisplay(ingredient, fuel, result, station, source.duration(), source.experience())
                }
            }
            is SmithingRecipeDisplay -> {
                val template = projectSlot(source.template(), viewerId, budget, depth + 1)
                val base = projectSlot(source.base(), viewerId, budget, depth + 1)
                val addition = projectSlot(source.addition(), viewerId, budget, depth + 1)
                val result = projectSlot(source.result(), viewerId, budget, depth + 1)
                val station = projectSlot(source.craftingStation(), viewerId, budget, depth + 1)
                if (
                    template === source.template() && base === source.base() && addition === source.addition() &&
                    result === source.result() && station === source.craftingStation()
                ) {
                    source
                } else {
                    SmithingRecipeDisplay(template, base, addition, result, station)
                }
            }
            is StonecutterRecipeDisplay -> {
                val input = projectSlot(source.input(), viewerId, budget, depth + 1)
                val result = projectSlot(source.result(), viewerId, budget, depth + 1)
                val station = projectSlot(source.craftingStation(), viewerId, budget, depth + 1)
                if (input === source.input() && result === source.result() && station === source.craftingStation()) {
                    source
                } else {
                    StonecutterRecipeDisplay(input, result, station)
                }
            }
            else -> source
        }
    }

    private fun projectStonecutterRecipes(
        source: SelectableRecipe.SingleInputSet<StonecutterRecipe>,
        viewerId: UUID,
        budget: NmsPayloadProjectionBudget,
        depth: Int,
    ): SelectableRecipe.SingleInputSet<StonecutterRecipe> {
        var changed = false
        val entries = source.entries().map { entry ->
            budget.enterPayload(depth)
            val recipe = entry.recipe()
            val display = projectSlot(recipe.optionDisplay(), viewerId, budget, depth + 1)
            if (display === recipe.optionDisplay()) {
                entry
            } else {
                changed = true
                SelectableRecipe.SingleInputEntry(
                    entry.input(),
                    SelectableRecipe(display, recipe.recipe()),
                )
            }
        }
        return if (!changed) source else SelectableRecipe.SingleInputSet(java.util.List.copyOf(entries))
    }

    private fun projectSlots(
        source: List<SlotDisplay>,
        viewerId: UUID,
        budget: NmsPayloadProjectionBudget,
        depth: Int,
    ): List<SlotDisplay> {
        var changed = false
        val projected = source.map { slot ->
            val value = projectSlot(slot, viewerId, budget, depth)
            changed = changed || value !== slot
            value
        }
        return if (!changed) source else java.util.List.copyOf(projected)
    }

    private fun projectSlot(
        source: SlotDisplay,
        viewerId: UUID,
        budget: NmsPayloadProjectionBudget,
        depth: Int,
    ): SlotDisplay {
        budget.enterPayload(depth)
        return when (source) {
            is SlotDisplay.ItemStackSlotDisplay -> {
                val stack = itemProjector.project(source.stack(), viewerId)
                if (stack === source.stack()) source else SlotDisplay.ItemStackSlotDisplay(stack)
            }
            is SlotDisplay.Composite -> {
                val contents = projectSlots(source.contents(), viewerId, budget, depth + 1)
                if (contents === source.contents()) source else SlotDisplay.Composite(contents)
            }
            is SlotDisplay.DyedSlotDemo -> {
                val dye = projectSlot(source.dye(), viewerId, budget, depth + 1)
                val target = projectSlot(source.target(), viewerId, budget, depth + 1)
                if (dye === source.dye() && target === source.target()) source else SlotDisplay.DyedSlotDemo(dye, target)
            }
            is SlotDisplay.OnlyWithComponent -> {
                val nested = projectSlot(source.source(), viewerId, budget, depth + 1)
                if (nested === source.source()) source else SlotDisplay.OnlyWithComponent(nested, source.component())
            }
            is SlotDisplay.SmithingTrimDemoSlotDisplay -> {
                val base = projectSlot(source.base(), viewerId, budget, depth + 1)
                val material = projectSlot(source.material(), viewerId, budget, depth + 1)
                val pattern = projectTrimPattern(source.pattern(), viewerId, budget, depth + 1)
                if (base === source.base() && material === source.material() && pattern === source.pattern()) {
                    source
                } else {
                    SlotDisplay.SmithingTrimDemoSlotDisplay(base, material, pattern)
                }
            }
            is SlotDisplay.WithAnyPotion -> {
                val display = projectSlot(source.display(), viewerId, budget, depth + 1)
                if (display === source.display()) source else SlotDisplay.WithAnyPotion(display)
            }
            is SlotDisplay.WithRemainder -> {
                val input = projectSlot(source.input(), viewerId, budget, depth + 1)
                val remainder = projectSlot(source.remainder(), viewerId, budget, depth + 1)
                if (input === source.input() && remainder === source.remainder()) {
                    source
                } else {
                    SlotDisplay.WithRemainder(input, remainder)
                }
            }
            else -> source
        }
    }

    private fun projectTrimPattern(
        source: Holder<TrimPattern>,
        viewerId: UUID,
        budget: NmsPayloadProjectionBudget,
        depth: Int,
    ): Holder<TrimPattern> {
        budget.enterPayload(depth)
        val value = source.value()
        val description = componentProjector.project(value.description(), viewerId, budget, depth + 1)
        return if (description === value.description()) {
            source
        } else {
            Holder.direct(TrimPattern(value.assetId(), description, value.decal()))
        }
    }
}
