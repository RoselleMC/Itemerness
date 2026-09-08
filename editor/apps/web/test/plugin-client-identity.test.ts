import { afterEach, expect, it, vi } from "vitest";
import { contentHash } from "@itemerness/protocol";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import { PluginClient } from "../src/api/client.js";
const id = "0807ed00-2fd5-45d6-8214-16b77148533e";
const info = {
    product: "itemerness",
    authentication: "none",
    serverId: id,
    serverName: "Folia :25565",
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
        "server.identity.persistent",
        "server.alias.write",
        "presentation.segmented-frame.decorations",
        "catalog.base-components.attributes-enchantments",
    ],
};
const reply = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status });
afterEach(() => vi.unstubAllGlobals());

it("saves aliases with both identity and previous-value guards", async () => {
    const fetch = vi
        .fn()
        .mockResolvedValueOnce(reply(info))
        .mockResolvedValueOnce(reply({ serverId: id, serverAlias: "Preview" }));
    vi.stubGlobal("fetch", fetch);
    const client = new PluginClient("http://127.0.0.1:18087", "");
    await client.handshake();
    expect(await client.saveServerAlias("Preview", "Before")).toBe("Preview");
    expect(fetch.mock.calls[1]![0]).toBe(
        "http://127.0.0.1:18087/api/v2/server",
    );
    expect(JSON.parse(fetch.mock.calls[1]![1].body)).toEqual({
        targetServerId: id,
        alias: "Preview",
        expectedAlias: "Before",
    });
});

it("rejects a missing draft from a replacement server instead of resetting the current draft", async () => {
    const fetch = vi
        .fn()
        .mockResolvedValueOnce(reply(info))
        .mockResolvedValueOnce(
            reply({ code: "DRAFT_NOT_FOUND", serverId: "another" }, 404),
        );
    vi.stubGlobal("fetch", fetch);
    const client = new PluginClient("http://127.0.0.1:18087", "");
    await client.handshake();
    await expect(client.loadDocument()).rejects.toThrow(
        "SERVER_IDENTITY_CHANGED",
    );
});

it("binds draft writes to the negotiated UUID and verifies response identity", async () => {
    const fetch = vi
        .fn()
        .mockResolvedValueOnce(reply(info))
        .mockResolvedValueOnce(
            reply({
                serverId: id,
                snapshotHash: contentHash(baselineDocument),
                revision: 1,
                diagnostics: [],
            }),
        );
    vi.stubGlobal("fetch", fetch);
    const client = new PluginClient("http://127.0.0.1:18087", "");
    await client.handshake();
    await client.saveDocument(baselineDocument, "");
    expect(JSON.parse(fetch.mock.calls[1]![1].body).targetServerId).toBe(id);
});

it.each(["handshake", "read", "write"])(
    "pins identity across %s and blocks every subsequent request",
    async (operation) => {
        const response =
            operation === "handshake"
                ? reply({ ...info, serverId: "another" })
                : operation === "read"
                  ? reply({
                        document: baselineDocument,
                        snapshotHash: contentHash(baselineDocument),
                        revision: 1,
                        serverId: "another",
                    })
                  : reply({ code: "TARGET_MISMATCH" }, 409);
        const fetch = vi
            .fn()
            .mockResolvedValueOnce(reply(info))
            .mockResolvedValueOnce(response);
        vi.stubGlobal("fetch", fetch);
        const client = new PluginClient("http://127.0.0.1:18087", "");
        await client.handshake();
        await expect(
            operation === "handshake"
                ? client.handshake()
                : operation === "read"
                  ? client.loadDocument()
                  : client.saveDocument(baselineDocument, ""),
        ).rejects.toThrow("SERVER_IDENTITY_CHANGED");
        await expect(client.saveDocument(baselineDocument, "")).rejects.toThrow(
            "SERVER_IDENTITY_CHANGED",
        );
        expect(fetch).toHaveBeenCalledTimes(2);
    },
);
