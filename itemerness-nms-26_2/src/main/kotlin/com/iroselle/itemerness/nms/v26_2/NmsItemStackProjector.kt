package com.iroselle.itemerness.nms.v26_2

import com.iroselle.itemerness.projection.ProjectionRequest
import com.iroselle.itemerness.projection.ProjectionResult
import com.iroselle.itemerness.projection.ProjectionRuntime
import com.iroselle.itemerness.projection.ProjectionGeneration
import com.iroselle.itemerness.projection.ProjectionPdcFallbackPlan
import com.iroselle.itemerness.projection.RenderedDisplay
import java.util.UUID
import net.minecraft.core.component.DataComponents
import net.minecraft.resources.Identifier
import net.minecraft.world.item.ItemStack
import net.minecraft.world.item.component.CustomData
import net.minecraft.world.item.component.ItemLore
import net.minecraft.world.item.component.TooltipDisplay

internal class NmsItemStackProjector(
    private val runtime: ProjectionRuntime,
    private val codec: NmsCanonicalItemCodec = NmsCanonicalItemCodec(),
) {
    fun project(source: ItemStack, viewerId: UUID): ItemStack = newSession(viewerId).project(source).stack

    fun newSession(viewerId: UUID): NmsItemProjectionSession {
        val context = try {
            runtime.contexts.acquire(viewerId)
        } catch (_: Exception) {
            null
        }?.takeIf { it.viewer.viewerId == viewerId }
        val fallbackPlan = if (context == null) {
            ProjectionPdcFallbackPlan.EMPTY
        } else {
            try {
                runtime.pdcFallbackPlans.acquire(context)
            } catch (_: Exception) {
                return NmsItemProjectionSession(
                    viewerId,
                    context = null,
                    pdcFallbackPlan = ProjectionPdcFallbackPlan.EMPTY,
                )
            }
        }
        return NmsItemProjectionSession(viewerId, context, fallbackPlan)
    }

    fun newSanitizingSession(viewerId: UUID): NmsItemProjectionSession =
        NmsItemProjectionSession(
            viewerId,
            context = null,
            pdcFallbackPlan = ProjectionPdcFallbackPlan.EMPTY,
        )

    /** Removes only Itemerness-owned client state while preserving all unrelated components. */
    fun canonicalFallback(source: ItemStack): ItemStack = sanitize(source)

    inner class NmsItemProjectionSession internal constructor(
        private val viewerId: UUID,
        private val context: com.iroselle.itemerness.projection.ProjectionContext?,
        private val pdcFallbackPlan: ProjectionPdcFallbackPlan,
    ) {
        val generation: ProjectionGeneration?
            get() = context?.generation

        fun project(source: ItemStack): NmsShallowProjection = try {
            when (val decoded = codec.decode(source, pdcFallbackPlan)) {
                CanonicalDecodeResult.Missing -> NmsShallowProjection(source, managed = false)
                is CanonicalDecodeResult.Invalid -> NmsShallowProjection(sanitize(source), managed = true)
                is CanonicalDecodeResult.Decoded -> NmsShallowProjection(
                    projectManaged(source, viewerId, decoded, context),
                    managed = true,
                )
            }
        } catch (_: Exception) {
            // A reserved canonical marker is never allowed to pass through after projection
            // failure. The sanitized copy removes both machine state and every display surface
            // that could itself contain an embedded ShowItem payload.
            NmsShallowProjection(sanitize(source), managed = true)
        }
    }

    private fun projectManaged(
        source: ItemStack,
        viewerId: UUID,
        decoded: CanonicalDecodeResult.Decoded,
        context: com.iroselle.itemerness.projection.ProjectionContext?,
    ): ItemStack {
        if (context == null || context.viewer.viewerId != viewerId) {
            return sanitize(source)
        }

        val result = try {
            runtime.projector.project(ProjectionRequest(decoded.snapshot, context))
        } catch (_: Exception) {
            return sanitize(source)
        }
        return when (result) {
            is ProjectionResult.Rendered -> try {
                applyDisplay(
                    sanitize(source),
                    result.display,
                    decoded.snapshot.canManageVanillaTooltipLines,
                )
            } catch (_: Exception) {
                sanitize(source)
            }
            is ProjectionResult.Fallback -> sanitize(source)
        }
    }

    private fun sanitize(source: ItemStack): ItemStack {
        if (source.isEmpty) {
            return source
        }
        val projected = source.copy()
        projected.get(DataComponents.CUSTOM_DATA)?.let { customData ->
            val tag = customData.copyTag()
            tag.remove(NmsCanonicalItemCodec.ROOT_KEY)
            tag.remove(NmsViewTokenCodec.VIEW_KEY)
            CustomData.set(DataComponents.CUSTOM_DATA, projected, tag)
        }
        projected.remove(DataComponents.CUSTOM_NAME)
        projected.remove(DataComponents.ITEM_NAME)
        projected.remove(DataComponents.LORE)
        projected.remove(DataComponents.TOOLTIP_DISPLAY)
        projected.remove(DataComponents.TOOLTIP_STYLE)
        projected.remove(DataComponents.ITEM_MODEL)
        return projected
    }

    private fun applyDisplay(
        projected: ItemStack,
        display: RenderedDisplay,
        canManageVanillaTooltipLines: Boolean,
    ): ItemStack {
        projected.set(DataComponents.ITEM_NAME, NmsRenderedText.convert(display.displayName))
        if (display.lore.isEmpty()) {
            projected.remove(DataComponents.LORE)
        } else {
            projected.set(
                DataComponents.LORE,
                ItemLore(java.util.List.copyOf(display.lore.map(NmsRenderedText::convert))),
            )
        }
        replaceIdentifier(projected, DataComponents.TOOLTIP_STYLE, display.tooltipStyle?.toString())
        replaceIdentifier(projected, DataComponents.ITEM_MODEL, display.itemModel?.toString())
        if (display.managesVanillaTooltipLines && canManageVanillaTooltipLines) {
            var tooltip = TooltipDisplay.DEFAULT
            projected.components.keySet().forEach { component ->
                if (component !in MANAGED_TOOLTIP_COMPONENTS) {
                    tooltip = tooltip.withHidden(component, true)
                }
            }
            projected.set(DataComponents.TOOLTIP_DISPLAY, tooltip)
        }
        return projected
    }

    private fun replaceIdentifier(
        projected: ItemStack,
        type: net.minecraft.core.component.DataComponentType<Identifier>,
        value: String?,
    ) {
        if (value == null) {
            projected.remove(type)
        } else {
            projected.set(type, Identifier.parse(value))
        }
    }

    private companion object {
        val MANAGED_TOOLTIP_COMPONENTS = setOf(
            DataComponents.ITEM_NAME,
            DataComponents.LORE,
            DataComponents.TOOLTIP_DISPLAY,
            DataComponents.TOOLTIP_STYLE,
            DataComponents.ITEM_MODEL,
            DataComponents.CUSTOM_DATA,
        )
    }
}

internal data class NmsShallowProjection(
    val stack: ItemStack,
    val managed: Boolean,
)
