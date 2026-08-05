package com.iroselle.itemerness.bukkit.placeholder

import me.clip.placeholderapi.expansion.PlaceholderExpansion
import org.bukkit.OfflinePlayer

internal class ItemernessPlaceholderExpansion(
    private val pluginVersion: String,
    snapshots: PlaceholderSnapshotLookup,
    catalogRevision: () -> Long? = { null },
) : PlaceholderExpansion() {
    private val resolver = PlaceholderRequestResolver(snapshots, catalogRevision)

    init {
        require(pluginVersion.isNotBlank()) { "Plugin version must not be blank" }
    }

    override fun getIdentifier(): String = IDENTIFIER

    override fun getAuthor(): String = AUTHOR

    override fun getVersion(): String = pluginVersion

    override fun persist(): Boolean = true

    override fun onRequest(player: OfflinePlayer?, params: String): String? =
        resolver.resolve(player?.uniqueId, params)

    private companion object {
        const val IDENTIFIER = "itemerness"
        const val AUTHOR = "iRoselle"
    }
}
