import { afterEach, describe, expect, it, vi } from "vitest";
import {
    EDITOR_TRANSFER_CEILING,
    LEGACY_TRANSFER_LIMITS,
    handshakeSchema,
    negotiateTransferLimits,
    type ProjectDocument,
} from "@itemerness/protocol";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import {
    PluginClient,
    PluginHttpError,
    TransferSizeError,
    transferSizeDetail,
} from "../src/api/client.js";
import { formatBytes } from "../src/features/common/formatBytes.js";
import { contentHash } from "@itemerness/protocol";

const MiB = 1024 * 1024;
const limits = {
    documentBytes: 16 * MiB,
    requestBytes: 17 * MiB,
    responseBytes: 17 * MiB,
};
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
        "catalog.read",
        "catalog.status",
        "transfer.limits",
    ],
    limits,
};
const response = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status });

/** The baseline document grown with translated text to about [bytes]. */
function sized(bytes: number): ProjectDocument {
    const message = "Translated flavor text for a production item. ".repeat(300);
    const count = Math.ceil(bytes / (message.length + 24));
    const [locale, ...others] = baselineDocument.locales;
    return {
        ...baselineDocument,
        locales: [
            {
                ...locale!,
                messages: {
                    ...locale!.messages,
                    ...Object.fromEntries(
                        Array.from({ length: count }, (_, index) => [
                            `item.copy-${index}.lore`,
                            message,
                        ]),
                    ),
                },
            },
            ...others,
        ],
    };
}
const length = (value: unknown) =>
    new TextEncoder().encode(JSON.stringify(value)).length;

afterEach(() => vi.unstubAllGlobals());

describe("negotiated transfer limits", () => {
    it("falls back to 2 MiB for plugins that advertise nothing and never exceeds the editor ceiling", () => {
        const { limits: _limits, ...legacy } = handshake;
        expect(negotiateTransferLimits(handshakeSchema.parse(legacy))).toEqual(
            LEGACY_TRANSFER_LIMITS,
        );
        expect(
            negotiateTransferLimits(
                handshakeSchema.parse({
                    ...handshake,
                    limits: {
                        documentBytes: 64 * MiB,
                        requestBytes: 3 * MiB,
                        responseBytes: 65 * MiB,
                    },
                }),
            ),
        ).toEqual({
            documentBytes: EDITOR_TRANSFER_CEILING.documentBytes,
            requestBytes: 3 * MiB,
            responseBytes: EDITOR_TRANSFER_CEILING.responseBytes,
        });
    });

    it("imports and saves a document above 3 MiB through a plugin that accepts 16 MiB", async () => {
        const document = sized(3.4 * MiB);
        expect(length(document)).toBeGreaterThan(3.3 * MiB);
        const fetch = vi
            .fn()
            .mockResolvedValueOnce(response(handshake))
            .mockResolvedValueOnce(
                response({
                    document,
                    sourceHash: "sha256:" + "1".repeat(64),
                    diagnostics: [],
                }),
            )
            .mockResolvedValueOnce(
                response({
                    serverId: "test",
                    snapshotHash: "sha256:" + "2".repeat(64),
                    revision: 1,
                    diagnostics: [],
                }),
            );
        vi.stubGlobal("fetch", fetch);
        const client = new PluginClient("https://example.test", "");
        await client.handshake();
        expect(client.transferLimits).toEqual(limits);
        const read = await client.readCatalog();
        expect(read.document.locales[0]!.messages["item.copy-0.lore"]).toBe(
            document.locales[0]!.messages["item.copy-0.lore"],
        );
        await client.saveDocument(read.document, "");
        expect(fetch).toHaveBeenCalledTimes(3);
    });

    it("refuses an oversized document before sending it and reports both sizes", async () => {
        const fetch = vi.fn().mockResolvedValueOnce(
            response({
                ...handshake,
                limits: { ...limits, documentBytes: 1 * MiB },
            }),
        );
        vi.stubGlobal("fetch", fetch);
        const client = new PluginClient("https://example.test", "");
        await client.handshake();
        const document = sized(1.2 * MiB);
        const failure = await client
            .saveDocument(document, "")
            .catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(TransferSizeError);
        expect(transferSizeDetail(failure)).toEqual({
            code: "DOCUMENT_TOO_LARGE",
            limitBytes: 1 * MiB,
            actualBytes: length(document),
        });
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("reads sizes from plugin refusals, including string diagnostic parameters", () => {
        expect(
            transferSizeDetail(
                new PluginHttpError(
                    413,
                    {
                        code: "DOCUMENT_TOO_LARGE",
                        actualBytes: 17_000_000,
                        limitBytes: 16 * MiB,
                    },
                    "DOCUMENT_TOO_LARGE",
                ),
            ),
        ).toEqual({
            code: "DOCUMENT_TOO_LARGE",
            actualBytes: 17_000_000,
            limitBytes: 16 * MiB,
        });
        expect(
            transferSizeDetail(
                new PluginHttpError(
                    422,
                    {
                        code: "CATALOG_DOCUMENT_TOO_LARGE",
                        diagnostics: [
                            {
                                code: "CATALOG.DOCUMENT_TOO_LARGE",
                                params: {
                                    actualBytes: "18000000",
                                    limitBytes: String(16 * MiB),
                                },
                            },
                        ],
                    },
                    "CATALOG_DOCUMENT_TOO_LARGE",
                ),
            ),
        ).toMatchObject({ actualBytes: 18_000_000, limitBytes: 16 * MiB });
        // Older plugins refuse without sizes; the editor must not invent them.
        expect(
            transferSizeDetail(
                new PluginHttpError(
                    413,
                    { code: "REQUEST_TOO_LARGE" },
                    "REQUEST_TOO_LARGE",
                ),
            ),
        ).toEqual({
            code: "REQUEST_TOO_LARGE",
            actualBytes: null,
            limitBytes: null,
        });
        expect(
            transferSizeDetail(new PluginHttpError(409, {}, "DRAFT_CONFLICT")),
        ).toBeNull();
        expect(formatBytes(16 * MiB)).toBe("16.00 MiB");
    });

    it("bounds responses by the negotiated limit", async () => {
        vi.stubGlobal(
            "fetch",
            vi
                .fn()
                .mockResolvedValueOnce(
                    response({
                        ...handshake,
                        limits: { ...limits, responseBytes: 3 * MiB },
                    }),
                )
                .mockResolvedValueOnce(
                    new Response("x".repeat(3 * MiB + 1)),
                ),
        );
        const client = new PluginClient("https://example.test", "");
        await client.handshake();
        await expect(client.readCatalog()).rejects.toThrow(
            "RESPONSE_TOO_LARGE",
        );
    });
});

describe("catalog status", () => {
    it("reads the server fingerprint without touching the draft", async () => {
        const fetch = vi
            .fn()
            .mockResolvedValueOnce(response(handshake))
            .mockResolvedValueOnce(
                response({
                    serverId: "test",
                    sourceHash: "sha256:" + "3".repeat(64),
                }),
            );
        vi.stubGlobal("fetch", fetch);
        const client = new PluginClient("https://example.test", "");
        await client.handshake();
        await expect(client.catalogStatus()).resolves.toEqual({
            serverId: "test",
            sourceHash: "sha256:" + "3".repeat(64),
        });
        const [url, init] = fetch.mock.calls[1]!;
        expect(String(url)).toBe("https://example.test/api/v2/catalog/status");
        expect((init as RequestInit).method).toBe("GET");
    });
});

describe("slow transfers", () => {
    afterEach(() => vi.useRealTimers());

    /** A response whose body arrives in chunks the test releases; like real fetch, an abort errors it. */
    function trickle() {
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        const body = new ReadableStream<Uint8Array>({
            start(value) {
                controller = value;
            },
        });
        return {
            respond(init: RequestInit) {
                init.signal?.addEventListener("abort", () =>
                    controller.error(new DOMException("Aborted", "AbortError")),
                );
                return new Response(body);
            },
            push: (text: string) => controller.enqueue(new TextEncoder().encode(text)),
            end: () => controller.close(),
        };
    }

    it("keeps a long transfer alive while data arrives and fails one that stalls", async () => {
        vi.useFakeTimers();
        const steady = trickle();
        const stalled = trickle();
        const replies = [steady, stalled];
        vi.stubGlobal(
            "fetch",
            vi.fn(async (url: string, init: RequestInit) =>
                url.endsWith("/api/handshake")
                    ? response(handshake)
                    : replies.shift()!.respond(init),
            ),
        );
        const client = new PluginClient("https://example.test", "");
        await client.handshake();
        const read = client.catalogStatus();
        const json = JSON.stringify({ serverId: "test", sourceHash: "sha256:" + "4".repeat(64) });
        // Forty seconds in total, never more than ten without data: longer than the old fixed deadline.
        for (const piece of json.match(/.{1,16}/g)!) {
            await vi.advanceTimersByTimeAsync(10_000);
            steady.push(piece);
        }
        steady.end();
        await expect(read).resolves.toMatchObject({ serverId: "test" });

        const stalledRead = client.catalogStatus();
        const failure = expect(stalledRead).rejects.toThrow("REQUEST_TIMEOUT");
        stalled.push("{");
        await vi.advanceTimersByTimeAsync(15_001);
        await failure;
    });
});

describe("previews by snapshot reference", () => {
    it("send a large document only when the plugin does not hold it", async () => {
        const document = sized(400 * 1024);
        const requests: Record<string, unknown>[] = [];
        let known = false;
        const artifact = (request: Record<string, unknown>) => ({
            schemaVersion: 1,
            origin: "agent",
            itemId: request.itemId,
            viewer: request.viewer,
            display: null,
            fidelity: [],
            diagnostics: [],
            digests: { snapshot: request.snapshotHash },
            failure: null,
        });
        vi.stubGlobal(
            "fetch",
            vi.fn(async (url: string, init: RequestInit) => {
                if (url.endsWith("/api/handshake"))
                    return response({
                        ...handshake,
                        capabilities: [...handshake.capabilities, "preview.compile", "preview.snapshot-reference"],
                    });
                const body = JSON.parse(String(init.body));
                requests.push(body);
                if (!body.document && !known)
                    return response({ code: "SNAPSHOT_UNKNOWN" }, 409);
                known = true;
                return response({ artifact: artifact(body), stale: false });
            }),
        );
        const client = new PluginClient("https://example.test", "");
        await client.handshake();
        const request = {
            document,
            itemId: "itemerness:ember-blade",
            viewer: {
                locale: "en_us",
                requestedTheme: null,
                assetProfile: null,
                capabilities: [],
                metricsRevision: null,
                resourcePackLoaded: false,
                managesVanillaTooltipLines: false,
                direction: "LEFT_TO_RIGHT" as const,
            },
            snapshotHash: contentHash(document),
            targetServerId: "test",
        };
        await client.preview(request);
        expect(requests.map((body) => "document" in body)).toEqual([false, true]);
        await client.preview({ ...request, itemId: "itemerness:travel-token" });
        expect(requests.map((body) => "document" in body)).toEqual([false, true, false]);
    });
});
