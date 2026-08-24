import type { DecodedImage } from "../image.js";

/**
 * A glyph as the engine needs it: the metrics the layout depends on, plus enough information to
 * draw the exact source pixels.
 *
 * Metrics and pixels are deliberately separate concerns. Metrics alone give a `metric-faithful`
 * preview with no Mojang asset mounted; pixels upgrade the raster to `approximate-raster`. Neither
 * one is allowed to be inferred from the other.
 */

/** Ink extents relative to the pen position, with the baseline at y = 0 and up negative. */
export interface GlyphBounds {
    readonly left: number;
    readonly right: number;
    readonly top: number;
    readonly bottom: number;
}

export const EMPTY_BOUNDS: GlyphBounds = {
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
};

/**
 * Where a glyph's pixels come from and how they map to GUI pixels.
 *
 * The destination rectangle is always
 * `x ∈ [-originX·scale, (sourceWidth-originX)·scale]`, `y ∈ [-ascent, -ascent + sourceHeight·scale]`.
 * Expressing bitmap and unihex glyphs through one transform keeps the painter from growing a
 * per-provider special case, which is where drift between the two would start.
 */
export interface GlyphRasterBase {
    readonly sourceWidth: number;
    readonly sourceHeight: number;
    /** Source column that lands on the pen position. */
    readonly originX: number;
    /** GUI pixels per source pixel. */
    readonly scale: number;
    /** GUI pixels from the baseline to the top source row. */
    readonly ascent: number;
}

export interface BitmapGlyphRaster extends GlyphRasterBase {
    readonly kind: "bitmap";
    readonly image: DecodedImage;
    /** Top-left of the glyph cell inside the texture. */
    readonly sourceX: number;
    readonly sourceY: number;
}

export interface UnihexGlyphRaster extends GlyphRasterBase {
    readonly kind: "unihex";
    /** Sixteen rows of bits, most significant bit leftmost within `bitWidth`. */
    readonly rows: readonly number[];
    readonly bitWidth: number;
}

export type GlyphRaster = BitmapGlyphRaster | UnihexGlyphRaster;

export interface Glyph {
    readonly codePoint: number;
    /** Signed logical advance in GUI pixels; what `Font.width` sums. */
    readonly advancePixels: number;
    /** Extra advance contributed when the run is bold. */
    readonly boldExtraAdvancePixels: number;
    readonly hasInk: boolean;
    readonly bounds: GlyphBounds;
    readonly raster: GlyphRaster | null;
    /** Provider that supplied this glyph, for the metrics inspector. */
    readonly providerKind:
        "bitmap" | "space" | "unihex" | "metrics-artifact" | "declared";
}

/** Reads a unihex bit, with column 0 at the left. */
export function unihexBit(
    rows: readonly number[],
    bitWidth: number,
    x: number,
    y: number,
): boolean {
    const row = rows[y];
    if (row === undefined) return false;
    return (row & (1 << (bitWidth - 1 - x))) !== 0;
}

/** True when the raster has a lit pixel at the given source coordinate. */
export function rasterInk(raster: GlyphRaster, x: number, y: number): boolean {
    if (raster.kind === "unihex")
        return unihexBit(raster.rows, raster.bitWidth, x, y);
    const image = raster.image;
    const px = raster.sourceX + x;
    const py = raster.sourceY + y;
    if (px < 0 || py < 0 || px >= image.width || py >= image.height)
        return false;
    return (image.data[(py * image.width + px) * 4 + 3] ?? 0) !== 0;
}

/** Straight RGBA of a raster pixel. Unihex glyphs are pure white masks. */
export function rasterPixel(
    raster: GlyphRaster,
    x: number,
    y: number,
): [number, number, number, number] {
    if (raster.kind === "unihex") {
        return unihexBit(raster.rows, raster.bitWidth, x, y)
            ? [255, 255, 255, 255]
            : [0, 0, 0, 0];
    }
    const image = raster.image;
    const px = raster.sourceX + x;
    const py = raster.sourceY + y;
    if (px < 0 || py < 0 || px >= image.width || py >= image.height)
        return [0, 0, 0, 0];
    const base = (py * image.width + px) * 4;
    return [
        image.data[base] ?? 0,
        image.data[base + 1] ?? 0,
        image.data[base + 2] ?? 0,
        image.data[base + 3] ?? 0,
    ];
}
