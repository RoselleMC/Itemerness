import type { FontMetricsArtifact, GlyphMetric } from "../ifm.js";
import type { Glyph } from "./glyph.js";
import type { FontTable } from "./assemble.js";

/**
 * Cross-checks the browser font engine against the metrics artifact the plugin ships.
 *
 * This is the objective evidence behind the `metric-faithful` badge. The artifact was generated
 * from the real client jar by `tools/font-metrics/generate_minecraft_font_metrics.py`; if the
 * advances and ink bounds this engine derives from the same textures agree with it for every code
 * point, then browser wrapping and server wrapping cannot disagree. If they do not agree, the UI
 * must say so rather than let an editor trust a width that will be wrong in game.
 *
 * One asymmetry is expected and handled here. The artifact's `minecraft:default` table holds only
 * the space and bitmap providers, because the server models the unifont fallback through the
 * table's `fallback` pointer to `minecraft:uniform`. A font assembled from a resource pack
 * naturally also contains the unifont glyphs that `default.json` references. Those extra code
 * points are checked against the uniform table instead of being reported as drift.
 */

export interface MetricMismatch {
    readonly codePoint: number;
    readonly field:
        | "advance"
        | "boldExtra"
        | "hasInk"
        | "left"
        | "right"
        | "top"
        | "bottom";
    readonly expected: number | boolean;
    readonly actual: number | boolean;
}

export interface CrossCheckReport {
    readonly fontId: string;
    readonly metricsRevision: string;
    readonly comparedGlyphs: number;
    /** Code points the artifact declares but the engine did not produce. */
    readonly missingInEngine: readonly number[];
    readonly mismatches: readonly MetricMismatch[];
    /** Code points the engine produced beyond the artifact table, with no expected source. */
    readonly unexplainedExtras: readonly number[];
    readonly matches: boolean;
}

const EPSILON = 1e-9;

function close(expected: number, actual: number): boolean {
    return Math.abs(expected - actual) <= EPSILON;
}

function compareGlyph(
    codePoint: number,
    expected: GlyphMetric,
    actual: Glyph,
): MetricMismatch[] {
    const mismatches: MetricMismatch[] = [];
    if (!close(expected.advancePixels, actual.advancePixels)) {
        mismatches.push({
            codePoint,
            field: "advance",
            expected: expected.advancePixels,
            actual: actual.advancePixels,
        });
    }
    if (
        !close(expected.boldExtraAdvancePixels, actual.boldExtraAdvancePixels)
    ) {
        mismatches.push({
            codePoint,
            field: "boldExtra",
            expected: expected.boldExtraAdvancePixels,
            actual: actual.boldExtraAdvancePixels,
        });
    }
    if (expected.hasInk !== actual.hasInk) {
        mismatches.push({
            codePoint,
            field: "hasInk",
            expected: expected.hasInk,
            actual: actual.hasInk,
        });
    }
    if (!expected.hasInk || !actual.hasInk) return mismatches;
    const pairs = [
        ["left", expected.left, actual.bounds.left],
        ["right", expected.right, actual.bounds.right],
        ["top", expected.top, actual.bounds.top],
        ["bottom", expected.bottom, actual.bounds.bottom],
    ] as const;
    for (const [field, expectedValue, actualValue] of pairs) {
        if (!close(expectedValue, actualValue)) {
            mismatches.push({
                codePoint,
                field,
                expected: expectedValue,
                actual: actualValue,
            });
        }
    }
    return mismatches;
}

export interface CrossCheckOptions {
    /**
     * Table that legitimately supplies code points beyond the compared table. For
     * `minecraft:default` this is the uniform table, whose glyphs reach the client through the
     * fallback chain rather than through the default table itself.
     */
    readonly fallbackTable?: ReadonlyMap<number, GlyphMetric>;
    /** Stop after this many mismatches, so a broken pack does not produce a million entries. */
    readonly maximumMismatches?: number;
}

export function crossCheckFont(
    table: FontTable,
    artifactTable: {
        metricsRevision: string;
        glyphs: ReadonlyMap<number, GlyphMetric>;
    },
    options: CrossCheckOptions = {},
): CrossCheckReport {
    const limit = options.maximumMismatches ?? 256;
    const missingInEngine: number[] = [];
    const mismatches: MetricMismatch[] = [];
    let compared = 0;

    for (const [codePoint, expected] of artifactTable.glyphs) {
        const actual = table.glyphs.get(codePoint);
        if (!actual) {
            if (missingInEngine.length < limit) missingInEngine.push(codePoint);
            continue;
        }
        compared += 1;
        if (mismatches.length < limit)
            mismatches.push(...compareGlyph(codePoint, expected, actual));
    }

    const unexplainedExtras: number[] = [];
    for (const codePoint of table.glyphs.keys()) {
        if (artifactTable.glyphs.has(codePoint)) continue;
        if (options.fallbackTable?.has(codePoint)) continue;
        if (unexplainedExtras.length < limit) unexplainedExtras.push(codePoint);
    }

    return {
        fontId: table.fontId,
        metricsRevision: artifactTable.metricsRevision,
        comparedGlyphs: compared,
        missingInEngine,
        mismatches: mismatches.slice(0, limit),
        unexplainedExtras,
        matches: missingInEngine.length === 0 && mismatches.length === 0,
    };
}

/** Runs the check for both vanilla tables the artifact carries. */
export function crossCheckVanillaFonts(
    artifact: FontMetricsArtifact,
    lookup: (fontId: string) => FontTable,
    options: CrossCheckOptions = {},
): readonly CrossCheckReport[] {
    const uniform = artifact.tablesByFont.get("minecraft:uniform");
    return [...artifact.tablesByFont.values()].map((artifactTable) =>
        crossCheckFont(lookup(artifactTable.fontId), artifactTable, {
            ...options,
            fallbackTable:
                artifactTable.fontId === "minecraft:default" && uniform
                    ? uniform.glyphs
                    : options.fallbackTable,
        }),
    );
}
