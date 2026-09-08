import { invoke, isTauri } from "@tauri-apps/api/core";
import {
    browserHandleSource,
    nativePackSource,
    type BrowserHandle,
    type NativePackSelection,
    type PackSource,
} from "./packSources.js";
import { isVanillaVersion, type VanillaVersion } from "./vanillaAssets.js";

export interface PreviewSettings {
    selectedItemId: string | null;
    viewerLocale: string;
    compareLocales: boolean;
    annotations: boolean;
    guiScale: number;
    zoomMode: "fit" | "manual";
}
export interface WorkspaceSettings {
    remember: boolean;
    vanillaVersion: VanillaVersion | null;
    preview: PreviewSettings;
}
export interface WorkspaceMount {
    source: PackSource;
    autoReload: boolean;
}
export interface ServerWorkspace {
    settings: WorkspaceSettings;
    mounts: WorkspaceMount[];
}

export const defaultWorkspaceSettings = (): WorkspaceSettings => ({
    remember: true,
    vanillaVersion: null,
    preview: {
        selectedItemId: null,
        viewerLocale: "",
        compareLocales: false,
        annotations: false,
        guiScale: 3,
        zoomMode: "fit",
    },
});
export function persistentServerId(
    info: { serverId: string; capabilities: string[] } | null,
): string | null {
    return info?.capabilities.includes("server.identity.persistent") &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
            info.serverId,
        )
        ? info.serverId
        : null;
}

function parseSettings(value: unknown): WorkspaceSettings {
    if (!value || typeof value !== "object")
        throw new Error("WORKSPACE_INVALID");
    const s = value as WorkspaceSettings,
        p = s.preview;
    if (
        typeof s.remember !== "boolean" ||
        (s.vanillaVersion !== null && !isVanillaVersion(s.vanillaVersion)) ||
        !p ||
        (p.selectedItemId !== null &&
            (typeof p.selectedItemId !== "string" ||
                p.selectedItemId.length > 256)) ||
        typeof p.viewerLocale !== "string" ||
        p.viewerLocale.length > 128 ||
        typeof p.compareLocales !== "boolean" ||
        typeof p.annotations !== "boolean" ||
        !Number.isFinite(p.guiScale) ||
        p.guiScale < 0.01 ||
        p.guiScale > 32 ||
        !["fit", "manual"].includes(p.zoomMode)
    )
        throw new Error("WORKSPACE_INVALID");
    // Project only local preferences. Unknown fields can never enter the document or saved record.
    return {
        remember: s.remember,
        vanillaVersion: s.vanillaVersion,
        preview: {
            selectedItemId: p.selectedItemId,
            viewerLocale: p.viewerLocale,
            compareLocales: p.compareLocales,
            annotations: p.annotations,
            guiScale: p.guiScale,
            zoomMode: p.zoomMode,
        },
    };
}

function openDatabase(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open("itemerness-server-workspaces", 1);
        request.onupgradeneeded = () =>
            request.result.createObjectStore("profiles");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        request.onblocked = () =>
            reject(new Error("WORKSPACE_STORAGE_UNAVAILABLE"));
    });
}
async function browserRecord(
    serverId: string,
    value?: unknown,
): Promise<unknown> {
    const db = await openDatabase();
    try {
        return await new Promise((resolve, reject) => {
            const tx = db.transaction(
                "profiles",
                value === undefined ? "readonly" : "readwrite",
            );
            const store = tx.objectStore("profiles");
            const request =
                value === undefined
                    ? store.get(serverId)
                    : store.put(value, serverId);
            tx.oncomplete = () => resolve(request.result);
            tx.onabort = () =>
                reject(tx.error ?? new Error("WORKSPACE_WRITE_FAILED"));
            tx.onerror = () => reject(tx.error);
        });
    } finally {
        db.close();
    }
}

export async function loadServerWorkspace(
    serverId: string,
): Promise<ServerWorkspace | null> {
    if (isTauri()) {
        const saved = await invoke<{
            settings: unknown;
            mounts: { source: NativePackSelection; autoReload: boolean }[];
        } | null>("load_server_workspace", { serverId });
        if (!saved) return null;
        return {
            settings: parseSettings(saved.settings),
            mounts: saved.mounts.map((m) => ({
                source: nativePackSource(m.source),
                autoReload: m.autoReload,
            })),
        };
    }
    const saved = (await browserRecord(serverId)) as
        | {
              schema: number;
              settings: unknown;
              mounts: { handle: BrowserHandle; autoReload: boolean }[];
          }
        | undefined;
    if (!saved) return null;
    if (
        saved.schema !== 1 ||
        !Array.isArray(saved.mounts) ||
        saved.mounts.length > 64
    )
        throw new Error("WORKSPACE_INVALID");
    const settings = parseSettings(saved.settings);
    const mounts = settings.remember
        ? saved.mounts.map((m) => {
              if (
                  !m.handle ||
                  !["file", "directory"].includes(m.handle.kind) ||
                  typeof m.autoReload !== "boolean"
              )
                  throw new Error("WORKSPACE_INVALID");
              return {
                  source: browserHandleSource(m.handle),
                  autoReload: m.autoReload,
              };
          })
        : [];
    return { settings, mounts };
}

export async function saveServerWorkspace(
    serverId: string,
    workspace: ServerWorkspace,
) {
    const settings = workspace.settings.remember
        ? parseSettings(workspace.settings)
        : { ...defaultWorkspaceSettings(), remember: false };
    const mounts = settings.remember ? workspace.mounts : [];
    if (isTauri()) {
        await invoke("save_server_workspace", {
            serverId,
            settings,
            mounts: mounts
                .filter((m) => m.source.native)
                .map((m) => ({ id: m.source.id, autoReload: m.autoReload })),
        });
    } else {
        await browserRecord(serverId, {
            schema: 1,
            settings,
            mounts: mounts
                .filter((m) => m.source.handle)
                .map((m) => ({
                    handle: m.source.handle,
                    autoReload: m.autoReload,
                })),
        });
    }
}
