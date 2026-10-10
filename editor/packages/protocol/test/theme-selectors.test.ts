import { describe, expect, it } from "vitest";
import { baselineDocument } from "../fixtures/baseline.js";
import { contentHash } from "../src/canonical.js";
import {
    projectDocumentSchema,
    themeSelectorNodeSchema,
    upgradeProjectDocument,
    type ThemeSelectorNode,
} from "../src/document.js";
import {
    DATA_SCHEMA_OWNER_CAPABILITY,
    THEME_SELECTORS_CAPABILITY,
    supportsThemeSelectors,
    usesThemeSelectors,
} from "../src/documentCapabilities.js";

const selector: ThemeSelectorNode = {
    uuid: "8c7c4b1e-6a7e-4a55-9b8e-2f3c0b6d5a10",
    id: "example:charge-frame",
    cases: [
        {
            condition: {
                operator: "GREATER_THAN_OR_EQUAL",
                left: { kind: "data", key: "example:charges" },
                right: {
                    kind: "literal",
                    value: { kind: "integer", value: "3" },
                },
            },
            theme: "itemerness:default",
        },
    ],
    defaultTheme: "itemerness:vanilla-frame",
};

describe("theme selector documents", () => {
    it("are optional, so documents without selectors keep their hash", () => {
        const document = structuredClone(baselineDocument);
        const hash = contentHash(document);
        expect(
            Object.hasOwn(
                projectDocumentSchema.parse(document),
                "themeSelectors",
            ),
        ).toBe(false);
        expect(usesThemeSelectors(document)).toBe(false);
        expect(contentHash(projectDocumentSchema.parse(document))).toBe(hash);
    });

    it("parse strictly with the shared condition model", () => {
        const document = {
            ...structuredClone(baselineDocument),
            themeSelectors: [selector],
        };
        expect(projectDocumentSchema.parse(document).themeSelectors).toEqual([
            selector,
        ]);
        expect(
            themeSelectorNodeSchema.safeParse({ ...selector, priority: 1 })
                .success,
        ).toBe(false);
        expect(
            themeSelectorNodeSchema.safeParse({
                ...selector,
                cases: [{ ...selector.cases[0], weight: 1 }],
            }).success,
        ).toBe(false);
        expect(
            themeSelectorNodeSchema.safeParse({
                ...selector,
                cases: [
                    {
                        ...selector.cases[0],
                        condition: {
                            ...selector.cases[0]!.condition,
                            operator: "MATCHES",
                        },
                    },
                ],
            }).success,
        ).toBe(false);
        // A missing right operand defaults to null exactly like conditional blocks.
        const exists = themeSelectorNodeSchema.parse({
            ...selector,
            cases: [
                {
                    condition: {
                        operator: "EXISTS",
                        left: { kind: "fact", key: "example:class" },
                    },
                    theme: "itemerness:ember",
                },
            ],
        });
        expect(exists.cases[0]!.condition.right).toBeNull();
    });

    it("lets the document default theme name a selector", () => {
        const upgraded = upgradeProjectDocument(
            structuredClone(baselineDocument),
            (_schema, key) => ({
                readSources: [
                    {
                        kind:
                            key.scope === "DEFINITION"
                                ? "catalogDefinition"
                                : "canonicalNbt",
                    },
                ],
                access: {
                    read: "INTERNAL",
                    write: [
                        key.scope === "DEFINITION" ? "definition" : "internal",
                    ],
                },
                placeholderApi: { exposed: false, formatter: null },
            }),
        );
        const document = {
            ...upgraded,
            defaultTheme: selector.id,
            themeSelectors: [selector],
        };
        expect(projectDocumentSchema.safeParse(document).success).toBe(true);
        const missing = { ...document, themeSelectors: undefined };
        delete missing.themeSelectors;
        expect(projectDocumentSchema.safeParse(missing).success).toBe(false);
    });
});

describe("theme selector capability", () => {
    it("is required only when the field is present, even if empty", () => {
        expect(supportsThemeSelectors(undefined)).toBe(false);
        expect(supportsThemeSelectors([DATA_SCHEMA_OWNER_CAPABILITY])).toBe(
            false,
        );
        expect(supportsThemeSelectors([THEME_SELECTORS_CAPABILITY])).toBe(true);
        expect(usesThemeSelectors({ themeSelectors: [] })).toBe(true);
        expect(usesThemeSelectors({ themeSelectors: [selector] })).toBe(true);
        expect(usesThemeSelectors({})).toBe(false);
    });
});
