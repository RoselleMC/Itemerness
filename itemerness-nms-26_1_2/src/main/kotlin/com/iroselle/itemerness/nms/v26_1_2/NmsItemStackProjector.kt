package com.iroselle.itemerness.nms.v26_1_2

import com.iroselle.itemerness.projection.ProjectionRequest
import com.iroselle.itemerness.projection.ProjectionResult
import com.iroselle.itemerness.projection.ProjectionRuntime
import com.iroselle.itemerness.projection.RenderedDisplay
import java.util.UUID
import net.minecraft.core.component.DataComponents
import net.minecraft.resources.Identifier
import net.minecraft.world.item.ItemStack
import net.minecraft.world.item.component.CustomData
import net.minecraft.world.item.component.ItemLore

internal class NmsItemStackProjector(
    private val runtime: ProjectionRuntime,
    private val codec: NmsCanonicalItemCodec = NmsCanonicalItemCodec(),
) {
    fun project(source: ItemStack, viewerId: UUID): ItemStack = try {
        when (val decoded = codec.decode(source)) {
            CanonicalDecodeResult.Missing -> source
            is CanonicalDecodeResult.Invalid -> sanitize(source)
            is CanonicalDecodeResult.Decoded -> projectManaged(source, viewerId, decoded)
        }
    } catch (_: Exception) {
        // Outbound failure policy is pass-through until bounded diagnostics are available.
        source
    }

    private fun projectManaged(
        source: ItemStack,
        viewerId: UUID,
        decoded: CanonicalDecodeResult.Decoded,
    ): ItemStack {
        val context = try {
            runtime.contexts.acquire(viewerId)
        } catch (_: Exception) {
            null
        } ?: return sanitize(source)
        if (context.viewer.viewerId != viewerId) {
            return sanitize(source)
        }

        val result = try {
            runtime.projector.project(ProjectionRequest(decoded.snapshot, context))
        } catch (_: Exception) {
            return sanitize(source)
        }
        return when (result) {
            is ProjectionResult.Rendered -> try {
                applyDisplay(sanitize(source), result.display)
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
            CustomData.set(DataComponents.CUSTOM_DATA, projected, tag)
        }
        projected.remove(DataComponents.CUSTOM_NAME)
        projected.remove(DataComponents.LORE)
        projected.remove(DataComponents.TOOLTIP_STYLE)
        projected.remove(DataComponents.ITEM_MODEL)
        return projected
    }

    private fun applyDisplay(
        projected: ItemStack,
        display: RenderedDisplay,
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
}
