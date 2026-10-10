import { afterEach, describe, expect, it, vi } from "vitest";
import {
    CATALOG_SOURCE_LAYOUT_CAPABILITY,
    contentHash,
    projectDocumentSchema,
    type ProjectDocument,
} from "@itemerness/protocol";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import { PluginClient } from "../src/api/client.js";
import {
    itemSourceFiles,
    setSourceFile,
    validSourcePath,
} from "../src/state/sourceLayout.js";

const hash = "sha256:" + "a".repeat(64);

function withLayout(): ProjectDocument {
    const document = structuredClone(baselineDocument);
    document.sourceLayout = {
        sourceHash: hash,
        files: { [document.items[0]!.uuid]: "items/armory/weapons.yml" },
    };
    return document;
}

describe("catalog source layout", () => {
    it("parses as optional document metadata", () => {
        expect(projectDocumentSchema.parse(withLayout()).sourceLayout).toEqual(
            withLayout().sourceLayout,
        );
        const plain = projectDocumentSchema.parse(baselineDocument);
        expect(Object.hasOwn(plain, "sourceLayout")).toBe(false);
        expect(contentHash(plain)).toBe(contentHash(baselineDocument));
    });

    it("accepts only relative YAML paths inside the node's own directory", () => {
        expect(validSourcePath("items/armory/weapons.yml", "items")).toBe(true);
        expect(validSourcePath("items/basic.yaml", "items")).toBe(true);
        for (const path of [
            "items/../config.yml",
            "themes/weapons.yml",
            "/items/weapons.yml",
            "items/weapons.txt",
            "items",
            "items//weapons.yml",
        ])
            expect(validSourcePath(path, "items"), path).toBe(false);
    });

    it("assigns, clears and suggests item files without inventing a layout", () => {
        const document = withLayout();
        const second = document.items[1]!.uuid;
        const assigned = setSourceFile(
            document,
            second,
            "items/consumables.yml",
        );
        expect(itemSourceFiles(assigned)).toEqual([
            "items/armory/weapons.yml",
            "items/consumables.yml",
        ]);
        expect(
            setSourceFile(assigned, second, null).sourceLayout?.files[second],
        ).toBeUndefined();
        const plain = structuredClone(baselineDocument);
        expect(setSourceFile(plain, second, "items/x.yml")).toBe(plain);
    });
});

describe("plugin transport", () => {
    afterEach(() => vi.unstubAllGlobals());

    const handshake = (capabilities: string[]) => ({
        product: "itemerness",
        authentication: "none",
        serverId: "test",
        pluginVersion: "0.1.0",
        minecraftVersion: "26.1.2",
        platform: "Paper",
        compilerDigest: "sha256:" + "0".repeat(64),
        protocols: [{ major: 2, minMinor: 0, maxMinor: 0 }],
        documentSchemas: [1, 2],
        previewSchemas: [1],
        capabilities: [
            "draft.read",
            "draft.write",
            "catalog.read",
            ...capabilities,
        ],
    });
    const read = (document: ProjectDocument) =>
        new Response(
            JSON.stringify({ document, sourceHash: hash, diagnostics: [] }),
        );

    it("asks for the layout only when the plugin advertises it", async () => {
        for (const [capabilities, expected] of [
            [[], false],
            [[CATALOG_SOURCE_LAYOUT_CAPABILITY], true],
        ] as const) {
            const fetch = vi
                .fn()
                .mockResolvedValueOnce(
                    new Response(JSON.stringify(handshake([...capabilities]))),
                )
                .mockResolvedValueOnce(read(baselineDocument));
            vi.stubGlobal("fetch", fetch);
            const client = new PluginClient("http://example.test", "");
            await client.handshake();
            await client.readCatalog();
            const headers = fetch.mock.calls[1]![1].headers as Record<
                string,
                string
            >;
            expect(headers["X-Itemerness-Catalog-Layout"] === "1").toBe(
                expected,
            );
        }
    });

    it("never sends a layout to a plugin that cannot read it", async () => {
        const fetch = vi
            .fn()
            .mockResolvedValueOnce(new Response(JSON.stringify(handshake([]))));
        vi.stubGlobal("fetch", fetch);
        const client = new PluginClient("http://example.test", "");
        await client.handshake();
        await expect(client.saveDocument(withLayout(), "")).rejects.toThrow(
            "CATALOG_SOURCE_LAYOUT_UNSUPPORTED",
        );
        expect(fetch).toHaveBeenCalledTimes(1);
    });
});
