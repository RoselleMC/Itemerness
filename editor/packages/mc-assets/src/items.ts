import type { DecodedImage } from "./image.js";
import { decodeImage } from "./image.js";
import { assetPath, parseLocation, type PackStack } from "./pack.js";

/**
 * Item icon resolution, limited on purpose to flat sprites.
 *
 * An item whose model resolves to `item/generated` or `item/handheld` is a stack of 2D texture
 * layers, and those can be reproduced exactly. Block models are a 3D render with lighting and an
 * isometric transform; approximating one would put a picture next to a tooltip that claims the
 * same fidelity as the tooltip itself. Those return `unsupported` so the UI can show a neutral
 * placeholder and mark the icon `client-only`.
 */

export type ItemIcon =
    | {
          readonly kind: "flat";
          readonly layers: readonly DecodedImage[];
          readonly modelId: string;
      }
    | {
          readonly kind: "unsupported";
          readonly reason: "block-model" | "missing" | "invalid";
          readonly detail: string;
      };

interface ModelDocument {
    parent?: unknown;
    textures?: Record<string, unknown>;
}

const FLAT_PARENTS = new Set([
    "minecraft:item/generated",
    "minecraft:item/handheld",
    "minecraft:item/handheld_rod",
    "minecraft:item/handheld_mace",
    "minecraft:builtin/generated",
    "item/generated",
    "item/handheld",
    "builtin/generated",
]);

const MAX_PARENT_DEPTH = 16;

function readModel(stack: PackStack, modelId: string): ModelDocument | null {
    const location = parseLocation(modelId);
    const path = assetPath(
        { namespace: location.namespace, path: `${location.path}.json` },
        "models/",
    );
    const bytes = stack.read(path);
    if (!bytes) return null;
    try {
        return JSON.parse(new TextDecoder().decode(bytes)) as ModelDocument;
    } catch {
        return null;
    }
}

/** Follows the modern `assets/<ns>/items/<path>.json` selector down to a model id. */
function resolveItemDefinitionModel(
    stack: PackStack,
    itemId: string,
): string | null {
    const location = parseLocation(itemId);
    const path = assetPath(
        { namespace: location.namespace, path: `${location.path}.json` },
        "items/",
    );
    const bytes = stack.read(path);
    if (!bytes) return null;
    try {
        const parsed = JSON.parse(new TextDecoder().decode(bytes)) as {
            model?: unknown;
        };
        let node = parsed.model;
        for (let depth = 0; depth < MAX_PARENT_DEPTH; depth += 1) {
            if (typeof node !== "object" || node === null) return null;
            const record = node as Record<string, unknown>;
            if (typeof record.model === "string") return record.model;
            // Conditional and select models carry nested cases; the first branch is a reasonable
            // still-frame for a preview and is labelled as such by the caller.
            const nested =
                (Array.isArray(record.cases)
                    ? (record.cases[0] as Record<string, unknown> | undefined)
                          ?.model
                    : null) ??
                record.on_true ??
                record.fallback;
            if (nested === undefined || nested === null) return null;
            node = nested;
        }
        return null;
    } catch {
        return null;
    }
}

/** Resolves an item's icon through the mounted pack stack. */
export function resolveItemIcon(
    stack: PackStack,
    materialId: string,
): ItemIcon {
    const location = parseLocation(materialId);
    const startModel =
        resolveItemDefinitionModel(stack, materialId) ??
        `${location.namespace}:item/${location.path}`;

    const textures: Record<string, string> = {};
    let current: string | null = startModel;
    let flat = false;
    let resolvedModel = startModel;

    for (let depth = 0; depth < MAX_PARENT_DEPTH && current; depth += 1) {
        if (FLAT_PARENTS.has(current)) {
            flat = true;
            break;
        }
        const model: ModelDocument | null = readModel(stack, current);
        if (!model) {
            return depth === 0
                ? { kind: "unsupported", reason: "missing", detail: current }
                : { kind: "unsupported", reason: "invalid", detail: current };
        }
        resolvedModel = current;
        for (const [key, value] of Object.entries(model.textures ?? {})) {
            if (typeof value === "string" && !(key in textures))
                textures[key] = value;
        }
        current = typeof model.parent === "string" ? model.parent : null;
    }

    if (!flat) {
        return {
            kind: "unsupported",
            reason: "block-model",
            detail: resolvedModel,
        };
    }

    const layers: DecodedImage[] = [];
    for (let index = 0; index < 8; index += 1) {
        const texture = textures[`layer${index}`];
        if (!texture) break;
        const textureLocation = parseLocation(texture);
        const path = assetPath(
            {
                namespace: textureLocation.namespace,
                path: `${textureLocation.path}.png`,
            },
            "textures/",
        );
        const bytes = stack.read(path);
        if (!bytes)
            return { kind: "unsupported", reason: "missing", detail: path };
        try {
            layers.push(decodeImage(bytes, path));
        } catch (error) {
            return {
                kind: "unsupported",
                reason: "invalid",
                detail: (error as Error).message,
            };
        }
    }

    if (layers.length === 0) {
        return {
            kind: "unsupported",
            reason: "invalid",
            detail: `${resolvedModel} has no layer0 texture`,
        };
    }
    return { kind: "flat", layers, modelId: resolvedModel };
}
