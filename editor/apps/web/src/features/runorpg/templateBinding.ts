import type {
    ItemTemplate,
    ItemTemplateOverlay,
    RunoRpgCatalogItem,
} from "@itemerness/protocol";
import {
    defaultRunoRpgAppearance,
    templateLocalId,
} from "./templateProjection.js";

/**
 * Writing instances that came from a template.
 *
 * The payloads here are the ordinary catalog create/update contracts — a template contributes
 * values, never a shape. That is what keeps `plugins/Itemerness/items/*.yml` free of any key
 * `CatalogSourceLoader` would reject, and it is why applying a template update needs no server-side
 * notion of inheritance at all.
 */

async function submit(method: "POST" | "PUT", body: unknown): Promise<unknown> {
    const response = await fetch("/api/v1/runorpg/catalog/item", {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });
    const parsed = (await response.json().catch(() => null)) as {
        error?: string;
        detail?: string;
    } | null;
    if (!response.ok) {
        throw new Error(
            parsed?.detail ?? parsed?.error ?? `HTTP ${response.status}`,
        );
    }
    return parsed;
}

/**
 * An update payload for `item` with `overlay` laid over it.
 *
 * Fields the overlay omits keep their current value, which is exactly the contract the caller
 * wants: only the fields a template still owns are pushed, the rest are the author's.
 */
export function instanceUpdateBody(
    item: RunoRpgCatalogItem,
    overlay: Partial<ItemTemplateOverlay> = {},
): Record<string, unknown> {
    const appearance = defaultRunoRpgAppearance(item);
    return {
        id: item.id,
        expectedFileHash: item.fileHash,
        enabled: item.enabled,
        material: overlay.material ?? item.material,
        layout: overlay.layout ?? item.layout ?? appearance.layout,
        theme: overlay.theme ?? item.theme ?? appearance.theme,
        mode: overlay.mode ?? item.mode,
        maxStackSize: overlay.maxStackSize ?? item.maxStackSize,
        unbreakable: overlay.unbreakable ?? item.unbreakable,
        displayName: item.displayName,
        itemLevel: overlay.itemLevel ?? item.itemLevel,
        itemTier: overlay.itemTier ?? item.itemTier,
        itemPrefix: overlay.itemPrefix ?? item.itemPrefix,
        modifiers: overlay.modifiers ?? item.modifiers,
        skills: overlay.skills ?? item.skills,
        presentationBlocks:
            overlay.presentationBlocks ?? item.presentationBlocks,
        presentationMessages: item.presentationMessages,
    };
}

export async function saveInstance(
    item: RunoRpgCatalogItem,
    overlay: Partial<ItemTemplateOverlay> = {},
): Promise<void> {
    await submit("PUT", instanceUpdateBody(item, overlay));
}

export interface InstanceIdentity {
    readonly localId: string;
    readonly displayName: string;
    readonly description: string;
    readonly enabled: boolean;
}

/**
 * Creates one instance seeded from a template.
 *
 * Lore blocks travel only when the template actually defines them; an empty list would otherwise
 * publish an item with no lore at all, where the server default is the pair of repeat blocks every
 * hand-made item starts with.
 */
export async function createInstanceFromTemplate(
    template: ItemTemplate,
    identity: InstanceIdentity,
): Promise<string> {
    const body = await submit("POST", {
        localId: identity.localId,
        displayName: identity.displayName,
        description: identity.description,
        enabled: identity.enabled,
        material: template.material,
        layout: template.layout,
        theme: template.theme,
        mode: template.mode,
        maxStackSize: template.maxStackSize,
        unbreakable: template.unbreakable,
        modifiers: template.baseModifiers,
        skills: template.baseSkills,
        itemTier: template.itemTier,
        itemLevel: template.itemLevel,
        itemPrefix: template.itemPrefix,
        ...(template.presentationBlocks.length > 0
            ? { presentationBlocks: template.presentationBlocks }
            : {}),
    });
    const created = (body as { created?: string } | null)?.created;
    return created ?? `runocraft:${identity.localId}`;
}

/** A default local id for a new instance of `template`, unique against `taken`. */
export function suggestedInstanceLocalId(
    template: ItemTemplate,
    taken: readonly string[],
): string {
    const stem = templateLocalId(template).replace(/^template-/u, "");
    const used = new Set(taken);
    let counter = 1;
    while (used.has(`runocraft:${stem}-${counter}`)) counter += 1;
    return `${stem}-${counter}`;
}
