package com.iroselle.itemerness.bukkit.api

import com.iroselle.itemerness.api.PreviewDataProvider
import com.iroselle.itemerness.api.PreviewDataRegistration
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap

/**
 * One preview data provider per plugin. Entries are keyed by plugin name and bound to the caller's
 * lifecycle generation: a disabled plugin's provider is removed, and a stale entry from a previous
 * generation is never called because its caller is no longer active.
 */
internal class PreviewProviderRegistry {
    class Entry(val caller: AuthenticatedPluginCaller, val provider: PreviewDataProvider)

    private val entries = ConcurrentHashMap<String, Entry>()

    fun register(caller: AuthenticatedPluginCaller, provider: PreviewDataProvider): PreviewDataRegistration {
        val key = caller.pluginName.lowercase(Locale.ROOT)
        val entry = Entry(caller, provider)
        entries[key] = entry
        return object : PreviewDataRegistration {
            override fun unregister() {
                entries.remove(key, entry)
            }
        }
    }

    /** Active providers in a stable order, so scenario lists do not reorder between requests. */
    fun active(): List<Entry> = entries.values.filter { it.caller.isActive() }.sortedBy { it.caller.pluginName.lowercase(Locale.ROOT) }

    fun find(pluginName: String): Entry? = entries[pluginName.lowercase(Locale.ROOT)]?.takeIf { it.caller.isActive() }

    fun retire(pluginName: String) {
        entries.remove(pluginName.lowercase(Locale.ROOT))
    }

    fun clear() = entries.clear()
}
