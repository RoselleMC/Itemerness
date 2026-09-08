import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { zipSync } from "fflate";
import { mountArchive } from "@itemerness/mc-assets";
import * as assets from "@itemerness/mc-assets";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import { contentHash } from "@itemerness/protocol";
import {
    packFontIds,
    proposePackFontImport,
    readPackFont,
} from "../src/state/packFontImport.js";

const png = new Uint8Array(
    readFileSync(new URL("../src-tauri/icons/32x32.png", import.meta.url)),
);
const bitmap = {
    type: "bitmap",
    file: "example:font/icon.png",
    ascent: 7,
    height: 8,
    chars: ["\ue000"],
};
const space = { type: "space", advances: { "\ue001": -1 } };
function pack(providers: unknown[] = [bitmap, space]) {
    return mountArchive(
        zipSync({
            "assets/example/font/frame.json": new TextEncoder().encode(
                JSON.stringify({ providers }),
            ),
            "assets/example/textures/font/icon.png": png,
        }),
        { name: "frame.zip", kind: "resource-pack" },
    );
}

describe("resource-pack font declarations", () => {
    afterEach(() => vi.restoreAllMocks());
    it("imports negative-ascent bitmap glyphs without manufacturing invalid canvas metadata", () => {
        const source = readPackFont(
            pack([{ ...bitmap, ascent: -1 }]),
            "example:frame",
        );
        expect(source.bitmaps).toEqual([]);
        expect(source.glyphs[0]).toMatchObject({
            bitmap: null,
            visualBounds: { left: 0, right: 8, top: 1, bottom: 9 },
        });
        const result = proposePackFontImport(
            structuredClone(baselineDocument),
            source,
        );
        expect(result.added).toBe(1);
        expect(result.document.bitmaps).toEqual(baselineDocument.bitmaps);
    });
    it("skips already supplied code points before reading or decoding repeated providers", () => {
        const decode = vi.spyOn(assets, "decodeImage");
        const measure = vi.spyOn(assets, "bitmapProviderGlyphs");
        const source = readPackFont(
            pack(Array(256).fill(bitmap)),
            "example:frame",
        );
        expect(source.glyphs).toHaveLength(1);
        expect(decode).toHaveBeenCalledTimes(1);
        expect(measure).toHaveBeenCalledTimes(1);
    });
    it.each(["decode", "analysis"])(
        "rejects cumulative %s work before exceeding the per-import budget",
        (kind) => {
            const width = 8192,
                height = kind === "decode" ? 4096 : 2048;
            const header = Uint8Array.from(png);
            new DataView(header.buffer).setUint32(16, width, false);
            new DataView(header.buffer).setUint32(20, height, false);
            // Decode correctness is covered by mc-assets; these spies isolate pre-allocation budgeting.
            const decode = vi.spyOn(assets, "decodeImage").mockReturnValue({
                width,
                height,
                data: new Uint8ClampedArray(),
            });
            const measure = vi
                .spyOn(assets, "bitmapProviderGlyphs")
                .mockImplementation((provider) => {
                    const codePoint = provider.chars[0]!.codePointAt(0)!;
                    return new Map([
                        [
                            codePoint,
                            {
                                codePoint,
                                advancePixels: 8,
                                boldExtraAdvancePixels: 1,
                                hasInk: true,
                                bounds: {
                                    left: 0,
                                    right: 7,
                                    top: -7,
                                    bottom: 1,
                                },
                                raster: null,
                                providerKind: "bitmap",
                            },
                        ],
                    ]);
                });
            const providers = Array.from(
                { length: kind === "decode" ? 2 : 3 },
                (_, index) => ({
                    ...bitmap,
                    file: `example:font/${kind === "decode" ? index : 0}.png`,
                    chars: [String.fromCodePoint(0xe000 + index)],
                }),
            );
            const mounted = mountArchive(
                zipSync({
                    "assets/example/font/frame.json": new TextEncoder().encode(
                        JSON.stringify({ providers }),
                    ),
                    "assets/example/textures/font/0.png": header,
                    "assets/example/textures/font/1.png": header,
                }),
                { name: "budget.zip", kind: "resource-pack" },
            );
            expect(() => readPackFont(mounted, "example:frame")).toThrow(
                "analysisBudget",
            );
            expect(decode).toHaveBeenCalledTimes(1);
            expect(measure).toHaveBeenCalledTimes(kind === "decode" ? 1 : 2);
        },
    );
    it("reads actual bitmap metrics, texture metadata and signed spaces without changing the pack", () => {
        const mounted = pack();
        expect(packFontIds(mounted)).toEqual(["example:frame"]);
        const result = readPackFont(mounted, "example:frame");
        expect(result.font.metrics).toBe("explicit");
        expect(result.glyphs).toHaveLength(2);
        expect(result.glyphs[0]!.bitmap).toBe(result.bitmaps[0]!.id);
        expect(result.bitmaps[0]).toMatchObject({
            texture: "example:font/icon.png",
            sourceWidthPixels: 32,
            sourceHeightPixels: 32,
            renderHeightPixels: 8,
            ascentPixels: 7,
        });
        expect(result.glyphs[1]).toMatchObject({
            advancePixels: -1,
            bitmap: null,
            visualBounds: { left: 0, right: 0, top: 0, bottom: 0 },
        });
        expect(mounted.read("assets/example/textures/font/icon.png")).toEqual(
            png,
        );
    });
    it("adds declarations once with no binding, theme, item or capability side effects", () => {
        const original = structuredClone(baselineDocument);
        const hash = contentHash(original);
        const source = readPackFont(pack(), "example:frame");
        const result = proposePackFontImport(original, source);
        expect(result.added).toBe(2);
        expect(contentHash(original)).toBe(hash);
        for (const field of [
            "items",
            "themes",
            "assetProfiles",
            "resourcePackBindings",
            "spacing",
        ] as const)
            expect(result.document[field]).toEqual(original[field]);
        const again = proposePackFontImport(result.document, source);
        expect(again.added).toBe(0);
        expect(again.existing).toBe(2);
        expect(contentHash(again.document)).toBe(contentHash(result.document));
    });
    it("keeps small-ink glyphs when optional whole-texture metadata exceeds the current canvas budget", () => {
        const source = readPackFont(pack([bitmap]), "example:frame");
        // A tall transparent texture can contain only an eight-pixel ink rectangle.
        Object.assign(source.bitmaps[0]!, {
            sourceWidthPixels: 8,
            sourceHeightPixels: 512,
            renderWidthPixels: 8,
            renderHeightPixels: 512,
        });
        const before = JSON.stringify(source);
        const original = structuredClone(baselineDocument);
        const result = proposePackFontImport(original, source);
        expect(result.added).toBe(1);
        expect(result.document.glyphs.at(-1)).toMatchObject({
            bitmap: null,
            visualBounds: source.glyphs[0]!.visualBounds,
        });
        expect(result.document.bitmaps).toEqual(original.bitmaps);
        expect(JSON.stringify(source)).toBe(before);
        const repeated = proposePackFontImport(result.document, source);
        expect(repeated.added).toBe(0);
        expect(repeated.existing).toBe(1);
        expect(repeated.conflicts).toEqual([]);
        expect(contentHash(repeated.document)).toBe(
            contentHash(result.document),
        );
        source.glyphs[0]!.visualBounds.bottom = 512;
        expect(() => proposePackFontImport(original, source)).toThrow(
            "boundsBudget",
        );
    });
    it("keeps conflicting code points and avoids unrelated semantic ID collisions", () => {
        const source = readPackFont(pack(), "example:frame");
        const first = proposePackFontImport(
            structuredClone(baselineDocument),
            source,
        ).document;
        first.glyphs.at(-1)!.advancePixels = -2;
        const before = contentHash(first);
        const next = proposePackFontImport(first, source);
        expect(next.conflicts).toEqual([first.glyphs.at(-1)!.id]);
        expect(contentHash(next.document)).toBe(before);
        const other = structuredClone(baselineDocument);
        other.glyphs[0]!.id = source.glyphs[0]!.id;
        other.bitmaps[0]!.id = source.bitmaps[0]!.id;
        const renamed = proposePackFontImport(other, source);
        expect(renamed.document.glyphs.at(-2)!.id).toBe(
            source.glyphs[0]!.id + "-2",
        );
        expect(renamed.document.glyphs.at(-2)!.bitmap).toBe(
            source.bitmaps[0]!.id + "-2",
        );
    });
    it("never replaces builtin or manifest font declarations", () => {
        const doc = structuredClone(baselineDocument);
        const source = readPackFont(pack(), "example:frame");
        doc.fonts.push({ ...source.font, metrics: "manifest:external" });
        expect(() => proposePackFontImport(doc, source)).toThrow(
            "fontConflict",
        );
    });
    it("reports equal metrics with a different texture as a conflict", () => {
        const source = readPackFont(pack(), "example:frame");
        const previous = proposePackFontImport(
            structuredClone(baselineDocument),
            source,
        ).document;
        previous.bitmaps.at(-1)!.texture = "other:font/different.png";
        const result = proposePackFontImport(previous, source);
        expect(result.conflicts).toEqual([previous.glyphs.at(-2)!.id]);
        expect(contentHash(result.document)).toBe(contentHash(previous));
    });
    it.each([
        { type: "reference", id: "minecraft:default" },
        { type: "ttf", file: "example:body.ttf" },
        { type: "unknown-provider" },
        { ...space, filter: { uniform: true } },
    ])(
        "refuses unsupported or conditional providers as a whole",
        (provider) => {
            expect(() =>
                readPackFont(pack([space, provider]), "example:frame"),
            ).toThrow("unsupportedProvider");
        },
    );
    it("respects provider precedence and does not invent atlas bitmap metadata", () => {
        const source = readPackFont(
            pack([
                { type: "space", advances: { "\ue000": 3 } },
                { ...bitmap, chars: ["\ue000\ue002"] },
            ]),
            "example:frame",
        );
        expect(source.glyphs[0]!.advancePixels).toBe(3);
        expect(source.glyphs[1]!.bitmap).toBeNull();
        expect(source.bitmaps).toEqual([]);
    });
    it("rejects missing textures, invalid scalars and out-of-budget metrics", () => {
        expect(() =>
            readPackFont(
                pack([{ ...bitmap, file: "example:missing.png" }]),
                "example:frame",
            ),
        ).toThrow("missingTexture");
        const invalid = readPackFont(
            pack([{ type: "space", advances: { "\ud800": 1 } }]),
            "example:frame",
        );
        expect(() =>
            proposePackFontImport(structuredClone(baselineDocument), invalid),
        ).toThrow("codePoint");
        const large = readPackFont(
            pack([{ type: "space", advances: { "\ue000": 5000 } }]),
            "example:frame",
        );
        expect(() =>
            proposePackFontImport(structuredClone(baselineDocument), large),
        ).toThrow("advanceRange");
    });
});
