import { create } from "zustand";
import i18next from "i18next";
import { mountArchive } from "@itemerness/mc-assets";
import {
    fetchVanillaBundle,
    isVanillaVersion,
    type VanillaVersion,
    type VanillaPhase,
} from "../api/vanillaAssets.js";
import type { PackSource } from "../api/packSources.js";
import { useEditorStore } from "./store.js";
import { notify, useToasts } from "./toasts.js";

export interface SourceMount {
    source: PackSource;
    packId: string | null;
    status: "loading" | "ready" | "error";
    error: string | null;
    autoReload: boolean;
    watchError: boolean;
    loadedAt: number | null;
    stamp: string | null;
}
interface VanillaMount {
    version: VanillaVersion;
    status: "idle" | "loading" | "ready" | "error";
    phase: VanillaPhase;
    error: string | null;
}
const initialVanilla = (): VanillaMount => ({
    version: "26.1.2",
    status: "idle",
    phase: "cache",
    error: null,
});
export const useAssetMounts = create<{
    sources: SourceMount[];
    vanilla: VanillaMount;
}>(() => ({ sources: [], vanilla: initialVanilla() }));
let generation = 0;
let vanillaRequest = 0;
let vanillaAbort: AbortController | null = null;
const running = new Set<string>();
const pending = new Map<string, ReturnType<typeof setTimeout>>();
const queued = new Set<string>();
const checking = new Set<string>();
const find = (id: string) =>
    useAssetMounts.getState().sources.find((mount) => mount.source.id === id);
const update = (id: string, patch: Partial<SourceMount>) =>
    useAssetMounts.setState((state) => ({
        sources: state.sources.map((mount) =>
            mount.source.id === id ? { ...mount, ...patch } : mount,
        ),
    }));
const message = (key: string, name: string) =>
    String(i18next.t(`packManager:${key}`, { name }));

export function resetAssetMounts() {
    generation++;
    vanillaRequest++;
    vanillaAbort?.abort();
    vanillaAbort = null;
    for (const mount of useAssetMounts.getState().sources)
        mount.source.release();
    for (const timer of pending.values()) clearTimeout(timer);
    pending.clear();
    queued.clear();
    running.clear();
    checking.clear();
    useAssetMounts.setState({ sources: [], vanilla: initialVanilla() });
    useToasts.setState({ notices: [] });
}

export async function addPackSources(
    sources: PackSource[],
    expectedEpoch = useEditorStore.getState().workspaceEpoch,
    options: { autoReload?: boolean; quiet?: boolean } = {},
) {
    const epoch = generation;
    for (const source of sources) {
        if (
            epoch !== generation ||
            expectedEpoch !== useEditorStore.getState().workspaceEpoch
        ) {
            source.release();
            continue;
        }
        const existing = useAssetMounts
            .getState()
            .sources.find(
                (mount) =>
                    mount.source.id === source.id ||
                    (source.native && mount.source.path === source.path),
            );
        if (existing) {
            if (existing.source.id !== source.id) source.release();
            await reloadPackSource(existing.source.id);
            continue;
        }
        if (useAssetMounts.getState().sources.length >= 64) {
            source.release();
            notify(message("mountLimit", source.name), "error", "pack-import");
            continue;
        }
        useAssetMounts.setState((state) => ({
            sources: [
                ...state.sources,
                {
                    source,
                    packId: null,
                    status: "loading",
                    error: null,
                    autoReload:
                        source.reloadable && (options.autoReload ?? true),
                    watchError: false,
                    loadedAt: null,
                    stamp: null,
                },
            ],
        }));
        await reloadPackSource(source.id, false, options.quiet);
        if (epoch === generation && find(source.id))
            await configureWatch(source.id);
    }
}

export async function configureWatch(id: string) {
    const mount = find(id);
    if (!mount) return;
    try {
        await mount.source.watch(mount.autoReload);
        if (find(id)?.source === mount.source)
            update(id, { watchError: false });
    } catch {
        if (find(id)?.source === mount.source)
            update(id, { watchError: mount.autoReload });
    }
}

export function setPackAutoReload(id: string, enabled: boolean) {
    const mount = find(id);
    if (!mount?.source.reloadable) return;
    update(id, { autoReload: enabled });
    if (!enabled) {
        clearTimeout(pending.get(id));
        pending.delete(id);
        queued.delete(id);
    }
    void configureWatch(id);
    if (enabled) schedulePackReload(id);
}

export function schedulePackReload(id: string, debounce = true) {
    if (!find(id)?.autoReload) return;
    if (!debounce && pending.has(id)) return;
    clearTimeout(pending.get(id));
    pending.set(
        id,
        setTimeout(() => {
            pending.delete(id);
            void reloadPackSource(id, true);
        }, 250),
    );
}

export async function pollPackSources() {
    for (const mount of useAssetMounts.getState().sources) {
        const id = mount.source.id;
        if (!mount.autoReload || checking.has(id) || running.has(id)) continue;
        checking.add(id);
        try {
            const stamp = await mount.source.stamp();
            if (find(id)?.source !== mount.source) continue;
            if (stamp !== mount.stamp) schedulePackReload(id, false);
        } catch (error) {
            if (find(id)?.source !== mount.source) continue;
            const detail = String(error);
            if (mount.error !== detail)
                notify(
                    message("reloadFailed", mount.source.name),
                    "error",
                    `pack:${id}`,
                );
            update(id, { status: "error", error: detail, stamp: null });
        } finally {
            checking.delete(id);
        }
    }
}

export async function reloadPackSource(
    id: string,
    automatic = false,
    quiet = false,
) {
    const mount = find(id);
    if (!mount || (automatic && !mount.autoReload)) return;
    if (running.has(id)) {
        queued.add(id);
        return;
    }
    const epoch = generation;
    const valid = () =>
        epoch === generation && find(id)?.source === mount.source;
    running.add(id);
    update(id, { status: "loading" });
    let attemptedStamp: string | null = null;
    try {
        if (!automatic && !quiet) await mount.source.requestAccess?.();
        const before = await mount.source.stamp();
        attemptedStamp = before;
        const bytes = await mount.source.read();
        if (!valid()) return;
        const after = await mount.source.stamp();
        if (!valid()) return;
        if (automatic && !find(id)?.autoReload) {
            update(id, { status: mount.packId ? "ready" : "error" });
            return;
        }
        if (before !== after) throw new Error("PACK_CHANGED_DURING_READ");
        const mounted = mountArchive(bytes, { name: mount.source.name });
        const pack = { ...mounted, id: `${id}:${mounted.id}` };
        const changed = pack.id !== mount.packId;
        if (changed)
            useEditorStore
                .getState()
                .setMountedPack(pack, mount.packId ?? undefined);
        update(id, {
            packId: pack.id,
            status: "ready",
            error: null,
            stamp: after,
            loadedAt: changed || !automatic ? Date.now() : mount.loadedAt,
        });
        if (useEditorStore.getState().mountError === mount.error)
            useEditorStore.setState({ mountError: null });
        if (!quiet && (changed || !automatic))
            notify(
                message(
                    mount.packId
                        ? changed
                            ? "reloaded"
                            : "unchanged"
                        : "mounted",
                    mount.source.name,
                ),
                "success",
                `pack:${id}`,
            );
        if (mount.source.native && mount.autoReload) await configureWatch(id);
    } catch (error) {
        if (!valid()) return;
        const detail = error instanceof Error ? error.message : String(error);
        update(id, { status: "error", error: detail, stamp: attemptedStamp });
        useEditorStore.setState({ mountError: detail });
        if (!automatic || mount.error !== detail)
            notify(
                message("reloadFailed", mount.source.name),
                "error",
                `pack:${id}`,
            );
    } finally {
        if (valid()) {
            running.delete(id);
            if (queued.delete(id)) schedulePackReload(id);
        }
    }
}

export function removePackSource(id: string) {
    const mount = find(id);
    if (!mount) return;
    clearTimeout(pending.get(id));
    pending.delete(id);
    queued.delete(id);
    running.delete(id);
    checking.delete(id);
    mount.source.release();
    useAssetMounts.setState((state) => ({
        sources: state.sources.filter((value) => value !== mount),
    }));
    if (mount.packId) useEditorStore.getState().removePack(mount.packId);
}

export async function loadVanilla(version: VanillaVersion, explicit = false) {
    vanillaAbort?.abort();
    const abort = new AbortController();
    vanillaAbort = abort;
    const epoch = generation,
        request = ++vanillaRequest;
    const valid = () => epoch === generation && request === vanillaRequest;
    const current = useAssetMounts.getState().vanilla;
    if (version !== current.version) {
        for (const slot of useEditorStore.getState().packs)
            if (slot.pack.kind === "vanilla")
                useEditorStore.getState().removePack(slot.pack.id);
    }
    useAssetMounts.setState({
        vanilla: { version, status: "loading", phase: "cache", error: null },
    });
    try {
        const bytes = await fetchVanillaBundle(
            version,
            (phase) => {
                if (valid())
                    useAssetMounts.setState((state) => ({
                        vanilla: { ...state.vanilla, phase },
                    }));
            },
            abort.signal,
        );
        if (!valid()) return;
        const pack = mountArchive(bytes, {
            name: `vanilla-${version}`,
            kind: "vanilla",
        });
        useEditorStore.getState().setMountedPack(pack);
        useAssetMounts.setState((state) => ({
            vanilla: { ...state.vanilla, status: "ready" },
        }));
        if (explicit)
            notify(message("vanillaReady", version), "success", "vanilla");
    } catch (error) {
        if (!valid()) return;
        const detail = error instanceof Error ? error.message : String(error);
        useAssetMounts.setState((state) => ({
            vanilla: { ...state.vanilla, status: "error", error: detail },
        }));
        notify(message("vanillaFailed", version), "error", "vanilla");
    }
}

export function ensureVanilla(serverVersion?: string) {
    if (useAssetMounts.getState().vanilla.status !== "idle") return;
    const version: VanillaVersion =
        serverVersion && isVanillaVersion(serverVersion)
            ? serverVersion
            : "26.1.2";
    void loadVanilla(version);
}
