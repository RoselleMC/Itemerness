import { rasterPixel, type GlyphRaster } from "@itemerness/mc-assets";
import { toCssColor } from "./colors.js";
import type { DrawList, DrawOp } from "./drawlist.js";

/**
 * Renders a draw list onto a 2D canvas.
 *
 * Everything is nearest-neighbour at an integer GUI scale, because Minecraft's font atlas is
 * sampled with `NEAREST` and any smoothing here would produce a softer preview than the game.
 * Glyph textures are tinted the way the font shader tints them, by multiplying the texture RGBA
 * with the text colour, so a coloured bitmap icon keeps its own colours while a white glyph takes
 * the theme's.
 */

export interface CanvasLike {
    width: number;
    height: number;
    getContext(contextId: "2d"): CanvasRenderingContext2D | null;
}

export interface RenderToCanvasOptions {
    /** Integer GUI scale, as in the client's video settings. */
    readonly guiScale?: number;
    /** Draw the debug annotation ops. */
    readonly showAnnotations?: boolean;
    readonly devicePixelRatio?: number;
}

const ANNOTATION_COLORS: Record<string, string> = {
    "logical-width": "rgb(80 200 255 / 0.9)",
    "visual-bounds": "rgb(255 190 60 / 0.9)",
    "width-anchor": "rgb(120 255 140 / 0.95)",
    "height-anchor": "rgb(200 140 255 / 0.95)",
    "safe-area": "rgb(255 90 140 / 0.8)",
    baseline: "rgb(255 255 255 / 0.35)",
    "line-box": "rgb(120 160 255 / 0.55)",
};

/** Cache key for one tinted glyph bitmap. */
function rasterKey(raster: GlyphRaster): string {
    if (raster.kind === "unihex")
        return `u:${raster.bitWidth}:${raster.rows.join(",")}:${raster.originX}`;
    return `b:${raster.sourceX},${raster.sourceY},${raster.sourceWidth},${raster.sourceHeight}:${raster.image.width}x${raster.image.height}`;
}

class GlyphBitmapCache {
    private readonly cache = new Map<string, ImageData>();

    get(raster: GlyphRaster, color: number): ImageData {
        const key = `${rasterKey(raster)}|${color.toString(16)}`;
        const cached = this.cache.get(key);
        if (cached) return cached;
        const width = raster.sourceWidth;
        const height = raster.sourceHeight;
        const data = new Uint8ClampedArray(width * height * 4);
        const tintR = (color >> 16) & 0xff;
        const tintG = (color >> 8) & 0xff;
        const tintB = color & 0xff;
        for (let y = 0; y < height; y += 1) {
            for (let x = 0; x < width; x += 1) {
                const [r, g, b, a] = rasterPixel(raster, x, y);
                const base = (y * width + x) * 4;
                data[base] = (r * tintR) / 255;
                data[base + 1] = (g * tintG) / 255;
                data[base + 2] = (b * tintB) / 255;
                data[base + 3] = a;
            }
        }
        const image = new ImageData(data, width, height);
        this.cache.set(key, image);
        return image;
    }
}

const glyphCache = new GlyphBitmapCache();
const spriteCache = new WeakMap<object, ImageData>();

function imageDataFor(image: {
    width: number;
    height: number;
    data: Uint8ClampedArray;
}): ImageData {
    const cached = spriteCache.get(image);
    if (cached) return cached;
    const created = new ImageData(
        new Uint8ClampedArray(image.data),
        image.width,
        image.height,
    );
    spriteCache.set(image, created);
    return created;
}

/** Draws an ImageData through an offscreen canvas so it can be scaled and clipped. */
function bitmapCanvas(source: ImageData): HTMLCanvasElement | OffscreenCanvas {
    const canvas =
        typeof OffscreenCanvas !== "undefined"
            ? new OffscreenCanvas(source.width, source.height)
            : Object.assign(document.createElement("canvas"), {
                  width: source.width,
                  height: source.height,
              });
    const context = canvas.getContext("2d") as CanvasRenderingContext2D | null;
    context?.putImageData(source, 0, 0);
    return canvas as HTMLCanvasElement | OffscreenCanvas;
}

const canvasCache = new WeakMap<
    ImageData,
    HTMLCanvasElement | OffscreenCanvas
>();

function cachedBitmap(source: ImageData): HTMLCanvasElement | OffscreenCanvas {
    const cached = canvasCache.get(source);
    if (cached) return cached;
    const created = bitmapCanvas(source);
    canvasCache.set(source, created);
    return created;
}

export function renderDrawList(
    canvas: CanvasLike,
    drawList: DrawList,
    options: RenderToCanvasOptions = {},
): void {
    const guiScale = Math.max(1, Math.round(options.guiScale ?? 2));
    const pixelRatio = options.devicePixelRatio ?? 1;
    const scale = guiScale * pixelRatio;

    canvas.width = Math.ceil(drawList.width * scale);
    canvas.height = Math.ceil(drawList.height * scale);
    const context = canvas.getContext("2d");
    if (!context)
        throw new Error("A 2D canvas context is required to render a preview");

    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.imageSmoothingEnabled = false;
    context.setTransform(scale, 0, 0, scale, 0, 0);

    for (const op of drawList.ops) {
        if (op.kind === "annotation" && !options.showAnnotations) continue;
        drawOp(context, op);
    }
    context.setTransform(1, 0, 0, 1, 0, 0);
}

function drawOp(context: CanvasRenderingContext2D, op: DrawOp): void {
    switch (op.kind) {
        case "rect": {
            const alpha = ((op.color >>> 24) & 0xff) / 255;
            context.fillStyle = toCssColor(
                op.color & 0xffffff,
                alpha === 0 ? 1 : alpha,
            );
            context.fillRect(op.x, op.y, op.width, op.height);
            return;
        }
        case "gradient": {
            const gradient = context.createLinearGradient(
                op.x,
                op.y,
                op.x,
                op.y + op.height,
            );
            const topAlpha = ((op.topColor >>> 24) & 0xff) / 255;
            const bottomAlpha = ((op.bottomColor >>> 24) & 0xff) / 255;
            gradient.addColorStop(
                0,
                toCssColor(op.topColor & 0xffffff, topAlpha || 1),
            );
            gradient.addColorStop(
                1,
                toCssColor(op.bottomColor & 0xffffff, bottomAlpha || 1),
            );
            context.save();
            context.strokeStyle = gradient;
            context.lineWidth = 1;
            context.strokeRect(
                op.x + 0.5,
                op.y + 0.5,
                op.width - 1,
                op.height - 1,
            );
            context.restore();
            return;
        }
        case "sprite": {
            const bitmap = cachedBitmap(imageDataFor(op.image));
            context.drawImage(
                bitmap as CanvasImageSource,
                op.sourceX,
                op.sourceY,
                op.sourceWidth,
                op.sourceHeight,
                op.x,
                op.y,
                op.width,
                op.height,
            );
            return;
        }
        case "glyph": {
            const raster = op.placed.glyph.raster;
            if (!raster) {
                // Metrics without pixels. Drawing nothing would make an unmounted preview look
                // like an empty tooltip; drawing a substitute glyph would be a lie. A translucent
                // block over the glyph's exact ink bounds shows the geometry that *is* faithful
                // and reads as unmistakably not-text, which is what the fidelity badge says.
                if (op.shadow) return;
                const bounds = op.placed.glyph.bounds;
                context.save();
                context.globalAlpha = 0.45;
                context.fillStyle = toCssColor(op.color);
                context.fillRect(
                    op.x + bounds.left,
                    op.baselineY + bounds.top,
                    Math.max(0.5, bounds.right - bounds.left),
                    Math.max(0.5, bounds.bottom - bounds.top),
                );
                context.restore();
                return;
            }
            const bitmap = cachedBitmap(glyphCache.get(raster, op.color));
            const width = raster.sourceWidth * raster.scale;
            const height = raster.sourceHeight * raster.scale;
            const left = op.x - raster.originX * raster.scale;
            const top = op.baselineY - raster.ascent;
            const passes = op.bold
                ? [0, op.placed.glyph.boldExtraAdvancePixels]
                : [0];
            for (const offset of passes) {
                context.save();
                if (op.italic) {
                    // The client shears glyphs about the baseline; reproduce it as a transform so
                    // the ink lands where measure.ts already predicted it would.
                    context.translate(left + offset, op.baselineY);
                    context.transform(1, 0, -0.25, 1, 0, 0);
                    context.drawImage(
                        bitmap as CanvasImageSource,
                        0,
                        top - op.baselineY,
                        width,
                        height,
                    );
                } else {
                    context.translate(left + offset, top);
                    context.drawImage(
                        bitmap as CanvasImageSource,
                        0,
                        0,
                        width,
                        height,
                    );
                }
                context.restore();
            }
            return;
        }
        case "annotation": {
            context.save();
            context.strokeStyle =
                ANNOTATION_COLORS[op.role] ?? "rgb(255 255 255 / 0.6)";
            context.lineWidth = 0.5;
            if (op.height === 0) {
                context.beginPath();
                context.moveTo(op.x, op.y + 0.25);
                context.lineTo(op.x + Math.max(op.width, 1), op.y + 0.25);
                context.stroke();
            } else {
                context.strokeRect(
                    op.x + 0.25,
                    op.y + 0.25,
                    Math.max(op.width, 0.5),
                    Math.max(op.height, 0.5),
                );
            }
            context.restore();
            return;
        }
        default:
            return;
    }
}
