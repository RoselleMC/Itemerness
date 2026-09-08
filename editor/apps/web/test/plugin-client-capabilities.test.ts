import { afterEach, describe, expect, it, vi } from "vitest";
import {
    contentHash,
    previewViewerSchema,
    SEGMENTED_FRAME_DECORATIONS_CAPABILITY,
    EXTENDED_BASE_COMPONENTS_CAPABILITY,
    type ProjectDocument,
    type PreviewRequest,
} from "@itemerness/protocol";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import { PluginClient } from "../src/api/client.js";

const handshake = {
    product: "itemerness",
    authentication: "none",
    serverId: "test",
    pluginVersion: "999.0.0",
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
        "catalog.export",
    ],
};
const response = (body: unknown) => new Response(JSON.stringify(body));
const operations = ["save", "preview", "export"] as const;
type Operation = (typeof operations)[number];

function previewRequest(document: ProjectDocument): PreviewRequest {
    return {
        document,
        itemId: "itemerness:test",
        viewer: previewViewerSchema.parse({ locale: "en_us" }),
        snapshotHash: contentHash(document),
        targetServerId: "test",
    };
}

function send(
    client: PluginClient,
    operation: Operation,
    document: ProjectDocument,
) {
    switch (operation) {
        case "save":
            return client.saveDocument(document, contentHash(document));
        case "preview":
            return client.preview(previewRequest(document));
        case "export":
            return client.exportCatalog(document, "test");
    }
}

function reply(operation: Operation, document: ProjectDocument) {
    if (operation === "save")
        return {
            snapshotHash: contentHash(document),
            revision: 54,
            diagnostics: [],
        };
    if (operation === "export")
        return { files: [], settingsPatch: "", diagnostics: [] };
    const request = previewRequest(document);
    return {
        artifact: {
            schemaVersion: 1,
            origin: "agent",
            itemId: request.itemId,
            viewer: request.viewer,
            display: null,
            fidelity: [],
            digests: { snapshot: request.snapshotHash },
        },
        stale: false,
    };
}

const variants: Array<[string, (document: ProjectDocument) => void]> = [
    ...(["top", "body", "connector", "bottom"] as const).flatMap((row) =>
        (["center", "kern"] as const).flatMap((field) =>
            [null, "frame.decoration"].map(
                (value): [string, (document: ProjectDocument) => void] => [
                    `${row}.${field}=${value}`,
                    (document) => {
                        document.themes.find(
                            (theme) => theme.segmentedFrame,
                        )!.segmentedFrame![row]![field] = value;
                    },
                ],
            ),
        ),
    ),
    ...[false, true].map(
        (value): [string, (document: ProjectDocument) => void] => [
            `includeName=${value}`,
            (document) => {
                document.themes.find(
                    (theme) => theme.segmentedFrame,
                )!.segmentedFrame!.includeName = value;
            },
        ],
    ),
    [
        "segmented tooltip style",
        (document) => {
            document.themes.find(
                (theme) => theme.segmentedFrame,
            )!.tooltipStyle = "example:custom";
        },
    ],
    [
        "inactive frame null decoration",
        (document) => {
            const theme = document.themes.find(
                (entry) => entry.segmentedFrame,
            )!;
            theme.renderer = "NATIVE_TOOLTIP_STYLE";
            theme.segmentedFrame!.top.center = null;
        },
    ],
];

afterEach(() => vi.unstubAllGlobals());

describe.each(operations)("%s document capability gate", (operation) => {
    it.each([
        "minecraft:attribute_modifiers",
        "minecraft:enchantments",
        "minecraft:stored_enchantments",
    ])(
        "gates %s by its exact capability without rewriting empty values",
        async (id) => {
            const document = structuredClone(baselineDocument);
            document.items[0]!.enabled = false;
            document.items[0]!.definition.baseComponents = [
                {
                    id,
                    value:
                        id === "minecraft:attribute_modifiers"
                            ? { kind: "list", values: [] }
                            : { kind: "compound", entries: {} },
                },
            ];
            const hash = contentHash(document);
            const fetch = vi.fn().mockResolvedValueOnce(response(handshake));
            vi.stubGlobal("fetch", fetch);
            const old = new PluginClient("http://example.test", "");
            await old.handshake();
            await expect(send(old, operation, document)).rejects.toThrow(
                "EXTENDED_BASE_COMPONENTS_UNSUPPORTED",
            );
            expect(fetch).toHaveBeenCalledTimes(1);
            fetch
                .mockResolvedValueOnce(
                    response({
                        ...handshake,
                        capabilities: [
                            ...handshake.capabilities,
                            EXTENDED_BASE_COMPONENTS_CAPABILITY,
                        ],
                    }),
                )
                .mockResolvedValueOnce(response(reply(operation, document)));
            const current = new PluginClient("http://example.test", "");
            await current.handshake();
            await send(current, operation, document);
            expect(fetch).toHaveBeenCalledTimes(3);
            expect(JSON.parse(fetch.mock.calls[2]![1].body).document).toEqual(
                document,
            );
            expect(contentHash(document)).toBe(hash);
        },
    );
    it("sends a legacy document to an old peer without changing its hash", async () => {
        const document = structuredClone(baselineDocument);
        const hash = contentHash(document);
        const fetch = vi
            .fn()
            .mockResolvedValueOnce(response(handshake))
            .mockResolvedValueOnce(response(reply(operation, document)));
        vi.stubGlobal("fetch", fetch);
        const client = new PluginClient("http://example.test", "");
        await client.handshake();
        await send(client, operation, document);
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(JSON.parse(fetch.mock.calls[1]![1].body).document).toEqual(
            document,
        );
        expect(contentHash(document)).toBe(hash);
    });

    it.each(variants)(
        "rejects %s before sending to an old peer",
        async (_, mutate) => {
            const document = structuredClone(baselineDocument);
            mutate(document);
            const hash = contentHash(document);
            const fetch = vi.fn().mockResolvedValueOnce(response(handshake));
            vi.stubGlobal("fetch", fetch);
            const client = new PluginClient("http://example.test", "");
            await client.handshake();
            await expect(send(client, operation, document)).rejects.toThrow(
                "SEGMENTED_FRAME_DECORATIONS_UNSUPPORTED",
            );
            expect(fetch).toHaveBeenCalledTimes(1);
            expect(contentHash(document)).toBe(hash);
        },
    );

    it.each(variants)(
        "sends %s only when the exact capability is advertised",
        async (_, mutate) => {
            const document = structuredClone(baselineDocument);
            mutate(document);
            const fetch = vi
                .fn()
                .mockResolvedValueOnce(
                    response({
                        ...handshake,
                        pluginVersion: "0.1.0",
                        capabilities: [
                            ...handshake.capabilities,
                            SEGMENTED_FRAME_DECORATIONS_CAPABILITY,
                        ],
                    }),
                )
                .mockResolvedValueOnce(response(reply(operation, document)));
            vi.stubGlobal("fetch", fetch);
            const client = new PluginClient("http://example.test", "");
            await client.handshake();
            await send(client, operation, document);
            expect(fetch).toHaveBeenCalledTimes(2);
            expect(JSON.parse(fetch.mock.calls[1]![1].body).document).toEqual(
                document,
            );
        },
    );
});

it("can read an unsupported feature without altering its CAS snapshot, but cannot send it", async () => {
    const document = structuredClone(baselineDocument);
    document.themes.find(
        (theme) => theme.segmentedFrame,
    )!.segmentedFrame!.includeName = false;
    const snapshotHash = contentHash(document);
    const fetch = vi
        .fn()
        .mockResolvedValueOnce(response(handshake))
        .mockResolvedValueOnce(
            response({ document, snapshotHash, revision: 54 }),
        );
    vi.stubGlobal("fetch", fetch);
    const client = new PluginClient("http://example.test", "");
    await client.handshake();
    const loaded = (await client.loadDocument())!;
    expect(loaded).toEqual({ document, snapshotHash, revision: 54 });
    await expect(
        client.saveDocument(loaded.document, loaded.snapshotHash),
    ).rejects.toThrow("SEGMENTED_FRAME_DECORATIONS_UNSUPPORTED");
    expect(fetch).toHaveBeenCalledTimes(2);
});
