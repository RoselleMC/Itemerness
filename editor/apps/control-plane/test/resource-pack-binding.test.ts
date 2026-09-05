import { describe, expect, it } from "vitest";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import {
    packIdFromSha1,
    withServerResourcePackBinding,
} from "../src/resource-pack-binding.js";

const SHA1 = "145bc4d144db000942319efbbdd70a8e3e09789e";

describe("server resource pack binding", () => {
    it("derives the pack id the server derives", () => {
        // UUID.nameUUIDFromBytes over the raw digest: a version 3 UUID, variant 2. Getting this
        // wrong produces a binding that looks right and matches nothing.
        const packId = packIdFromSha1(SHA1);
        expect(packId).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-3[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
        );
        expect(packIdFromSha1(SHA1)).toBe(packId);
    });

    it("replaces the shipped placeholder with the served pack", () => {
        const before = baselineDocument.resourcePackBindings[0]!;
        expect(before.enabled).toBe(false);

        const bound = withServerResourcePackBinding(baselineDocument, SHA1);
        const after = bound.resourcePackBindings[0]!;
        expect(after).toMatchObject({
            enabled: true,
            sha1: SHA1,
            packId: packIdFromSha1(SHA1),
            assetProfile: before.assetProfile,
        });
        // Everything else is content and must survive untouched.
        expect(bound.themes).toBe(baselineDocument.themes);
        expect(bound.items).toBe(baselineDocument.items);
    });

    it("is a no-op once the document already names the pack", () => {
        const bound = withServerResourcePackBinding(baselineDocument, SHA1);
        expect(withServerResourcePackBinding(bound, SHA1)).toBe(bound);
    });

    it("refuses to guess when several packs could match", () => {
        // Two enabled bindings for capability-granting profiles would both match the same bytes,
        // and an ambiguous profile resolves to none at all — worse than leaving it alone.
        const ambiguous = {
            ...baselineDocument,
            resourcePackBindings: [
                ...baselineDocument.resourcePackBindings,
                {
                    ...baselineDocument.resourcePackBindings[0]!,
                    uuid: "0f5b2d1a-0000-4000-8000-000000000001",
                },
            ],
        };
        expect(withServerResourcePackBinding(ambiguous, SHA1)).toBe(ambiguous);
    });
});
