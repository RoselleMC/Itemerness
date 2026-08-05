package com.iroselle.itemerness.nms.v26_1_2

import java.util.Optional
import java.util.UUID
import net.minecraft.core.Holder
import net.minecraft.network.chat.ClickEvent
import net.minecraft.network.chat.Component
import net.minecraft.network.chat.ComponentContents
import net.minecraft.network.chat.HoverEvent
import net.minecraft.network.chat.MutableComponent
import net.minecraft.network.chat.Style
import net.minecraft.nbt.Tag
import net.minecraft.core.RegistryAccess
import com.iroselle.itemerness.projection.ProjectionGeneration
import net.minecraft.resources.Identifier
import net.minecraft.nbt.CompoundTag
import net.minecraft.network.chat.contents.NbtContents
import net.minecraft.network.chat.contents.ObjectContents
import net.minecraft.network.chat.contents.SelectorContents
import net.minecraft.network.chat.contents.TranslatableContents
import net.minecraft.server.dialog.Dialog

/** Deeply rebuilds components whose hover graph exposes an ItemStackTemplate. */
internal class NmsComponentProjector(
    private val itemProjector: NmsRecursiveItemProjector,
    private val nbtProjector: NmsCanonicalNbtProjector,
    private val registryAccessSource: () -> RegistryAccess,
    private val customPayloadRegistration: NmsCustomPayloadRegistration,
    private val generationSource: () -> ProjectionGeneration?,
) {
    private var dialogProjector: NmsDialogProjectionBridge = NmsDialogProjectionBridge.NOOP

    fun bindDialogProjector(projector: NmsDialogProjectionBridge) {
        check(dialogProjector === NmsDialogProjectionBridge.NOOP) {
            "The component dialog projector can only be bound once"
        }
        dialogProjector = projector
    }

    fun project(source: Component, viewerId: UUID): Component =
        project(source, viewerId, NmsPayloadProjectionBudget(), depth = 0)

    fun project(
        source: Component,
        viewerId: UUID,
        budget: NmsPayloadProjectionBudget,
        depth: Int,
    ): Component = projectComponent(source, viewerId, budget, depth)

    private fun projectComponent(
        source: Component,
        viewerId: UUID,
        budget: NmsPayloadProjectionBudget,
        depth: Int,
    ): Component {
        budget.enterComponent(depth)

        val projectedContents = projectContents(source.contents, viewerId, budget, depth + 1)
        val projectedStyle = projectStyle(source.style, viewerId, budget, depth + 1)
        var siblingChanged = false
        val projectedSiblings = source.siblings.map { sibling ->
            val projected = projectComponent(sibling, viewerId, budget, depth + 1)
            siblingChanged = siblingChanged || projected !== sibling
            projected
        }

        if (projectedContents === source.contents && projectedStyle === source.style && !siblingChanged) {
            return source
        }

        return MutableComponent.create(projectedContents)
            .setStyle(projectedStyle)
            .also { rebuilt -> projectedSiblings.forEach(rebuilt::append) }
    }

    private fun projectContents(
        source: ComponentContents,
        viewerId: UUID,
        budget: NmsPayloadProjectionBudget,
        depth: Int,
    ): ComponentContents = when (source) {
        is TranslatableContents -> projectTranslatable(source, viewerId, budget, depth)
        is SelectorContents -> {
            val separator = projectOptional(source.separator(), viewerId, budget, depth)
            if (separator == source.separator()) source else SelectorContents(source.selector(), separator)
        }
        is NbtContents -> {
            val separator = projectOptional(source.separator(), viewerId, budget, depth)
            if (separator == source.separator()) {
                source
            } else {
                NbtContents(
                    source.nbtPath(),
                    source.interpreting(),
                    source.plain(),
                    separator,
                    source.dataSource(),
                )
            }
        }
        is ObjectContents -> {
            val fallback = projectOptional(source.fallback(), viewerId, budget, depth)
            if (fallback == source.fallback()) source else ObjectContents(source.contents(), fallback)
        }
        else -> source
    }

    private fun projectTranslatable(
        source: TranslatableContents,
        viewerId: UUID,
        budget: NmsPayloadProjectionBudget,
        depth: Int,
    ): TranslatableContents {
        var changed = false
        val args = source.args.map { argument ->
            if (argument is Component) {
                val projected = projectComponent(argument, viewerId, budget, depth)
                changed = changed || projected !== argument
                projected
            } else {
                argument
            }
        }.toTypedArray()
        return if (!changed) source else TranslatableContents(source.key, source.fallback, args)
    }

    private fun projectStyle(
        source: Style,
        viewerId: UUID,
        budget: NmsPayloadProjectionBudget,
        depth: Int,
    ): Style {
        val hover = source.hoverEvent
        val projectedHover = when (hover) {
            is HoverEvent.ShowItem -> {
                val item = itemProjector.project(hover.item(), viewerId)
                if (item === hover.item()) hover else HoverEvent.ShowItem(item)
            }
            is HoverEvent.ShowText -> {
                val value = projectComponent(hover.value(), viewerId, budget, depth)
                if (value === hover.value()) hover else HoverEvent.ShowText(value)
            }
            is HoverEvent.ShowEntity -> {
                val info = hover.entity()
                val name = projectOptional(info.name, viewerId, budget, depth)
                if (name == info.name) {
                    hover
                } else {
                    HoverEvent.ShowEntity(HoverEvent.EntityTooltipInfo(info.type, info.uuid, name))
                }
            }
            else -> hover
        }
        val click = source.clickEvent
        val projectedClick = click?.let { projectClickEvent(it, viewerId, budget, depth) }
        var result = source
        if (projectedHover !== hover) {
            result = result.withHoverEvent(projectedHover)
        }
        if (projectedClick !== click) {
            result = result.withClickEvent(projectedClick)
        }
        return result
    }

    fun projectClickEvent(
        source: ClickEvent,
        viewerId: UUID,
        budget: NmsPayloadProjectionBudget,
        depth: Int,
    ): ClickEvent = when (source) {
            is ClickEvent.ShowDialog -> {
                val dialog = dialogProjector.project(source.dialog(), viewerId, budget, depth)
                if (dialog === source.dialog()) source else ClickEvent.ShowDialog(dialog)
            }
            is ClickEvent.Custom -> {
                val payload = projectOptionalTag(source.payload(), viewerId, budget)
                if (payload == source.payload()) {
                    source
                } else {
                    val registered = customPayloadRegistration.registerDirect(
                        source.id(),
                        source.payload().orElseThrow(),
                        payload.orElseThrow(),
                        generationSource(),
                    )
                    ClickEvent.Custom(source.id(), Optional.of(registered))
                }
            }
            else -> source
        }

    fun projectTag(
        source: Tag,
        viewerId: UUID,
        budget: NmsPayloadProjectionBudget,
    ): NmsTagProjection = nbtProjector.newSession(
        viewerId,
        registryAccessSource(),
        budget.nbtBudget,
    ).project(source)

    fun registerCustomAdditions(
        id: Identifier,
        canonical: CompoundTag,
        projected: CompoundTag,
    ): CompoundTag = customPayloadRegistration.registerAdditions(
        id,
        canonical,
        projected,
        generationSource(),
    )

    private fun projectOptionalTag(
        source: Optional<Tag>,
        viewerId: UUID,
        budget: NmsPayloadProjectionBudget,
    ): Optional<Tag> {
        if (source.isEmpty) return source
        val original = source.orElseThrow()
        val projected = projectTag(original, viewerId, budget)
        return if (!projected.changed) source else Optional.of(projected.tag)
    }

    private fun projectOptional(
        source: Optional<Component>,
        viewerId: UUID,
        budget: NmsPayloadProjectionBudget,
        depth: Int,
    ): Optional<Component> {
        if (source.isEmpty) {
            return source
        }
        val original = source.orElseThrow()
        val projected = projectComponent(original, viewerId, budget, depth)
        return if (projected === original) source else Optional.of(projected)
    }

}

internal fun interface NmsDialogProjectionBridge {
    fun project(
        source: Holder<Dialog>,
        viewerId: UUID,
        budget: NmsPayloadProjectionBudget,
        depth: Int,
    ): Holder<Dialog>

    companion object {
        val NOOP = NmsDialogProjectionBridge { source, _, _, _ -> source }
    }
}

/** Shared graph budget for mutually recursive components, dialogs, advancements, and recipes. */
internal class NmsPayloadProjectionBudget(
    val nbtBudget: NmsCanonicalNbtProjector.TraversalBudget = NmsCanonicalNbtProjector.TraversalBudget(),
    private val limits: NmsProjectionLimits = NmsProjectionLimits.DEFAULT,
) {
    private var componentNodes = 0
    private var payloadNodes = 0
    private val activeDialogs = java.util.IdentityHashMap<Dialog, Unit>()

    fun enterComponent(depth: Int) {
        requireProjectionInput(depth <= limits.componentDepth) { "Component projection exceeds the recursion limit" }
        componentNodes++
        requireProjectionInput(componentNodes <= limits.componentNodes) {
            "Component projection exceeds the node limit"
        }
    }

    fun enterPayload(depth: Int) {
        requireProjectionInput(depth <= limits.componentDepth) {
            "Structured payload projection exceeds the recursion limit"
        }
        payloadNodes++
        requireProjectionInput(payloadNodes <= limits.payloadNodes) {
            "Structured payload projection exceeds the node limit"
        }
    }

    fun enterDialog(dialog: Dialog, depth: Int) {
        enterPayload(depth)
        requireProjectionInput(activeDialogs.put(dialog, Unit) == null) {
            "Dialog projection contains a reference cycle"
        }
    }

    fun leaveDialog(dialog: Dialog) {
        activeDialogs.remove(dialog)
    }
}
