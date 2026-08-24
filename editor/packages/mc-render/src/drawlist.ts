import type { DecodedImage, Sprite } from "@itemerness/mc-assets";
import type { PlacedGlyph } from "./measure.js";

/**
 * The painter emits a draw list rather than touching a canvas directly.
 *
 * Every op carries GUI-pixel geometry, so the list can be asserted in a test with no DOM, rendered
 * to a canvas in the browser, or overlaid with debug annotations. Keeping geometry and painting
 * apart is what makes "does the width anchor land where the theme says" a unit test instead of a
 * screenshot review.
 */

export interface RectOp {
    readonly kind: "rect";
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    /** Packed ARGB. Alpha matters for tooltip backgrounds. */
    readonly color: number;
}

export interface GradientRectOp {
    readonly kind: "gradient";
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    readonly topColor: number;
    readonly bottomColor: number;
}

export interface SpriteOp {
    readonly kind: "sprite";
    readonly image: DecodedImage;
    readonly sourceX: number;
    readonly sourceY: number;
    readonly sourceWidth: number;
    readonly sourceHeight: number;
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
}

export interface GlyphOp {
    readonly kind: "glyph";
    readonly placed: PlacedGlyph;
    /** Pen position in GUI pixels. */
    readonly x: number;
    /** Baseline in GUI pixels. */
    readonly baselineY: number;
    readonly color: number;
    readonly italic: boolean;
    readonly bold: boolean;
    readonly shadow: boolean;
}

/** A debug annotation. Never part of what the client would draw. */
export interface AnnotationOp {
    readonly kind: "annotation";
    readonly role:
        | "logical-width"
        | "visual-bounds"
        | "width-anchor"
        | "height-anchor"
        | "safe-area"
        | "baseline"
        | "line-box";
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    readonly label: string | null;
}

export type DrawOp =
    RectOp | GradientRectOp | SpriteOp | GlyphOp | AnnotationOp;

export interface DrawList {
    /** Full extent including tooltip padding, in GUI pixels. */
    readonly width: number;
    readonly height: number;
    readonly ops: readonly DrawOp[];
}

const MAX_TILES = 4096;

/**
 * Expands a GUI sprite over a destination rectangle following its `.png.mcmeta` scaling rule.
 *
 * `nine_slice` is what makes a resource-pack tooltip frame follow the text: corners stay at their
 * natural size while edges and centre repeat, or stretch when `stretch_inner` is set. Getting this
 * right is the difference between previewing a frame and previewing a smeared texture.
 */
export function spriteOps(
    sprite: Sprite,
    x: number,
    y: number,
    width: number,
    height: number,
): SpriteOp[] {
    const image = sprite.image;
    const scaling = sprite.scaling;
    const referenceWidth = scaling.width ?? image.width;
    const referenceHeight = scaling.height ?? image.height;

    if (scaling.type === "stretch" || !scaling.border) {
        if (scaling.type !== "tile") {
            return [
                {
                    kind: "sprite",
                    image,
                    sourceX: 0,
                    sourceY: 0,
                    sourceWidth: image.width,
                    sourceHeight: image.height,
                    x,
                    y,
                    width,
                    height,
                },
            ];
        }
        return tile(
            image,
            0,
            0,
            image.width,
            image.height,
            x,
            y,
            width,
            height,
            referenceWidth,
            referenceHeight,
        );
    }

    const border = scaling.border;
    const left = Math.min(border.left, Math.floor(width / 2), image.width);
    const right = Math.min(
        border.right,
        Math.ceil(width / 2),
        image.width - left,
    );
    const top = Math.min(border.top, Math.floor(height / 2), image.height);
    const bottom = Math.min(
        border.bottom,
        Math.ceil(height / 2),
        image.height - top,
    );

    const innerSourceWidth = Math.max(0, image.width - left - right);
    const innerSourceHeight = Math.max(0, image.height - top - bottom);
    const innerWidth = Math.max(0, width - left - right);
    const innerHeight = Math.max(0, height - top - bottom);

    const ops: SpriteOp[] = [];
    const push = (
        sx: number,
        sy: number,
        sw: number,
        sh: number,
        dx: number,
        dy: number,
        dw: number,
        dh: number,
    ) => {
        if (sw <= 0 || sh <= 0 || dw <= 0 || dh <= 0) return;
        if (scaling.stretchInner || sw === dw) {
            ops.push({
                kind: "sprite",
                image,
                sourceX: sx,
                sourceY: sy,
                sourceWidth: sw,
                sourceHeight: sh,
                x: dx,
                y: dy,
                width: dw,
                height: dh,
            });
            return;
        }
        ops.push(...tile(image, sx, sy, sw, sh, dx, dy, dw, dh, sw, sh));
    };

    // Corners keep their natural size.
    push(0, 0, left, top, x, y, left, top);
    push(image.width - right, 0, right, top, x + width - right, y, right, top);
    push(
        0,
        image.height - bottom,
        left,
        bottom,
        x,
        y + height - bottom,
        left,
        bottom,
    );
    push(
        image.width - right,
        image.height - bottom,
        right,
        bottom,
        x + width - right,
        y + height - bottom,
        right,
        bottom,
    );
    // Edges repeat or stretch along one axis.
    push(left, 0, innerSourceWidth, top, x + left, y, innerWidth, top);
    push(
        left,
        image.height - bottom,
        innerSourceWidth,
        bottom,
        x + left,
        y + height - bottom,
        innerWidth,
        bottom,
    );
    push(0, top, left, innerSourceHeight, x, y + top, left, innerHeight);
    push(
        image.width - right,
        top,
        right,
        innerSourceHeight,
        x + width - right,
        y + top,
        right,
        innerHeight,
    );
    // Centre.
    push(
        left,
        top,
        innerSourceWidth,
        innerSourceHeight,
        x + left,
        y + top,
        innerWidth,
        innerHeight,
    );
    return ops;
}

function tile(
    image: DecodedImage,
    sourceX: number,
    sourceY: number,
    sourceWidth: number,
    sourceHeight: number,
    x: number,
    y: number,
    width: number,
    height: number,
    tileWidth: number,
    tileHeight: number,
): SpriteOp[] {
    const ops: SpriteOp[] = [];
    const stepX = Math.max(1, tileWidth);
    const stepY = Math.max(1, tileHeight);
    for (let offsetY = 0; offsetY < height; offsetY += stepY) {
        for (let offsetX = 0; offsetX < width; offsetX += stepX) {
            if (ops.length >= MAX_TILES) return ops;
            const drawWidth = Math.min(stepX, width - offsetX);
            const drawHeight = Math.min(stepY, height - offsetY);
            ops.push({
                kind: "sprite",
                image,
                sourceX,
                sourceY,
                sourceWidth: Math.max(
                    1,
                    Math.round((drawWidth / stepX) * sourceWidth),
                ),
                sourceHeight: Math.max(
                    1,
                    Math.round((drawHeight / stepY) * sourceHeight),
                ),
                x: x + offsetX,
                y: y + offsetY,
                width: drawWidth,
                height: drawHeight,
            });
        }
    }
    return ops;
}
