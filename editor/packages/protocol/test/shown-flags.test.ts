import { describe, expect, it } from "vitest";
import { baselineDocument } from "../fixtures/baseline.js";
import { contentHash } from "../src/canonical.js";
import { projectDocumentSchema } from "../src/document.js";
import { handshakeSchema } from "../src/connection.js";
import {
    SHOWN_FLAGS_CAPABILITY,
    supportsShownFlags,
    usesShownFlags,
} from "../src/documentCapabilities.js";

function withShownFlags(shownFlags: unknown) {
    const document = structuredClone(baselineDocument) as unknown as {
        items: { presentation: Record<string, unknown> }[];
    };
    document.items[0]!.presentation.shownFlags = shownFlags;
    return document;
}

describe("item shown flags", () => {
    it("are absent from existing documents, so their hashes do not change", () => {
        const document = structuredClone(baselineDocument);
        const hash = contentHash(document);
        const parsed = projectDocumentSchema.parse(document);
        expect(
            parsed.items.every(
                (item) => !Object.hasOwn(item.presentation, "shownFlags"),
            ),
        ).toBe(true);
        expect(usesShownFlags(parsed)).toBe(false);
        expect(contentHash(parsed)).toBe(hash);
    });

    it("parse namespaced data component ids and reject malformed or excessive lists", () => {
        const parsed = projectDocumentSchema.parse(
            withShownFlags(["minecraft:enchantments", "example:future"]),
        );
        expect(parsed.items[0]!.presentation.shownFlags).toEqual([
            "minecraft:enchantments",
            "example:future",
        ]);
        for (const invalid of [
            "minecraft:enchantments",
            ["Minecraft:Enchantments"],
            ["enchantments"],
            [1],
            Array.from({ length: 65 }, (_, index) => `example:c${index}`),
        ])
            expect(
                projectDocumentSchema.safeParse(withShownFlags(invalid)).success,
            ).toBe(false);
        expect(
            projectDocumentSchema.safeParse(
                withShownFlags(
                    Array.from({ length: 64 }, (_, index) => `example:c${index}`),
                ),
            ).success,
        ).toBe(true);
    });

    it("require the exact capability whenever the property is present, even empty", () => {
        const document = projectDocumentSchema.parse(withShownFlags([]));
        expect(usesShownFlags(document)).toBe(true);
        expect(supportsShownFlags(undefined)).toBe(false);
        expect(supportsShownFlags(["presentation.theme-selectors"])).toBe(false);
        expect(supportsShownFlags([SHOWN_FLAGS_CAPABILITY])).toBe(true);
    });

    it("accept optional server component suggestions in the handshake", () => {
        const handshake = {
            product: "itemerness",
            serverId: "test",
            pluginVersion: "1.0.0",
            minecraftVersion: "26.1.2",
            platform: "Folia",
            compilerDigest: "sha256:" + "0".repeat(64),
            protocols: [{ major: 2, minMinor: 0, maxMinor: 0 }],
            documentSchemas: [2],
            previewSchemas: [1],
            capabilities: ["draft.read", "draft.write"],
        };
        expect(handshakeSchema.parse(handshake).dataComponentTypes).toBeUndefined();
        expect(
            handshakeSchema.parse({
                ...handshake,
                dataComponentTypes: ["minecraft:enchantments"],
            }).dataComponentTypes,
        ).toEqual(["minecraft:enchantments"]);
    });
});
