import { describe, expect, it } from "vitest";
import { baselineDocument } from "../fixtures/baseline.js";
import { contentHash } from "../src/canonical.js";
import { projectDocumentSchema } from "../src/document.js";

describe("base component source values", () => {
    it("keeps omitted components distinct from explicit empty attribute and enchantment overrides", () => {
        const document = structuredClone(baselineDocument);
        document.items[0]!.definition.baseComponents = [];
        const omitted = contentHash(document);
        document.items[0]!.definition.baseComponents = [
            {
                id: "minecraft:attribute_modifiers",
                value: { kind: "list", values: [] },
            },
            {
                id: "minecraft:enchantments",
                value: { kind: "compound", entries: {} },
            },
            {
                id: "minecraft:stored_enchantments",
                value: {
                    kind: "compound",
                    entries: {
                        "custom:skill/one": { kind: "integer", value: "255" },
                    },
                },
            },
        ];
        const restored = projectDocumentSchema.parse(
            JSON.parse(JSON.stringify(document)),
        );
        expect(restored.items[0]!.definition.baseComponents).toEqual(
            document.items[0]!.definition.baseComponents,
        );
        expect(contentHash(restored)).not.toBe(omitted);
        expect(restored.items.slice(1)).toEqual(document.items.slice(1));
    });
});
