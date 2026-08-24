package com.iroselle.itemerness.nms.v26_1_1

/**
 * A bounded, input-local projection failure. The source packet is still a valid server packet and
 * may be rebuilt through the canonical fallback path without poisoning the exact-version adapter.
 */
internal class NmsRecoverableProjectionException(
    message: String,
    cause: Throwable? = null,
) : IllegalStateException(message, cause)

/**
 * An exact-version runtime invariant failed after startup. Falling back would hide an ABI or
 * lifecycle defect, so the adapter must retire globally instead.
 */
internal class NmsProjectionInfrastructureException(
    message: String,
    cause: Throwable? = null,
) : IllegalStateException(message, cause)

/** A component reported a normal DataResult failure while building a vanilla hash patch. */
internal class NmsRecoverableHashEncodingException(
    message: String,
) : IllegalArgumentException(message)

internal data class NmsProjectionLimits(
    val nbtDepth: Int,
    val nbtNodes: Int,
    val nbtCompoundEntries: Int,
    val nbtListElements: Int,
    val nbtCandidates: Int,
    val nbtDecodedItems: Int,
    val nbtKeyBytes: Int,
    val nbtStringBytes: Int,
    val nbtTotalStringBytes: Int,
    val nbtInputBytes: Int,
    val nbtOutputBytes: Int,
    val componentDepth: Int,
    val componentNodes: Int,
    val payloadNodes: Int,
    val itemDepth: Int,
    val items: Int,
    val nestedComponents: Int,
    val codecCalls: Int,
    val bundleDepth: Int,
    val packets: Int,
    val structuredEntries: Int,
    val chunkPacketBytes: Int,
) {
    companion object {
        val DEFAULT = NmsProjectionLimits(
            nbtDepth = 32,
            nbtNodes = 8_192,
            nbtCompoundEntries = 1_024,
            nbtListElements = 4_096,
            nbtCandidates = 512,
            nbtDecodedItems = 256,
            nbtKeyBytes = 1_024,
            nbtStringBytes = 65_535,
            nbtTotalStringBytes = 256 * 1_024,
            nbtInputBytes = 2 * 1_024 * 1_024,
            nbtOutputBytes = 2 * 1_024 * 1_024,
            componentDepth = 32,
            componentNodes = 4_096,
            payloadNodes = 8_192,
            itemDepth = 16,
            items = 256,
            nestedComponents = 1_024,
            codecCalls = 512,
            bundleDepth = 8,
            packets = 512,
            structuredEntries = 4_096,
            chunkPacketBytes = 8 * 1_024 * 1_024,
        )

        /** A second, still-bounded pass that only removes owned client state. */
        val CANONICAL_FALLBACK = NmsProjectionLimits(
            nbtDepth = 256,
            nbtNodes = 1_048_576,
            nbtCompoundEntries = 65_536,
            nbtListElements = 65_536,
            nbtCandidates = 16_384,
            nbtDecodedItems = 8_192,
            nbtKeyBytes = 65_535,
            nbtStringBytes = 1_048_576,
            nbtTotalStringBytes = 16 * 1_024 * 1_024,
            nbtInputBytes = 32 * 1_024 * 1_024,
            nbtOutputBytes = 32 * 1_024 * 1_024,
            componentDepth = 256,
            componentNodes = 262_144,
            payloadNodes = 262_144,
            itemDepth = 128,
            items = 8_192,
            nestedComponents = 65_536,
            codecCalls = 32_768,
            bundleDepth = 64,
            packets = 8_192,
            structuredEntries = 65_536,
            chunkPacketBytes = 32 * 1_024 * 1_024,
        )
    }
}

internal inline fun requireProjectionInput(
    condition: Boolean,
    lazyMessage: () -> String,
) {
    if (!condition) throw NmsRecoverableProjectionException(lazyMessage())
}

internal fun Throwable.isTerminalOutboundProjectionFailure(): Boolean = when (this) {
    is LinkageError,
    is NmsProjectionInfrastructureException,
    -> true
    else -> false
}

@Suppress("DEPRECATION")
internal fun Throwable.rethrowIfFatalProjectionFailure() {
    when (this) {
        is VirtualMachineError -> throw this
        is ThreadDeath -> throw this
    }
}
