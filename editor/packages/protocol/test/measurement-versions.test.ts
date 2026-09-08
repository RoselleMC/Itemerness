import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { contentHash, projectDocumentSchema } from "../src/index.js";

const documents = JSON.parse(
    readFileSync(
        new URL("../fixtures/measurement-version-golden.json", import.meta.url),
        "utf8",
    ),
) as Record<string, unknown>;

describe("supported Minecraft measurement targets", () => {
    it.each(Object.entries(documents))(
        "preserves the actual %s YAML loader document",
        (target, raw) => {
            const parsed = projectDocumentSchema.parse(raw);
            expect(parsed.measurement?.clientVersion).toBe(target);
            expect(parsed).toEqual(raw);
            expect(contentHash(parsed)).toBe(contentHash(raw));
        },
    );
});
