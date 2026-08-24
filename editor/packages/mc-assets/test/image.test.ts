import { describe, expect, it } from "vitest";
import { encode as encodePng } from "fast-png";
import { decodeImage, ImageDecodeError } from "../src/image.js";

function forgedPngHeader(
    width: number,
    height: number,
    depth = 8,
    colourType = 6,
): Uint8Array {
    const bytes = new Uint8Array(33);
    bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
    const view = new DataView(bytes.buffer);
    view.setUint32(8, 13, false);
    bytes.set([73, 72, 68, 82], 12);
    view.setUint32(16, width, false);
    view.setUint32(20, height, false);
    bytes[24] = depth;
    bytes[25] = colourType;
    return bytes;
}

describe("decodeImage preflight", () => {
    it("allows a valid image within the decode budget", () => {
        const bytes = encodePng({
            width: 1,
            height: 1,
            channels: 4,
            depth: 8,
            data: new Uint8Array([10, 20, 30, 255]),
        });

        expect(decodeImage(bytes, "valid.png")).toEqual({
            width: 1,
            height: 1,
            data: new Uint8ClampedArray([10, 20, 30, 255]),
        });
    });

    it("rejects forged oversized IHDR dimensions before PNG decoding", () => {
        expect(() =>
            decodeImage(forgedPngHeader(65_535, 1), "huge.png"),
        ).toThrow(/unsupported dimensions 65535x1/u);
    });

    it("rejects a dimension-valid image whose projected decode memory is unsafe", () => {
        expect(() =>
            decodeImage(forgedPngHeader(8192, 8192), "memory.png"),
        ).toThrow(/unsafe PNG decode budget/u);
    });

    it("rejects malformed IHDR metadata with a typed error", () => {
        const malformed = forgedPngHeader(1, 1, 4, 6);
        expect(() => decodeImage(malformed, "malformed.png")).toThrow(
            ImageDecodeError,
        );
        expect(() => decodeImage(malformed, "malformed.png")).toThrow(
            /unsupported PNG colour type/u,
        );
    });
});
