import { describe, expect, it } from "vitest";
import { baselineDocument } from "../fixtures/baseline.js";
import { contentHash } from "../src/canonical.js";
import {
    projectDocumentSchema,
    resourcePackBindingNodeSchema,
} from "../src/document.js";
import {
    RESOURCE_PACK_DELIVERY_CAPABILITY,
    supportsResourcePackDelivery,
    usesResourcePackDelivery,
} from "../src/documentCapabilities.js";

const binding = baselineDocument.resourcePackBindings[0]!;

describe("resource-pack binding delivery", () => {
    it("is absent for verified bindings, so existing documents keep their hash", () => {
        const document = structuredClone(baselineDocument);
        const hash = contentHash(document);
        const parsed = projectDocumentSchema.parse(document);
        expect(
            parsed.resourcePackBindings.every(
                (entry) => !Object.hasOwn(entry, "delivery"),
            ),
        ).toBe(true);
        expect(usesResourcePackDelivery(document)).toBe(false);
        expect(contentHash(parsed)).toBe(hash);
    });

    it("parses assumed delivery without a pack identity and rejects unknown values", () => {
        const assumed = {
            ...binding,
            enabled: true,
            packId: null,
            sha1: null,
            delivery: "ASSUMED" as const,
        };
        expect(resourcePackBindingNodeSchema.parse(assumed).delivery).toBe(
            "ASSUMED",
        );
        expect(
            resourcePackBindingNodeSchema.safeParse({
                ...assumed,
                delivery: "assumed",
            }).success,
        ).toBe(false);
        expect(
            resourcePackBindingNodeSchema.safeParse({
                ...assumed,
                delivery: "PROXY",
            }).success,
        ).toBe(false);
    });

    it("requires the exact capability whenever the property is present", () => {
        const document = structuredClone(baselineDocument);
        document.resourcePackBindings = [{ ...binding, delivery: "VERIFIED" }];
        expect(usesResourcePackDelivery(document)).toBe(true);
        expect(supportsResourcePackDelivery(undefined)).toBe(false);
        expect(
            supportsResourcePackDelivery(["presentation.theme-selectors"]),
        ).toBe(false);
        expect(
            supportsResourcePackDelivery([RESOURCE_PACK_DELIVERY_CAPABILITY]),
        ).toBe(true);
        expect(RESOURCE_PACK_DELIVERY_CAPABILITY).toBe(
            "assets.resource-pack-bindings.delivery",
        );
    });
});
