import { decode as decodePng } from "fast-png";

/**
 * Raw RGBA image data.
 *
 * The engine decodes PNGs itself rather than going through `createImageBitmap` so that alpha
 * inspection, glyph cell measurement, and rasterization all see identical bytes in the browser and
 * in Node tests. Glyph advances are derived from "the right-most column with any alpha", which is
 * not a question a canvas can answer without a readback.
 */
export interface DecodedImage {
    readonly width: number;
    readonly height: number;
    /** RGBA, 8 bits per channel, row-major. */
    readonly data: Uint8ClampedArray;
}

export class ImageDecodeError extends Error {}

const MAX_DIMENSION = 8192;
const MAX_PNG_BYTES = 64 * 1024 * 1024;
const MAX_RGBA_BYTES = 128 * 1024 * 1024;
const MAX_DECODE_WORKING_BYTES = 256 * 1024 * 1024;
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const;

interface PngHeader {
    readonly width: number;
    readonly height: number;
    readonly depth: number;
    readonly channels: number;
}

/** Reads and budgets IHDR before the decoder allocates scanline or pixel buffers. */
function validatePngHeader(bytes: Uint8Array, label: string): PngHeader {
    if (bytes.byteLength > MAX_PNG_BYTES) {
        throw new ImageDecodeError(`${label} exceeds the PNG input size limit`);
    }
    if (
        bytes.byteLength < 33 ||
        PNG_SIGNATURE.some((value, index) => bytes[index] !== value)
    ) {
        throw new ImageDecodeError(
            `${label} is not a readable PNG: invalid signature`,
        );
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const headerLength = view.getUint32(8, false);
    const headerType = String.fromCharCode(
        bytes[12]!,
        bytes[13]!,
        bytes[14]!,
        bytes[15]!,
    );
    if (headerLength !== 13 || headerType !== "IHDR") {
        throw new ImageDecodeError(
            `${label} is not a readable PNG: invalid IHDR`,
        );
    }
    const width = view.getUint32(16, false);
    const height = view.getUint32(20, false);
    const depth = bytes[24]!;
    const colourType = bytes[25]!;
    const compression = bytes[26]!;
    const filter = bytes[27]!;
    const interlace = bytes[28]!;
    if (
        width <= 0 ||
        height <= 0 ||
        width > MAX_DIMENSION ||
        height > MAX_DIMENSION
    ) {
        throw new ImageDecodeError(
            `${label} has unsupported dimensions ${width}x${height}`,
        );
    }

    const validDepths: Readonly<Record<number, readonly number[]>> = {
        0: [1, 2, 4, 8, 16],
        2: [8, 16],
        3: [1, 2, 4, 8],
        4: [8, 16],
        6: [8, 16],
    };
    const channelCounts: Readonly<Record<number, number>> = {
        0: 1,
        2: 3,
        3: 1,
        4: 2,
        6: 4,
    };
    const channels = channelCounts[colourType];
    if (!channels || !validDepths[colourType]?.includes(depth)) {
        throw new ImageDecodeError(
            `${label} has unsupported PNG colour type ${colourType} at depth ${depth}`,
        );
    }
    if (
        compression !== 0 ||
        filter !== 0 ||
        (interlace !== 0 && interlace !== 1)
    ) {
        throw new ImageDecodeError(
            `${label} has unsupported PNG encoding methods`,
        );
    }

    const pixels = width * height;
    const rgbaBytes = pixels * 4;
    const scanlineBytes = Math.ceil((width * channels * depth) / 8) + 1;
    const inflatedBytes = scanlineBytes * height;
    const decodedSampleBytes = pixels * channels * (depth === 16 ? 2 : 1);
    const workingBytes =
        bytes.byteLength + rgbaBytes + inflatedBytes + decodedSampleBytes;
    if (rgbaBytes > MAX_RGBA_BYTES || workingBytes > MAX_DECODE_WORKING_BYTES) {
        throw new ImageDecodeError(
            `${label} requires an unsafe PNG decode budget (${workingBytes} bytes)`,
        );
    }
    return { width, height, depth, channels };
}

/** Decodes a PNG into straight RGBA, expanding palettes, grayscale, and 16-bit samples. */
export function decodeImage(bytes: Uint8Array, label: string): DecodedImage {
    const header = validatePngHeader(bytes, label);
    let decoded;
    try {
        decoded = decodePng(bytes);
    } catch (error) {
        throw new ImageDecodeError(
            `${label} is not a readable PNG: ${(error as Error).message}`,
        );
    }
    const { width, height, channels, depth, palette } = decoded;
    if (
        width !== header.width ||
        height !== header.height ||
        depth !== header.depth ||
        channels !== header.channels
    ) {
        throw new ImageDecodeError(
            `${label} decoded metadata does not match its PNG header`,
        );
    }

    const out = new Uint8ClampedArray(width * height * 4);
    const source = decoded.data;
    const shift = depth === 16 ? 8 : 0;
    const pixels = width * height;

    // Vanilla's font sheets are 1-bit indexed PNGs, so sub-byte depths are the common case here,
    // not an exotic one. Scanlines are padded to whole bytes; missing that is how every glyph in
    // ascii.png ends up measuring as blank.
    if (depth < 8) {
        const bytesPerRow = Math.ceil((width * depth) / 8);
        const mask = (1 << depth) - 1;
        const maxValue = mask;
        for (let y = 0; y < height; y += 1) {
            for (let x = 0; x < width; x += 1) {
                const bitOffset = x * depth;
                const byte = source[
                    y * bytesPerRow + (bitOffset >> 3)
                ] as number;
                const value = (byte >> (8 - depth - (bitOffset & 7))) & mask;
                const target = (y * width + x) * 4;
                if (palette) {
                    const entry = palette[value] ?? [0, 0, 0, 0];
                    out[target] = entry[0] ?? 0;
                    out[target + 1] = entry[1] ?? 0;
                    out[target + 2] = entry[2] ?? 0;
                    out[target + 3] = entry[3] ?? 255;
                } else {
                    const grey = Math.round((value / maxValue) * 255);
                    out[target] = grey;
                    out[target + 1] = grey;
                    out[target + 2] = grey;
                    out[target + 3] = 255;
                }
            }
        }
        return { width, height, data: out };
    }

    if (palette) {
        for (let index = 0; index < pixels; index += 1) {
            const entry = palette[
                ((source[index] as number) >> shift) as number
            ] ?? [0, 0, 0, 0];
            out[index * 4] = entry[0] ?? 0;
            out[index * 4 + 1] = entry[1] ?? 0;
            out[index * 4 + 2] = entry[2] ?? 0;
            out[index * 4 + 3] = entry[3] ?? 255;
        }
        return { width, height, data: out };
    }

    for (let index = 0; index < pixels; index += 1) {
        const base = index * channels;
        switch (channels) {
            case 1: {
                const grey = (source[base] as number) >> shift;
                out[index * 4] = grey;
                out[index * 4 + 1] = grey;
                out[index * 4 + 2] = grey;
                out[index * 4 + 3] = 255;
                break;
            }
            case 2: {
                const grey = (source[base] as number) >> shift;
                out[index * 4] = grey;
                out[index * 4 + 1] = grey;
                out[index * 4 + 2] = grey;
                out[index * 4 + 3] = (source[base + 1] as number) >> shift;
                break;
            }
            case 3: {
                out[index * 4] = (source[base] as number) >> shift;
                out[index * 4 + 1] = (source[base + 1] as number) >> shift;
                out[index * 4 + 2] = (source[base + 2] as number) >> shift;
                out[index * 4 + 3] = 255;
                break;
            }
            case 4: {
                out[index * 4] = (source[base] as number) >> shift;
                out[index * 4 + 1] = (source[base + 1] as number) >> shift;
                out[index * 4 + 2] = (source[base + 2] as number) >> shift;
                out[index * 4 + 3] = (source[base + 3] as number) >> shift;
                break;
            }
            default:
                throw new ImageDecodeError(
                    `${label} has ${channels} channels, which is not a PNG colour type`,
                );
        }
    }
    return { width, height, data: out };
}

export function alphaAt(image: DecodedImage, x: number, y: number): number {
    if (x < 0 || y < 0 || x >= image.width || y >= image.height) return 0;
    return image.data[(y * image.width + x) * 4 + 3] ?? 0;
}

/**
 * Minecraft measures glyph cells with `getLuminanceOrAlpha`, which is the alpha channel for the
 * RGBA textures fonts actually use. Grayscale-without-alpha textures fall back to luminance, so
 * the same rule is applied here for the rare pack that ships one.
 */
export function inkAt(image: DecodedImage, x: number, y: number): boolean {
    return alphaAt(image, x, y) !== 0;
}
