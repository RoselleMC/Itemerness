import { decodeImage, type DecodedImage } from "./image.js";
import { assetPath, parseLocation, type PackStack } from "./pack.js";

/**
 * GUI sprites and their `.png.mcmeta` scaling rules.
 *
 * Tooltip frames are the reason this exists. Since 24w36a a resource pack can point
 * `minecraft:tooltip_style` at `<ns>:tooltip/<path>_background` and `_frame`, and the client
 * nine-slices those sprites around whatever rectangle the text happens to occupy. Reproducing that
 * in the browser is what lets an editor see their own frame instead of a vanilla stand-in.
 */

export type GuiScalingMode = "stretch" | "tile" | "nine_slice";

export interface SpriteBorder {
    readonly left: number;
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
}

export interface GuiScaling {
    readonly type: GuiScalingMode;
    /** Tile and nine-slice reference size; defaults to the texture size. */
    readonly width: number | null;
    readonly height: number | null;
    readonly border: SpriteBorder | null;
    readonly stretchInner: boolean;
}

export const STRETCH_SCALING: GuiScaling = {
    type: "stretch",
    width: null,
    height: null,
    border: null,
    stretchInner: false,
};

export interface Sprite {
    readonly location: string;
    readonly image: DecodedImage;
    readonly scaling: GuiScaling;
}

function readBorder(raw: unknown): SpriteBorder | null {
    if (typeof raw === "number" && Number.isFinite(raw)) {
        return { left: raw, top: raw, right: raw, bottom: raw };
    }
    if (typeof raw === "object" && raw !== null) {
        const record = raw as Record<string, unknown>;
        const pick = (key: string) =>
            typeof record[key] === "number" ? (record[key] as number) : 0;
        return {
            left: pick("left"),
            top: pick("top"),
            right: pick("right"),
            bottom: pick("bottom"),
        };
    }
    return null;
}

function readScaling(raw: unknown): GuiScaling {
    if (typeof raw !== "object" || raw === null) return STRETCH_SCALING;
    const gui = (raw as Record<string, unknown>).gui;
    if (typeof gui !== "object" || gui === null) return STRETCH_SCALING;
    const scaling = (gui as Record<string, unknown>).scaling;
    if (typeof scaling !== "object" || scaling === null) return STRETCH_SCALING;
    const record = scaling as Record<string, unknown>;
    const type = record.type;
    const mode: GuiScalingMode =
        type === "tile" || type === "nine_slice" ? type : "stretch";
    return {
        type: mode,
        width: typeof record.width === "number" ? record.width : null,
        height: typeof record.height === "number" ? record.height : null,
        border: readBorder(record.border),
        stretchInner: record.stretch_inner === true,
    };
}

/**
 * Loads `assets/<ns>/textures/gui/sprites/<path>.png` and its optional `.mcmeta` sidecar.
 * Returns null when the pack stack does not provide the sprite, which is a normal state the
 * caller must render a fallback for rather than an error.
 */
export function loadSprite(
    stack: PackStack,
    spriteLocation: string,
): Sprite | null {
    const location = parseLocation(spriteLocation);
    const texturePath = assetPath(
        {
            namespace: location.namespace,
            path: `gui/sprites/${location.path}.png`,
        },
        "textures/",
    );
    const bytes = stack.read(texturePath);
    if (!bytes) return null;

    let metaRaw: unknown = null;
    const metaBytes = stack.read(`${texturePath}.mcmeta`);
    if (metaBytes) {
        try {
            metaRaw = JSON.parse(new TextDecoder().decode(metaBytes));
        } catch {
            metaRaw = null;
        }
    }
    return {
        location: spriteLocation,
        image: decodeImage(bytes, texturePath),
        scaling: readScaling(metaRaw),
    };
}

/** The two sprites `minecraft:tooltip_style` resolves to for a given style id. */
export function tooltipStyleSprites(styleId: string): {
    background: string;
    frame: string;
} {
    const location = parseLocation(styleId);
    return {
        background: `${location.namespace}:tooltip/${location.path}_background`,
        frame: `${location.namespace}:tooltip/${location.path}_frame`,
    };
}

/** Vanilla's own tooltip sprites, used when an item declares no custom style. */
export const VANILLA_TOOLTIP_SPRITES = {
    background: "minecraft:tooltip/background",
    frame: "minecraft:tooltip/frame",
} as const;
