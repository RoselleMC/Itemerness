import { createHash } from "node:crypto";
import {
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rm,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
    RunoRpgCatalogError,
    RunoRpgCatalogService,
} from "../src/runorpg-catalog.js";

const sourceTypes = [
    "runorpg:item",
    "runorpg:item-affix",
    "runorpg:socket",
    "runorpg:set",
    "runorpg:profession",
    "runorpg:class",
    "runorpg:core-attribute",
    "runorpg:temporary",
] as const;

function fixture(): string {
    const modifiers = sourceTypes
        .map(
            (sourceType, index) =>
                `          - { attribute: runocraft:stat_${index}, operation: ${index % 2 === 0 ? "runorpg:flat" : "runorpg:relative"}, value: ${index + 0.5}${index === 0 ? ", value-mode: runorpg:final" : ""}, source-type: ${sourceType}, source-id: source-${index}, priority: ${100 + index} }`,
        )
        .join("\n");
    return `schema-version: 1
namespace: runocraft
items:
  test-sword:
    enabled: true
    base:
      material: minecraft:iron_sword
      components:
        minecraft:attribute_modifiers:
          - { type: minecraft:attack_damage, amount: 99 }
    instance:
      schemas: [runorpg:item-skill-contract@1]
      defaults:
        runorpg:attribute-modifiers:
${modifiers}
    definition-data:
      runorpg:item-profile:
        legacy-type: SWORD
        legacy-id: TEST_SWORD
        required-level: 7
    presentation:
      name: { message: item.test-sword.name }
`;
}

describe("RunoRpgCatalogService", () => {
    let root: string;
    let attributesFile: string;
    let sourceFile: string;

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), "itemerness-runorpg-"));
        attributesFile = join(root, "p0_attributes.kts");
        sourceFile = join(root, "items", "catalog.yml");
        await mkdir(join(root, "items"), { recursive: true });
        await mkdir(join(root, "locales"), { recursive: true });
        await writeFile(sourceFile, fixture(), "utf8");
        await writeFile(
            join(root, "locales", "zh_cn.yml"),
            "messages:\n  item.test-sword.name: 测试铁剑\n",
            "utf8",
        );
        await writeFile(
            join(root, "locales", "en_us.yml"),
            "messages:\n  item.test-sword.name: Test Sword\n",
            "utf8",
        );
        await writeFile(
            attributesFile,
            Array.from(
                { length: 40 },
                (_, index) =>
                    `numericAttribute("STAT_${index}", "属性 ${index}", order = ${index})`,
            ).join("\n"),
            "utf8",
        );
    });

    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });

    it("loads every scripted attribute, modifier operation and source type", async () => {
        const service = new RunoRpgCatalogService({
            catalogRoot: root,
            attributesFile,
        });
        const catalog = await service.catalog();

        expect(catalog.available).toBe(true);
        expect(catalog.writable).toBe(true);
        expect(catalog.attributes).toHaveLength(40);
        expect(catalog.items).toHaveLength(1);
        expect(catalog.items[0]).toMatchObject({
            id: "runocraft:test-sword",
            displayName: "测试铁剑",
            description: "",
            layout: null,
            theme: null,
            mode: "unique",
            maxStackSize: 1,
            unbreakable: false,
            legacyReference: "SWORD:TEST_SWORD",
            requiredLevel: 7,
            vanillaAttributesDisabled: false,
            skills: [],
        });
        expect(
            catalog.items[0]!.modifiers.map((entry) => entry.operation),
        ).toEqual(
            sourceTypes.map((_, index) =>
                index % 2 === 0 ? "runorpg:flat" : "runorpg:relative",
            ),
        );
        expect(
            catalog.items[0]!.modifiers.map((entry) => entry.sourceType),
        ).toEqual(sourceTypes);
        expect(catalog.items[0]!.modifiers[0]!.valueMode).toBe("runorpg:final");
    });

    it("backs up and atomically saves authoritative RunoRPG attributes", async () => {
        const service = new RunoRpgCatalogService({
            catalogRoot: root,
            attributesFile,
        });
        const initial = (await service.catalog()).items[0]!;

        await service.update({
            id: initial.id,
            expectedFileHash: initial.fileHash,
            enabled: false,
            material: "minecraft:diamond_sword",
            layout: "itemerness:equipment",
            theme: "itemerness:ember",
            mode: "unique",
            maxStackSize: 1,
            unbreakable: true,
            modifiers: [
                {
                    attribute: "runocraft:stat_39",
                    operation: "runorpg:relative",
                    value: 12.5,
                    valueMode: "runorpg:bonus",
                    sourceType: "runorpg:set",
                    sourceId: "runocraft:test-set",
                    priority: 420,
                },
            ],
            skills: [
                {
                    id: "runocraft:test-cast",
                    mythicSkill: "RUNORPG_TEST_CAST",
                    trigger: "runorpg:right-click",
                    cooldownGroup: "runocraft:test-cast",
                    cooldownSeconds: 1.5,
                    manaCost: 2,
                    staminaCost: 0,
                    power: 1,
                    cancelVanilla: true,
                    hidden: false,
                    lore: "测试施法 [右键]",
                },
            ],
        });

        const saved = parse(await readFile(sourceFile, "utf8")) as unknown;
        expect(saved).toMatchObject({
            items: {
                "test-sword": {
                    enabled: false,
                    base: {
                        material: "minecraft:diamond_sword",
                        components: {
                            "minecraft:attribute_modifiers": [],
                            "minecraft:max_stack_size": 1,
                            "minecraft:unbreakable": true,
                        },
                    },
                    presentation: {
                        layout: "itemerness:equipment",
                        theme: "itemerness:ember",
                    },
                    instance: {
                        mode: "unique",
                        "id-generator": "uuid-v4",
                        schemas: [
                            "runorpg:item-skill-contract@1",
                            "runorpg:item-stats@1",
                        ],
                        defaults: {
                            "runorpg:attribute-modifiers": [
                                {
                                    attribute: "runocraft:stat_39",
                                    operation: "runorpg:relative",
                                    value: 12.5,
                                    "value-mode": "runorpg:bonus",
                                    "source-type": "runorpg:set",
                                    "source-id": "runocraft:test-set",
                                    priority: 420,
                                },
                            ],
                            "runorpg:item-skills": [
                                {
                                    id: "runocraft:test-cast",
                                    "mythic-skill": "RUNORPG_TEST_CAST",
                                    trigger: "runorpg:right-click",
                                    "cooldown-group": "runocraft:test-cast",
                                    "cooldown-seconds": 1.5,
                                    "mana-cost": 2,
                                    "stamina-cost": 0,
                                    power: 1,
                                    "cancel-vanilla": true,
                                    hidden: false,
                                    lore: "测试施法 [右键]",
                                },
                            ],
                        },
                    },
                },
            },
        });

        const backups = await readdir(join(root, "_editor-backups", "items"));
        expect(backups).toHaveLength(1);
        expect(
            await readFile(
                join(root, "_editor-backups", "items", backups[0]!),
                "utf8",
            ),
        ).toBe(fixture());
        expect(
            (await readdir(join(root, "items"))).some((name) =>
                name.endsWith(".tmp"),
            ),
        ).toBe(false);
    });

    it("rejects a stale file hash instead of overwriting external changes", async () => {
        const service = new RunoRpgCatalogService({ catalogRoot: root });
        const initial = (await service.catalog()).items[0]!;
        await writeFile(sourceFile, `${fixture()}# external change\n`, "utf8");

        await expect(
            service.update({
                id: initial.id,
                expectedFileHash: initial.fileHash,
                enabled: true,
                material: initial.material,
                layout: "itemerness:equipment",
                theme: "itemerness:ember",
                mode: initial.mode,
                maxStackSize: initial.maxStackSize,
                unbreakable: initial.unbreakable,
                modifiers: initial.modifiers,
                skills: initial.skills,
            }),
        ).rejects.toMatchObject<Partial<RunoRpgCatalogError>>({
            code: "conflict",
        });
        expect(
            createHash("sha256")
                .update(await readFile(sourceFile))
                .digest("hex"),
        ).not.toBe(initial.fileHash.slice("sha256:".length));
    });

    it("round-trips RunoRPG text and conditions and rejects example data", async () => {
        const service = new RunoRpgCatalogService({
            catalogRoot: root,
            attributesFile,
        });
        const initial = (await service.catalog()).items[0]!;
        const blocks = [
            {
                uuid: "10000000-0000-4000-8000-000000000001",
                type: "repeat" as const,
                data: "runorpg:attribute-lore",
                maximumElements: 128,
                template: {
                    labelMessage: "runorpg.data.attribute.label",
                    valuePath: "lore",
                    missingMessage: "runorpg.data.attribute.missing",
                    icon: null,
                    format: null,
                },
                style: null,
                anchor: null,
                missingPolicy: "OMIT" as const,
            },
            {
                uuid: "10000000-0000-4000-8000-000000000002",
                type: "conditional" as const,
                condition: {
                    operator: "GREATER_THAN_OR_EQUAL" as const,
                    left: {
                        kind: "fact" as const,
                        key: "runorpg:attribute.stat_0",
                    },
                    right: {
                        kind: "literal" as const,
                        value: { kind: "decimal" as const, value: "5.0" },
                    },
                },
                thenBlocks: [
                    {
                        uuid: "10000000-0000-4000-8000-000000000003",
                        type: "description" as const,
                        message: "runorpg.item.test-sword.ready",
                        style: "description",
                        anchor: null,
                        wrapping: "body",
                    },
                ],
                otherwiseBlocks: [],
                style: null,
                anchor: null,
            },
        ];

        await service.update({
            id: initial.id,
            expectedFileHash: initial.fileHash,
            enabled: initial.enabled,
            material: initial.material,
            layout: "itemerness:equipment",
            theme: "itemerness:ember",
            mode: initial.mode,
            maxStackSize: initial.maxStackSize,
            unbreakable: initial.unbreakable,
            displayName: "脚本铁剑",
            itemLevel: 9,
            itemTier: "锻铸",
            itemPrefix: "坚固的",
            modifiers: initial.modifiers,
            skills: initial.skills,
            presentationBlocks: blocks,
            presentationMessages: {
                "runorpg.data.attribute.label": "属性",
                "runorpg.data.attribute.missing": "未知属性",
                "runorpg.item.test-sword.ready": "属性条件满足",
            },
        });

        const reloaded = (await service.catalog()).items[0]!;
        expect(reloaded).toMatchObject({
            displayName: "脚本铁剑",
            itemLevel: 9,
            itemTier: "锻铸",
            itemPrefix: "坚固的",
        });
        expect(reloaded.presentationBlocks.map((block) => block.type)).toEqual([
            "repeat",
            "conditional",
        ]);
        expect(reloaded.presentationMessages).toMatchObject({
            "runorpg.item.test-sword.ready": "属性条件满足",
        });
        const saved = parse(await readFile(sourceFile, "utf8")) as {
            items: Record<string, { presentation: { blocks: unknown[] } }>;
        };
        expect(saved.items["test-sword"]!.presentation.blocks).toHaveLength(2);

        await expect(
            service.update({
                id: reloaded.id,
                expectedFileHash: reloaded.fileHash,
                enabled: reloaded.enabled,
                material: reloaded.material,
                layout: "itemerness:equipment",
                theme: "itemerness:ember",
                mode: reloaded.mode,
                maxStackSize: reloaded.maxStackSize,
                unbreakable: reloaded.unbreakable,
                modifiers: reloaded.modifiers,
                skills: reloaded.skills,
                presentationBlocks: [
                    {
                        uuid: "10000000-0000-4000-8000-000000000004",
                        type: "field",
                        labelMessage: "example.data.quality",
                        data: "example:quality",
                        format: null,
                        icon: null,
                        style: null,
                        anchor: null,
                        wrapping: null,
                        missingPolicy: "OMIT",
                    },
                ],
                presentationMessages: {
                    "example.data.quality": "无效品质",
                },
            }),
        ).rejects.toMatchObject<Partial<RunoRpgCatalogError>>({
            code: "invalid-source",
        });
    });

    it("creates a disabled RunoRPG item with no vanilla attributes", async () => {
        const service = new RunoRpgCatalogService({
            catalogRoot: root,
            attributesFile,
        });

        await service.create({
            localId: "editor-blade",
            displayName: "编辑器长剑",
            description: "由编辑器创建。",
            enabled: false,
            material: "minecraft:iron_sword",
            layout: "itemerness:equipment",
            theme: "itemerness:ember",
            mode: "unique",
            maxStackSize: 1,
            unbreakable: true,
            modifiers: [],
            skills: [],
        });

        const catalog = await service.catalog();
        expect(catalog.items).toHaveLength(2);
        expect(
            catalog.items.find((item) => item.id === "runocraft:editor-blade"),
        ).toMatchObject({
            displayName: "编辑器长剑",
            description: "由编辑器创建。",
            enabled: false,
            mode: "unique",
            vanillaAttributesDisabled: true,
        });
        const created = parse(
            await readFile(
                join(root, "items", "runocraft-editor-editor-blade.yml"),
                "utf8",
            ),
        ) as unknown;
        expect(created).toMatchObject({
            namespace: "runocraft",
            items: {
                "editor-blade": {
                    base: {
                        components: { "minecraft:attribute_modifiers": [] },
                    },
                    instance: {
                        schemas: [
                            "runorpg:item-stats@1",
                            "runorpg:item-skill-contract@1",
                        ],
                    },
                    presentation: {
                        layout: "itemerness:equipment",
                        theme: "itemerness:ember",
                    },
                },
            },
        });
    });
});

describe("RunoRpgCatalogService editor snapshot", () => {
    let root: string;
    let attributesFile: string;
    let snapshotFile: string;

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), "itemerness-snapshot-"));
        attributesFile = join(root, "p0_attributes.kts");
        snapshotFile = join(root, "snapshot.json");
        await mkdir(join(root, "items"), { recursive: true });
        await mkdir(join(root, "locales"), { recursive: true });
        await writeFile(join(root, "items", "catalog.yml"), fixture(), "utf8");
        await writeFile(
            join(root, "locales", "zh_cn.yml"),
            "messages:\n  item.test-sword.name: 测试铁剑\n",
            "utf8",
        );
        // The scrape fallback would report exactly one attribute with this name.
        await writeFile(
            attributesFile,
            'numericAttribute("SCRIPT_ONLY", "脚本解析", order = 1)',
            "utf8",
        );
    });

    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });

    async function writeSnapshot(body: Record<string, unknown>): Promise<void> {
        await writeFile(snapshotFile, JSON.stringify(body), "utf8");
    }

    it("prefers the runtime snapshot over scraping the Kotlin script", async () => {
        await writeSnapshot({
            schemaVersion: 1,
            revision: 3,
            hash: "sha256:abc",
            attributes: [
                {
                    id: "runocraft:attack_damage",
                    name: "攻击伤害",
                    defaultValue: 1,
                    percent: false,
                    order: 100,
                },
            ],
        });
        const service = new RunoRpgCatalogService({
            catalogRoot: root,
            attributesFile,
            snapshotFile,
        });

        const catalog = await service.catalog();

        expect(catalog.attributes.map((entry) => entry.id)).toContain(
            "runocraft:attack_damage",
        );
        expect(catalog.attributes.map((entry) => entry.name)).not.toContain(
            "脚本解析",
        );
    });

    it("falls back to the script when no snapshot is configured", async () => {
        const service = new RunoRpgCatalogService({
            catalogRoot: root,
            attributesFile,
        });

        const catalog = await service.catalog();

        expect(catalog.attributes.map((entry) => entry.name)).toContain(
            "脚本解析",
        );
    });

    it("reports an unsupported snapshot version and keeps the editor usable", async () => {
        await writeSnapshot({ schemaVersion: 99, attributes: [] });
        const service = new RunoRpgCatalogService({
            catalogRoot: root,
            attributesFile,
            snapshotFile,
        });

        const catalog = await service.catalog();

        expect(catalog.diagnostics.join(" ")).toContain("99");
        expect(catalog.attributes.map((entry) => entry.name)).toContain(
            "脚本解析",
        );
    });

    it("reports an unreadable snapshot instead of failing the catalog", async () => {
        await writeFile(snapshotFile, "{ not json", "utf8");
        const service = new RunoRpgCatalogService({
            catalogRoot: root,
            attributesFile,
            snapshotFile,
        });

        const catalog = await service.catalog();

        expect(catalog.available).toBe(true);
        expect(catalog.diagnostics.join(" ")).toContain("编辑器快照");
    });
});
