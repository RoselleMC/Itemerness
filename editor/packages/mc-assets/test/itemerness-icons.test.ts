import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { bitmapProviderGlyphs } from "../src/font/bitmap.js";
import { parseFontDefinition } from "../src/font/providers.js";
import { decodeImage } from "../src/image.js";

const resource = (path: string) =>
    fileURLToPath(
        new URL(`../../../../resource-pack/${path}`, import.meta.url),
    );

describe("Itemerness icon font", () => {
    it("ships raster pixels with the declared nine-pixel advances", async () => {
        const definition = parseFontDefinition(
            JSON.parse(
                await readFile(
                    resource("assets/itemerness/font/icons.json"),
                    "utf8",
                ),
            ),
            "itemerness:icons",
        );
        const provider = definition[0];
        expect(provider?.type).toBe("bitmap");
        if (!provider || provider.type !== "bitmap") return;

        expect(definition[1]).toMatchObject({
            type: "reference",
            id: "minecraft:default",
        });

        const imageBytes = await readFile(
            resource("assets/itemerness/textures/font/icons.png"),
        );
        const glyphs = bitmapProviderGlyphs(
            provider,
            decodeImage(imageBytes, "itemerness:font/icons.png"),
            "itemerness:font/icons.png",
        );

        expect([...glyphs.keys()]).toEqual([
            0xe001, 0xe002, 0xe003, 0xe004, 0xe005,
        ]);
        for (const glyph of glyphs.values()) {
            expect(glyph.advancePixels).toBe(9);
            expect(glyph.raster).not.toBeNull();
            expect(glyph.bounds.top).toBeGreaterThanOrEqual(-8);
            expect(glyph.bounds.bottom).toBeLessThanOrEqual(0);
        }
    });

    it("ships a BMP signed-spacing provider aligned with the presentation manifest", async () => {
        const definition = parseFontDefinition(
            JSON.parse(
                await readFile(
                    resource("assets/itemerness/font/spacing.json"),
                    "utf8",
                ),
            ),
            "itemerness:spacing",
        );
        expect(definition).toHaveLength(1);
        const provider = definition[0];
        expect(provider?.type).toBe("space");
        if (!provider || provider.type !== "space") return;

        expect(provider.advances.size).toBe(512);
        expect(provider.advances.get(0xe300)).toBe(-256);
        expect(provider.advances.get(0xe3ff)).toBe(-1);
        expect(provider.advances.get(0xe400)).toBe(1);
        expect(provider.advances.get(0xe402)).toBe(3);
        expect(provider.advances.get(0xe4ff)).toBe(256);
    });
});
