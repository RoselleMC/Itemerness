package com.iroselle.itemerness.projection

import java.util.UUID

/**
 * Optional exact-version capability for actively resending persistent item surfaces.
 *
 * The caller invokes this from the viewer's owning entity context. Implementations must remain
 * bounded and only enqueue packet copies; projection still occurs later on the channel event loop.
 */
interface ProjectionRefreshAdapter {
    /**
     * Refreshes surfaces for the exact platform player already owned by the calling entity
     * context. Implementations must reject stale UUID-only mappings and must not block while
     * handing packet copies to the connection event loop.
     */
    fun refreshViewer(viewerId: UUID, owningPlayer: Any)
}
