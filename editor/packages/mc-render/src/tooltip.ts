import type { Sprite } from "@itemerness/mc-assets";
import type { PreviewLine, PreviewRun } from "@itemerness/protocol";
import {
    DEFAULT_LORE_COLOR,
    DEFAULT_TEXT_COLOR,
    LEGACY_TOOLTIP,
    shadowColor,
} from "./colors.js";
import type { AnnotationOp, DrawList, DrawOp, GlyphOp } from "./drawlist.js";
import { spriteOps } from "./drawlist.js";
import type { PresentationFonts } from "./fonts.js";
import {
    measureLine,
    STRIKETHROUGH_BOTTOM_PIXELS,
    STRIKETHROUGH_TOP_PIXELS,
    UNDERLINE_BOTTOM_PIXELS,
    UNDERLINE_TOP_PIXELS,
    type MeasuredLine,
} from "./measure.js";

/**
 * Tooltip geometry and painting.
 *
 * The vertical metrics and background coordinates come from an audit of the 1.21.11 client. Every
 * text component is ten logical pixels tall, an extra two pixels sit between the first and second
 * component, and a single-component tooltip is two pixels shorter. TooltipRenderUtil draws the
 * sprite nine pixels beyond the three-pixel content padding on every edge; keeping those values
 * separate prevents the sprite's transparent border from covering the text in the preview.
 */
export interface TooltipProfile {
    readonly clientVersion: string;
    readonly lineHeightPixels: number;
    /** Extra gap inserted after the display name, before the first lore line. */
    readonly firstLineGapPixels: number;
    /** Visible space between the text content and the tooltip background. */
    readonly paddingPixels: number;
    /** Transparent/nine-slice sprite area outside the visible three-pixel content padding. */
    readonly spriteOutsetPixels: number;
    /** A one-component tooltip measures two pixels shorter than the naive line count. */
    readonly singleComponentHeightAdjustPixels: number;
    /** Distance from a line's top edge down to the text baseline. */
    readonly textAscentPixels: number;
    readonly shadowOffsetPixels: number;
}

export const PROFILE_1_21_11: TooltipProfile = {
    clientVersion: "1.21.11",
    lineHeightPixels: 10,
    firstLineGapPixels: 2,
    paddingPixels: 3,
    spriteOutsetPixels: 9,
    singleComponentHeightAdjustPixels: -2,
    textAscentPixels: 7,
    shadowOffsetPixels: 1,
};

/** Kept as a source-compatible alias while callers move to the 1.21.11 baseline name. */
export const PROFILE_26_1_2 = PROFILE_1_21_11;

/** Top edge of component `index`, in GUI pixels from the content origin. */
export function componentTop(
    index: number,
    profile: TooltipProfile = PROFILE_1_21_11,
): number {
    return index === 0
        ? 0
        : index * profile.lineHeightPixels + profile.firstLineGapPixels;
}

export function contentHeight(
    componentCount: number,
    profile: TooltipProfile = PROFILE_1_21_11,
): number {
    if (componentCount <= 0) return 0;
    const base = componentCount * profile.lineHeightPixels;
    return componentCount === 1
        ? base + profile.singleComponentHeightAdjustPixels
        : base;
}

export interface TooltipGeometry {
    readonly profile: TooltipProfile;
    /** Widest logical component width; what decides the tooltip's width in game. */
    readonly contentWidthPixels: number;
    readonly contentHeightPixels: number;
    readonly totalWidthPixels: number;
    readonly totalHeightPixels: number;
    readonly components: readonly {
        readonly line: MeasuredLine;
        readonly top: number;
        readonly baselineY: number;
    }[];
    /**
     * Union of ink that lands outside the background rectangle. A bitmap canvas theme that
     * overflows here would be clipped or drawn over the frame in game.
     */
    readonly inkOutsideBackground: boolean;
}

export interface RenderOptions {
    readonly profile?: TooltipProfile;
    /** Custom `minecraft:tooltip_style` sprites, when the theme sets one and the pack provides it. */
    readonly backgroundSprite?: Sprite | null;
    readonly frameSprite?: Sprite | null;
    /** Draw the logical width, visual bounds, and anchor overlays. */
    readonly annotations?: boolean;
    readonly defaultNameColor?: number;
    readonly defaultLoreColor?: number;
}

function styleColor(run: PreviewRun, fallback: number): number {
    return run.style.color ?? fallback;
}

/** Measures the display name and every lore line into placed geometry. */
export function layoutTooltip(
    lines: readonly PreviewLine[],
    fonts: PresentationFonts,
    options: RenderOptions = {},
): TooltipGeometry {
    const profile = options.profile ?? PROFILE_1_21_11;
    const measured = lines.map((line) =>
        measureLine(line.runs, fonts, { lenient: true }),
    );
    const contentWidthPixels = measured.reduce(
        (widest, line) => Math.max(widest, line.logicalWidthPixels),
        0,
    );
    const height = contentHeight(measured.length, profile);

    const components = measured.map((line, index) => {
        const top = componentTop(index, profile);
        return { line, top, baselineY: top + profile.textAscentPixels };
    });

    let inkOutsideBackground = false;
    for (const component of components) {
        const bounds = component.line.visualBounds;
        if (
            bounds.left < -profile.paddingPixels ||
            bounds.right > contentWidthPixels + profile.paddingPixels ||
            component.baselineY + bounds.top < -profile.paddingPixels ||
            component.baselineY + bounds.bottom > height + profile.paddingPixels
        ) {
            inkOutsideBackground = true;
        }
    }

    return {
        profile,
        contentWidthPixels,
        contentHeightPixels: height,
        totalWidthPixels:
            contentWidthPixels +
            (profile.paddingPixels + profile.spriteOutsetPixels) * 2,
        totalHeightPixels:
            height + (profile.paddingPixels + profile.spriteOutsetPixels) * 2,
        components,
        inkOutsideBackground,
    };
}

/** Builds the full draw list for a tooltip, background first, then text, then annotations. */
export function renderTooltip(
    lines: readonly PreviewLine[],
    fonts: PresentationFonts,
    options: RenderOptions = {},
): { geometry: TooltipGeometry; drawList: DrawList } {
    const geometry = layoutTooltip(lines, fonts, options);
    const { profile } = geometry;
    const originX = profile.paddingPixels + profile.spriteOutsetPixels;
    const originY = profile.paddingPixels + profile.spriteOutsetPixels;
    const ops: DrawOp[] = [];

    const hasTooltipSprite = Boolean(
        options.backgroundSprite || options.frameSprite,
    );
    const backgroundX = hasTooltipSprite ? 0 : profile.spriteOutsetPixels;
    const backgroundY = hasTooltipSprite ? 0 : profile.spriteOutsetPixels;
    const backgroundWidth = hasTooltipSprite
        ? geometry.totalWidthPixels
        : geometry.contentWidthPixels + profile.paddingPixels * 2;
    const backgroundHeight = hasTooltipSprite
        ? geometry.totalHeightPixels
        : geometry.contentHeightPixels + profile.paddingPixels * 2;

    if (options.backgroundSprite) {
        ops.push(
            ...spriteOps(
                options.backgroundSprite,
                backgroundX,
                backgroundY,
                backgroundWidth,
                backgroundHeight,
            ),
        );
    } else {
        // Pre-sprite gradient. Reported as approximate-raster: a real client would use the
        // tooltip background sprite from whatever pack is loaded.
        ops.push({
            kind: "rect",
            x: backgroundX,
            y: backgroundY,
            width: backgroundWidth,
            height: backgroundHeight,
            color: LEGACY_TOOLTIP.background,
        });
    }
    if (options.frameSprite) {
        ops.push(
            ...spriteOps(
                options.frameSprite,
                backgroundX,
                backgroundY,
                backgroundWidth,
                backgroundHeight,
            ),
        );
    } else if (!options.backgroundSprite) {
        ops.push({
            kind: "gradient",
            x: backgroundX + 1,
            y: backgroundY + 1,
            width: backgroundWidth - 2,
            height: backgroundHeight - 2,
            topColor: LEGACY_TOOLTIP.borderTop,
            bottomColor: LEGACY_TOOLTIP.borderBottom,
        });
    }

    geometry.components.forEach((component, index) => {
        const fallbackColor =
            index === 0
                ? (options.defaultNameColor ?? DEFAULT_TEXT_COLOR)
                : (options.defaultLoreColor ?? DEFAULT_LORE_COLOR);
        const baselineY = originY + component.baselineY;
        // Shadow first, exactly as the client batches it: every glyph on the line is drawn once
        // offset by one pixel in the darkened colour before the main pass.
        for (const pass of [true, false]) {
            for (const placed of component.line.glyphs) {
                if (!placed.glyph.hasInk) continue;
                const color = styleColor(placed.run, fallbackColor);
                const offset = pass ? profile.shadowOffsetPixels : 0;
                const op: GlyphOp = {
                    kind: "glyph",
                    placed,
                    x: originX + placed.x + offset,
                    baselineY: baselineY + offset,
                    color: pass ? shadowColor(color) : color,
                    italic: placed.run.style.italic,
                    bold: placed.run.style.bold,
                    shadow: pass,
                };
                ops.push(op);
            }
            for (const decoration of decorationOps(
                component.line,
                originX,
                baselineY,
                fallbackColor,
                pass,
                profile,
            )) {
                ops.push(decoration);
            }
        }
    });

    if (options.annotations)
        ops.push(...annotationOps(geometry, originX, originY));

    return {
        geometry,
        drawList: {
            width: geometry.totalWidthPixels,
            height: geometry.totalHeightPixels,
            ops,
        },
    };
}

function decorationOps(
    line: MeasuredLine,
    originX: number,
    baselineY: number,
    fallbackColor: number,
    shadow: boolean,
    profile: TooltipProfile,
): DrawOp[] {
    const ops: DrawOp[] = [];
    let cursor = 0;
    for (const run of line.runs) {
        const runGlyphs = line.glyphs.filter((placed) => placed.run === run);
        const runWidth = runGlyphs.reduce(
            (sum, placed) => sum + placed.advance,
            0,
        );
        const start = runGlyphs.length > 0 ? runGlyphs[0]!.x : cursor;
        cursor = start + runWidth;
        if (runWidth <= 0) continue;
        const color = shadow
            ? shadowColor(styleColor(run, fallbackColor))
            : styleColor(run, fallbackColor);
        const offset = shadow ? profile.shadowOffsetPixels : 0;
        if (run.style.strikethrough) {
            ops.push({
                kind: "rect",
                x: originX + start - 1 + offset,
                y:
                    baselineY +
                    STRIKETHROUGH_TOP_PIXELS -
                    profile.textAscentPixels +
                    offset,
                width: runWidth + 1,
                height: STRIKETHROUGH_BOTTOM_PIXELS - STRIKETHROUGH_TOP_PIXELS,
                color: 0xff000000 | color,
            });
        }
        if (run.style.underlined) {
            ops.push({
                kind: "rect",
                x: originX + start - 1 + offset,
                y:
                    baselineY +
                    UNDERLINE_TOP_PIXELS -
                    profile.textAscentPixels +
                    offset,
                width: runWidth + 1,
                height: UNDERLINE_BOTTOM_PIXELS - UNDERLINE_TOP_PIXELS,
                color: 0xff000000 | color,
            });
        }
    }
    return ops;
}

function annotationOps(
    geometry: TooltipGeometry,
    originX: number,
    originY: number,
): AnnotationOp[] {
    const ops: AnnotationOp[] = [
        {
            kind: "annotation",
            role: "safe-area",
            x: originX,
            y: originY,
            width: geometry.contentWidthPixels,
            height: geometry.contentHeightPixels,
            label: `${geometry.contentWidthPixels}x${geometry.contentHeightPixels}`,
        },
    ];
    geometry.components.forEach((component, index) => {
        ops.push({
            kind: "annotation",
            role: "line-box",
            x: originX,
            y: originY + component.top,
            width: component.line.logicalWidthPixels,
            height: geometry.profile.lineHeightPixels,
            label: `#${index} w=${component.line.logicalWidthPixels}`,
        });
        ops.push({
            kind: "annotation",
            role: "baseline",
            x: originX,
            y: originY + component.baselineY,
            width: component.line.logicalWidthPixels,
            height: 0,
            label: null,
        });
        const bounds = component.line.visualBounds;
        ops.push({
            kind: "annotation",
            role: "visual-bounds",
            x: originX + bounds.left,
            y: originY + component.baselineY + bounds.top,
            width: bounds.right - bounds.left,
            height: bounds.bottom - bounds.top,
            label: null,
        });
        for (const placed of component.line.glyphs) {
            if (
                placed.run.kind !== "WIDTH_ANCHOR" &&
                placed.run.kind !== "HEIGHT_ANCHOR"
            )
                continue;
            ops.push({
                kind: "annotation",
                role:
                    placed.run.kind === "WIDTH_ANCHOR"
                        ? "width-anchor"
                        : "height-anchor",
                x: originX + placed.x,
                y: originY + component.top,
                width: placed.advance,
                height: geometry.profile.lineHeightPixels,
                label: `${placed.advance >= 0 ? "+" : ""}${placed.advance}`,
            });
        }
    });
    return ops;
}
