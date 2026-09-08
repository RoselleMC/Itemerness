import { describe, expect, it } from "vitest";
import { baselineDocument } from "../fixtures/baseline.js";
import {
    contentHash,
    itemLayout,
    itemTheme,
    projectDocumentSchema,
    type ProjectDocument,
} from "../src/index.js";

function fixture() {
    return {
        ...structuredClone(baselineDocument),
        schemaVersion: 2 as const,
        measurement: { boldExtraAdvancePixels: 1 },
        dataSchemas: [],
        defaultLayout: baselineDocument.layouts[0]!.id,
        defaultTheme: baselineDocument.themes[0]!.id,
    };
}
describe("presentation defaults", () => {
    it("retains legacy hashes and requires explicit legacy bindings", () => {
        expect(contentHash(projectDocumentSchema.parse(baselineDocument))).toBe(
            contentHash(baselineDocument),
        );
        for (const value of [null, undefined]) {
            const document = structuredClone(baselineDocument);
            document.items[0]!.presentation.theme = value;
            expect(projectDocumentSchema.safeParse(document).success).toBe(
                false,
            );
        }
        expect(
            projectDocumentSchema.safeParse({
                ...baselineDocument,
                defaultTheme: null,
            }).success,
        ).toBe(false);
        expect(
            projectDocumentSchema.safeParse({
                ...baselineDocument,
                defaultLayout: baselineDocument.layouts[0]!.id,
            }).success,
        ).toBe(false);
    });
    it("preserves omitted and null authoring bindings while resolving the same defaults", () => {
        const document = fixture();
        document.items[0]!.presentation.theme = null;
        delete document.items[0]!.presentation.layout;
        const parsed = projectDocumentSchema.parse(document);
        expect(contentHash(parsed)).toBe(contentHash(document));
        expect(parsed.items[0]!.presentation).toHaveProperty("theme", null);
        expect(parsed.items[0]!.presentation).not.toHaveProperty("layout");
        expect(itemTheme(parsed, parsed.items[0]!)).toBe(document.defaultTheme);
        expect(itemLayout(parsed, parsed.items[0]!)).toBe(
            document.defaultLayout,
        );
        expect(itemTheme(parsed, parsed.items[1]!)).toBe(
            parsed.items[1]!.presentation.theme,
        );
    });
    it("does not fill absent v2 roots and rejects missing or dangling inheritance defaults", () => {
        const document = fixture();
        const without: ProjectDocument = { ...document };
        delete without.defaultLayout;
        delete without.defaultTheme;
        expect(projectDocumentSchema.parse(without)).not.toHaveProperty(
            "defaultTheme",
        );
        without.items[0]!.presentation.theme = null;
        expect(projectDocumentSchema.safeParse(without).success).toBe(false);
        expect(
            projectDocumentSchema.safeParse({
                ...document,
                defaultTheme: "missing:theme",
            }).success,
        ).toBe(false);
        expect(itemTheme(without, without.items[0]!)).toBeNull();
    });
});
