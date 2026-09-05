import { z } from "zod";
import { namespacedIdSchema } from "./common.js";
import { presentationBlockSchema } from "./document.js";

export const runoRpgModifierOperationSchema = z.enum([
    "runorpg:flat",
    "runorpg:relative",
]);

export const runoRpgModifierValueModeSchema = z.enum([
    "runorpg:bonus",
    "runorpg:final",
]);

export const runoRpgModifierSourceTypeSchema = z.enum([
    "runorpg:item",
    "runorpg:item-affix",
    "runorpg:socket",
    "runorpg:set",
    "runorpg:profession",
    "runorpg:class",
    "runorpg:core-attribute",
    "runorpg:temporary",
]);

export const runoRpgAttributeModifierSchema = z.object({
    attribute: namespacedIdSchema,
    operation: runoRpgModifierOperationSchema,
    value: z.number().finite(),
    valueMode: runoRpgModifierValueModeSchema.default("runorpg:bonus"),
    sourceType: runoRpgModifierSourceTypeSchema.default("runorpg:item"),
    sourceId: z.string().min(1).max(256).nullable().default(null),
    priority: z.number().int().min(-1_000_000).max(1_000_000).default(100),
});
export type RunoRpgAttributeModifier = z.infer<
    typeof runoRpgAttributeModifierSchema
>;

export const runoRpgItemSkillTriggerSchema = z.enum([
    "runorpg:left-click",
    "runorpg:right-click",
    "runorpg:shift-left-click",
    "runorpg:shift-right-click",
    "runorpg:swap-items",
    "runorpg:sneak",
    "runorpg:timer",
    "runorpg:consume",
    "runorpg:right-charge-release",
    "runorpg:shield-block",
    "runorpg:critical-strike",
    "runorpg:crossbow-shoot",
]);

export const runoRpgItemSkillSchema = z.object({
    id: namespacedIdSchema,
    mythicSkill: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/),
    trigger: runoRpgItemSkillTriggerSchema,
    cooldownGroup: namespacedIdSchema,
    cooldownSeconds: z.number().finite().min(0).max(86_400),
    manaCost: z.number().finite().min(0),
    staminaCost: z.number().finite().min(0),
    power: z.number().finite().min(0).max(10_000),
    cancelVanilla: z.boolean(),
    hidden: z.boolean(),
    lore: z.string().max(512),
});
export type RunoRpgItemSkill = z.infer<typeof runoRpgItemSkillSchema>;

export const runoRpgAttributeDefinitionSchema = z.object({
    id: namespacedIdSchema,
    name: z.string().min(1).max(128),
    defaultValue: z.number().finite().default(0),
    percent: z.boolean().default(false),
    order: z.number().int().min(-1_000_000).max(1_000_000).default(0),
});
export type RunoRpgAttributeDefinition = z.infer<
    typeof runoRpgAttributeDefinitionSchema
>;

export const runoRpgCatalogItemSchema = z.object({
    id: namespacedIdSchema,
    localId: z.string().min(1).max(256),
    sourceFile: z.string().min(1).max(256),
    fileHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    displayName: z.string().min(1).max(512),
    description: z.string().max(2048),
    enabled: z.boolean(),
    material: namespacedIdSchema,
    layout: namespacedIdSchema.nullable(),
    theme: namespacedIdSchema.nullable(),
    mode: z.enum(["unique", "fungible"]),
    maxStackSize: z.number().int().min(1).max(99),
    unbreakable: z.boolean(),
    vanillaAttributesDisabled: z.boolean(),
    schemas: z.array(z.string().min(1).max(256)).max(64),
    legacyReference: z.string().min(1).max(512).nullable(),
    requiredLevel: z.number().int().min(0).max(1_000_000).nullable(),
    itemLevel: z.number().int().min(0).max(1_000_000),
    itemTier: z.string().max(128),
    itemPrefix: z.string().max(128),
    modifiers: z.array(runoRpgAttributeModifierSchema).max(128),
    skills: z.array(runoRpgItemSkillSchema).max(32),
    presentationBlocks: z.array(presentationBlockSchema).max(128),
    presentationMessages: z.record(z.string().max(2048)),
});
export type RunoRpgCatalogItem = z.infer<typeof runoRpgCatalogItemSchema>;

export const runoRpgCatalogSchema = z.object({
    available: z.boolean(),
    writable: z.boolean(),
    items: z.array(runoRpgCatalogItemSchema).max(4096),
    attributes: z.array(runoRpgAttributeDefinitionSchema).max(4096),
    diagnostics: z.array(z.string().max(2048)).max(256),
});
export type RunoRpgCatalog = z.infer<typeof runoRpgCatalogSchema>;

export const runoRpgCatalogItemUpdateSchema = z.object({
    id: namespacedIdSchema,
    expectedFileHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    enabled: z.boolean(),
    material: namespacedIdSchema,
    layout: namespacedIdSchema,
    theme: namespacedIdSchema,
    mode: z.enum(["unique", "fungible"]),
    maxStackSize: z.number().int().min(1).max(99),
    unbreakable: z.boolean(),
    displayName: z.string().trim().min(1).max(512).optional(),
    itemLevel: z.number().int().min(0).max(1_000_000).optional(),
    itemTier: z.string().max(128).optional(),
    itemPrefix: z.string().max(128).optional(),
    modifiers: z.array(runoRpgAttributeModifierSchema).max(128),
    skills: z.array(runoRpgItemSkillSchema).max(32),
    presentationBlocks: z.array(presentationBlockSchema).max(128).optional(),
    presentationMessages: z.record(z.string().max(2048)).optional(),
});
export type RunoRpgCatalogItemUpdate = z.infer<
    typeof runoRpgCatalogItemUpdateSchema
>;

export const runoRpgCatalogItemCreateSchema = z.object({
    localId: z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,63}$/),
    displayName: z.string().trim().min(1).max(128),
    description: z.string().trim().max(2048).default(""),
    enabled: z.boolean().default(false),
    material: namespacedIdSchema,
    layout: namespacedIdSchema.default("itemerness:equipment"),
    theme: namespacedIdSchema.default("itemerness:ember"),
    mode: z.enum(["unique", "fungible"]),
    maxStackSize: z.number().int().min(1).max(99),
    unbreakable: z.boolean(),
    modifiers: z.array(runoRpgAttributeModifierSchema).max(128).default([]),
    skills: z.array(runoRpgItemSkillSchema).max(32).default([]),
    // Supplied when the item is created from a template. Omitting them keeps the plain
    // "new empty item" path byte-identical to what it wrote before templates existed.
    itemTier: z.string().max(128).optional(),
    itemLevel: z.number().int().min(0).max(1_000_000).optional(),
    itemPrefix: z.string().max(128).optional(),
    presentationBlocks: z.array(presentationBlockSchema).max(128).optional(),
});
export type RunoRpgCatalogItemCreate = z.infer<
    typeof runoRpgCatalogItemCreateSchema
>;

export const serverResourcePackStatusSchema = z.object({
    available: z.boolean(),
    name: z.string().min(1).max(256).nullable(),
    sha1: z
        .string()
        .regex(/^[a-f0-9]{40}$/)
        .nullable(),
    byteLength: z.number().int().min(0).nullable(),
    modifiedAt: z.string().datetime().nullable(),
});
export type ServerResourcePackStatus = z.infer<
    typeof serverResourcePackStatusSchema
>;
