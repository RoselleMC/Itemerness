import { describe, expect, it } from "vitest";
import { baselineDocument } from "../fixtures/baseline.js";
import { contentHash, previewRequestSchema } from "../src/index.js";

describe("preview request snapshot binding", () => {
    it("accepts a document only with its own canonical hash", () => {
        const parsed = previewRequestSchema.parse({
            document: baselineDocument,
            itemId: `${baselineDocument.namespace}:${baselineDocument.items[0]!.id}`,
            viewer: { locale: baselineDocument.defaultLocale },
            snapshotHash: contentHash(baselineDocument),
        });

        expect(parsed.document).toEqual(baselineDocument);
        expect(parsed.snapshotHash).toBe(contentHash(parsed.document));
    });

    it("rejects a hash borrowed from another document", () => {
        const document = structuredClone(baselineDocument);
        document.namespace = "changed";

        const parsed = previewRequestSchema.safeParse({
            document,
            itemId: `changed:${document.items[0]!.id}`,
            viewer: { locale: document.defaultLocale },
            snapshotHash: contentHash(baselineDocument),
        });

        expect(parsed.success).toBe(false);
        if (!parsed.success) {
            expect(parsed.error.issues).toContainEqual(
                expect.objectContaining({
                    path: ["snapshotHash"],
                    message: "snapshotHash does not match document",
                }),
            );
        }
    });
});
