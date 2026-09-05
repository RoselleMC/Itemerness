import { z } from "zod";
import { namespacedIdSchema, uuidSchema } from "./common.js";
import {
    presentationBlockSchema,
    type PresentationBlock,
    type ProjectDocument,
} from "./document.js";
import {
    runoRpgAttributeModifierSchema,
    runoRpgItemSkillSchema,
    type RunoRpgCatalogItem,
} from "./runorpg.js";

/**
 * Item type templates and the instances made from them.
 *
 * A template is a prefab: it carries the defaults every item of one kind shares — material,
 * appearance, base attributes, base skills, lore layout. An instance is an ordinary
 * {@link RunoRpgCatalogItem} written to `plugins/Itemerness/items/*.yml`; nothing about the
 * template survives into that file. Inheritance is resolved here, in the editor, at the moment a
 * value is copied, so the server keeps reading the same flat definitions it always has and
 * `/itemerness reload` needs no plugin change.
 *
 * Provenance (which template an instance came from, which of its fields the author has since
 * changed) therefore has nowhere to live in the game YAML — `CatalogSourceLoader` rejects unknown
 * keys and would refuse the whole catalogue. It lives in the authoring document instead, under the
 * document's `extensions` channel rather than as new top-level fields: `ProjectDocumentCodec`
 * rejects unknown root keys too, and an editor-only registry must not cost the agent its ability to
 * compile a preview.
 */

/**
 * Item quality, and the tooltip frame that goes with it.
 *
 * A template does not carry a "kind" field: the template *is* the kind, which is why the item
 * library filters by template rather than by a second, parallel taxonomy nobody maintains.
 *
 * Quality is different — it varies between items of the same kind, and the resource pack ships one
 * frame per tier. Binding the two here is what makes changing an item's tier change its border
 * instead of only its label.
 *
 * The ladder mirrors `plugins/Itemerness/themes/quality-*.yml` on the server, which is the only
 * authority: `unique` uses the original Epic Tooltip legendary art and `corruption` is the purple
 * recolour of it, so neither can be inferred from anything else.
 */
export const ITEM_QUALITY_TIERS = [
    "common",
    "uncommon",
    "rare",
    "unique",
    "legendary",
    "corruption",
] as const;
export type ItemQualityTier = (typeof ITEM_QUALITY_TIERS)[number];

/** The theme drawing `tier`'s frame, or null when the tier is not one the pack has art for. */
export function qualityThemeOf(tier: string): string | null {
    const normalized = tier.trim().toLowerCase();
    return (ITEM_QUALITY_TIERS as readonly string[]).includes(normalized)
        ? `itemerness:quality-${normalized}`
        : null;
}

/** `itemerness:quality-rare` -> `rare`; anything else -> null. */
export function qualityTierOfTheme(
    theme: string | null,
): ItemQualityTier | null {
    const match = /^itemerness:quality-([a-z]+)$/u.exec(theme ?? "");
    const tier = match?.[1];
    return tier && (ITEM_QUALITY_TIERS as readonly string[]).includes(tier)
        ? (tier as ItemQualityTier)
        : null;
}

export const itemTemplateSchema = z.object({
    uuid: uuidSchema,
    /** The kind key, e.g. `runocraft:template-sword`. Stable across renames of `displayName`. */
    id: namespacedIdSchema,
    displayName: z.string().min(1).max(128),
    description: z.string().max(2048).default(""),
    /** Whether the template is offered when creating an instance. */
    enabled: z.boolean().default(true),
    /**
     * Bumped on every edit. An instance whose binding records an older revision is what the panel
     * calls "template updated"; without it a change would either apply to everything at once or to
     * nothing at all.
     */
    revision: z.number().int().min(0).default(0),
    material: namespacedIdSchema,
    layout: namespacedIdSchema.default("itemerness:equipment"),
    theme: namespacedIdSchema.default("itemerness:ember"),
    mode: z.enum(["unique", "fungible"]).default("unique"),
    maxStackSize: z.number().int().min(1).max(99).default(1),
    unbreakable: z.boolean().default(false),
    itemTier: z.string().max(128).default(""),
    itemLevel: z.number().int().min(0).max(1_000_000).default(0),
    itemPrefix: z.string().max(128).default(""),
    baseModifiers: z.array(runoRpgAttributeModifierSchema).max(128).default([]),
    baseSkills: z.array(runoRpgItemSkillSchema).max(32).default([]),
    presentationBlocks: z.array(presentationBlockSchema).max(128).default([]),
    presentationMessages: z.record(z.string().max(2048)).default({}),
});
export type ItemTemplate = z.infer<typeof itemTemplateSchema>;

/**
 * The fields a template owns. Everything else about an instance — its id, display name, and
 * description — is per-item by definition and is never pushed down from the template.
 */
export const ITEM_TEMPLATE_FIELDS = [
    "material",
    "layout",
    "theme",
    "mode",
    "maxStackSize",
    "unbreakable",
    "itemTier",
    "itemLevel",
    "itemPrefix",
    "modifiers",
    "skills",
    "presentationBlocks",
] as const;
export type ItemTemplateField = (typeof ITEM_TEMPLATE_FIELDS)[number];

const itemTemplateFieldSchema = z.enum(ITEM_TEMPLATE_FIELDS);

export const itemTemplateBindingSchema = z.object({
    /** The `RunoRpgCatalogItem.id` this binding describes. */
    instanceId: namespacedIdSchema,
    templateId: namespacedIdSchema,
    /** Fields the author has changed on the instance; a template update leaves these alone. */
    overriddenFields: z.array(itemTemplateFieldSchema).max(32).default([]),
    templateRevisionSeen: z.number().int().min(0).default(0),
});
export type ItemTemplateBinding = z.infer<typeof itemTemplateBindingSchema>;

export const ITEM_TEMPLATE_EXTENSION_KEY = "itemerness:item-templates";

export const itemTemplateRegistrySchema = z.object({
    version: z.literal(1).default(1),
    templates: z.array(itemTemplateSchema).max(256).default([]),
    bindings: z.array(itemTemplateBindingSchema).max(4096).default([]),
});
export type ItemTemplateRegistry = z.infer<typeof itemTemplateRegistrySchema>;

export const EMPTY_ITEM_TEMPLATE_REGISTRY: ItemTemplateRegistry = {
    version: 1,
    templates: [],
    bindings: [],
};

/**
 * Reads the registry out of a document.
 *
 * A malformed payload reads as empty rather than throwing: the extension channel is explicitly the
 * place where a newer or older editor may have written something this build cannot interpret, and
 * losing the template list must never take the whole editor down with it.
 */
export function itemTemplateRegistryOf(
    document: ProjectDocument,
): ItemTemplateRegistry {
    const raw = document.extensions?.[ITEM_TEMPLATE_EXTENSION_KEY];
    if (raw === undefined) return EMPTY_ITEM_TEMPLATE_REGISTRY;
    const parsed = itemTemplateRegistrySchema.safeParse(raw);
    return parsed.success ? parsed.data : EMPTY_ITEM_TEMPLATE_REGISTRY;
}

/** Returns a copy of the document carrying `registry`, dropping the key when it is empty. */
export function withItemTemplateRegistry(
    document: ProjectDocument,
    registry: ItemTemplateRegistry,
): ProjectDocument {
    const rest = { ...(document.extensions ?? {}) };
    delete rest[ITEM_TEMPLATE_EXTENSION_KEY];
    if (registry.templates.length === 0 && registry.bindings.length === 0) {
        if (Object.keys(rest).length > 0)
            return { ...document, extensions: rest };
        const { extensions: _dropped, ...without } = document;
        return without;
    }
    return {
        ...document,
        extensions: { ...rest, [ITEM_TEMPLATE_EXTENSION_KEY]: registry },
    };
}

/** The instance-shaped value a template supplies for one field. */
export function itemTemplateFieldValue(
    template: ItemTemplate,
    field: ItemTemplateField,
): unknown {
    switch (field) {
        case "modifiers":
            return template.baseModifiers;
        case "skills":
            return template.baseSkills;
        default:
            return template[field];
    }
}

/**
 * Compares template and instance values.
 *
 * Presentation block identities are synthesised independently on each side — the control plane
 * seeds them from the YAML position — so a uuid difference says nothing about whether the lore
 * layout was edited and is stripped before comparing.
 */
function comparable(value: unknown): string {
    return JSON.stringify(value, (key, entry) =>
        key === "uuid" ? undefined : (entry as unknown),
    );
}

function instanceFieldValue(
    item: Pick<RunoRpgCatalogItem, ItemTemplateField>,
    field: ItemTemplateField,
): unknown {
    return item[field];
}

/**
 * Whether the template has an opinion about `field`.
 *
 * An empty block list means "whatever the server writes by default", not "no lore at all" — the
 * create endpoint fills in the standard repeat blocks in that case. Comparing against the empty
 * list would mark every instance as permanently out of date and, worse, offer an update that
 * erases the lore the author never asked the template to own.
 */
function templateOwnsField(
    template: ItemTemplate,
    field: ItemTemplateField,
): boolean {
    return (
        field !== "presentationBlocks" || template.presentationBlocks.length > 0
    );
}

/**
 * The fields where an instance already differs from its template.
 *
 * Recomputed whenever the author saves an instance, and stored on the binding. Deriving it again
 * at template-update time would be wrong: by then the template has moved, so every field it
 * changed would look overridden and nothing would ever propagate.
 */
export function overriddenItemTemplateFields(
    template: ItemTemplate,
    item: Pick<RunoRpgCatalogItem, ItemTemplateField>,
): ItemTemplateField[] {
    return ITEM_TEMPLATE_FIELDS.filter(
        (field) =>
            templateOwnsField(template, field) &&
            comparable(instanceFieldValue(item, field)) !==
                comparable(itemTemplateFieldValue(template, field)),
    );
}

/**
 * The fields a template update would change on one instance, ignoring fields the author owns.
 * An empty result is what makes the "template updated" banner stay hidden.
 */
export function pendingItemTemplateFields(
    template: ItemTemplate,
    binding: ItemTemplateBinding,
    item: Pick<RunoRpgCatalogItem, ItemTemplateField>,
): ItemTemplateField[] {
    const owned = new Set(binding.overriddenFields);
    return ITEM_TEMPLATE_FIELDS.filter(
        (field) =>
            !owned.has(field) &&
            templateOwnsField(template, field) &&
            comparable(instanceFieldValue(item, field)) !==
                comparable(itemTemplateFieldValue(template, field)),
    );
}

export interface ItemTemplateOverlay {
    material: string;
    layout: string;
    theme: string;
    mode: "unique" | "fungible";
    maxStackSize: number;
    unbreakable: boolean;
    itemTier: string;
    itemLevel: number;
    itemPrefix: string;
    modifiers: RunoRpgCatalogItem["modifiers"];
    skills: RunoRpgCatalogItem["skills"];
    presentationBlocks: PresentationBlock[];
}

/** Template values for `fields`, ready to be spread over an instance draft. */
export function itemTemplateOverlay(
    template: ItemTemplate,
    fields: readonly ItemTemplateField[] = ITEM_TEMPLATE_FIELDS,
): Partial<ItemTemplateOverlay> {
    const overlay: Record<string, unknown> = {};
    for (const field of fields) {
        if (!templateOwnsField(template, field)) continue;
        overlay[field] = structuredClone(
            itemTemplateFieldValue(template, field),
        );
    }
    return overlay as Partial<ItemTemplateOverlay>;
}
