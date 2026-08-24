import type {
    PreviewLine,
    PreviewRun,
    VisualBounds,
} from "@itemerness/protocol";
import type { FontLibrary } from "@itemerness/mc-assets";
import type { PresentationFonts, ResolvedGlyph } from "./fonts.js";

/**
 * Text measurement, mirroring `PixelMeasurer` in
 * `itemerness-core/src/main/kotlin/com/iroselle/itemerness/core/presentation/TextLayout.kt`.
 *
 * Two numbers come out of a line and they are not the same number. The logical width is the signed
 * advance sum, which is what `Font.width` measures and therefore what decides tooltip width and
 * line breaking. The visual bounds are where ink can actually land, which italic shear, bold's
 * second pass, and negative-bearing glyphs can push outside the logical box. A bitmap canvas theme
 * lives entirely in the gap between the two, so both are computed here rather than one being
 * inferred from the other.
 *
 * The style-decoration constants below are copied from the same Kotlin file so the browser cannot
 * drift from the server's idea of where a strikethrough sits.
 */

/** Exact 26.1.2 `BakedSheetGlyph` geometry; see `TextLayout.kt` lines 179-186. */
const BOLD_RENDER_THICKNESS_PIXELS = 0.1;
const EFFECT_LEADING_OVERHANG_PIXELS = 1;
export const STRIKETHROUGH_TOP_PIXELS = 3.5;
export const STRIKETHROUGH_BOTTOM_PIXELS = 4.5;
export const UNDERLINE_TOP_PIXELS = 8;
export const UNDERLINE_BOTTOM_PIXELS = 9;

/** Italic shear applied by the client's glyph baking, as a function of the y coordinate. */
export function italicShear(y: number): number {
    return 1 - 0.25 * y;
}

export class MissingGlyphError extends Error {
    constructor(
        readonly codePoint: number,
        readonly fontId: string | null,
    ) {
        super(
            `No metric for U+${codePoint.toString(16).toUpperCase().padStart(4, "0")} in font ${fontId ?? "default"}`,
        );
        this.name = "MissingGlyphError";
    }
}

/** One glyph placed on a line, carrying everything the painter needs. */
export interface PlacedGlyph {
    readonly glyph: ResolvedGlyph;
    /** Pen position before this glyph, in GUI pixels from the line origin. */
    readonly x: number;
    readonly advance: number;
    readonly run: PreviewRun;
}

export interface MeasuredLine {
    readonly runs: readonly PreviewRun[];
    /** `ceil` of the final pen position; the number `Font.width` would return. */
    readonly logicalWidthPixels: number;
    /** Unrounded pen position, needed when computing exact width anchors. */
    readonly advanceSum: number;
    readonly visualBounds: VisualBounds;
    readonly glyphs: readonly PlacedGlyph[];
    /** At least one code point had no trustworthy advance. */
    readonly missingMetrics: boolean;
    /** Runs whose pixels are unavailable, so the caller can downgrade the raster claim. */
    readonly missingRaster: boolean;
}

export interface MeasureOptions {
    /**
     * When true, a code point with no known metric yields a zero-width placeholder and sets
     * `missingRaster` instead of throwing. Used for optimistic local previews, where refusing to
     * draw anything would be worse feedback than drawing an obviously incomplete line.
     */
    readonly lenient?: boolean;
}

export function measureLine(
    runs: readonly PreviewRun[],
    fonts: PresentationFonts,
    options: MeasureOptions = {},
): MeasuredLine {
    let cursor = 0;
    let minimumX = 0;
    let maximumX = 0;
    let minimumY = 0;
    let maximumY = 0;
    let hasInk = false;
    let missingMetrics = false;
    let missingRaster = false;
    const placed: PlacedGlyph[] = [];

    for (const run of runs) {
        const runStart = cursor;
        for (const character of run.text) {
            const codePoint = character.codePointAt(0)!;
            const glyph = fonts.resolve(run.style.font, codePoint, run.kind);
            if (!glyph) {
                if (!options.lenient)
                    throw new MissingGlyphError(codePoint, run.style.font);
                missingMetrics = true;
                missingRaster = true;
                continue;
            }
            if (glyph.rasterMissing && glyph.hasInk) missingRaster = true;

            if (glyph.hasInk) {
                const italicLeft = run.style.italic
                    ? Math.min(
                          italicShear(glyph.bounds.top),
                          italicShear(glyph.bounds.bottom),
                      )
                    : 0;
                const italicRight = run.style.italic
                    ? Math.max(
                          italicShear(glyph.bounds.top),
                          italicShear(glyph.bounds.bottom),
                      )
                    : 0;
                const boldThickness = run.style.bold
                    ? BOLD_RENDER_THICKNESS_PIXELS
                    : 0;
                const boldCopyOffset = run.style.bold
                    ? glyph.boldExtraAdvancePixels
                    : 0;
                minimumX = Math.min(
                    minimumX,
                    cursor + glyph.bounds.left + italicLeft - boldThickness,
                );
                maximumX = Math.max(
                    maximumX,
                    cursor +
                        glyph.bounds.right +
                        italicRight +
                        boldCopyOffset +
                        boldThickness,
                );
                minimumY = Math.min(minimumY, glyph.bounds.top - boldThickness);
                maximumY = Math.max(
                    maximumY,
                    glyph.bounds.bottom + boldThickness,
                );
                hasInk = true;
            }

            const advance =
                glyph.advancePixels +
                (run.style.bold ? glyph.boldExtraAdvancePixels : 0);
            placed.push({ glyph, x: cursor, advance, run });
            cursor += advance;
        }

        if (
            cursor > runStart &&
            (run.style.underlined || run.style.strikethrough)
        ) {
            minimumX = Math.min(
                minimumX,
                runStart - EFFECT_LEADING_OVERHANG_PIXELS,
            );
            maximumX = Math.max(maximumX, cursor);
            if (run.style.strikethrough) {
                minimumY = Math.min(minimumY, STRIKETHROUGH_TOP_PIXELS);
                maximumY = Math.max(maximumY, STRIKETHROUGH_BOTTOM_PIXELS);
            }
            if (run.style.underlined) {
                minimumY = Math.min(minimumY, UNDERLINE_TOP_PIXELS);
                maximumY = Math.max(maximumY, UNDERLINE_BOTTOM_PIXELS);
            }
            hasInk = true;
        }
    }

    return {
        runs,
        logicalWidthPixels: Math.ceil(cursor),
        advanceSum: cursor,
        visualBounds: hasInk
            ? {
                  left: minimumX,
                  right: maximumX,
                  top: minimumY,
                  bottom: maximumY,
              }
            : { left: 0, right: Math.max(0, cursor), top: 0, bottom: 0 },
        glyphs: placed,
        missingMetrics,
        missingRaster,
    };
}

export interface PreviewFontEvidence {
    /** Every displayed code point had a metric and reproduced the display's logical width. */
    readonly metricsComplete: boolean;
    /** Every displayed inked glyph had source pixels. */
    readonly rasterComplete: boolean;
    /** A mounted font provider supplied at least one displayed advance. */
    readonly mountedMetricsUsed: boolean;
    /** A mounted font provider supplied at least one displayed glyph raster. */
    readonly mountedRasterUsed: boolean;
}

const MOUNTED_METRIC_PROVIDERS = new Set(["bitmap", "space", "unihex"]);

/** Derives fidelity evidence from the lines actually being previewed, never pack presence alone. */
export function previewFontEvidence(
    lines: readonly PreviewLine[],
    fonts: PresentationFonts,
    library: FontLibrary | null = null,
): PreviewFontEvidence {
    if (lines.length === 0) {
        return {
            metricsComplete: false,
            rasterComplete: false,
            mountedMetricsUsed: false,
            mountedRasterUsed: false,
        };
    }

    const requestedFonts = new Set<string>();
    let metricsComplete = true;
    let rasterComplete = true;
    let mountedMetricsUsed = false;
    let mountedRasterUsed = false;
    for (const line of lines) {
        line.runs.forEach((run) => {
            if (run.style.font !== null) requestedFonts.add(run.style.font);
        });
        const measured = measureLine(line.runs, fonts, { lenient: true });
        if (
            measured.missingMetrics ||
            measured.logicalWidthPixels !== line.logicalWidthPixels
        ) {
            metricsComplete = false;
        }
        if (measured.missingRaster) rasterComplete = false;
        for (const placed of measured.glyphs) {
            if (MOUNTED_METRIC_PROVIDERS.has(placed.glyph.providerKind)) {
                mountedMetricsUsed = true;
            }
            if (placed.glyph.raster !== null) mountedRasterUsed = true;
        }
    }

    if (library !== null) {
        const mountedFonts = new Set(library.availableFonts());
        for (const fontId of requestedFonts) {
            if (
                mountedFonts.has(fontId) &&
                library.get(fontId).metricsIncomplete
            ) {
                metricsComplete = false;
            }
        }
    }

    return {
        metricsComplete,
        rasterComplete,
        mountedMetricsUsed,
        mountedRasterUsed,
    };
}

/** Measures a single string in one style, the common case for quick width questions. */
export function measureText(
    text: string,
    fonts: PresentationFonts,
    style: PreviewRun["style"],
    options: MeasureOptions = {},
): MeasuredLine {
    return measureLine(
        [{ text, kind: "TEXT", unbreakable: false, style }],
        fonts,
        options,
    );
}

/**
 * Verifies a server-produced line against locally computed metrics.
 *
 * The browser must not re-wrap an agent artifact, but it can check the arithmetic. A disagreement
 * here means the mounted resource pack does not match what the target server compiled against,
 * which is exactly the situation that produces a correct-looking preview and a broken tooltip in
 * game.
 */
export interface GeometryAgreement {
    readonly agrees: boolean;
    readonly expectedWidthPixels: number;
    readonly actualWidthPixels: number;
    readonly widthDeltaPixels: number;
}

export function compareGeometry(
    serverLine: PreviewLine,
    measured: MeasuredLine,
): GeometryAgreement {
    const delta = measured.logicalWidthPixels - serverLine.logicalWidthPixels;
    return {
        agrees: delta === 0,
        expectedWidthPixels: serverLine.logicalWidthPixels,
        actualWidthPixels: measured.logicalWidthPixels,
        widthDeltaPixels: delta,
    };
}
