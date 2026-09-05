import { describe, expect, it } from "vitest";
import {
    projectDocumentSchema,
    type RunoRpgCatalogItem,
} from "@itemerness/protocol";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import {
    defaultRunoRpgAppearance,
    projectRunoRpgTemplate,
} from "../src/features/runorpg/templateProjection.js";

function item(overrides: Partial<RunoRpgCatalogItem> = {}): RunoRpgCatalogItem {
    return {
        id: "runocraft:test-sword",
        localId: "test-sword",
        sourceFile: "items/weapons.yml",
        fileHash: `sha256:${"a".repeat(64)}`,
        displayName: "测试铁剑",
        description: "用于投影测试。",
        enabled: true,
        material: "minecraft:iron_sword",
        layout: null,
        theme: null,
        mode: "unique",
        maxStackSize: 1,
        unbreakable: true,
        vanillaAttributesDisabled: true,
        schemas: ["runorpg:item-stats@1"],
        legacyReference: "SWORD:TEST_SWORD",
        requiredLevel: 7,
        itemLevel: 7,
        itemTier: "稀有",
        itemPrefix: "",
        modifiers: [
            {
                attribute: "runocraft:attack_damage",
                operation: "runorpg:flat",
                value: 12,
                valueMode: "runorpg:final",
                sourceType: "runorpg:item",
                sourceId: null,
                priority: 100,
            },
        ],
        skills: [
            {
                id: "runocraft:test-cast",
                mythicSkill: "RUNO_TEST_CAST",
                trigger: "runorpg:right-click",
                cooldownGroup: "runocraft:test-cast",
                cooldownSeconds: 2,
                manaCost: 5,
                staminaCost: 0,
                power: 1,
                cancelVanilla: true,
                hidden: false,
                lore: "测试技能 [右键]",
            },
        ],
        presentationBlocks: [],
        presentationMessages: {},
        ...overrides,
    };
}

describe("RunoRPG appearance", () => {
    it("lets the quality tier choose the frame", () => {
        // The pack ships one frame per tier, so an item's border is a statement about its quality
        // rather than an independent styling choice.
        expect(defaultRunoRpgAppearance(item({ itemTier: "rare" })).theme).toBe(
            "itemerness:quality-rare",
        );
        expect(
            defaultRunoRpgAppearance(item({ itemTier: "LEGENDARY" })).theme,
        ).toBe("itemerness:quality-legendary");
    });

    it("falls back on the equipment split when the tier has no art", () => {
        expect(defaultRunoRpgAppearance(item({ itemTier: "稀有" }))).toEqual({
            layout: "itemerness:equipment",
            theme: "itemerness:ember",
        });
        expect(
            defaultRunoRpgAppearance(
                item({
                    itemTier: "",
                    material: "minecraft:flint",
                    legacyReference: "MOB_DROP:WOLF_FANG",
                    sourceFile: "items/materials.yml",
                }),
            ),
        ).toEqual({
            layout: "itemerness:plain",
            theme: "itemerness:vanilla-frame",
        });
    });
});

describe("RunoRPG Itemerness projection", () => {
    it("uses the Ember equipment appearance for weapons", () => {
        expect(defaultRunoRpgAppearance(item())).toEqual({
            layout: "itemerness:equipment",
            theme: "itemerness:ember",
        });
    });

    it("produces a valid document with RunoRPG lore and no vanilla attributes", () => {
        const projected = projectRunoRpgTemplate(baselineDocument, item(), [
            {
                id: "runocraft:attack_damage",
                name: "攻击伤害",
                defaultValue: 1,
                percent: false,
                order: 100,
            },
        ]);

        expect(() => projectDocumentSchema.parse(projected)).not.toThrow();
        expect(projected.items[0]!.presentation).toMatchObject({
            layout: "itemerness:equipment",
            theme: "itemerness:ember",
        });
        expect(projected.items[0]!.presentation.blocks).toHaveLength(3);
        expect(projected.items[0]!.presentation.blocks).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    type: "repeat",
                    data: "runorpg:attribute-lore",
                }),
                expect.objectContaining({
                    type: "repeat",
                    data: "runorpg:item-skills",
                }),
            ]),
        );
        expect(projected.dataSchemas).toHaveLength(1);
        expect(
            projected.dataSchemas[0]!.keys.filter((key) =>
                [
                    "runorpg:item-level",
                    "runorpg:item-tier",
                    "runorpg:item-prefix",
                ].includes(key.id),
            ).map((key) => [key.id, key.defaultValue]),
        ).toEqual([
            ["runorpg:item-level", { kind: "integer", value: "0" }],
            ["runorpg:item-tier", { kind: "string", value: "" }],
            ["runorpg:item-prefix", { kind: "string", value: "" }],
        ]);
        expect(
            projected.dataSchemas.flatMap((schema) =>
                schema.keys.map((key) => key.id),
            ),
        ).not.toContain("example:quality");
        expect(projected.viewerFacts.map((fact) => fact.id)).toContain(
            "runorpg:attribute.attack_damage",
        );
        expect(
            projected.viewerFacts.find(
                (fact) => fact.id === "runorpg:attribute.attack_damage",
            )?.previewValue,
        ).toEqual({ kind: "decimal", value: "12.0" });
        expect(projected.viewerFacts.map((fact) => fact.id)).not.toContain(
            "example:level",
        );
        expect(projected.items[0]!.definition.baseComponents).toContainEqual({
            id: "minecraft:attribute_modifiers",
            value: { kind: "list", values: [] },
        });
    });
});
