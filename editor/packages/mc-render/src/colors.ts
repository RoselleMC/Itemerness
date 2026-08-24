/**
 * Minecraft text colours.
 *
 * The sixteen legacy names are not arbitrary hex: the client uses these exact values, and a theme
 * that says `gray` must not be previewed with the browser's idea of grey. Shadow colour is derived
 * the way the client derives it, by masking off the low two bits of each channel and shifting, so
 * shadows under custom RGB colours land on the same values the game would pick.
 */

export const NAMED_COLORS: ReadonlyMap<string, number> = new Map([
    ["black", 0x000000],
    ["dark_blue", 0x0000aa],
    ["dark_green", 0x00aa00],
    ["dark_aqua", 0x00aaaa],
    ["dark_red", 0xaa0000],
    ["dark_purple", 0xaa00aa],
    ["gold", 0xffaa00],
    ["gray", 0xaaaaaa],
    ["dark_gray", 0x555555],
    ["blue", 0x5555ff],
    ["green", 0x55ff55],
    ["aqua", 0x55ffff],
    ["red", 0xff5555],
    ["light_purple", 0xff55ff],
    ["yellow", 0xffff55],
    ["white", 0xffffff],
]);

/** Default tooltip text colour when a theme leaves a role unset. */
export const DEFAULT_TEXT_COLOR = 0xffffff;
/** Vanilla's lore colour, used when a preview has no theme opinion. */
export const DEFAULT_LORE_COLOR = 0xaaaaaa;

/** Parses `white`, `#rrggbb`, or `#rgb`. Returns null for anything else. */
export function parseColor(value: string | null | undefined): number | null {
    if (!value) return null;
    const named = NAMED_COLORS.get(value);
    if (named !== undefined) return named;
    const hex = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(value.trim());
    if (!hex) return null;
    const digits = hex[1]!;
    if (digits.length === 3) {
        const r = Number.parseInt(digits[0]!.repeat(2), 16);
        const g = Number.parseInt(digits[1]!.repeat(2), 16);
        const b = Number.parseInt(digits[2]!.repeat(2), 16);
        return (r << 16) | (g << 8) | b;
    }
    return Number.parseInt(digits, 16);
}

/** The colour the client draws a text shadow with. */
export function shadowColor(color: number): number {
    return (color & 0xfcfcfc) >> 2;
}

export function toCssColor(color: number, alpha = 1): string {
    const r = (color >> 16) & 0xff;
    const g = (color >> 8) & 0xff;
    const b = color & 0xff;
    return alpha >= 1
        ? `rgb(${r} ${g} ${b})`
        : `rgb(${r} ${g} ${b} / ${alpha})`;
}

/**
 * Vanilla tooltip background and border colours, used only when no sprite is available.
 *
 * Modern clients draw tooltips from `minecraft:tooltip/background` and `tooltip/frame` sprites.
 * These constants reproduce the pre-sprite gradient so an unmounted preview still looks like a
 * tooltip; anything drawn from them is reported as `approximate-raster`, never as the real frame.
 */
export const LEGACY_TOOLTIP = {
    background: 0xf0100010,
    borderTop: 0x505000ff,
    borderBottom: 0x5028007f,
} as const;
