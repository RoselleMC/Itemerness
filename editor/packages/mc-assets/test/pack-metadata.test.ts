import { describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import {
    MAX_PACK_FORMAT_MINOR,
    mountArchive,
    packFormatDeclarationStatus,
} from "../src/pack.js";

const baseline = { major: 84, minor: 0 };

function mountMetadata(pack: unknown) {
    return mountArchive(
        zipSync({
            "pack.mcmeta": new TextEncoder().encode(JSON.stringify({ pack })),
            "assets/example/font/default.json": new TextEncoder().encode(
                '{"providers":[]}',
            ),
        }),
        { name: "declaration.zip" },
    );
}

describe("resource pack format declarations", () => {
    it.each([
        [84, 84, 0, MAX_PACK_FORMAT_MINOR],
        [[84], [84], 0, MAX_PACK_FORMAT_MINOR],
        [[84, 0], [84, 2], 0, 2],
        [[84, 1], [84, 1], 1, 1],
    ])(
        "reads new endpoints %j to %j",
        (minimum, maximum, minMinor, maxMinor) => {
            const pack = mountMetadata({
                min_format: minimum,
                max_format: maximum,
            });
            expect(pack.meta?.declaredFormats).toEqual({
                minimum: { major: 84, minor: minMinor },
                maximum: { major: 84, minor: maxMinor },
                source: "min_format/max_format",
            });
            expect(packFormatDeclarationStatus(pack.meta, baseline)).toBe(
                minMinor === 0 ? "included" : "outside",
            );
        },
    );

    it("uses lexicographic, inclusive major/minor bounds", () => {
        const pack = mountMetadata({
            min_format: [83, 100],
            max_format: [84, 2],
        });
        expect(
            packFormatDeclarationStatus(pack.meta, { major: 83, minor: 99 }),
        ).toBe("outside");
        expect(
            packFormatDeclarationStatus(pack.meta, { major: 83, minor: 100 }),
        ).toBe("included");
        expect(packFormatDeclarationStatus(pack.meta, baseline)).toBe(
            "included",
        );
        expect(
            packFormatDeclarationStatus(pack.meta, { major: 84, minor: 2 }),
        ).toBe("included");
        expect(
            packFormatDeclarationStatus(pack.meta, { major: 84, minor: 3 }),
        ).toBe("outside");
    });

    it.each([
        [84, 84, 84],
        [[75, 84], 75, 84],
        [{ min_inclusive: 75, max_inclusive: 84 }, 75, 84],
    ])("normalizes legacy supported_formats %j", (value, minimum, maximum) => {
        const pack = mountMetadata({
            pack_format: minimum,
            supported_formats: value,
        });
        expect(pack.meta?.supportedFormats).toEqual([minimum, maximum]);
        expect(pack.meta?.declaredFormats).toEqual({
            minimum: { major: minimum, minor: 0 },
            maximum: { major: maximum, minor: MAX_PACK_FORMAT_MINOR },
            source: "supported_formats",
        });
        expect(packFormatDeclarationStatus(pack.meta, baseline)).toBe(
            "included",
        );
    });

    it("reports the old single-version 75 declaration outside the pinned 84.0 baseline", () => {
        const pack = mountMetadata({
            pack_format: 75,
            description: "Original pack",
        });
        expect(pack.meta?.packFormat).toBe(75);
        expect(pack.meta?.description).toBe("Original pack");
        expect(packFormatDeclarationStatus(pack.meta, baseline)).toBe(
            "outside",
        );
        expect(pack.has("assets/example/font/default.json")).toBe(true);
        expect(
            JSON.parse(new TextDecoder().decode(pack.read("pack.mcmeta"))),
        ).toEqual({
            pack: { pack_format: 75, description: "Original pack" },
        });
    });

    it("uses explicit min/max when legacy fields are also present", () => {
        const pack = mountMetadata({
            min_format: 64,
            max_format: [84, 0],
            pack_format: 64,
            supported_formats: [64, 84],
        });
        expect(pack.meta?.declaredFormats?.source).toBe(
            "min_format/max_format",
        );
        expect(packFormatDeclarationStatus(pack.meta, baseline)).toBe(
            "included",
        );
        expect(
            packFormatDeclarationStatus(pack.meta, { major: 84, minor: 1 }),
        ).toBe("outside");
    });

    it.each([
        {},
        null,
        [],
        "pack",
        84,
        { pack_format: "84" },
        { pack_format: 84.1 },
        { pack_format: -1 },
        { pack_format: 2147483648 },
        { pack_format: 84, min_format: 84 },
        { pack_format: 84, max_format: 84 },
        { pack_format: 84, min_format: null, max_format: 84 },
        { pack_format: 84, min_format: [], max_format: 84 },
        { pack_format: 84, min_format: [84, 0, 0], max_format: 84 },
        { pack_format: 84, min_format: [84, "0"], max_format: 84 },
        { pack_format: 84, min_format: [84, -1], max_format: 84 },
        { pack_format: 84, min_format: 85, max_format: 84 },
        { pack_format: 84, min_format: [84, 2], max_format: [84, 1] },
        { pack_format: 84, supported_formats: [84] },
        { pack_format: 84, supported_formats: [75, "84"] },
        { pack_format: 84, supported_formats: [75, 84, 85] },
        { pack_format: 84, supported_formats: [85, 75] },
        { pack_format: 84, supported_formats: { min_inclusive: 75 } },
        { pack_format: 84, supported_formats: [70, 75] },
    ])(
        "keeps unreadable declarations unknown without blocking assets: %j",
        (value) => {
            const pack = mountMetadata(value);
            expect(packFormatDeclarationStatus(pack.meta, baseline)).toBe(
                "unknown",
            );
            expect(pack.has("assets/example/font/default.json")).toBe(true);
        },
    );

    it.each([undefined, "{", "null", "[]"])(
        "keeps absent or malformed metadata unknown: %s",
        (metadata) => {
            const files: Record<string, Uint8Array> = {
                "assets/example/font/default.json": new TextEncoder().encode(
                    "{}",
                ),
            };
            if (metadata !== undefined)
                files["pack.mcmeta"] = new TextEncoder().encode(metadata);
            const pack = mountArchive(zipSync(files), { name: "unknown.zip" });
            expect(pack.meta).toBeNull();
            expect(packFormatDeclarationStatus(pack.meta, baseline)).toBe(
                "unknown",
            );
            expect(pack.has("assets/example/font/default.json")).toBe(true);
        },
    );
});
