import { create } from "zustand";
import { itemKey } from "@itemerness/protocol";
import i18next from "i18next";
import {
    defaultWorkspaceSettings,
    loadServerWorkspace,
    saveServerWorkspace,
    type PreviewSettings,
    type ServerWorkspace,
    type WorkspaceSettings,
} from "../api/serverWorkspace.js";
import { addPackSources, loadVanilla, useAssetMounts } from "./assetMounts.js";
import { useEditorStore } from "./store.js";
import { notify } from "./toasts.js";

export const useServerWorkspaceState = create<{
    serverId: string | null;
    epoch: number;
    status: "idle" | "loading" | "saving" | "ready" | "error";
    settings: WorkspaceSettings;
    error: string | null;
}>(() => ({
    serverId: null,
    epoch: -1,
    status: "idle",
    settings: defaultWorkspaceSettings(),
    error: null,
}));

let queue = Promise.resolve();
let flushCurrent: (() => void) | null = null;
let forgetCurrent: (() => Promise<void>) | null = null;
export async function flushServerWorkspace() {
    flushCurrent?.();
    await queue;
}
export async function forgetServerWorkspace(serverId: string, epoch: number) {
    const current = useServerWorkspaceState.getState();
    if (current.serverId === serverId && current.epoch === epoch)
        await forgetCurrent?.();
}

function previewSettings(): PreviewSettings {
    const s = useEditorStore.getState();
    return {
        selectedItemId: s.selectedItemId,
        viewerLocale: s.viewerLocale,
        compareLocales: s.compareLocales,
        annotations: s.annotations,
        guiScale: s.zoomMode === "fit" ? 3 : s.guiScale,
        zoomMode: s.zoomMode,
    };
}
function snapshot(): ServerWorkspace {
    const s = useEditorStore.getState(),
        assets = useAssetMounts.getState();
    const mounts = [...assets.sources]
        .sort((a, b) => {
            const ai = s.packs.findIndex((slot) => slot.pack.id === a.packId),
                bi = s.packs.findIndex((slot) => slot.pack.id === b.packId);
            return (ai < 0 ? Infinity : ai) - (bi < 0 ? Infinity : bi);
        })
        .map((m) => ({ source: m.source, autoReload: m.autoReload }));
    return {
        settings: {
            ...useServerWorkspaceState.getState().settings,
            preview: previewSettings(),
            vanillaVersion:
                assets.vanilla.status === "idle"
                    ? null
                    : assets.vanilla.version,
        },
        mounts,
    };
}
function signature(value: ServerWorkspace) {
    return JSON.stringify({
        settings: value.settings,
        mounts: value.mounts.map((m) => [m.source.id, m.autoReload]),
    });
}

/** Only starts after a current, validated document is ready. It never loads authoring data. */
export function startServerWorkspace(serverId: string, epoch: number) {
    let disposed = false,
        hydrated = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let latest: ServerWorkspace | null = null,
        lastSignature = "";
    const initialPreview = previewSettings();
    const valid = () =>
        !disposed &&
        useEditorStore.getState().workspaceEpoch === epoch &&
        useServerWorkspaceState.getState().serverId === serverId;
    useServerWorkspaceState.setState({
        serverId,
        epoch,
        status: "loading",
        settings: defaultWorkspaceSettings(),
        error: null,
    });
    const report = (error: unknown) => {
        if (!valid()) return;
        useServerWorkspaceState.setState({
            status: "error",
            error: String(error),
        });
        notify(
            String(i18next.t("serverWorkspace:storageFailed")),
            "error",
            "server-workspace",
        );
    };
    const flush = () => {
        clearTimeout(timer);
        if (!latest) return;
        const value = latest;
        latest = null;
        queue = queue
            .then(() => saveServerWorkspace(serverId, value))
            .then(() => {
                if (valid())
                    useServerWorkspaceState.setState({
                        status: "ready",
                        error: null,
                    });
            })
            .catch(report);
    };
    flushCurrent = flush;
    const changed = () => {
        if (!hydrated || !valid()) return;
        const value = snapshot(),
            key = signature(value);
        if (key === lastSignature) return;
        lastSignature = key;
        latest = value;
        useServerWorkspaceState.setState({ status: "saving" });
        clearTimeout(timer);
        timer = setTimeout(flush, 150);
    };
    const stops = [
        useEditorStore.subscribe(changed),
        useAssetMounts.subscribe(changed),
        useServerWorkspaceState.subscribe(changed),
    ];
    const forget = async () => {
        clearTimeout(timer);
        latest = null;
        hydrated = false;
        const settings = { ...defaultWorkspaceSettings(), remember: false };
        queue = queue
            .then(() => saveServerWorkspace(serverId, { settings, mounts: [] }))
            .then(() => {
                if (!valid()) return;
                useServerWorkspaceState.setState({
                    settings,
                    status: "ready",
                    error: null,
                });
                hydrated = true;
                lastSignature = signature(snapshot());
            })
            .catch(report);
        await queue;
    };
    forgetCurrent = forget;
    void (async () => {
        await queue;
        if (!valid()) return;
        const saved = await loadServerWorkspace(serverId);
        if (!valid()) {
            saved?.mounts.forEach((m) => m.source.release());
            return;
        }
        if (saved)
            useServerWorkspaceState.setState({ settings: saved.settings });
        if (saved?.settings.remember) {
            const current = previewSettings(),
                restored = saved.settings.preview;
            const patch: Partial<PreviewSettings> = {};
            for (const key of Object.keys(
                current,
            ) as (keyof PreviewSettings)[]) {
                if (current[key] === initialPreview[key])
                    Object.assign(patch, { [key]: restored[key] });
            }
            const doc = useEditorStore.getState().document;
            if (
                !doc.items.some(
                    (item) => itemKey(doc, item) === patch.selectedItemId,
                )
            )
                delete patch.selectedItemId;
            if (
                !doc.locales.some(
                    (locale) => locale.locale === patch.viewerLocale,
                )
            )
                delete patch.viewerLocale;
            useEditorStore.setState(patch);
            // Mounting prepends to the pack stack; reverse the saved priority order.
            for (const mount of [...saved.mounts].reverse()) {
                if (!valid()) {
                    mount.source.release();
                    continue;
                }
                await addPackSources([mount.source], epoch, {
                    autoReload: mount.autoReload,
                    quiet: true,
                });
            }
            if (!valid()) return;
            if (saved.settings.vanillaVersion)
                void loadVanilla(saved.settings.vanillaVersion);
        }
        if (!valid()) return;
        useServerWorkspaceState.setState({ status: "ready" });
        hydrated = true;
        changed();
    })().catch(report);
    window.addEventListener("pagehide", flush);
    return () => {
        disposed = true;
        stops.forEach((stop) => stop());
        flush();
        window.removeEventListener("pagehide", flush);
        if (flushCurrent === flush) flushCurrent = null;
        if (forgetCurrent === forget) forgetCurrent = null;
    };
}

export function updateWorkspaceSettings(
    patch: Partial<Pick<WorkspaceSettings, "remember">>,
) {
    useServerWorkspaceState.setState((s) => ({
        settings: { ...s.settings, ...patch },
    }));
}
