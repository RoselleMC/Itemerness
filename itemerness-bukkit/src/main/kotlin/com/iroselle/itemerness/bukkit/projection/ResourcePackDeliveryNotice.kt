package com.iroselle.itemerness.bukkit.projection

import com.iroselle.itemerness.core.presentation.PresentationCatalogSnapshot
import com.iroselle.itemerness.core.presentation.ResourcePackDelivery

/**
 * Describes the operator's assumed resource-pack declaration once per catalog publication. Assumed delivery is never
 * verified per viewer, so the risk is stated where the catalog becomes active rather than for every viewer.
 */
internal object ResourcePackDeliveryNotice {
    fun describe(presentation: PresentationCatalogSnapshot): String? {
        val assumed = presentation.resourcePackBindings.values
            .firstOrNull { binding -> binding.enabled && binding.delivery == ResourcePackDelivery.ASSUMED }
            ?: return null
        return "Resource-pack binding ${assumed.id} uses assumed delivery: every viewer is treated as having its pack " +
            "and asset profile ${assumed.assetProfile}. Delivery is not verified; clients that cannot load the pack " +
            "(for example Bedrock players through Geyser) will see missing glyphs."
    }
}
