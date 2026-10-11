import { namespacedIdSchema, type ItemNode } from "@itemerness/protocol";

/** Matches the plugin compiler's limit for shown vanilla tooltip components per item. */
export const MAX_SHOWN_FLAGS = 64;

/**
 * Components that projection replaces or removes. The plugin compiler rejects them, so the editor
 * refuses them before they reach a save. No other component vocabulary is assumed here.
 */
export const PROJECTION_OWNED_COMPONENTS: readonly string[] = [
    "minecraft:custom_data",
    "minecraft:custom_name",
    "minecraft:item_name",
    "minecraft:lore",
    "minecraft:tooltip_display",
    "minecraft:tooltip_style",
    "minecraft:item_model",
];

export type ShownFlagIssue = "invalid" | "duplicate" | "owned" | "limit";

/** Accepts `enchantments` as shorthand for `minecraft:enchantments`. */
export function normalizeShownFlag(raw: string): string {
    const trimmed = raw.trim();
    return trimmed.includes(":") ? trimmed : `minecraft:${trimmed}`;
}

export function shownFlagIssue(
    current: readonly string[],
    candidate: string,
): ShownFlagIssue | null {
    if (!namespacedIdSchema.safeParse(candidate).success) return "invalid";
    if (PROJECTION_OWNED_COMPONENTS.includes(candidate)) return "owned";
    if (current.includes(candidate)) return "duplicate";
    if (current.length >= MAX_SHOWN_FLAGS) return "limit";
    return null;
}

/** Writes the list, removing the property when empty so older plugins can still load the item. */
export function withShownFlags(
    presentation: ItemNode["presentation"],
    flags: readonly string[],
): ItemNode["presentation"] {
    const { shownFlags: _previous, ...rest } = presentation;
    return flags.length ? { ...rest, shownFlags: [...flags] } : rest;
}
