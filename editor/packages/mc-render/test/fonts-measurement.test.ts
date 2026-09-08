import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readFontMetricsArtifact } from "@itemerness/mc-assets";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import { fontNodeSchema, glyphNodeSchema } from "@itemerness/protocol";
import { PresentationFonts } from "../src/fonts.js";

const font = fontNodeSchema.parse({
    uuid: "00000000-0000-4000-8000-000000000001",
    id: "example:explicit",
    metrics: "explicit",
    fallbackAdvancePixels: 6,
});
const glyph = glyphNodeSchema.parse({
    uuid: "00000000-0000-4000-8000-000000000002",
    id: "test.glyph",
    font: font.id,
    codePoint: 65,
    advancePixels: 8,
    visualBounds: { left: 0, right: 7, top: -8, bottom: 0 },
});

describe("document measurement policy", () => {
    it("does not require pixels for an explicitly declared ink-free seam kern", () => {
        const kern = {
            ...glyph,
            advancePixels: -1,
            visualBounds: { left: 0, right: 0, top: 0, bottom: 0 },
        };
        const fonts = new PresentationFonts({
            fonts: [font],
            glyphs: [kern],
            spacing: null,
        });
        expect(fonts.resolve(font.id, 65, "FRAME")).toMatchObject({
            advancePixels: -1,
            hasInk: false,
            rasterMissing: false,
            boldExtraAdvancePixels: 0,
        });
    });
    it("applies the global bold advance only to flat-fallback glyphs, not registered assets", () => {
        for (const pixels of [0, 0.5, 2, 4096]) {
            const fonts = new PresentationFonts({
                fonts: [font],
                glyphs: [glyph],
                spacing: null,
                boldExtraAdvancePixels: pixels,
            });
            expect(
                fonts.resolve(font.id, 65, "TEXT")?.boldExtraAdvancePixels,
            ).toBe(0);
            expect(
                fonts.resolve(font.id, 66, "TEXT")?.boldExtraAdvancePixels,
            ).toBe(pixels);
        }
    });
    it("retains schema 1's one-pixel default", () => {
        const fonts = new PresentationFonts({
            fonts: [font],
            glyphs: [glyph],
            spacing: null,
        });
        expect(fonts.resolve(font.id, 65, "TEXT")?.boldExtraAdvancePixels).toBe(
            0,
        );
        expect(fonts.resolve(font.id, 66, "TEXT")?.boldExtraAdvancePixels).toBe(
            1,
        );
    });
    it("uses the global advance when a declared glyph is reached through a font fallback", () => {
        const entry = {
            ...font,
            id: "example:entry",
            fallback: font.id,
            fallbackAdvancePixels: null,
        };
        for (const pixels of [0, 0.5, 1, 3]) {
            const fonts = new PresentationFonts({
                fonts: [entry, font],
                glyphs: [glyph],
                spacing: null,
                boldExtraAdvancePixels: pixels,
            });
            expect(
                fonts.resolve(font.id, 65, "TEXT")?.boldExtraAdvancePixels,
            ).toBe(0);
            expect(
                fonts.resolve(entry.id, 65, "TEXT")?.boldExtraAdvancePixels,
            ).toBe(pixels);
        }
    });
    it("does not override generated glyph-specific advances or spacing advances", () => {
        const artifact = readFontMetricsArtifact(
            new Uint8Array(
                readFileSync(
                    new URL(
                        "../../../../itemerness-bukkit/src/main/resources/META-INF/itemerness/font-metrics/minecraft-26.1.2.ifm",
                        import.meta.url,
                    ),
                ),
            ),
        );
        const options = {
            artifact,
            fonts: baselineDocument.fonts,
            glyphs: baselineDocument.glyphs,
            spacing: baselineDocument.spacing,
        };
        const original = new PresentationFonts(options);
        const altered = new PresentationFonts({
            ...options,
            boldExtraAdvancePixels: 5,
        });
        expect(
            altered.resolve("minecraft:default", 65, "TEXT")
                ?.boldExtraAdvancePixels,
        ).toBe(
            original.resolve("minecraft:default", 65, "TEXT")
                ?.boldExtraAdvancePixels,
        );
        const spacing = baselineDocument.spacing!;
        expect(
            altered.resolve(
                spacing.font,
                spacing.positive.firstCodePoint,
                "SPACING",
            )?.boldExtraAdvancePixels,
        ).toBe(0);
    });
});
