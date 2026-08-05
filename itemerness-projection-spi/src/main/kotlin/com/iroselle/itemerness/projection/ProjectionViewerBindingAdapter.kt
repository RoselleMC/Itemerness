package com.iroselle.itemerness.projection

import java.util.UUID

/**
 * Optional exact-version capability for publishing a connection's immutable viewer identity.
 *
 * Both methods must be invoked from the player's owning entity context. [owningPlayer] is the
 * platform player object already owned by that context; exact-version adapters validate its type
 * and capture only its immutable UUID/channel binding. The channel event loop must never discover
 * a player by reading global Bukkit or NMS state itself.
 */
interface ProjectionViewerBindingAdapter {
    fun bindViewer(viewerId: UUID, owningPlayer: Any)

    fun unbindViewer(viewerId: UUID)
}
