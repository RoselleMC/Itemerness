import type {
    FidelityAspect,
    FidelityClaim,
    FidelityLevel,
    PreviewOrigin,
} from "@itemerness/protocol";

/**
 * Builds the fidelity claims shown next to a preview.
 *
 * The rule this file exists to enforce: nothing is claimed at a level the evidence does not
 * support. A browser canvas can be metric-faithful and still not be a Minecraft framebuffer, and
 * an editor deciding whether a frame lines up needs to know which of those they are looking at.
 * Every aspect gets its own level and its own reason key, so the UI can explain the downgrade
 * rather than showing a bare percentage.
 */

export interface FidelityInputs {
    readonly origin: PreviewOrigin;
    /** True when the preview geometry came from an agent compile of the current snapshot. */
    readonly snapshotMatches: boolean;
    /** At least one displayed advance came from a mounted font provider. */
    readonly mountedMetricsUsed: boolean;
    /** At least one displayed glyph raster came from a mounted font provider. */
    readonly mountedRasterUsed: boolean;
    /** The generated vanilla metrics artifact is loaded. */
    readonly metricsArtifactLoaded: boolean;
    /** All fonts used by the preview produced complete metrics. */
    readonly metricsComplete: boolean;
    /** Every inked glyph had pixels available. */
    readonly rasterComplete: boolean;
    /** The theme asked for a tooltip style and the pack supplied both sprites. */
    readonly tooltipSpritesAvailable: boolean;
    readonly tooltipStyleRequested: boolean;
    readonly itemIcon: "flat" | "unsupported" | "absent";
    /** The theme preserves vanilla-generated tooltip lines that Itemerness does not own. */
    readonly preservesVanillaLines: boolean;
}

function claim(
    aspect: FidelityAspect,
    level: FidelityLevel,
    reasonKey: string,
    params: Record<string, string | number | boolean> = {},
): FidelityClaim {
    return { aspect, level, reasonKey, params };
}

export function buildFidelityClaims(inputs: FidelityInputs): FidelityClaim[] {
    const claims: FidelityClaim[] = [];

    const structureLevel: FidelityLevel =
        inputs.origin === "agent" && inputs.snapshotMatches
            ? "exact-structure"
            : "metric-faithful";
    const structureReason =
        inputs.origin === "agent"
            ? inputs.snapshotMatches
                ? "fidelity.content.agent_verified"
                : "fidelity.content.agent_stale"
            : inputs.origin === "mock"
              ? "fidelity.content.mock"
              : "fidelity.content.local";
    claims.push(claim("content", structureLevel, structureReason));
    claims.push(claim("locale", structureLevel, structureReason));
    claims.push(claim("theme-selection", structureLevel, structureReason));

    if (
        inputs.metricsComplete &&
        (inputs.mountedMetricsUsed || inputs.metricsArtifactLoaded)
    ) {
        claims.push(
            claim(
                "metrics",
                "metric-faithful",
                inputs.mountedMetricsUsed
                    ? "fidelity.metrics.from_mounted_assets"
                    : "fidelity.metrics.from_artifact",
            ),
        );
    } else {
        claims.push(
            claim(
                "metrics",
                "approximate-raster",
                "fidelity.metrics.incomplete",
            ),
        );
    }

    claims.push(
        claim(
            "wrapping",
            inputs.origin === "agent" && inputs.snapshotMatches
                ? "exact-structure"
                : "metric-faithful",
            inputs.origin === "agent"
                ? "fidelity.wrapping.agent"
                : "fidelity.wrapping.browser_greedy",
        ),
    );

    claims.push(
        claim(
            "glyph-raster",
            inputs.mountedRasterUsed && inputs.rasterComplete
                ? "approximate-raster"
                : "client-only",
            inputs.mountedRasterUsed
                ? inputs.rasterComplete
                    ? "fidelity.raster.mounted"
                    : "fidelity.raster.partial"
                : "fidelity.raster.no_assets",
        ),
    );

    claims.push(
        claim(
            "tooltip-frame",
            inputs.tooltipSpritesAvailable
                ? "approximate-raster"
                : "client-only",
            inputs.tooltipSpritesAvailable
                ? "fidelity.frame.sprites_mounted"
                : inputs.tooltipStyleRequested
                  ? "fidelity.frame.sprites_missing"
                  : "fidelity.frame.legacy_gradient",
        ),
    );

    claims.push(
        claim(
            "item-icon",
            inputs.itemIcon === "flat" ? "approximate-raster" : "client-only",
            inputs.itemIcon === "flat"
                ? "fidelity.icon.flat_sprite"
                : inputs.itemIcon === "unsupported"
                  ? "fidelity.icon.block_model"
                  : "fidelity.icon.absent",
        ),
    );

    // Never claimed above client-only: the server cannot know the viewer's GUI scale, window size,
    // or where the cursor sits, and the client repositions or flips a tooltip based on all three.
    claims.push(
        claim(
            "positioning",
            "client-only",
            "fidelity.positioning.client_decides",
        ),
    );

    claims.push(
        claim(
            "vanilla-extra-lines",
            "client-only",
            inputs.preservesVanillaLines
                ? "fidelity.vanilla_lines.preserved"
                : "fidelity.vanilla_lines.managed",
        ),
    );

    return claims;
}

/** The weakest level present, for a single summary badge. */
export function overallFidelity(
    claims: readonly FidelityClaim[],
): FidelityLevel {
    const order: FidelityLevel[] = [
        "exact-structure",
        "metric-faithful",
        "approximate-raster",
        "client-only",
    ];
    let worst: FidelityLevel = "exact-structure";
    for (const entry of claims) {
        if (order.indexOf(entry.level) > order.indexOf(worst))
            worst = entry.level;
    }
    return worst;
}
