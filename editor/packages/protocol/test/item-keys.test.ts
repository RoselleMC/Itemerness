import { describe, expect, it } from "vitest";
import { baselineDocument } from "../fixtures/baseline.js";
import {
    contentHash,
    itemKey,
    namespacedIdSchema,
    projectDocumentSchema,
} from "../src/index.js";

function modern() {
    return {
        ...structuredClone(baselineDocument),
        schemaVersion: 2 as const,
        measurement: { boldExtraAdvancePixels: 1 },
        dataSchemas: [],
    };
}

describe("versioned item identity", () => {
    it("keeps legacy paths and canonical document bytes unchanged", () => {
        const parsed = projectDocumentSchema.parse(baselineDocument);
        expect(contentHash(parsed)).toBe(contentHash(baselineDocument));
        expect(parsed.items[0]!.id).toBe("travel-token");
        expect(itemKey(parsed, parsed.items[0]!)).toBe(
            "itemerness:travel-token",
        );
        const invalid = structuredClone(parsed);
        invalid.items[0]!.id = "other:travel-token";
        expect(projectDocumentSchema.safeParse(invalid).success).toBe(false);
        invalid.items[0]!.id = "a".repeat(201);
        expect(projectDocumentSchema.safeParse(invalid).success).toBe(true);
        invalid.namespace = "x";
        invalid.items[0]!.id = "a".repeat(254);
        expect(projectDocumentSchema.safeParse(invalid).success).toBe(true);
        invalid.items[0]!.id += "a";
        expect(projectDocumentSchema.safeParse(invalid).success).toBe(false);
    });

    it("accepts qualified and default-relative IDs without rewriting either", () => {
        const document = modern();
        document.items[0]!.id = "travel-token";
        document.items[1]!.id = "other:travel-token";
        const parsed = projectDocumentSchema.parse(document);
        expect(
            parsed.items.map((item) => itemKey(parsed, item)).slice(0, 2),
        ).toEqual(["itemerness:travel-token", "other:travel-token"]);
        expect(parsed.items[0]!.id).toBe("travel-token");
        expect(parsed.items[1]!.id).toBe("other:travel-token");
        expect(itemKey(parsed, "other:travel-token")).toBe(
            "other:travel-token",
        );
    });

    it("rejects aliases of the same logical item key", () => {
        const document = modern();
        document.items[1]!.id = "itemerness:travel-token";
        const parsed = projectDocumentSchema.safeParse(document);
        expect(parsed.success).toBe(false);
        if (!parsed.success)
            expect(parsed.error.issues).toContainEqual(
                expect.objectContaining({
                    path: ["items", 1, "id"],
                    message: "Duplicate item key itemerness:travel-token",
                }),
            );
    });

    it("checks the resolved length and core namespace limit", () => {
        const document = modern();
        document.items[0]!.id = "a".repeat(255 - document.namespace.length);
        expect(projectDocumentSchema.safeParse(document).success).toBe(true);
        document.items[0]!.id += "a";
        expect(projectDocumentSchema.safeParse(document).success).toBe(false);
        document.items[0]!.id = `x:${"a".repeat(254)}`;
        expect(projectDocumentSchema.safeParse(document).success).toBe(true);
        expect(
            namespacedIdSchema.safeParse(`${"n".repeat(64)}:path`).success,
        ).toBe(true);
        expect(
            namespacedIdSchema.safeParse(`${"n".repeat(65)}:path`).success,
        ).toBe(false);
    });
});
