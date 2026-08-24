import { unzipSync } from "fflate";
import type { Glyph } from "./glyph.js";
import type { UnihexSizeOverride } from "./providers.js";

/**
 * The `unihex` provider: GNU Unifont hex data, which is where every CJK, Cyrillic, and rare-script
 * glyph in vanilla comes from.
 *
 * A hex line is `CODEPOINT:BITS`, with 16 rows packed into 32, 64, 96, or 128 hex digits, giving
 * an 8, 16, 24, or 32 pixel wide bitmap. Advance is derived from the crop, not from the bit width:
 * `left` and `right` are the inked columns unless a `size_overrides` entry pins them, and the
 * logical advance is `(right - left + 1) / 2 + 1` in GUI pixels because unifont renders at half
 * scale.
 *
 * This is a port of `parse_unihex_archive` / `metric_from_unihex` in
 * `tools/font-metrics/generate_minecraft_font_metrics.py`, so the browser and the shipped metrics
 * artifact derive the same numbers from the same bytes.
 */

export class UnihexError extends Error {}

export interface UnihexGlyphSource {
    readonly rows: readonly number[];
    readonly bitWidth: number;
}

const UNIHEX_ROWS = 16;
/** Unifont renders 16 source pixels into 8 GUI pixels. */
export const UNIHEX_SCALE = 0.5;
/** Baseline sits below source row 14, i.e. 7 GUI pixels down from the top row. */
export const UNIHEX_ASCENT = 7;
const UNIHEX_BOLD_EXTRA = 0.5;

/** Parses a zip of `.hex` files into code point to bitmap rows. */
export function parseUnihexArchive(
    bytes: Uint8Array,
    label: string,
): Map<number, UnihexGlyphSource> {
    let entries: Record<string, Uint8Array>;
    try {
        entries = unzipSync(bytes);
    } catch (error) {
        throw new UnihexError(
            `${label} is not a readable archive: ${(error as Error).message}`,
        );
    }
    const hexEntries = Object.keys(entries)
        .filter((name) => name.endsWith(".hex"))
        .sort();
    if (hexEntries.length === 0)
        throw new UnihexError(`No .hex file in ${label}`);

    const glyphs = new Map<number, UnihexGlyphSource>();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    for (const entry of hexEntries) {
        const text = decoder.decode(entries[entry]!);
        let lineNumber = 0;
        for (const rawLine of text.split(/\r?\n/)) {
            lineNumber += 1;
            if (rawLine.length === 0 || rawLine.startsWith("#")) continue;
            const separator = rawLine.indexOf(":");
            if (separator < 0)
                throw new UnihexError(
                    `Invalid Unihex line ${entry}:${lineNumber}`,
                );
            const codePointText = rawLine.slice(0, separator);
            const bitmapText = rawLine.slice(separator + 1);
            if (!/^[0-9A-Fa-f]+$/.test(codePointText)) {
                throw new UnihexError(
                    `Invalid Unihex line ${entry}:${lineNumber}`,
                );
            }
            const codePoint = Number.parseInt(codePointText, 16);
            if (
                codePoint > 0x10ffff ||
                (codePoint >= 0xd800 && codePoint <= 0xdfff)
            ) {
                throw new UnihexError(
                    `Invalid Unihex code point at ${entry}:${lineNumber}`,
                );
            }
            if (
                ![32, 64, 96, 128].includes(bitmapText.length) ||
                !/^[0-9A-Fa-f]+$/.test(bitmapText)
            ) {
                throw new UnihexError(
                    `Invalid Unihex bitmap width at ${entry}:${lineNumber}`,
                );
            }
            const bitWidth = bitmapText.length / 4;
            const rowDigits = bitWidth / 4;
            const rows: number[] = [];
            for (
                let offset = 0;
                offset < bitmapText.length;
                offset += rowDigits
            ) {
                rows.push(
                    Number.parseInt(
                        bitmapText.slice(offset, offset + rowDigits),
                        16,
                    ),
                );
            }
            if (rows.length !== UNIHEX_ROWS || glyphs.has(codePoint)) {
                throw new UnihexError(
                    `Duplicate or malformed Unihex glyph at ${entry}:${lineNumber}`,
                );
            }
            glyphs.set(codePoint, { rows, bitWidth });
        }
    }
    return glyphs;
}

interface InkBounds {
    readonly minimumX: number;
    readonly maximumX: number;
    readonly minimumY: number;
    readonly maximumY: number;
}

/** Inked bit extents, or null for a blank glyph. */
export function unihexInkBounds(
    rows: readonly number[],
    bitWidth: number,
): InkBounds | null {
    let minimumX = bitWidth;
    let maximumX = -1;
    let minimumY = UNIHEX_ROWS;
    let maximumY = -1;
    for (let y = 0; y < rows.length; y += 1) {
        const row = rows[y]!;
        if (row === 0) continue;
        minimumY = Math.min(minimumY, y);
        maximumY = Math.max(maximumY, y);
        minimumX = Math.min(minimumX, bitWidth - bitLength(row));
        maximumX = Math.max(
            maximumX,
            bitWidth - 1 - (bitLength(row & -row) - 1),
        );
    }
    if (maximumX < 0) return null;
    return { minimumX, maximumX, minimumY, maximumY };
}

/** Number of bits needed to represent a non-negative integer, matching Python's `int.bit_length`. */
function bitLength(value: number): number {
    let remaining = value >>> 0;
    let length = 0;
    while (remaining > 0) {
        remaining >>>= 1;
        length += 1;
    }
    return length;
}

/** The `left`/`right` crop the advance is measured from, before any size override. */
export function unihexCrop(
    rows: readonly number[],
    bitWidth: number,
): { left: number; right: number } {
    const bounds = unihexInkBounds(rows, bitWidth);
    if (!bounds) return { left: 0, right: bitWidth };
    return { left: bounds.minimumX, right: bounds.maximumX };
}

export function applySizeOverrides(
    codePoint: number,
    crop: { left: number; right: number },
    overrides: readonly UnihexSizeOverride[],
): { left: number; right: number } {
    for (const override of overrides) {
        if (codePoint >= override.from && codePoint <= override.to) {
            return { left: override.left, right: override.right };
        }
    }
    return crop;
}

/** Builds the glyph, including the raster descriptor the painter needs. */
export function unihexGlyph(
    codePoint: number,
    source: UnihexGlyphSource,
    crop: { left: number; right: number },
): Glyph {
    const { left, right } = crop;
    if (!(left >= 0 && left <= right && right <= 31)) {
        throw new UnihexError(
            `Invalid Unihex crop ${left}..${right} for a ${source.bitWidth}-pixel glyph`,
        );
    }
    const width = right - left + 1;
    const advancePixels = Math.floor(width / 2) + 1;

    let minimumX = Number.POSITIVE_INFINITY;
    let maximumX = Number.NEGATIVE_INFINITY;
    let minimumY = Number.POSITIVE_INFINITY;
    let maximumY = Number.NEGATIVE_INFINITY;
    let hasInk = false;
    const lastColumn = Math.min(source.bitWidth - 1, right);
    for (let y = 0; y < source.rows.length; y += 1) {
        const row = source.rows[y]!;
        for (let x = Math.max(0, left); x <= lastColumn; x += 1) {
            if ((row & (1 << (source.bitWidth - 1 - x))) === 0) continue;
            hasInk = true;
            minimumX = Math.min(minimumX, x);
            maximumX = Math.max(maximumX, x);
            minimumY = Math.min(minimumY, y);
            maximumY = Math.max(maximumY, y);
        }
    }

    const raster = {
        kind: "unihex" as const,
        rows: source.rows,
        bitWidth: source.bitWidth,
        sourceWidth: source.bitWidth,
        sourceHeight: UNIHEX_ROWS,
        originX: left,
        scale: UNIHEX_SCALE,
        ascent: UNIHEX_ASCENT,
    };

    if (!hasInk) {
        return {
            codePoint,
            advancePixels,
            boldExtraAdvancePixels: UNIHEX_BOLD_EXTRA,
            hasInk: false,
            bounds: { left: 0, right: 0, top: 0, bottom: 0 },
            raster,
            providerKind: "unihex",
        };
    }

    return {
        codePoint,
        advancePixels,
        boldExtraAdvancePixels: UNIHEX_BOLD_EXTRA,
        hasInk: true,
        bounds: {
            left: (minimumX - left) / 2,
            right: (maximumX - left + 1) / 2,
            top: -7 + minimumY / 2,
            bottom: -7 + (maximumY + 1) / 2,
        },
        raster,
        providerKind: "unihex",
    };
}
