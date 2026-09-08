import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Handshake } from "@itemerness/protocol";

const KEY = "itemerness.connection-history.v1";
const values = new Map<string, string>();
const info = (serverId: string): Handshake => ({
    product: "itemerness",
    serverId,
    serverAlias: "Test server",
    pluginVersion: "0.1.0",
    minecraftVersion: "26.1.2",
    platform: "Folia",
    compilerDigest: "sha256:" + "0".repeat(64),
    protocols: [{ major: 2, minMinor: 0, maxMinor: 0 }],
    documentSchemas: [1],
    previewSchemas: [1],
    capabilities: ["server.identity.persistent"],
});
beforeEach(() => {
    vi.resetModules();
    values.clear();
    vi.stubGlobal("localStorage", {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
    });
});
afterEach(() => vi.unstubAllGlobals());

it("groups by installation, bounds history and reassigns reused addresses", async () => {
    const { useConnectionHistory } =
        await import("../src/state/connectionHistory.js");
    const history = useConnectionHistory.getState();
    for (let i = 0; i < 25; i++)
        history.remember(info(`server-${i}`), `https://server-${i}.test`);
    expect(useConnectionHistory.getState().entries).toHaveLength(20);
    for (let i = 0; i < 7; i++)
        history.remember(info("same"), `https://address-${i}.test/`);
    const group = useConnectionHistory.getState().entries[0]!;
    expect(group.addresses).toHaveLength(5);
    expect(group.addresses[0]!.url).toBe("https://address-6.test");
    history.remember(info("replacement"), "https://address-6.test");
    expect(
        useConnectionHistory
            .getState()
            .entries.find((entry) => entry.key === "same")?.addresses,
    ).toHaveLength(4);
    expect(JSON.parse(values.get(KEY)!)).toEqual(
        useConnectionHistory.getState().entries,
    );
});

it("forgetting an address also removes the remembered launch address without removing siblings", async () => {
    const { useConnectionHistory } =
        await import("../src/state/connectionHistory.js");
    const history = useConnectionHistory.getState();
    history.remember(info("same"), "https://one.test");
    history.remember(info("same"), "https://two.test");
    values.set("itemerness.api-url", "https://two.test");
    history.remove("same", "https://two.test");
    expect(values.has("itemerness.api-url")).toBe(false);
    expect(
        useConnectionHistory
            .getState()
            .entries[0]!.addresses.map((address) => address.url),
    ).toEqual(["https://one.test"]);
    history.remove("same");
    expect(useConnectionHistory.getState().entries).toEqual([]);
});

it("reads only bounded display metadata and rejects unusable dates and credential-bearing addresses", async () => {
    values.set(
        KEY,
        JSON.stringify([
            {
                serverId: "same",
                name: "Test",
                platform: "Folia",
                persistent: true,
                token: "must-not-be-restored",
                addresses: [
                    {
                        url: "https://valid.test/",
                        lastUsedAt: 42,
                        token: "secret",
                    },
                    {
                        url: "https://invalid-date.test",
                        lastUsedAt: Number.MAX_SAFE_INTEGER,
                    },
                    {
                        url: "https://user:password@invalid.test",
                        lastUsedAt: 42,
                    },
                ],
            },
        ]),
    );
    const { useConnectionHistory } =
        await import("../src/state/connectionHistory.js");
    expect(useConnectionHistory.getState().entries).toEqual([
        {
            key: "same",
            serverId: "same",
            name: "Test",
            platform: "Folia",
            persistent: true,
            addresses: [{ url: "https://valid.test", lastUsedAt: 42 }],
        },
    ]);
});
