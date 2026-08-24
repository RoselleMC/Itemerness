package com.iroselle.itemerness.nms.v26_1_1

/** Production activation requires complete exact-version carrier and security coverage. */
internal object NmsProjectionReleaseGate {
    const val ENABLED = true

    fun requireReady() {
        check(ENABLED && UNSUPPORTED_CARRIERS.isEmpty() && SECURITY_BLOCKERS.isEmpty()) {
            "Itemerness NMS projection is not release-ready; blockers: " +
                (UNSUPPORTED_CARRIERS + SECURITY_BLOCKERS).sorted().joinToString()
        }
    }

    val UNSUPPORTED_CARRIERS: Set<String> = emptySet()

    val SECURITY_BLOCKERS: Set<String> = emptySet()
}
