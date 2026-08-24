import type {
    FontLibrary,
    FontMetricsArtifact,
    Glyph,
} from "@itemerness/mc-assets";
import { EMPTY_BOUNDS } from "@itemerness/mc-assets";
import type {
    FontNode,
    GlyphNode,
    PresentationRunKind,
    SpacingNode,
} from "@itemerness/protocol";

/**
 * Resolves a code point in a given font to a glyph, following the same order as
 * `PixelMeasurer.metric` in `itemerness-core`.
 *
 * The order exists because the same code point can legitimately come from four places, and the
 * server's choice among them is what the browser has to reproduce:
 *
 * 1. a signed-advance spacing glyph, for width and height anchors;
 * 2. a glyph the project declares explicitly in its asset registry;
 * 3. a glyph the mounted resource pack provides;
 * 4. a glyph in the generated vanilla metrics artifact;
 *
 * and failing all of those, the font's fallback chain. A font whose metrics simply are not known
 * produces `null`, which the caller must surface as a missing-glyph diagnostic rather than
 * substituting a plausible width.
 */

export interface ResolvedGlyph extends Glyph {
    /** Font the glyph was ultimately taken from, which may differ through the fallback chain. */
    readonly sourceFontId: string;
    /** True when only metrics are known and no pixels are available to draw. */
    readonly rasterMissing: boolean;
}

export interface PresentationFontsOptions {
    /** Fonts assembled from the mounted resource-pack stack, when anything is mounted. */
    readonly library?: FontLibrary | null;
    /** The generated vanilla metrics artifact. Always available; it ships with the plugin. */
    readonly artifact?: FontMetricsArtifact | null;
    readonly fonts: readonly FontNode[];
    readonly glyphs: readonly GlyphNode[];
    readonly spacing: SpacingNode | null;
}

const MAX_FALLBACK_DEPTH = 16;

export class PresentationFonts {
    private readonly fontsById: ReadonlyMap<string, FontNode>;
    private readonly declaredByFontAndCodePoint: ReadonlyMap<string, GlyphNode>;
    private readonly cache = new Map<string, ResolvedGlyph | null>();

    constructor(private readonly options: PresentationFontsOptions) {
        this.fontsById = new Map(options.fonts.map((font) => [font.id, font]));
        this.declaredByFontAndCodePoint = new Map(
            options.glyphs.map((glyph) => [
                `${glyph.font}\u0000${glyph.codePoint}`,
                glyph,
            ]),
        );
    }

    /** Signed advance encoded by a spacing code point, or null when it is not one. */
    spacingAdvance(codePoint: number): number | null {
        const spacing = this.options.spacing;
        if (!spacing) return null;
        for (const range of [spacing.negative, spacing.positive]) {
            if (
                codePoint < range.firstCodePoint ||
                codePoint > range.lastCodePoint
            )
                continue;
            const advance =
                range.minimumAdvancePixels + (codePoint - range.firstCodePoint);
            if (
                advance < range.minimumAdvancePixels ||
                advance > range.maximumAdvancePixels
            )
                return null;
            return advance;
        }
        return null;
    }

    /** The spacing code point that produces an exact signed advance, or null when unreachable. */
    spacingCodePoint(advancePixels: number): number | null {
        const spacing = this.options.spacing;
        if (!spacing || advancePixels === 0 || !Number.isInteger(advancePixels))
            return null;
        const range = advancePixels < 0 ? spacing.negative : spacing.positive;
        if (
            advancePixels < range.minimumAdvancePixels ||
            advancePixels > range.maximumAdvancePixels
        )
            return null;
        return (
            range.firstCodePoint + (advancePixels - range.minimumAdvancePixels)
        );
    }

    resolve(
        fontId: string | null,
        codePoint: number,
        kind: PresentationRunKind,
    ): ResolvedGlyph | null {
        const key = `${fontId ?? ""}\u0000${codePoint}\u0000${kind}`;
        if (this.cache.has(key)) return this.cache.get(key)!;
        const resolved = this.compute(fontId, codePoint, kind);
        this.cache.set(key, resolved);
        return resolved;
    }

    private compute(
        fontId: string | null,
        codePoint: number,
        kind: PresentationRunKind,
    ): ResolvedGlyph | null {
        if (
            kind === "SPACING" ||
            kind === "WIDTH_ANCHOR" ||
            kind === "HEIGHT_ANCHOR"
        ) {
            const advance = this.spacingAdvance(codePoint);
            if (advance !== null) {
                return {
                    codePoint,
                    advancePixels: advance,
                    boldExtraAdvancePixels: 0,
                    hasInk: false,
                    bounds: EMPTY_BOUNDS,
                    raster: null,
                    providerKind: "declared",
                    sourceFontId: this.options.spacing?.font ?? fontId ?? "",
                    rasterMissing: false,
                };
            }
        }

        let current = fontId;
        const visited = new Set<string>();
        for (
            let depth = 0;
            current !== null && depth < MAX_FALLBACK_DEPTH;
            depth += 1
        ) {
            if (visited.has(current)) break;
            visited.add(current);

            const declared = this.declaredByFontAndCodePoint.get(
                `${current}\u0000${codePoint}`,
            );
            if (declared) {
                const packGlyph =
                    this.options.library?.get(current).glyphs.get(codePoint) ??
                    null;
                return {
                    codePoint,
                    advancePixels: declared.advancePixels,
                    boldExtraAdvancePixels:
                        packGlyph?.boldExtraAdvancePixels ?? 1,
                    hasInk: true,
                    bounds: declared.visualBounds,
                    raster: packGlyph?.raster ?? null,
                    providerKind: "declared",
                    sourceFontId: current,
                    rasterMissing: packGlyph?.raster == null,
                };
            }

            const packGlyph = this.options.library
                ?.get(current)
                .glyphs.get(codePoint);
            if (packGlyph) {
                return {
                    ...packGlyph,
                    sourceFontId: current,
                    rasterMissing: packGlyph.raster === null,
                };
            }

            const table = this.artifactTable(current);
            const artifactGlyph = this.artifactGlyph(current, codePoint);
            if (artifactGlyph) return artifactGlyph;

            const declaration = this.fontsById.get(current);
            // Order copied from PixelMeasurer.metric: an explicit fallback font wins over any
            // fallback glyph, which in turn wins over a flat fallback advance. A builtin font
            // carries its fallback pointer in the metrics artifact rather than in the document,
            // which is how minecraft:default reaches minecraft:uniform for CJK.
            const fallbackFont =
                declaration?.fallback ?? table?.fallback ?? null;
            if (fallbackFont !== null) {
                current = fallbackFont;
                continue;
            }
            if (table?.fallbackGlyph) {
                const metric = table.fallbackGlyph;
                return {
                    codePoint,
                    advancePixels: metric.advancePixels,
                    boldExtraAdvancePixels: metric.boldExtraAdvancePixels,
                    hasInk: metric.hasInk,
                    bounds: metric.hasInk
                        ? {
                              left: metric.left,
                              right: metric.right,
                              top: metric.top,
                              bottom: metric.bottom,
                          }
                        : EMPTY_BOUNDS,
                    raster: null,
                    providerKind: "metrics-artifact",
                    sourceFontId: table.fontId,
                    rasterMissing: true,
                };
            }
            if (!declaration) break;
            if (declaration.fallbackAdvancePixels !== null) {
                const ink = codePoint !== 0x20 && !isWhitespace(codePoint);
                return {
                    codePoint,
                    advancePixels: declaration.fallbackAdvancePixels,
                    boldExtraAdvancePixels: 1,
                    hasInk: ink,
                    bounds: ink
                        ? {
                              left: 0,
                              right: Math.max(
                                  0,
                                  declaration.fallbackAdvancePixels - 1,
                              ),
                              top: -8,
                              bottom: 1,
                          }
                        : EMPTY_BOUNDS,
                    raster: null,
                    providerKind: "declared",
                    sourceFontId: current,
                    rasterMissing: true,
                };
            }
            break;
        }
        return null;
    }

    /** The metrics table backing a font id, whether selected by `builtin:` revision or by name. */
    private artifactTable(fontId: string) {
        const artifact = this.options.artifact;
        if (!artifact) return null;
        const declaration = this.fontsById.get(fontId);
        const byRevision = declaration?.metrics.startsWith("builtin:")
            ? artifact.tablesByRevision.get(
                  declaration.metrics.slice("builtin:".length),
              )
            : undefined;
        return byRevision ?? artifact.tablesByFont.get(fontId) ?? null;
    }

    /** Vanilla metrics from the shipped artifact, including its own fallback pointer. */
    private artifactGlyph(
        fontId: string,
        codePoint: number,
    ): ResolvedGlyph | null {
        const table = this.artifactTable(fontId);
        if (!table) return null;
        const metric = table.glyphs.get(codePoint);
        if (!metric) return null;
        return {
            codePoint,
            advancePixels: metric.advancePixels,
            boldExtraAdvancePixels: metric.boldExtraAdvancePixels,
            hasInk: metric.hasInk,
            bounds: metric.hasInk
                ? {
                      left: metric.left,
                      right: metric.right,
                      top: metric.top,
                      bottom: metric.bottom,
                  }
                : EMPTY_BOUNDS,
            raster: null,
            providerKind: "metrics-artifact",
            sourceFontId: table.fontId,
            rasterMissing: true,
        };
    }
}

function isWhitespace(codePoint: number): boolean {
    return (
        codePoint === 0x09 ||
        codePoint === 0x0a ||
        codePoint === 0x0b ||
        codePoint === 0x0c ||
        codePoint === 0x0d ||
        codePoint === 0x20 ||
        codePoint === 0x1c ||
        codePoint === 0x1d ||
        codePoint === 0x1e ||
        codePoint === 0x1f ||
        (codePoint >= 0x2000 && codePoint <= 0x200a) ||
        codePoint === 0x2028 ||
        codePoint === 0x2029 ||
        codePoint === 0x205f ||
        codePoint === 0x3000
    );
}
