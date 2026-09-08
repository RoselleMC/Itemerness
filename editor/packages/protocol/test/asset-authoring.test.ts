import { describe, expect, it } from "vitest";
import {
    bitmapNodeSchema,
    fontNodeSchema,
    measurementSchema,
    spacingNodeSchema,
} from "../src/document.js";

const font = (metrics: string) => ({
    uuid: "00000000-0000-0000-0000-000000000001",
    id: "example:font",
    metrics,
});

describe("asset authoring source parity", () => {
    it("accepts signed spacing Int ranges beyond individual glyph advance limits", () => {
        const value = {
            font: "example:spacing",
            negative: {
                firstCodePoint: 0xe000,
                lastCodePoint: 0xe000,
                minimumAdvancePixels: -2147483648,
                maximumAdvancePixels: -2147483648,
            },
            positive: {
                firstCodePoint: 0xe001,
                lastCodePoint: 0xe001,
                minimumAdvancePixels: 2147483647,
                maximumAdvancePixels: 2147483647,
            },
        };
        expect(spacingNodeSchema.parse(value)).toEqual(value);
        expect(
            spacingNodeSchema.safeParse({
                ...value,
                positive: {
                    ...value.positive,
                    maximumAdvancePixels: 2147483648,
                },
            }).success,
        ).toBe(false);
    });
    it("keeps actual source dimensions independent of rendered pixel budgets", () => {
        const bitmap = {
            uuid: crypto.randomUUID(),
            id: "large-source",
            texture: "example:large.png",
            sourceWidthPixels: 8192,
            sourceHeightPixels: 2147483647,
            renderWidthPixels: 24,
            renderHeightPixels: 24,
            ascentPixels: 24,
            visualBounds: { left: 0, top: -24, right: 24, bottom: 0 },
        };
        expect(bitmapNodeSchema.parse(bitmap).sourceWidthPixels).toBe(8192);
        expect(
            bitmapNodeSchema.safeParse({
                ...bitmap,
                sourceHeightPixels: 2147483648,
            }).success,
        ).toBe(false);
        expect(
            bitmapNodeSchema.safeParse({ ...bitmap, renderWidthPixels: 8192 })
                .success,
        ).toBe(false);
    });
    it.each([
        "explicit",
        "space-provider",
        "builtin:minecraft-default",
        "manifest:pack/metrics-v1",
        "example:font/metrics-v2",
    ])("accepts YAML metrics selector %s", (metrics) => {
        expect(fontNodeSchema.parse(font(metrics)).metrics).toBe(metrics);
    });
    it.each(["unqualified", "example:bad:value", "example:Bad", ":missing"])(
        "rejects invalid metrics selector %s",
        (metrics) => {
            expect(fontNodeSchema.safeParse(font(metrics)).success).toBe(false);
        },
    );
    it("keeps source advance metadata distinct from signed spacing ranges", () => {
        expect(
            fontNodeSchema.parse({
                ...font("explicit"),
                advances: { minimum: 12, maximum: 40 },
            }).advances,
        ).toEqual({ minimum: 12, maximum: 40 });
        expect(
            fontNodeSchema.parse({
                ...font("explicit"),
                advances: { minimum: -10000, maximum: -9999 },
            }).advances?.minimum,
        ).toBe(-10000);
        expect(
            fontNodeSchema.safeParse({
                ...font("explicit"),
                advances: { minimum: 4, maximum: 4 },
            }).success,
        ).toBe(false);
    });
    it("preserves absent measurement metadata and validates explicit supported policies", () => {
        const source = { boldExtraAdvancePixels: 1 };
        expect(measurementSchema.parse(source)).toEqual(source);
        for (const clientVersion of [
            "server",
            "1.21.11",
            "26.1.1",
            "26.1.2",
            "26.2",
        ])
            expect(
                measurementSchema.parse({
                    ...source,
                    clientVersion,
                    missingGlyph: "error",
                }),
            ).toEqual({ ...source, clientVersion, missingGlyph: "error" });
        expect(
            measurementSchema.safeParse({ ...source, clientVersion: "1.21" })
                .success,
        ).toBe(false);
        expect(
            measurementSchema.safeParse({ ...source, missingGlyph: "guess" })
                .success,
        ).toBe(false);
    });
});
