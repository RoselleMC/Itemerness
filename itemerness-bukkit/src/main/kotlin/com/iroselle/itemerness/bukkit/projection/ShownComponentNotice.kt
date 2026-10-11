package com.iroselle.itemerness.bukkit.projection

import com.iroselle.itemerness.api.ItemKey
import com.iroselle.itemerness.core.presentation.PresentationCatalogSnapshot
import io.papermc.paper.registry.RegistryAccess
import io.papermc.paper.registry.RegistryKey

/**
 * Warns once per catalog publication about shown vanilla tooltip components that this server's
 * data component registry does not know. The catalog stays valid because it may be shared with
 * servers running other Minecraft versions; the projection adapter ignores such ids.
 */
internal object ShownComponentNotice {
    private const val MAXIMUM_LISTED = 16

    fun describe(presentation: PresentationCatalogSnapshot, knownComponents: Set<ItemKey>?): String? {
        if (knownComponents == null) return null
        val unknown = presentation.items.values
            .flatMap { item -> item.shownFlags.filterNot(knownComponents::contains).map { flag -> "${item.key} $flag" } }
            .sorted()
        if (unknown.isEmpty()) return null
        val listed = unknown.take(MAXIMUM_LISTED).joinToString("; ")
        val remainder = if (unknown.size > MAXIMUM_LISTED) " and ${unknown.size - MAXIMUM_LISTED} more" else ""
        return "Shown vanilla tooltip components unknown to this server are ignored: $listed$remainder"
    }

    /** Data component ids registered on the running server, or null when the registry is unavailable. */
    fun serverComponents(): Set<ItemKey>? = try {
        RegistryAccess.registryAccess()
            .getRegistry(RegistryKey.DATA_COMPONENT_TYPE)
            .mapNotNullTo(HashSet()) { type -> runCatching { ItemKey.parse(type.key.asString()) }.getOrNull() }
    } catch (_: RuntimeException) {
        null
    }
}
