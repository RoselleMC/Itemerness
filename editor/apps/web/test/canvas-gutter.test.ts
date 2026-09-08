import { describe, expect, it } from "vitest";
import { canvasGutter, fitZoom } from "../src/state/zoom.js";

describe("canvas viewport gutter", () => {
    it("preserves the desktop margin and scales down without removing room for canvas controls", () => {
        expect(canvasGutter({ width: 900, height: 700 })).toBe(48);
        expect(canvasGutter({ width: 264, height: 289 })).toBe(33);
        expect(canvasGutter({ width: 584, height: 118 })).toBe(16);
        expect(canvasGutter({ width: 0, height: 0 })).toBe(16);
    });

    it("fits useful content into short viewports without altering game dimensions", () => {
        const viewport = { width: 584, height: 118 };
        const gameSize = { width: 220, height: 110 };
        const before = structuredClone(gameSize);
        const gutter = canvasGutter(viewport);
        const zoom = fitZoom(viewport, [gameSize], gutter);
        expect(gameSize.height * zoom).toBeGreaterThan(80);
        expect(gameSize.height * zoom + gutter * 2).toBeLessThanOrEqual(
            viewport.height,
        );
        expect(gameSize.width * zoom + gutter * 2).toBeLessThanOrEqual(
            viewport.width,
        );
        expect(gameSize).toEqual(before);
    });
});
