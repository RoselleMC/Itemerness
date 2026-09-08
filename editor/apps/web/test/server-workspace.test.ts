import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { zipSync } from "fflate";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import {
    defaultWorkspaceSettings,
    loadServerWorkspace,
    saveServerWorkspace,
    persistentServerId,
    type ServerWorkspace,
} from "../src/api/serverWorkspace.js";
import {
    startServerWorkspace,
    flushServerWorkspace,
    useServerWorkspaceState,
    updateWorkspaceSettings,
    forgetServerWorkspace,
} from "../src/state/serverWorkspace.js";
import { useEditorStore } from "../src/state/store.js";
import { resetAssetMounts, useAssetMounts } from "../src/state/assetMounts.js";
import type { PackSource } from "../src/api/packSources.js";

vi.mock("../src/api/serverWorkspace.js", async (original) => ({
    ...(await original<object>()),
    loadServerWorkspace: vi.fn(),
    saveServerWorkspace: vi.fn(),
}));
vi.mock("../src/api/vanillaAssets.js", () => ({
    fetchVanillaBundle: vi.fn(),
    isVanillaVersion: () => true,
}));
let stop: (() => void) | undefined;
const id = "0807ed00-2fd5-45d6-8214-16b77148533e";
const other = "d94af8ea-843a-4c1c-8bd8-24c8a1e5bb62";
function source(name: string, missing = false): PackSource {
    return {
        id: name,
        name,
        path: `/packs/${name}`,
        kind: "archive",
        native: true,
        reloadable: true,
        read: vi.fn(async () => {
            if (missing) throw new Error("Missing file");
            return zipSync({
                "pack.mcmeta": new TextEncoder().encode(
                    JSON.stringify({
                        pack: { pack_format: 84, description: name },
                    }),
                ),
            });
        }),
        stamp: async () => "1",
        watch: vi.fn(async () => {}),
        release: vi.fn(),
    };
}
const ready = () =>
    vi.waitFor(() =>
        expect(["saving", "ready"]).toContain(
            useServerWorkspaceState.getState().status,
        ),
    );
beforeEach(() => {
    vi.stubGlobal("window", new EventTarget());
    resetAssetMounts();
    useEditorStore.getState().resetDraft();
    useEditorStore.getState().setDocument(structuredClone(baselineDocument));
    vi.mocked(loadServerWorkspace).mockReset().mockResolvedValue(null);
    vi.mocked(saveServerWorkspace).mockReset().mockResolvedValue();
});
afterEach(async () => {
    stop?.();
    stop = undefined;
    await flushServerWorkspace();
    resetAssetMounts();
    vi.unstubAllGlobals();
});

it("requires an explicitly advertised canonical persistent identity", () => {
    expect(persistentServerId({ serverId: id, capabilities: [] })).toBeNull();
    expect(
        persistentServerId({
            serverId: "folia-25565",
            capabilities: ["server.identity.persistent"],
        }),
    ).toBeNull();
    expect(
        persistentServerId({
            serverId: id,
            capabilities: ["server.identity.persistent"],
        }),
    ).toBe(id);
});

it("restores priority and watch preferences without modifying or recording authoring data", async () => {
    const first = source("first"),
        second = source("second");
    const settings = defaultWorkspaceSettings();
    settings.preview = {
        ...settings.preview,
        annotations: true,
        guiScale: 2,
        zoomMode: "manual",
    };
    vi.mocked(loadServerWorkspace).mockResolvedValue({
        settings,
        mounts: [
            { source: first, autoReload: false },
            { source: second, autoReload: true },
        ],
    });
    const before = useEditorStore.getState().document;
    stop = startServerWorkspace(id, useEditorStore.getState().workspaceEpoch);
    await ready();
    await flushServerWorkspace();
    expect(useEditorStore.getState().packs.map((p) => p.pack.name)).toEqual([
        "first",
        "second",
    ]);
    expect(first.watch).toHaveBeenCalledWith(false);
    expect(second.watch).toHaveBeenCalledWith(true);
    expect(useEditorStore.getState().annotations).toBe(true);
    expect(useEditorStore.getState().guiScale).toBe(2);
    expect(useEditorStore.getState().document).toBe(before);
    const saved = vi.mocked(saveServerWorkspace).mock.lastCall!;
    expect(saved[0]).toBe(id);
    expect(Object.keys(saved[1]).sort()).toEqual(["mounts", "settings"]);
    expect(saved[1].mounts.map((m) => m.source.name)).toEqual([
        "first",
        "second",
    ]);
    expect(useEditorStore.getState().canUndo).toBe(false);
});

it("keeps missing paths available for retry instead of dropping their local record", async () => {
    vi.mocked(loadServerWorkspace).mockResolvedValue({
        settings: defaultWorkspaceSettings(),
        mounts: [{ source: source("missing", true), autoReload: false }],
    });
    stop = startServerWorkspace(id, useEditorStore.getState().workspaceEpoch);
    await ready();
    await flushServerWorkspace();
    expect(useAssetMounts.getState().sources[0]?.status).toBe("error");
    expect(
        vi.mocked(saveServerWorkspace).mock.lastCall![1].mounts[0]?.source.path,
    ).toBe("/packs/missing");
});

it("discards late restores after switching servers and flushes writes under their original identity", async () => {
    let resolve!: (value: ServerWorkspace) => void;
    vi.mocked(loadServerWorkspace).mockImplementationOnce(
        () =>
            new Promise((r) => {
                resolve = r;
            }),
    );
    stop = startServerWorkspace(id, useEditorStore.getState().workspaceEpoch);
    await vi.waitFor(() => expect(resolve).toBeDefined());
    stop();
    useEditorStore.getState().resetDraft();
    useEditorStore.getState().setDocument(structuredClone(baselineDocument));
    stop = startServerWorkspace(
        other,
        useEditorStore.getState().workspaceEpoch,
    );
    await ready();
    const old = source("old");
    resolve({
        settings: {
            ...defaultWorkspaceSettings(),
            preview: {
                ...defaultWorkspaceSettings().preview,
                annotations: true,
            },
        },
        mounts: [{ source: old, autoReload: true }],
    });
    await vi.waitFor(() => expect(old.release).toHaveBeenCalled());
    expect(useEditorStore.getState().packs).toHaveLength(0);
    expect(useEditorStore.getState().annotations).toBe(false);
    updateWorkspaceSettings({ remember: false });
    stop();
    stop = undefined;
    useEditorStore.getState().resetDraft();
    await flushServerWorkspace();
    expect(vi.mocked(saveServerWorkspace).mock.lastCall![0]).toBe(other);
    expect(
        vi.mocked(saveServerWorkspace).mock.lastCall![1].settings.remember,
    ).toBe(false);
});

it("does not overwrite explicit view changes made while a record loads", async () => {
    let resolve!: (value: ServerWorkspace) => void;
    vi.mocked(loadServerWorkspace).mockImplementationOnce(
        () =>
            new Promise((r) => {
                resolve = r;
            }),
    );
    stop = startServerWorkspace(id, useEditorStore.getState().workspaceEpoch);
    await vi.waitFor(() => expect(resolve).toBeDefined());
    useEditorStore.getState().setGuiScale(4);
    resolve({ settings: defaultWorkspaceSettings(), mounts: [] });
    await ready();
    expect(useEditorStore.getState().guiScale).toBe(4);
    expect(useEditorStore.getState().zoomMode).toBe("manual");
});

it("does not overwrite an unreadable record automatically and permits explicit forgetting", async () => {
    vi.mocked(loadServerWorkspace).mockRejectedValue(
        new Error("WORKSPACE_INVALID"),
    );
    const epoch = useEditorStore.getState().workspaceEpoch;
    stop = startServerWorkspace(id, epoch);
    await vi.waitFor(() =>
        expect(useServerWorkspaceState.getState().status).toBe("error"),
    );
    await flushServerWorkspace();
    expect(saveServerWorkspace).not.toHaveBeenCalled();
    await forgetServerWorkspace(id, epoch);
    expect(vi.mocked(saveServerWorkspace).mock.lastCall![1]).toEqual({
        settings: { ...defaultWorkspaceSettings(), remember: false },
        mounts: [],
    });
    expect(useServerWorkspaceState.getState().status).toBe("ready");
});
