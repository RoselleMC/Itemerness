import { describe, expect, it } from "vitest";
import { dataKeyNodeSchema, type ItemNode } from "@itemerness/protocol";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import {
    baseComponentIssue,
    componentFields,
    componentScalarValue,
    initialComponentValue,
    enchantmentKeyIssue,
    renameEnchantment,
} from "../src/features/inspector/baseComponents.js";
import {
    bindingIssue,
    compareDecimal,
    contentGraphIssues,
    contentsEditIssue,
    definitionReferenceIssues,
    generatorIssue,
    inferContentComponent,
    normalizeMaterial,
    replaceBinding,
    setInstanceMode,
} from "../src/features/inspector/itemDefinitionEditing.js";

const key = (kind: "long" | "decimal") =>
    dataKeyNodeSchema.parse({
        uuid: crypto.randomUUID(),
        id: "test:value",
        type: { kind },
        scope: "INSTANCE",
    });

describe("item definition editing", () => {
    it("infers only the loader's carriers and preserves full material namespaces", () => {
        for (const id of ["bundle", "red_bundle"])
            expect(inferContentComponent(`minecraft:${id}`)).toBe("BUNDLE");
        for (const id of [
            "shulker_box",
            "blue_shulker_box",
            "chest",
            "trapped_chest",
            "barrel",
        ])
            expect(inferContentComponent(`minecraft:${id}`)).toBe("CONTAINER");
        expect(inferContentComponent("custom:bundle")).toBeNull();
        expect(inferContentComponent("minecraft:paper")).toBeNull();
        expect(normalizeMaterial("diamond_sword")).toBe(
            "minecraft:diamond_sword",
        );
        expect(normalizeMaterial("custom:blade")).toBe("custom:blade");
        expect(normalizeMaterial("bad:value:extra")).toBeNull();
        expect(normalizeMaterial("")).toBeNull();
    });

    it("changes mode and ID together without rewriting unrelated components or values", () => {
        const old = baselineDocument.items[0]!.definition;
        const unique = setInstanceMode(old, "UNIQUE");
        expect(unique.instance).toMatchObject({
            mode: "UNIQUE",
            idGenerator: "UUID_V4",
        });
        expect(unique.baseComponents).toBe(old.baseComponents);
        expect(unique.definitionData).toBe(old.definitionData);
        expect(setInstanceMode(unique, "FUNGIBLE").instance).toMatchObject({
            mode: "FUNGIBLE",
            idGenerator: null,
        });
    });

    it("preserves assignments, generators and preview references when replacing or removing schema bindings", () => {
        const document = structuredClone(baselineDocument);
        const item = document.items[0]!;
        const old = item.definition;
        const next = replaceBinding(old, 0, {
            id: "missing:schema",
            version: 2,
        });
        expect(next.definitionData).toBe(old.definitionData);
        expect(next.instance.defaults).toBe(old.instance.defaults);
        expect(next.instance.generators).toBe(old.instance.generators);
        expect(bindingIssue(document, next.instance.schemas)).toBe(
            "missingSchema",
        );
        expect(
            definitionReferenceIssues(document, {
                ...item,
                definition: next,
            }).some((issue) => issue.code === "unboundKey"),
        ).toBe(true);
        expect(replaceBinding(old, 0, null).instance.schemas).toHaveLength(
            old.instance.schemas.length - 1,
        );
        const ref = old.instance.schemas[0]!;
        expect(bindingIssue(document, [ref, ref])).toBe("duplicateSchema");
        expect(
            bindingIssue(document, [
                { id: `a:${"x".repeat(127)}`, version: 1 },
            ]),
        ).toBe("bindingBudget");
    });

    it("checks generator type, scope, explicit defaults, allowed sets and exact decimal bounds", () => {
        const decimalKey = key("decimal");
        const generator = {
            kind: "randomDecimal" as const,
            key: decimalKey.id,
            minimum: "0.10000000000000001",
            maximum: "0.10000000000000002",
            scale: 12,
        };
        expect(generatorIssue(generator, decimalKey, [])).toBeNull();
        expect(
            generatorIssue(
                { ...generator, maximum: generator.minimum },
                decimalKey,
                [],
            ),
        ).toBe("generatorRange");
        expect(
            generatorIssue({ ...generator, scale: 13 }, decimalKey, []),
        ).toBe("generatorScale");
        expect(
            generatorIssue(generator, decimalKey, [
                { key: decimalKey.id, value: { kind: "null" } },
            ]),
        ).toBe("generatorDefault");
        expect(
            generatorIssue(
                generator,
                {
                    ...decimalKey,
                    constraints: {
                        ...decimalKey.constraints,
                        allowedValues: [{ kind: "decimal", value: "0" }],
                    },
                },
                [],
            ),
        ).toBe("generatorAllowed");
        expect(
            generatorIssue(
                { kind: "unixMillis", key: decimalKey.id },
                decimalKey,
                [],
            ),
        ).toBe("generatorType");
        expect(
            generatorIssue(
                { kind: "unixMillis", key: decimalKey.id },
                key("long"),
                [],
            ),
        ).toBeNull();
        expect(
            generatorIssue(
                generator,
                { ...decimalKey, scope: "DEFINITION" },
                [],
            ),
        ).toBe("wrongScope");
        expect(
            generatorIssue({ ...generator, maximum: "1e999" }, decimalKey, []),
        ).toBe("number");
        expect(compareDecimal("-1.2e3", "-1200.00")).toBe(0);
        expect(compareDecimal("0", "1e-100")).toBe(-1);
        expect(compareDecimal("-0", "0.000")).toBe(0);
        expect(compareDecimal("0.09", "0.1")).toBe(-1);
    });
});

describe("base component forms", () => {
    it("covers all fifteen supported components with valid structured defaults", () => {
        expect(Object.keys(componentFields)).toHaveLength(15);
        for (const [id, field] of Object.entries(componentFields))
            expect(
                baseComponentIssue(id, initialComponentValue(field)),
                id,
            ).toBeNull();
        expect(
            baseComponentIssue("minecraft:custom_data", {
                kind: "compound",
                entries: {},
            }),
        ).toBe("unsupportedComponent");
    });

    it("preserves explicit component clears and validates enchantment keys, levels and budgets", () => {
        expect(
            initialComponentValue(
                componentFields["minecraft:attribute_modifiers"]!,
            ),
        ).toEqual({ kind: "list", values: [] });
        expect(
            baseComponentIssue("minecraft:attribute_modifiers", {
                kind: "list",
                values: [{ kind: "integer", value: "1" }],
            }),
        ).toBe("componentValue");
        for (const id of [
            "minecraft:enchantments",
            "minecraft:stored_enchantments",
        ]) {
            expect(initialComponentValue(componentFields[id]!)).toEqual({
                kind: "compound",
                entries: {},
            });
            for (const level of ["1", "255"])
                expect(
                    baseComponentIssue(id, {
                        kind: "compound",
                        entries: {
                            "custom:combat/strength": {
                                kind: "integer",
                                value: level,
                            },
                        },
                    }),
                ).toBeNull();
            for (const level of ["0", "256", "-", "1.5"])
                expect(
                    baseComponentIssue(id, {
                        kind: "compound",
                        entries: {
                            "minecraft:sharpness": {
                                kind: "integer",
                                value: level,
                            },
                        },
                    }),
                ).toBe("componentValue");
            for (const count of [64, 65])
                expect(
                    baseComponentIssue(id, {
                        kind: "compound",
                        entries: Object.fromEntries(
                            Array.from({ length: count }, (_, i) => [
                                `custom:e${i}`,
                                { kind: "integer", value: "255" },
                            ]),
                        ),
                    }),
                ).toBe(count === 64 ? null : "componentValue");
            expect(
                baseComponentIssue(id, {
                    kind: "compound",
                    entries: { invalid: { kind: "integer", value: "1" } },
                }),
            ).toBe("componentValue");
            expect(
                baseComponentIssue(id, {
                    kind: "compound",
                    entries: {
                        "minecraft:sharpness": { kind: "decimal", value: "1" },
                    },
                }),
            ).toBe("componentValue");
        }
    });

    it("renames enchantment entries atomically without overwriting another level or changing order", () => {
        const entries = {
            "custom:first": { kind: "integer" as const, value: "255" },
            "custom:second": { kind: "integer" as const, value: "1" },
        };
        expect(enchantmentKeyIssue(entries, "invalid")).toBe("enchantmentKey");
        expect(
            enchantmentKeyIssue(entries, "custom:second", "custom:first"),
        ).toBe("enchantmentDuplicate");
        expect(
            renameEnchantment(entries, "custom:first", "custom:second"),
        ).toBeNull();
        expect(
            renameEnchantment(entries, "missing:key", "custom:third"),
        ).toBeNull();
        const renamed = renameEnchantment(
            entries,
            "custom:first",
            "custom:renamed",
        );
        expect(Object.keys(renamed!)).toEqual([
            "custom:renamed",
            "custom:second",
        ]);
        expect(renamed!["custom:renamed"]).toBe(entries["custom:first"]);
        expect(Object.keys(entries)).toEqual(["custom:first", "custom:second"]);
    });

    it("distinguishes unbreakable removal from explicit false glint and enforces component ranges", () => {
        expect(
            baseComponentIssue("minecraft:unbreakable", {
                kind: "boolean",
                value: false,
            }),
        ).toBe("unbreakable");
        expect(
            baseComponentIssue("minecraft:unbreakable", {
                kind: "compound",
                entries: {},
            }),
        ).toBeNull();
        expect(
            baseComponentIssue("minecraft:enchantment_glint_override", {
                kind: "boolean",
                value: false,
            }),
        ).toBeNull();
        for (const raw of ["0", "100", "1.5", "-"])
            expect(
                componentScalarValue(
                    componentFields["minecraft:max_stack_size"]!,
                    raw,
                ),
            ).toBeNull();
        expect(
            componentScalarValue(
                componentFields["minecraft:max_stack_size"]!,
                "99",
            ),
        ).toEqual({ kind: "integer", value: "99" });
        expect(
            baseComponentIssue("minecraft:max_damage", {
                kind: "integer",
                value: "2147483648",
            }),
        ).toBe("componentValue");
        expect(
            baseComponentIssue("minecraft:food", {
                kind: "compound",
                entries: {
                    nutrition: { kind: "integer", value: "1" },
                    saturation: { kind: "integer", value: "0" },
                    "can-always-eat": { kind: "boolean", value: true },
                },
            }),
        ).toBeNull();
    });

    it("checks complex component fields, list budgets, key syntax and model string/color rules", () => {
        const strings = (values: string[]) => ({
            kind: "compound" as const,
            entries: {
                strings: {
                    kind: "list" as const,
                    values: values.map((value) => ({
                        kind: "string" as const,
                        value,
                    })),
                },
            },
        });
        expect(
            baseComponentIssue(
                "minecraft:custom_model_data",
                strings(["12:34:56"]),
            ),
        ).toBeNull();
        expect(
            baseComponentIssue(
                "minecraft:custom_model_data",
                strings(["x\ny"]),
            ),
        ).toBe("componentValue");
        expect(
            baseComponentIssue(
                "minecraft:custom_model_data",
                strings(Array(65).fill("x")),
            ),
        ).toBe("componentValue");
        expect(
            baseComponentIssue("minecraft:custom_model_data", {
                kind: "compound",
                entries: { unknown: { kind: "null" } },
            }),
        ).toBe("componentValue");
        expect(
            baseComponentIssue("minecraft:item_model", {
                kind: "string",
                value: "foo:bar:baz",
            }),
        ).toBe("componentValue");
        expect(
            baseComponentIssue("minecraft:rarity", {
                kind: "string",
                value: "EPIC",
            }),
        ).toBeNull();
        const cooldown = componentFields["minecraft:use_cooldown"]!;
        expect(
            baseComponentIssue(
                "minecraft:use_cooldown",
                initialComponentValue(cooldown),
            ),
        ).toBeNull();
    });
});

describe("bounded nested contents", () => {
    const fixture = (count = 10) => {
        const document = structuredClone(baselineDocument);
        const template = document.items[0]!;
        document.items = Array.from(
            { length: count },
            (_, index): ItemNode => ({
                ...structuredClone(template),
                uuid: crypto.randomUUID(),
                id: `node_${index}`,
                enabled: true,
                definition: {
                    ...structuredClone(template.definition),
                    material: "minecraft:bundle",
                    contents: [],
                    contentComponent: null,
                },
            }),
        );
        return document;
    };
    it("rejects direct/indirect cycles, disabled targets, excess quantities and entry counts", () => {
        const document = fixture();
        const item = document.items[0]!;
        const id = (index: number) =>
            `${document.namespace}:${document.items[index]!.id}`;
        expect(
            contentsEditIssue(document, item, [{ item: id(0), amount: 1 }]),
        ).toBe("contentCycle");
        document.items[1]!.definition.contents = [{ item: id(0), amount: 1 }];
        expect(
            contentsEditIssue(document, item, [{ item: id(1), amount: 1 }]),
        ).toBe("contentCycle");
        document.items[1]!.definition.contents = [];
        document.items[1]!.enabled = false;
        expect(
            contentsEditIssue(document, item, [{ item: id(1), amount: 1 }]),
        ).toBe("contentDisabled");
        expect(
            contentsEditIssue(document, item, [{ item: id(2), amount: 100 }]),
        ).toBe("contentAmount");
        expect(
            contentsEditIssue(
                document,
                item,
                Array(65).fill({ item: id(2), amount: 1 }),
            ),
        ).toBe("contentEntries");
    });
    it("accounts for ancestor depths and multiplied descendants, not only the edited item", () => {
        const document = fixture();
        const id = (index: number) =>
            `${document.namespace}:${document.items[index]!.id}`;
        for (let index = 0; index < 7; index++)
            document.items[index]!.definition.contents = [
                { item: id(index + 1), amount: 1 },
            ];
        expect(contentGraphIssues(document)).toEqual([]);
        expect(
            contentsEditIssue(document, document.items[7]!, [
                { item: id(8), amount: 1 },
            ]),
        ).toBe("contentDepth");
        document.items[0]!.definition.contents = [{ item: id(8), amount: 99 }];
        expect(
            contentsEditIssue(document, document.items[8]!, [
                { item: id(9), amount: 3 },
            ]),
        ).toBe("contentBudget");
        expect(
            contentsEditIssue(document, document.items[8]!, [
                { item: id(9), amount: 1 },
            ]),
        ).toBeNull();
    });
    it("allows reducing imported over-budget contents but never enlarging an already invalid graph", () => {
        const document = fixture();
        const item = document.items[0]!;
        const id = `${document.namespace}:${document.items[1]!.id}`;
        item.definition.contents = Array.from({ length: 3 }, () => ({
            item: id,
            amount: 99,
        }));
        expect(
            contentsEditIssue(document, item, [
                ...item.definition.contents,
                { item: id, amount: 1 },
            ]),
        ).toBe("contentBudget");
        expect(
            contentsEditIssue(
                document,
                item,
                item.definition.contents.slice(0, 2),
            ),
        ).toBeNull();
    });
});
