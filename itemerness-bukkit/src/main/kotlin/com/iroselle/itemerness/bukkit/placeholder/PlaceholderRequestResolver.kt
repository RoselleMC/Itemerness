package com.iroselle.itemerness.bukkit.placeholder

import com.iroselle.itemerness.api.DataKey
import java.util.UUID

/** Pure request routing kept separate from PlaceholderAPI and Bukkit lifecycle classes. */
internal class PlaceholderRequestResolver(
    private val snapshots: PlaceholderSnapshotLookup,
    private val catalogRevision: () -> Long? = { null },
) {
    fun resolve(viewerId: UUID?, parameter: String): String? {
        val route = Route.parse(parameter) ?: return null
        val snapshot = viewerId?.let(snapshots::find)
        if (route == Route.CatalogRevision) {
            return snapshot?.catalogRevision?.toString()
                ?: catalogRevision()?.toString()
                ?: ""
        }
        snapshot ?: return ""
        return route.resolve(snapshot)
    }

    private sealed interface Route {
        fun resolve(snapshot: PlaceholderViewerSnapshot): String

        data object CatalogRevision : Route {
            override fun resolve(snapshot: PlaceholderViewerSnapshot): String =
                snapshot.catalogRevision.toString()
        }

        data object Locale : Route {
            override fun resolve(snapshot: PlaceholderViewerSnapshot): String = snapshot.locale.value
        }

        data object Theme : Route {
            override fun resolve(snapshot: PlaceholderViewerSnapshot): String = snapshot.theme.toString()
        }

        data object AssetProfile : Route {
            override fun resolve(snapshot: PlaceholderViewerSnapshot): String =
                snapshot.assetProfile?.toString().orEmpty()
        }

        data object MainHandPresent : Route {
            override fun resolve(snapshot: PlaceholderViewerSnapshot): String =
                snapshot.mainHand.present.toString()
        }

        data object MainHandId : Route {
            override fun resolve(snapshot: PlaceholderViewerSnapshot): String =
                snapshot.mainHand.id?.toString().orEmpty()
        }

        data object MainHandInstanceId : Route {
            override fun resolve(snapshot: PlaceholderViewerSnapshot): String =
                snapshot.mainHand.instanceId?.toString().orEmpty()
        }

        data object MainHandNamePlain : Route {
            override fun resolve(snapshot: PlaceholderViewerSnapshot): String =
                snapshot.mainHand.namePlain.orEmpty()
        }

        data class MainHandData(
            val key: DataKey,
        ) : Route {
            override fun resolve(snapshot: PlaceholderViewerSnapshot): String =
                snapshot.mainHand[key].orEmpty()
        }

        data object OffHandPresent : Route {
            override fun resolve(snapshot: PlaceholderViewerSnapshot): String =
                snapshot.offHand.present.toString()
        }

        data object OffHandId : Route {
            override fun resolve(snapshot: PlaceholderViewerSnapshot): String =
                snapshot.offHand.id?.toString().orEmpty()
        }

        data class OffHandData(
            val key: DataKey,
        ) : Route {
            override fun resolve(snapshot: PlaceholderViewerSnapshot): String =
                snapshot.offHand[key].orEmpty()
        }

        companion object {
            private const val MAIN_HAND_DATA_PREFIX = "mainhand_data_"
            private const val OFF_HAND_DATA_PREFIX = "offhand_data_"

            fun parse(parameter: String): Route? = when (parameter) {
                "catalog_revision" -> CatalogRevision
                "locale" -> Locale
                "theme" -> Theme
                "asset_profile" -> AssetProfile
                "mainhand_present" -> MainHandPresent
                "mainhand_id" -> MainHandId
                "mainhand_instance_id" -> MainHandInstanceId
                "mainhand_name_plain" -> MainHandNamePlain
                "offhand_present" -> OffHandPresent
                "offhand_id" -> OffHandId
                else -> parseData(parameter)
            }

            private fun parseData(parameter: String): Route? {
                val (prefix, factory) = when {
                    parameter.startsWith(MAIN_HAND_DATA_PREFIX) ->
                        MAIN_HAND_DATA_PREFIX to ::MainHandData

                    parameter.startsWith(OFF_HAND_DATA_PREFIX) ->
                        OFF_HAND_DATA_PREFIX to ::OffHandData

                    else -> return null
                }
                val rawKey = parameter.substring(prefix.length)
                val key = runCatching { DataKey.parse(rawKey) }.getOrNull() ?: return null
                return factory(key)
            }
        }
    }
}
