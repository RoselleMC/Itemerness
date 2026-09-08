import { describe, expect, it } from "vitest";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import { catalogTransferDiff } from "../src/features/settings/catalogTransferDiff.js";

describe("catalog replacement summary", () => {
    it("uses business identity and ignores UUIDs, extensions and preview samples", () => {
        const candidate = structuredClone(baselineDocument);
        candidate.items[0]!.uuid = crypto.randomUUID();
        candidate.items[0]!.presentation.blocks[0]!.uuid = crypto.randomUUID();
        candidate.items[0]!.extensions = { custom: true };
        candidate.items[0]!.previewData = {};
        candidate.viewerFacts[0]!.previewValue = {
            kind: "string",
            value: "different",
        };
        const result = catalogTransferDiff(baselineDocument, candidate);
        expect(
            result.counts.every(
                (entry) => !entry.added && !entry.removed && !entry.changed,
            ),
        ).toBe(true);
    });
    it("separately counts definition, availability, resource and translation changes", () => {
        const candidate = structuredClone(baselineDocument);
        candidate.items[0]!.enabled = !candidate.items[0]!.enabled;
        candidate.items.pop();
        candidate.bitmaps[0]!.texture = "example:changed.png";
        const messages = candidate.locales[0]!.messages;
        messages[Object.keys(messages)[0]!] = "changed";
        delete messages[Object.keys(messages)[1]!];
        messages["new.message"] = "";
        const result = catalogTransferDiff(baselineDocument, candidate);
        expect(
            result.counts.find((entry) => entry.kind === "items"),
        ).toMatchObject({ added: 0, removed: 1, changed: 1 });
        expect(
            result.counts.find((entry) => entry.kind === "bitmaps")?.changed,
        ).toBe(1);
        expect(result.messages).toEqual({ added: 1, removed: 1, changed: 1 });
        expect(result.enabled.after).not.toBe(result.enabled.before);
    });
    it("handles an absent draft without seeding or modifying the candidate", () => {
        const before = JSON.stringify(baselineDocument);
        const result = catalogTransferDiff(null, baselineDocument);
        expect(
            result.counts.every(
                (entry) => entry.added === entry.after && entry.before === 0,
            ),
        ).toBe(true);
        expect(result.settings.every((entry) => entry.before === null)).toBe(
            true,
        );
        expect(JSON.stringify(baselineDocument)).toBe(before);
    });
    it("keeps schema versions distinct and normalizes qualified item spellings", () => {
        const candidate = structuredClone(baselineDocument);
        candidate.schemaVersion = 2;
        candidate.items.forEach((item) => {
            item.id = `${candidate.namespace}:${item.id}`;
        });
        candidate.dataSchemas[0]!.version++;
        const result = catalogTransferDiff(baselineDocument, candidate);
        expect(
            result.counts.find((entry) => entry.kind === "items")?.changed,
        ).toBe(0);
        expect(
            result.counts.find((entry) => entry.kind === "dataSchemas"),
        ).toMatchObject({ added: 1, removed: 1, changed: 0 });
    });
    it("does not discard real compound fields that happen to use editor metadata names", () => {
        const candidate = structuredClone(baselineDocument);
        candidate.items[0]!.definition.definitionData.push({
            key: "example:compound",
            value: {
                kind: "compound",
                value: { extensions: { kind: "string", value: "runtime" } },
            },
        });
        expect(
            catalogTransferDiff(baselineDocument, candidate).counts.find(
                (entry) => entry.kind === "items",
            )?.changed,
        ).toBe(1);
    });
});
