import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { contentHash, emptyProjectDocument } from "@itemerness/protocol";
import { PluginClient } from "../src/api/client.js";

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
    capabilities: ["draft.read", "draft.write", "preview.compile"],
};
const rawLegacy = () =>
    JSON.parse(
        readFileSync(
            new URL(
                "../../../packages/protocol/fixtures/baseline.json",
                import.meta.url,
            ),
            "utf8",
        ),
    );
const response = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200 });
afterEach(() => vi.unstubAllGlobals());

describe("document version and CAS boundary", () => {
    it("loads and saves the original schema 1 JSON with exactly the original hash and revision", async () => {
        const raw = rawLegacy();
        const hash = contentHash(raw);
        const fetch = vi
            .fn()
            .mockResolvedValueOnce(response(handshake))
            .mockResolvedValueOnce(
                response({ document: raw, snapshotHash: hash, revision: 54 }),
            )
            .mockResolvedValueOnce(
                response({ snapshotHash: hash, revision: 54, diagnostics: [] }),
            );
        vi.stubGlobal("fetch", fetch);
        const client = new PluginClient("http://server.example:18107", "");
        await client.handshake();
        const loaded = (await client.loadDocument())!;
        expect(loaded).toEqual({
            document: raw,
            snapshotHash: hash,
            revision: 54,
        });
        expect(
            await client.saveDocument(loaded.document, loaded.snapshotHash),
        ).toMatchObject({ snapshotHash: hash, revision: 54 });
        expect(JSON.parse(fetch.mock.calls[2]![1].body)).toEqual({
            document: raw,
            expectedHash: hash,
        });
    });

    it("rejects unknown fields without a write even when the server provides the correct raw hash", async () => {
        const raw = rawLegacy();
        raw.dataSchemas[0].keys[0].unrecognizedReadPolicy = "public";
        const fetch = vi
            .fn()
            .mockResolvedValueOnce(response(handshake))
            .mockResolvedValueOnce(
                response({
                    document: raw,
                    snapshotHash: contentHash(raw),
                    revision: 54,
                }),
            );
        vi.stubGlobal("fetch", fetch);
        const client = new PluginClient("http://server.example:18107", "");
        await client.handshake();
        await expect(client.loadDocument()).rejects.toThrow(
            "unrecognizedReadPolicy",
        );
        await expect(
            client.saveDocument(raw, contentHash(raw)),
        ).rejects.toThrow("unrecognizedReadPolicy");
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it("preserves extension payloads verbatim through loading and saving", async () => {
        const raw = rawLegacy();
        raw.extensions = {
            newerCapability: { values: [1, "two"], enabled: true },
        };
        const hash = contentHash(raw);
        const fetch = vi
            .fn()
            .mockResolvedValueOnce(response(handshake))
            .mockResolvedValueOnce(
                response({ document: raw, snapshotHash: hash, revision: 55 }),
            )
            .mockResolvedValueOnce(
                response({ snapshotHash: hash, revision: 55, diagnostics: [] }),
            );
        vi.stubGlobal("fetch", fetch);
        const client = new PluginClient("http://server.example:18107", "");
        await client.handshake();
        const loaded = (await client.loadDocument())!;
        await client.saveDocument(loaded.document, hash);
        expect(JSON.parse(fetch.mock.calls[2]![1].body).document).toEqual(raw);
    });

    it("blocks schema 2 writes to a legacy server before making a request", async () => {
        const fetch = vi
            .fn()
            .mockResolvedValueOnce(
                response({ ...handshake, documentSchemas: [1] }),
            );
        vi.stubGlobal("fetch", fetch);
        const client = new PluginClient("http://server.example:18107", "");
        await client.handshake();
        const document = emptyProjectDocument(
            "00000000-0000-4000-8000-000000000001",
        );
        await expect(client.saveDocument(document, "")).rejects.toThrow(
            "DOCUMENT_SCHEMA_INCOMPATIBLE",
        );
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("requires the returned document version to have been advertised in the handshake", async () => {
        const document = emptyProjectDocument(
            "00000000-0000-4000-8000-000000000001",
        );
        const fetch = vi
            .fn()
            .mockResolvedValueOnce(
                response({ ...handshake, documentSchemas: [1] }),
            )
            .mockResolvedValueOnce(
                response({
                    document,
                    snapshotHash: contentHash(document),
                    revision: 1,
                }),
            );
        vi.stubGlobal("fetch", fetch);
        const client = new PluginClient("http://server.example:18107", "");
        await client.handshake();
        await expect(client.loadDocument()).rejects.toThrow(
            "DOCUMENT_SCHEMA_INCOMPATIBLE",
        );
    });
});
