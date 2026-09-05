import { describe, expect, it } from "vitest";
import type { MountedPack } from "@itemerness/mc-assets";
import type { ProjectDocument } from "@itemerness/protocol";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import { type AssetSlot, viewerOf } from "../src/state/store.js";

const MATCHING_SHA1 = "1111111111111111111111111111111111111111";
const PACK_ID = "10000000-0000-4000-8000-000000000001";

function pack(
    sha1: string,
    kind: MountedPack["kind"] = "resource-pack",
): AssetSlot {
    return {
        entryCount: 0,
        pack: {
            id: `sha256:${sha1}`,
            sha1,
            name: "fixture.zip",
            kind,
            meta: null,
            byteLength: 0,
            has: () => false,
            read: () => undefined,
            list: () => [],
        },
    };
}

function documentWithBindings(
    bindings: ProjectDocument["resourcePackBindings"],
): ProjectDocument {
    return { ...baselineDocument, resourcePackBindings: bindings };
}

function viewer(
    document: ProjectDocument,
    packs: readonly AssetSlot[],
    packSimulation: "auto" | "loaded" | "none" = "auto",
) {
    return viewerOf({
        document,
        viewerLocale: "en_us",
        themeOverride: null,
        packs,
        packSimulation,
        assetProfileOverride: null,
        managesVanillaTooltipLines: false,
    });
}

describe("viewerOf resource-pack identity", () => {
    const binding = {
        uuid: "20000000-0000-4000-8000-000000000001",
        id: "itemerness:test-pack",
        enabled: true,
        packId: PACK_ID,
        sha1: MATCHING_SHA1,
        assetProfile: "itemerness:example-pack-v1",
    } as const;

    it("grants only the profile bound to the exact mounted archive digest", () => {
        const result = viewer(documentWithBindings([binding]), [
            pack(MATCHING_SHA1),
        ]);

        expect(result.resourcePackLoaded).toBe(true);
        expect(result.assetProfile).toBe("itemerness:example-pack-v1");
        expect(result.capabilities).toEqual(
            baselineDocument.assetProfiles.find(
                (profile) => profile.id === "itemerness:example-pack-v1",
            )!.capabilities,
        );
        expect(result.metricsRevision).toBe("itemerness:example-pack-v1");
    });

    it("marks an arbitrary mounted resource pack loaded without granting its profile", () => {
        const result = viewer(documentWithBindings([binding]), [
            pack("2222222222222222222222222222222222222222"),
        ]);

        expect(result.resourcePackLoaded).toBe(true);
        expect(result.assetProfile).toBeNull();
        expect(result.capabilities).toEqual([]);
        expect(result.metricsRevision).toBeNull();
    });

    it("keeps explicit pack acceptance separate from profile capabilities", () => {
        const result = viewer(
            documentWithBindings([binding]),
            [pack("2222222222222222222222222222222222222222")],
            "loaded",
        );

        expect(result.resourcePackLoaded).toBe(true);
        expect(result.assetProfile).toBeNull();
        expect(result.capabilities).toEqual([]);
        expect(result.metricsRevision).toBeNull();
    });

    it("never infers managed vanilla tooltip lines from a resource pack", () => {
        const result = viewer(documentWithBindings([binding]), [
            pack(MATCHING_SHA1),
        ]);

        expect(result.managesVanillaTooltipLines).toBe(false);
    });

    it("applies profile and managed-line capabilities only as explicit persona overrides", () => {
        const result = viewerOf({
            document: documentWithBindings([]),
            viewerLocale: "en_us",
            themeOverride: null,
            packs: [],
            packSimulation: "loaded",
            assetProfileOverride: "itemerness:example-pack-v1",
            managesVanillaTooltipLines: true,
        });

        expect(result.resourcePackLoaded).toBe(true);
        expect(result.assetProfile).toBe("itemerness:example-pack-v1");
        expect(result.capabilities).toContain("itemerness:bitmap-canvas-v1");
        expect(result.managesVanillaTooltipLines).toBe(true);
    });

    it("rejects disabled, placeholder, unknown, and ambiguous bindings", () => {
        const variants: ProjectDocument["resourcePackBindings"][] = [
            [{ ...binding, enabled: false }],
            [{ ...binding, packId: "00000000-0000-0000-0000-000000000000" }],
            [{ ...binding, assetProfile: "itemerness:unknown" }],
            [
                binding,
                {
                    ...binding,
                    uuid: "20000000-0000-4000-8000-000000000002",
                    id: "itemerness:ambiguous-pack",
                    packId: "10000000-0000-4000-8000-000000000002",
                    assetProfile: "itemerness:vanilla",
                },
            ],
        ];

        for (const bindings of variants) {
            const result = viewer(documentWithBindings(bindings), [
                pack(MATCHING_SHA1),
            ]);
            expect(result.assetProfile).toBeNull();
            expect(result.capabilities).toEqual([]);
        }
    });

    it("does not treat a matching vanilla asset bundle as the server resource pack", () => {
        const result = viewer(documentWithBindings([binding]), [
            pack(MATCHING_SHA1, "vanilla"),
        ]);

        expect(result.resourcePackLoaded).toBe(false);
        expect(result.assetProfile).toBeNull();
    });

    it("lets explicit none suppress an otherwise matching resource pack", () => {
        const result = viewer(
            documentWithBindings([binding]),
            [pack(MATCHING_SHA1)],
            "none",
        );

        expect(result.resourcePackLoaded).toBe(false);
        expect(result.assetProfile).toBeNull();
        expect(result.capabilities).toEqual([]);
    });
});
