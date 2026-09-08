import { describe, expect, it, vi } from "vitest";
import {
    contentHash,
    previewArtifactSchema,
    previewViewerSchema,
    type PreviewRequest,
} from "@itemerness/protocol";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import { PreviewCache, previewKey } from "../src/api/previewCache.js";
import type { PluginClient } from "../src/api/client.js";

type Result = Awaited<ReturnType<PluginClient["preview"]>>;
const request = (id = "travel-token"): PreviewRequest => ({
    document: baselineDocument,
    itemId: `itemerness:${id}`,
    viewer: previewViewerSchema.parse({ locale: "en_us" }),
    snapshotHash: contentHash(baselineDocument),
    targetServerId: "test",
});
function result(input: PreviewRequest): Result {
    return {
        stale: false,
        artifact: previewArtifactSchema.parse({
            schemaVersion: 1,
            origin: "agent",
            itemId: input.itemId,
            viewer: input.viewer,
            display: {
                displayName: {
                    runs: [],
                    logicalWidthPixels: 0,
                    visualBounds: { left: 0, right: 0, top: 0, bottom: 0 },
                },
                lore: [],
                tooltipStyle: null,
                renderer: "PLAIN",
                selectedTheme: "itemerness:default",
                requestedTheme: "itemerness:default",
                catalogRevision: 1,
            },
            fidelity: [],
            diagnostics: [],
            digests: { snapshot: input.snapshotHash },
            failure: null,
        }),
    };
}

describe("connection-owned preview cache", () => {
    it("does not verify or cache a display accompanied by blocking diagnostics", async () => {
        const input = request();
        const response = result(input);
        response.artifact.diagnostics.push({
            code: "CATALOG.INVALID_SCOPE",
            severity: "ERROR",
            origin: "agent",
            messageKey: "diagnostics.catalog.invalid_scope",
            params: { detail: "Data key is not presentation-readable" },
            pointer: null,
            nodeUuid: null,
            businessId: null,
            targetServerId: null,
            fixKey: null,
        });
        const cache = new PreviewCache(async () => response);
        await cache.load(input);
        expect(cache.status(previewKey(input))).toBe("error");
        expect(cache.peek(previewKey(input))).toBeUndefined();
    });
    it("notifies item status subscribers without confusing different preview contexts", async () => {
        let resolve!: (value: Result) => void;
        const cache = new PreviewCache(
            () =>
                new Promise<Result>((done) => {
                    resolve = done;
                }),
        );
        const changed = vi.fn();
        const unsubscribe = cache.subscribe(changed);
        const input = request();
        const key = previewKey(input);
        expect(cache.status(key)).toBe("unverified");
        const pending = cache.load(input);
        expect(cache.status(key)).toBe("pending");
        expect(changed).toHaveBeenCalledTimes(1);
        resolve(result(input));
        await pending;
        expect(cache.status(key)).toBe("verified");
        expect(changed).toHaveBeenCalledTimes(2);
        expect(
            cache.status(previewKey({ ...input, snapshotHash: "different" })),
        ).toBe("unverified");
        cache.clear();
        expect(cache.status(key)).toBe("unverified");
        unsubscribe();
        const calls = changed.mock.calls.length;
        cache.clear();
        expect(changed).toHaveBeenCalledTimes(calls);
    });
    it("reserves a slot for foreground work while warming is in flight", async () => {
        const waiting: Array<{
            request: PreviewRequest;
            resolve: (value: Result) => void;
        }> = [];
        const cache = new PreviewCache(
            (input) =>
                new Promise<Result>((resolve) =>
                    waiting.push({ request: input, resolve }),
                ),
        );
        const first = cache.load(request("a"));
        const second = cache.load(request("b"));
        expect(waiting.map((entry) => entry.request.itemId)).toEqual([
            "itemerness:a",
        ]);
        const selected = cache.load(request("selected"), true);
        expect(waiting.map((entry) => entry.request.itemId)).toEqual([
            "itemerness:a",
            "itemerness:selected",
        ]);
        waiting[0]!.resolve(result(waiting[0]!.request));
        await first;
        waiting[1]!.resolve(result(waiting[1]!.request));
        waiting[2]!.resolve(result(waiting[2]!.request));
        await second;
        await selected;
    });
    it("coalesces in-flight work and keys completed results by item, document, and viewer", async () => {
        const compile = vi.fn(async (input: PreviewRequest) => result(input));
        const cache = new PreviewCache(compile);
        const input = request();
        const a = cache.load(input);
        const b = cache.load(input);
        expect(a).toBe(b);
        await a;
        expect(cache.peek(previewKey(input))).toBeDefined();
        await cache.load(input);
        expect(compile).toHaveBeenCalledTimes(1);
        await cache.load({
            ...input,
            viewer: { ...input.viewer, locale: "zh_cn" },
        });
        await cache.load({ ...input, snapshotHash: "sha256:changed" });
        await cache.load(request("ember-blade"));
        expect(compile).toHaveBeenCalledTimes(4);
    });

    it("limits concurrency and promotes the selected item ahead of queued warming", async () => {
        const waiting: {
            request: PreviewRequest;
            resolve: (result: Result) => void;
        }[] = [];
        const compile = vi.fn(
            (input: PreviewRequest) =>
                new Promise<Result>((resolve) =>
                    waiting.push({ request: input, resolve }),
                ),
        );
        const cache = new PreviewCache(compile);
        const jobs = [
            cache.load(request("a"), true),
            cache.load(request("b")),
            cache.load(request("c")),
            cache.load(request("d")),
        ];
        cache.load(request("d"), true);
        expect(compile).toHaveBeenCalledTimes(2);
        waiting[0]!.resolve(result(waiting[0]!.request));
        await jobs[0];
        expect(waiting[2]!.request.itemId).toBe("itemerness:d");
        waiting[1]!.resolve(result(waiting[1]!.request));
        await jobs[1];
        expect(waiting[3]!.request.itemId).toBe("itemerness:c");
        for (const pending of waiting.slice(2))
            pending.resolve(result(pending.request));
        await Promise.all(jobs);
    });

    it("clears a session and rejects late work even when the transport ignores cancellation", async () => {
        let finish!: (result: Result) => void;
        const cache = new PreviewCache(
            () =>
                new Promise<Result>((resolve) => {
                    finish = resolve;
                }),
        );
        const input = request();
        const failed = expect(cache.load(input)).rejects.toMatchObject({
            name: "AbortError",
        });
        cache.clear();
        finish(result(input));
        await failed;
        expect(cache.peek(previewKey(input))).toBeUndefined();
    });

    it("bounds LRU storage and never caches stale or failed artifacts", async () => {
        const compile = vi.fn(async (input: PreviewRequest) => result(input));
        const cache = new PreviewCache(compile, 2);
        await cache.load(request("a"));
        await cache.load(request("b"));
        await cache.load(request("a"));
        await cache.load(request("c"));
        expect(cache.peek(previewKey(request("b")))).toBeUndefined();
        compile.mockImplementationOnce(async (input) => ({
            ...result(input),
            stale: true,
        }));
        await cache.load(request("d"));
        expect(cache.peek(previewKey(request("d")))).toBeUndefined();
        compile.mockRejectedValueOnce(new Error("unavailable"));
        await expect(cache.load(request("e"))).rejects.toThrow("unavailable");
        expect(cache.peek(previewKey(request("e")))).toBeUndefined();
        cache.clear();
        expect(cache.peek(previewKey(request("a")))).toBeUndefined();
    });
});
