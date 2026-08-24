import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { baselineDocument } from "../fixtures/baseline.js";
import { contentHash } from "../src/canonical.js";
import { projectDocumentSchema } from "../src/document.js";

/**
 * The emitted fixture is a cross-language contract, not a convenience copy. If it drifts from the
 * TypeScript source the JVM codec test starts validating a document nobody edits, so staleness is
 * a failure rather than something to notice later.
 */
const jsonPath = fileURLToPath(
    new URL("../fixtures/baseline.json", import.meta.url),
);
const hashPath = fileURLToPath(
    new URL("../fixtures/baseline.sha256", import.meta.url),
);

describe("emitted fixture", () => {
    it("is up to date with the TypeScript source", () => {
        const emitted = JSON.parse(readFileSync(jsonPath, "utf8"));
        expect(
            contentHash(emitted),
            "run: pnpm --filter @itemerness/protocol gen:fixtures",
        ).toBe(contentHash(baselineDocument));
    });

    it("records the canonical hash the JVM codec must reproduce", () => {
        expect(readFileSync(hashPath, "utf8").trim()).toBe(
            contentHash(baselineDocument),
        );
    });

    it("round-trips through the schema unchanged", () => {
        const emitted = projectDocumentSchema.parse(
            JSON.parse(readFileSync(jsonPath, "utf8")),
        );
        expect(contentHash(emitted)).toBe(contentHash(baselineDocument));
    });
});
