import { afterEach, describe, expect, it, vi } from "vitest";
import { contentHash } from "@itemerness/protocol";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import { normalizeApiUrl, PluginClient } from "../src/api/client.js";
import { useConnectionStore } from "../src/state/connection.js";

const handshake = {
    product: "itemerness",
    serverId: "test",
    pluginVersion: "0.1.0",
    minecraftVersion: "26.1.2",
    platform: "Folia",
    compilerDigest: "sha256:" + "0".repeat(64),
    protocols: [{ major: 2, minMinor: 0, maxMinor: 0 }],
    documentSchemas: [1],
    previewSchemas: [1],
    capabilities: ["draft.read", "draft.write", "preview.compile"],
};
const TOKEN = "a".repeat(48);
const response = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status });

afterEach(() => {
    useConnectionStore.getState().disconnect();
    vi.unstubAllGlobals();
});

describe("plugin client", () => {
    it("accepts direct HTTP and HTTPS endpoints", () => {
        for (const url of [
            "http://192.168.1.10:18087",
            "http://10.0.0.25:18087",
            "http://[2001:db8::1]:18087",
            "http://server.example.com:18087/items",
            "https://example.com/items",
            "http://[::1]:18087",
        ]) {
            expect(normalizeApiUrl(`${url}/`)).toBe(url);
        }
    });
    it("rejects invalid, credential-bearing, and traversal addresses", () => {
        for (const url of [
            "https://user@example.com",
            "http://user:secret@192.168.1.10:18087",
            "https://example.com?token=x",
            "http://192.168.1.10:18087/#fragment",
            "https://example.com/../api",
            "https://example.com/%2e",
            "file:///tmp",
        ]) {
            expect(() => normalizeApiUrl(url)).toThrow();
        }
    });
    it("requires a handshake, binds all requests to one endpoint, and prohibits redirects", async () => {
        const fetch = vi
            .fn()
            .mockResolvedValueOnce(response(handshake))
            .mockResolvedValueOnce(
                response({
                    document: baselineDocument,
                    snapshotHash: contentHash(baselineDocument),
                    revision: 1,
                }),
            );
        vi.stubGlobal("fetch", fetch);
        const client = new PluginClient("https://server.example/items", TOKEN);
        await expect(client.loadDocument()).rejects.toThrow(
            "HANDSHAKE_REQUIRED",
        );
        expect(fetch).not.toHaveBeenCalled();
        await client.handshake();
        await client.loadDocument();
        expect(fetch.mock.calls[1]?.[0]).toBe(
            "https://server.example/items/api/v2/document",
        );
        expect(fetch.mock.calls[1]?.[1]).toMatchObject({
            redirect: "error",
            credentials: "omit",
            headers: {
                Authorization: `Bearer ${TOKEN}`,
                "X-Itemerness-Protocol": "2.0",
            },
        });
        client.close();
        await expect(client.loadDocument()).rejects.toThrow();
        expect(fetch).toHaveBeenCalledTimes(2);
    });
    it("rejects corrupt document payloads and preserves HTTP conflict metadata", async () => {
        vi.stubGlobal(
            "fetch",
            vi
                .fn()
                .mockResolvedValueOnce(response(handshake))
                .mockResolvedValueOnce(
                    response({
                        document: baselineDocument,
                        snapshotHash: "sha256:" + "0".repeat(64),
                        revision: 1,
                    }),
                )
                .mockResolvedValueOnce(
                    response(
                        { code: "DRAFT_CONFLICT", actualHash: "other" },
                        409,
                    ),
                ),
        );
        const client = new PluginClient("http://localhost:18087", TOKEN);
        await client.handshake();
        await expect(client.loadDocument()).rejects.toThrow(
            "SNAPSHOT_MISMATCH",
        );
        await expect(
            client.saveDocument(baselineDocument, "old"),
        ).rejects.toMatchObject({ status: 409, body: { actualHash: "other" } });
    });
    it("does not resurrect a cancelled connection when an old handshake arrives", async () => {
        let finish!: (value: Response) => void;
        vi.stubGlobal(
            "fetch",
            vi.fn().mockImplementation(
                () =>
                    new Promise<Response>((resolve) => {
                        finish = resolve;
                    }),
            ),
        );
        const attempt = useConnectionStore
            .getState()
            .connect("http://localhost:18087", TOKEN);
        useConnectionStore.getState().disconnect();
        finish(response(handshake));
        await attempt;
        expect(useConnectionStore.getState()).toMatchObject({
            status: "offline",
            client: null,
            info: null,
        });
    });
    it("bounds responses from an untrusted endpoint", async () => {
        vi.stubGlobal(
            "fetch",
            vi
                .fn()
                .mockResolvedValue(
                    new Response("x".repeat(2 * 1024 * 1024 + 1025)),
                ),
        );
        await expect(
            new PluginClient("http://localhost:18087", TOKEN).handshake(),
        ).rejects.toThrow("RESPONSE_TOO_LARGE");
    });
    it("remembers successful endpoints independently of the connection popup, never tokens", async () => {
        const setItem = vi.fn();
        vi.stubGlobal("localStorage", { setItem });
        vi.stubGlobal(
            "fetch",
            vi
                .fn()
                .mockResolvedValueOnce(response(handshake))
                .mockResolvedValueOnce(response({ code: "UNAUTHORIZED" }, 401)),
        );
        await useConnectionStore
            .getState()
            .connect("https://server.example/items/", TOKEN);
        expect(setItem).toHaveBeenCalledExactlyOnceWith(
            "itemerness.api-url",
            "https://server.example/items",
        );
        useConnectionStore.getState().disconnect();
        expect(useConnectionStore.getState().address).toBe(
            "https://server.example/items",
        );
        await useConnectionStore
            .getState()
            .connect("https://rejected.example/", TOKEN);
        expect(setItem).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(setItem.mock.calls)).not.toContain(TOKEN);
    });
    it("omits authorization for empty tokens and still respects protected server refusals", async () => {
        const fetch = vi
            .fn()
            .mockResolvedValueOnce(
                response({ ...handshake, authentication: "none" }),
            )
            .mockResolvedValueOnce(response({ code: "UNAUTHORIZED" }, 401));
        vi.stubGlobal("fetch", fetch);
        const connected = await new PluginClient(
            "http://localhost:18087",
            "",
        ).handshake();
        expect(connected.info.authentication).toBe("none");
        expect(fetch.mock.calls[0]?.[1].headers).not.toHaveProperty(
            "Authorization",
        );
        await expect(
            new PluginClient("http://localhost:18088", "").handshake(),
        ).rejects.toMatchObject({ status: 401 });
        expect(
            () => new PluginClient("http://localhost:18087", "short"),
        ).toThrow("INVALID_TOKEN");
    });
});
