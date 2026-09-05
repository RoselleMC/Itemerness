import { describe, expect, it } from "vitest";
import { baselineDocument } from "../fixtures/baseline.js";
import { projectDocumentSchema } from "../src/document.js";
import {
    ITEM_TEMPLATE_EXTENSION_KEY,
    itemTemplateOverlay,
    itemTemplateRegistryOf,
    itemTemplateSchema,
    overriddenItemTemplateFields,
    pendingItemTemplateFields,
    withItemTemplateRegistry,
    type ItemTemplate,
    type ItemTemplateBinding,
} from "../src/item-template.js";
import type { RunoRpgCatalogItem } from "../src/runorpg.js";

/**
 * Templates live in the document's extension channel because the JVM codec rejects unknown root
 * keys. These tests pin both halves of that decision: the registry survives a document round trip,
 * and a document without one still parses and hashes exactly as it did before templates existed.
 */

const template: ItemTemplate = itemTemplateSchema.parse({
    uuid: "11111111-1111-4111-8111-111111111111",
    id: "runocraft:template-sword",
    displayName: "剑",
    category: "sword",
    material: "minecraft:iron_sword",
    itemTier: "uncommon",
    baseModifiers: [
        {
            attribute: "runocraft:attack_damage",
            operation: "runorpg:flat",
            value: 12,
        },
    ],
    presentationBlocks: [
        {
            uuid: "22222222-2222-4222-8222-222222222222",
            type: "description",
            message: "runorpg.item.sword.description",
        },
    ],
});

function instance(patch: Partial<RunoRpgCatalogItem> = {}): RunoRpgCatalogItem {
    return {
        id: "runocraft:iron-sword",
        localId: "iron-sword",
        sourceFile: "items/runocraft-editor-iron-sword.yml",
        fileHash: `sha256:${"a".repeat(64)}`,
        displayName: "铁剑",
        description: "",
        enabled: true,
        material: template.material,
        layout: template.layout,
        theme: template.theme,
        mode: template.mode,
        maxStackSize: template.maxStackSize,
        unbreakable: template.unbreakable,
        vanillaAttributesDisabled: true,
        schemas: [],
        legacyReference: null,
        requiredLevel: null,
        itemLevel: template.itemLevel,
        itemTier: template.itemTier,
        itemPrefix: template.itemPrefix,
        modifiers: structuredClone(template.baseModifiers),
        skills: [],
        presentationBlocks: structuredClone(template.presentationBlocks),
        presentationMessages: {},
        ...patch,
    };
}

describe("item template registry", () => {
    it("round-trips through the document schema", () => {
        const binding: ItemTemplateBinding = {
            instanceId: "runocraft:iron-sword",
            templateId: template.id,
            overriddenFields: ["itemTier"],
            templateRevisionSeen: 3,
        };
        const document = withItemTemplateRegistry(baselineDocument, {
            version: 1,
            templates: [template],
            bindings: [binding],
        });
        const parsed = projectDocumentSchema.parse(
            JSON.parse(JSON.stringify(document)),
        );
        const registry = itemTemplateRegistryOf(parsed);
        expect(registry.templates).toHaveLength(1);
        expect(registry.templates[0]?.id).toBe(template.id);
        expect(registry.bindings[0]).toEqual(binding);
    });

    it("leaves a document without templates untouched", () => {
        const cleared = withItemTemplateRegistry(baselineDocument, {
            version: 1,
            templates: [],
            bindings: [],
        });
        expect(ITEM_TEMPLATE_EXTENSION_KEY in (cleared.extensions ?? {})).toBe(
            false,
        );
        expect(cleared).toEqual(baselineDocument);
    });

    it("reads an unintelligible payload as empty rather than throwing", () => {
        const document = {
            ...baselineDocument,
            extensions: { [ITEM_TEMPLATE_EXTENSION_KEY]: { version: 99 } },
        };
        expect(itemTemplateRegistryOf(document).templates).toEqual([]);
    });
});

describe("item template fields", () => {
    it("reports nothing overridden for an untouched instance", () => {
        expect(overriddenItemTemplateFields(template, instance())).toEqual([]);
    });

    it("ignores block identity, which each side synthesises separately", () => {
        const renumbered = instance({
            presentationBlocks: [
                {
                    ...template.presentationBlocks[0]!,
                    uuid: "33333333-3333-4333-8333-333333333333",
                },
            ],
        });
        expect(overriddenItemTemplateFields(template, renumbered)).toEqual([]);
    });

    it("reports the fields the author changed", () => {
        expect(
            overriddenItemTemplateFields(
                template,
                instance({ itemTier: "legendary", modifiers: [] }),
            ),
        ).toEqual(["itemTier", "modifiers"]);
    });

    it("leaves overridden fields out of a template update", () => {
        const moved: ItemTemplate = {
            ...template,
            itemTier: "rare",
            itemLevel: 40,
            revision: 1,
        };
        const binding: ItemTemplateBinding = {
            instanceId: "runocraft:iron-sword",
            templateId: template.id,
            overriddenFields: ["itemTier"],
            templateRevisionSeen: 0,
        };
        const pending = pendingItemTemplateFields(moved, binding, instance());
        expect(pending).toEqual(["itemLevel"]);
        expect(itemTemplateOverlay(moved, pending)).toEqual({ itemLevel: 40 });
    });

    it("treats an empty template layout as no opinion, not as empty lore", () => {
        const withoutLore: ItemTemplate = {
            ...template,
            presentationBlocks: [],
        };
        // The create endpoint fills in the server's default blocks, so the instance legitimately
        // has lore the template never described. Reporting that as a difference would offer an
        // "update" that erases it.
        expect(
            overriddenItemTemplateFields(withoutLore, instance()),
        ).not.toContain("presentationBlocks");
        expect(
            pendingItemTemplateFields(
                withoutLore,
                {
                    instanceId: "runocraft:iron-sword",
                    templateId: template.id,
                    overriddenFields: [],
                    templateRevisionSeen: 0,
                },
                instance(),
            ),
        ).toEqual([]);
        expect(itemTemplateOverlay(withoutLore)).not.toHaveProperty(
            "presentationBlocks",
        );
    });

    it("maps base values onto the instance field names", () => {
        expect(itemTemplateOverlay(template, ["modifiers", "skills"])).toEqual({
            modifiers: template.baseModifiers,
            skills: template.baseSkills,
        });
    });
});
