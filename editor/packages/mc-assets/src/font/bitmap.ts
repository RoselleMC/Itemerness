import type { DecodedImage } from "../image.js";
import type { Glyph } from "./glyph.js";
import type { BitmapProvider } from "./providers.js";
import { unicodeScalars } from "./providers.js";

/**
 * The `bitmap` provider: a texture split into a rectangular grid of glyph cells.
 *
 * The advance is not the cell width. Minecraft scans each cell from the right for the first column
 * containing any alpha, scales that by `height / cellHeight`, and adds one pixel of spacing:
 *
 *     advance = floor(0.5 + rightmostInkedColumnCount * scale) + 1
 *
 * This is the rule that makes a custom icon font's spacing predictable, and it is also why padding
 * a glyph with transparent pixels on the right does not widen it while padding on the left does.
 * Ported from `bitmap_provider_metrics` in the metrics generator.
 */

export class BitmapProviderError extends Error {}

const BITMAP_BOLD_EXTRA = 1;

export interface BitmapGrid {
    readonly rows: readonly (readonly number[])[];
    readonly columns: number;
    readonly cellWidth: number;
    readonly cellHeight: number;
    readonly scale: number;
}

export function bitmapGrid(
    provider: BitmapProvider,
    image: DecodedImage,
    label: string,
): BitmapGrid {
    const rows = provider.chars.map((row) => unicodeScalars(row));
    const columns = rows[0]?.length ?? 0;
    if (columns === 0 || rows.some((row) => row.length !== columns)) {
        throw new BitmapProviderError(
            `Non-rectangular character grid in ${label}`,
        );
    }
    if (image.width % columns !== 0 || image.height % rows.length !== 0) {
        throw new BitmapProviderError(
            `Texture dimensions do not match the character grid in ${label}`,
        );
    }
    const cellWidth = image.width / columns;
    const cellHeight = image.height / rows.length;
    if (cellHeight === 0)
        throw new BitmapProviderError(`Empty glyph cells in ${label}`);
    return {
        rows,
        columns,
        cellWidth,
        cellHeight,
        scale: provider.height / cellHeight,
    };
}

/** Builds every glyph a bitmap provider supplies. Code point 0 is the "no glyph" placeholder. */
export function bitmapProviderGlyphs(
    provider: BitmapProvider,
    image: DecodedImage,
    label: string,
): Map<number, Glyph> {
    const grid = bitmapGrid(provider, image, label);
    const output = new Map<number, Glyph>();

    for (let rowIndex = 0; rowIndex < grid.rows.length; rowIndex += 1) {
        const codePoints = grid.rows[rowIndex]!;
        for (
            let columnIndex = 0;
            columnIndex < codePoints.length;
            columnIndex += 1
        ) {
            const codePoint = codePoints[columnIndex]!;
            if (codePoint === 0) continue;
            const originX = columnIndex * grid.cellWidth;
            const originY = rowIndex * grid.cellHeight;

            let minimumX = Number.POSITIVE_INFINITY;
            let maximumX = Number.NEGATIVE_INFINITY;
            let minimumY = Number.POSITIVE_INFINITY;
            let maximumY = Number.NEGATIVE_INFINITY;
            let hasInk = false;
            for (let y = 0; y < grid.cellHeight; y += 1) {
                const rowBase = (originY + y) * image.width;
                for (let x = 0; x < grid.cellWidth; x += 1) {
                    if (
                        (image.data[(rowBase + originX + x) * 4 + 3] ?? 0) === 0
                    )
                        continue;
                    hasInk = true;
                    if (x < minimumX) minimumX = x;
                    if (x > maximumX) maximumX = x;
                    if (y < minimumY) minimumY = y;
                    if (y > maximumY) maximumY = y;
                }
            }

            const actualWidth = hasInk ? maximumX + 1 : 0;
            const advancePixels =
                Math.floor(0.5 + actualWidth * grid.scale) + 1;
            const raster = {
                kind: "bitmap" as const,
                image,
                sourceX: originX,
                sourceY: originY,
                sourceWidth: grid.cellWidth,
                sourceHeight: grid.cellHeight,
                originX: 0,
                scale: grid.scale,
                ascent: provider.ascent,
            };

            output.set(codePoint, {
                codePoint,
                advancePixels,
                boldExtraAdvancePixels: BITMAP_BOLD_EXTRA,
                hasInk,
                bounds: hasInk
                    ? {
                          left: minimumX * grid.scale,
                          right: (maximumX + 1) * grid.scale,
                          top: -provider.ascent + minimumY * grid.scale,
                          bottom:
                              -provider.ascent + (maximumY + 1) * grid.scale,
                      }
                    : { left: 0, right: 0, top: 0, bottom: 0 },
                raster,
                providerKind: "bitmap",
            });
        }
    }
    return output;
}
