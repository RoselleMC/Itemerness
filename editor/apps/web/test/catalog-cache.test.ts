import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunoRpgCatalog } from "@itemerness/protocol";
import {
    loadRunoRpgCatalog,
    resetRunoRpgCatalogCache,
} from "../src/features/runorpg/catalogCache.js";

const catalog: RunoRpgCatalog = {
    available: true,
    writable: true,
    items: [],
    attributes: [],
    diagnostics: [],
};

afterEach(() => {
    resetRunoRpgCatalogCache();
    vi.unstubAllGlobals();
});

describe("RunoRPG catalog session cache", () => {
    it("shares one request across callers and reuses the resolved catalog", async () => {
        const fetchMock = vi.fn(
            async () =>
                new Response(JSON.stringify(catalog), {
                    status: 200,
                    headers: { "content-type": "application/json" },
                }),
        );
        vi.stubGlobal("fetch", fetchMock);

        const first = loadRunoRpgCatalog();
        const second = loadRunoRpgCatalog();

        await expect(first).resolves.toEqual(catalog);
        await expect(second).resolves.toEqual(catalog);
        await expect(loadRunoRpgCatalog()).resolves.toEqual(catalog);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("requests fresh data only when force is explicit", async () => {
        const fetchMock = vi.fn(
            async () => new Response(JSON.stringify(catalog), { status: 200 }),
        );
        vi.stubGlobal("fetch", fetchMock);

        await loadRunoRpgCatalog();
        await loadRunoRpgCatalog(true);

        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
});
