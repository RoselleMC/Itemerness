import { afterEach, describe, expect, it, vi } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import {
    catalogExportSchema,
    catalogReadSchema,
    contentHash,
} from "@itemerness/protocol";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import { PluginClient } from "../src/api/client.js";
import { catalogArchive } from "../src/features/settings/catalogArchive.js";
import {
    saveLocalExport,
    MAX_LOCAL_YAML_BYTES,
} from "../src/features/settings/saveLocalExport.js";

const handshake = {
    product: "itemerness",
    authentication: "none",
    serverId: "test",
    pluginVersion: "0.1.0",
    minecraftVersion: "26.1.2",
    platform: "Folia",
    compilerDigest: "sha256:" + "0".repeat(64),
    protocols: [{ major: 2, minMinor: 0, maxMinor: 0 }],
    documentSchemas: [1, 2],
    previewSchemas: [1],
    capabilities: [
        "draft.read",
        "draft.write",
        "preview.compile",
        "catalog.read",
        "catalog.export",
    ],
};
const read = {
    document: baselineDocument,
    sourceHash: "sha256:" + "1".repeat(64),
    diagnostics: [],
};
const exported = {
    files: [{ path: "items/editor.yml", content: "items: {}\n" }],
    settingsPatch: "presentation:\n  default-theme: itemerness:default\n",
    diagnostics: [],
};
const response = (body: unknown) => new Response(JSON.stringify(body));
afterEach(() => vi.unstubAllGlobals());

describe("explicit catalog transfer", () => {
    it("uses negotiated authenticated routes without saving the read document", async () => {
        const fetch = vi
            .fn()
            .mockResolvedValueOnce(response(handshake))
            .mockResolvedValueOnce(response(read))
            .mockResolvedValueOnce(response(exported));
        vi.stubGlobal("fetch", fetch);
        const client = new PluginClient(
            "https://example.test/items",
            "a".repeat(48),
        );
        await client.handshake();
        expect(await client.readCatalog()).toEqual(read);
        expect(await client.exportCatalog(baselineDocument, "test")).toEqual(
            exported,
        );
        expect(fetch.mock.calls[1]![0]).toBe(
            "https://example.test/items/api/v2/catalog",
        );
        expect(fetch.mock.calls[1]![1]).toMatchObject({
            method: "GET",
            headers: {
                Authorization: "Bearer " + "a".repeat(48),
                "X-Itemerness-Protocol": "2.0",
            },
            redirect: "error",
            credentials: "omit",
        });
        expect(fetch.mock.calls[2]![0]).toBe(
            "https://example.test/items/api/v2/catalog/export",
        );
        expect(JSON.parse(fetch.mock.calls[2]![1].body)).toEqual({
            document: baselineDocument,
            snapshotHash: contentHash(baselineDocument),
            targetServerId: "test",
        });
        expect(fetch).toHaveBeenCalledTimes(3);
    });

    it("rejects malformed documents and unsafe archive paths before download", () => {
        expect(
            catalogReadSchema.safeParse({
                ...read,
                document: { ...baselineDocument, unexpected: true },
            }).success,
        ).toBe(false);
        for (const path of [
            "../config.yml",
            "items/../../config.yml",
            "/items/editor.yml",
            "items//editor.yml",
            "items/./editor.yml",
            "items\\editor.yml",
            "config.yml",
            "access.yml",
            "items/editor.json",
        ]) {
            expect(
                catalogExportSchema.safeParse({
                    ...exported,
                    files: [{ path, content: "" }],
                }).success,
                path,
            ).toBe(false);
        }
        expect(
            catalogExportSchema.safeParse({
                ...exported,
                files: [
                    { path: "items/editor.yml", content: "" },
                    { path: "items/EDITOR.yml", content: "" },
                ],
            }).success,
        ).toBe(false);
    });

    it("puts domain YAML and a distinct settings patch in the ZIP", () => {
        const files = unzipSync(catalogArchive(exported));
        expect(Object.keys(files).sort()).toEqual([
            "config.patch.yml",
            "items/editor.yml",
        ]);
        expect(strFromU8(files["config.patch.yml"]!)).toBe(
            exported.settingsPatch,
        );
        expect(strFromU8(files["items/editor.yml"]!)).toBe(
            exported.files[0]!.content,
        );
    });

    it("enforces the common 2 MiB response limit and never retries a busy transfer", async () => {
        const fetch = vi
            .fn()
            .mockResolvedValueOnce(response(handshake))
            .mockResolvedValueOnce(
                new Response("x".repeat(2 * 1024 * 1024 + 1)),
            )
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ code: "CATALOG_BUSY" }), {
                    status: 429,
                    headers: { "Retry-After": "1" },
                }),
            );
        vi.stubGlobal("fetch", fetch);
        const client = new PluginClient("https://example.test", "");
        await client.handshake();
        await expect(client.readCatalog()).rejects.toThrow(
            "RESPONSE_TOO_LARGE",
        );
        await expect(
            client.exportCatalog(baselineDocument, "test"),
        ).rejects.toMatchObject({ status: 429, message: "CATALOG_BUSY" });
        expect(fetch).toHaveBeenCalledTimes(3);
    });

    it("rejects invalid local export sizes before any browser or native save", async () => {
        await expect(
            saveLocalExport("config", new Uint8Array()),
        ).rejects.toThrow("EXPORT_SIZE_INVALID");
        await expect(
            saveLocalExport("access", new Uint8Array(MAX_LOCAL_YAML_BYTES + 1)),
        ).rejects.toThrow("EXPORT_SIZE_INVALID");
    });
});
