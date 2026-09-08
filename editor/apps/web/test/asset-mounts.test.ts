import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { zipSync } from "fflate";
import { mountArchive, packDescription } from "@itemerness/mc-assets";
import {
    addPackSources,
    configureWatch,
    loadVanilla,
    pollPackSources,
    reloadPackSource,
    removePackSource,
    resetAssetMounts,
    schedulePackReload,
    setPackAutoReload,
    useAssetMounts,
} from "../src/state/assetMounts.js";
import { useEditorStore } from "../src/state/store.js";
import { useToasts, notify, dismissToast } from "../src/state/toasts.js";
import { validPackCheckInterval } from "../src/state/preferences.js";
import type { PackSource } from "../src/api/packSources.js";
import { fetchVanillaBundle } from "../src/api/vanillaAssets.js";
vi.mock("../src/api/vanillaAssets.js", () => ({
    fetchVanillaBundle: vi.fn(),
    isVanillaVersion: (value: string) =>
        ["1.21.11", "26.1.1", "26.1.2", "26.2"].includes(value),
}));

const bytes = (value = "first") =>
    zipSync(
        {
            "pack.mcmeta": new TextEncoder().encode(
                JSON.stringify({
                    pack: { pack_format: 84, description: value },
                }),
            ),
        },
        { mtime: new Date("1980-01-01") },
    );
function source(id = "a") {
    let data = bytes(),
        stamp = "first";
    const value: PackSource = {
        id,
        name: `${id}.zip`,
        path: `/packs/${id}.zip`,
        native: false,
        kind: "archive",
        reloadable: true,
        read: vi.fn(async () => data),
        stamp: vi.fn(async () => stamp),
        watch: vi.fn(async () => {}),
        release: vi.fn(),
    };
    return {
        value,
        change(next: Uint8Array, revision = "next") {
            data = next;
            stamp = revision;
        },
    };
}
beforeEach(() => {
    resetAssetMounts();
    useEditorStore.getState().resetDraft();
    vi.clearAllMocks();
});
afterEach(() => {
    resetAssetMounts();
    vi.useRealTimers();
});

describe("path-backed pack lifecycle", () => {
    it("keeps one bottom vanilla and preserves custom priorities across reloads", async () => {
        const a = source("a"),
            b = source("b");
        await addPackSources([a.value, b.value]);
        const state = useEditorStore.getState();
        state.mountPack(bytes("vanilla1"), "vanilla1", "vanilla");
        state.mountPack(bytes("vanilla2"), "vanilla2", "vanilla");
        state.movePackTo(2, 0);
        state.movePackTo(0, 2);
        expect(
            useEditorStore.getState().packs.map((slot) => slot.pack.name),
        ).toEqual(["b.zip", "a.zip", "vanilla2"]);
        const old = useEditorStore.getState().packs[1]!.pack;
        a.change(bytes("changed"));
        await reloadPackSource("a");
        expect(
            useEditorStore.getState().packs.map((slot) => slot.pack.name),
        ).toEqual(["b.zip", "a.zip", "vanilla2"]);
        expect(useEditorStore.getState().packs[1]!.pack.id).not.toBe(old.id);
        expect(useEditorStore.getState().canUndo).toBe(false);
    });
    it("distinguishes two paths with identical bytes and removes only their own content", async () => {
        await addPackSources([source("a").value, source("b").value]);
        expect(useEditorStore.getState().packs).toHaveLength(2);
        removePackSource("a");
        expect(
            useEditorStore.getState().packs.map((slot) => slot.pack.name),
        ).toEqual(["b.zip"]);
    });
    it("coalesces file events, only toasts content changes, and preserves exact immutable packs on no-op", async () => {
        vi.useFakeTimers();
        const a = source();
        await addPackSources([a.value]);
        useToasts.setState({ notices: [] });
        const previous = useEditorStore.getState().packs;
        const loadedAt = useAssetMounts.getState().sources[0]!.loadedAt;
        schedulePackReload("a");
        schedulePackReload("a");
        schedulePackReload("a");
        await vi.advanceTimersByTimeAsync(250);
        expect(a.value.read).toHaveBeenCalledTimes(2);
        expect(useEditorStore.getState().packs).toBe(previous);
        expect(useToasts.getState().notices).toHaveLength(0);
        expect(useAssetMounts.getState().sources[0]!.loadedAt).toBe(loadedAt);
        a.change(bytes("second"));
        await pollPackSources();
        await vi.advanceTimersByTimeAsync(250);
        expect(useToasts.getState().notices).toHaveLength(1);
        expect(useAssetMounts.getState().sources[0]!.status).toBe("ready");
    });
    it("does not postpone an already scheduled reload during frequent polling", async () => {
        vi.useFakeTimers();
        const a = source();
        await addPackSources([a.value]);
        a.change(bytes("second"));
        await pollPackSources();
        await vi.advanceTimersByTimeAsync(200);
        await pollPackSources();
        await vi.advanceTimersByTimeAsync(50);
        expect(a.value.read).toHaveBeenCalledTimes(2);
        expect(useAssetMounts.getState().sources[0]!.status).toBe("ready");
    });
    it("retains last good bytes after invalid writes and recovers on a later change without retry storms", async () => {
        vi.useFakeTimers();
        const a = source();
        await addPackSources([a.value]);
        const before = useEditorStore.getState().packs;
        a.change(new Uint8Array([1, 2, 3]), "invalid");
        await reloadPackSource("a", true);
        expect(useEditorStore.getState().packs).toBe(before);
        expect(useAssetMounts.getState().sources[0]!.status).toBe("error");
        await pollPackSources();
        await vi.advanceTimersByTimeAsync(2000);
        expect(a.value.read).toHaveBeenCalledTimes(2);
        a.change(bytes("repaired"), "fixed");
        await pollPackSources();
        await vi.advanceTimersByTimeAsync(250);
        expect(useAssetMounts.getState().sources[0]!.status).toBe("ready");
        expect(useEditorStore.getState().mountError).toBeNull();
    });
    it("rejects a changing snapshot and disables queued automatic work", async () => {
        vi.useFakeTimers();
        const a = source();
        await addPackSources([a.value]);
        vi.mocked(a.value.stamp)
            .mockResolvedValueOnce("before")
            .mockResolvedValueOnce("after");
        await reloadPackSource("a");
        expect(useAssetMounts.getState().sources[0]!.error).toBe(
            "PACK_CHANGED_DURING_READ",
        );
        schedulePackReload("a");
        setPackAutoReload("a", false);
        await vi.advanceTimersByTimeAsync(1000);
        expect(a.value.read).toHaveBeenCalledTimes(2);
        expect(a.value.watch).toHaveBeenLastCalledWith(false);
    });
    it("does not revive removed sources or a previous workspace after pending reads finish", async () => {
        const a = source();
        let finish!: (value: Uint8Array) => void;
        vi.mocked(a.value.read).mockImplementation(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        const work = addPackSources([a.value]);
        await Promise.resolve();
        await Promise.resolve();
        resetAssetMounts();
        useEditorStore.getState().resetDraft();
        finish(bytes());
        await work;
        expect(useEditorStore.getState().packs).toHaveLength(0);
        expect(useAssetMounts.getState().sources).toHaveLength(0);
        expect(a.value.release).toHaveBeenCalledOnce();
        expect(useToasts.getState().notices).toHaveLength(0);
    });
    it("reports native watcher degradation without dropping valid resources", async () => {
        const a = source();
        await addPackSources([a.value]);
        vi.mocked(a.value.watch).mockRejectedValue(new Error("Unavailable"));
        await configureWatch("a");
        expect(useAssetMounts.getState().sources[0]).toMatchObject({
            status: "ready",
            watchError: true,
        });
        expect(useEditorStore.getState().packs).toHaveLength(1);
    });
});

it("never installs a superseded vanilla version or a result from an old workspace", async () => {
    const pending = new Map<string, (bytes: Uint8Array) => void>();
    vi.mocked(fetchVanillaBundle).mockImplementation(
        (version) => new Promise((resolve) => pending.set(version!, resolve)),
    );
    const first = loadVanilla("26.1.2"),
        second = loadVanilla("26.2");
    pending.get("26.2")!(bytes("new"));
    await second;
    pending.get("26.1.2")!(bytes("old"));
    await first;
    expect(
        useEditorStore.getState().packs.map((slot) => slot.pack.name),
    ).toEqual(["vanilla-26.2"]);
    const third = loadVanilla("1.21.11");
    resetAssetMounts();
    useEditorStore.getState().resetDraft();
    pending.get("1.21.11")!(bytes());
    await third;
    expect(useEditorStore.getState().packs).toHaveLength(0);
});

it("bounds toast stacks and replaces repeated operations without exposing clipboard contents", () => {
    notify("first", "success", "pack:a");
    notify("second", "success", "pack:a");
    expect(useToasts.getState().notices).toHaveLength(1);
    expect(useToasts.getState().notices[0]!.message).toBe("second");
    for (const id of ["b", "c", "d", "e"]) notify(id, "info", id);
    expect(useToasts.getState().notices.map((notice) => notice.id)).toEqual([
        "c",
        "d",
        "e",
    ]);
    dismissToast("d");
    expect(useToasts.getState().notices).toHaveLength(2);
});

it("bounds detection intervals and reads structured pack descriptions as text, not HTML", () => {
    for (const value of [250, 1000, 60000])
        expect(validPackCheckInterval(value)).toBe(true);
    for (const value of [NaN, Infinity, 0, 249, 60001, 1000.5])
        expect(validPackCheckInterval(value)).toBe(false);
    expect(
        packDescription({
            text: "Pack ",
            extra: [{ text: "name", color: "red" }, "\nDetails"],
        }),
    ).toBe("Pack name\nDetails");
    expect(packDescription("\u00a7aGreen <b>name</b>")).toBe(
        "Green <b>name</b>",
    );
    const pack = mountArchive(bytes(), { name: "safe.zip" });
    expect(pack.meta?.description).toBe("first");
});
