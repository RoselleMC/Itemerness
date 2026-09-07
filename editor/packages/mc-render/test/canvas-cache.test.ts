import { afterEach, expect, it, vi } from "vitest";
import type { DrawList, GlyphOp } from "../src/drawlist.js";
import { renderDrawList } from "../src/canvas.js";

afterEach(() => vi.unstubAllGlobals());

it("does not reuse tinted glyph pixels from a different same-sized texture", () => {
    vi.stubGlobal(
        "ImageData",
        class {
            constructor(
                public data: Uint8ClampedArray,
                public width: number,
                public height: number,
            ) {}
        },
    );
    vi.stubGlobal(
        "OffscreenCanvas",
        class {
            pixels: ImageData | null = null;
            getContext() {
                return {
                    putImageData: (image: ImageData) => {
                        this.pixels = image;
                    },
                };
            }
        },
    );
    const painted: number[][] = [];
    const context = {
        setTransform: vi.fn(),
        clearRect: vi.fn(),
        save: vi.fn(),
        restore: vi.fn(),
        translate: vi.fn(),
        drawImage: (source: { pixels: ImageData }) =>
            painted.push([...source.pixels.data]),
    } as unknown as CanvasRenderingContext2D;
    const canvas = { width: 1, height: 1, getContext: () => context };
    const draw = (rgba: number[]) => {
        const raster = {
            kind: "bitmap" as const,
            image: { width: 1, height: 1, data: new Uint8ClampedArray(rgba) },
            sourceX: 0,
            sourceY: 0,
            sourceWidth: 1,
            sourceHeight: 1,
            originX: 0,
            scale: 1,
            ascent: 0,
        };
        const op: GlyphOp = {
            kind: "glyph",
            x: 0,
            baselineY: 0,
            color: 0xffffff,
            italic: false,
            bold: false,
            shadow: false,
            placed: {
                x: 0,
                advance: 1,
                glyph: {
                    codePoint: 65,
                    advancePixels: 1,
                    boldExtraAdvancePixels: 1,
                    hasInk: true,
                    bounds: { left: 0, right: 1, top: 0, bottom: 1 },
                    raster,
                    providerKind: "bitmap",
                    sourceFontId: "test:font",
                    rasterMissing: false,
                },
                run: {
                    text: "A",
                    kind: "TEXT",
                    unbreakable: false,
                    style: {
                        color: 0xffffff,
                        font: "test:font",
                        bold: false,
                        italic: false,
                        underlined: false,
                        strikethrough: false,
                    },
                },
            },
        };
        const list: DrawList = { width: 1, height: 1, ops: [op] };
        renderDrawList(canvas, list);
        renderDrawList(canvas, list);
    };
    draw([255, 0, 0, 255]);
    draw([0, 0, 255, 255]);
    expect(painted).toEqual([
        [255, 0, 0, 255],
        [255, 0, 0, 255],
        [0, 0, 255, 255],
        [0, 0, 255, 255],
    ]);
});
