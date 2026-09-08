import { invoke, isTauri } from "@tauri-apps/api/core";
import i18next from "i18next";
import { notify } from "../../state/toasts.js";
import { useEditorStore } from "../../state/store.js";

export type LocalExportKind = "catalog" | "config" | "access";
export const MAX_CATALOG_ARCHIVE_BYTES = 4 * 1024 * 1024;
export const MAX_LOCAL_YAML_BYTES = 2 * 1024 * 1024;

const exports = {
    catalog: {
        name: "itemerness-catalog.zip",
        type: "application/zip",
        limit: MAX_CATALOG_ARCHIVE_BYTES,
    },
    config: {
        name: "config.yml",
        type: "application/yaml",
        limit: MAX_LOCAL_YAML_BYTES,
    },
    access: {
        name: "access.yml",
        type: "application/yaml",
        limit: MAX_LOCAL_YAML_BYTES,
    },
} as const;

export async function saveLocalExport(
    kind: LocalExportKind,
    bytes: Uint8Array,
): Promise<boolean> {
    const options = exports[kind];
    const epoch = useEditorStore.getState().workspaceEpoch;
    if (!options || !bytes.length || bytes.length > options.limit)
        throw new Error("EXPORT_SIZE_INVALID");
    if (isTauri()) {
        try {
            const saved = await invoke<boolean>("save_editor_export", {
                kind,
                bytes: Array.from(bytes),
            });
            if (saved && epoch === useEditorStore.getState().workspaceEpoch)
                notify(
                    String(i18next.t("packManager:exportSaved")),
                    "success",
                    "export",
                );
            return saved;
        } catch (reason) {
            throw new Error(
                typeof reason === "string" ? reason : "EXPORT_SAVE_FAILED",
            );
        }
    }
    const url = URL.createObjectURL(
        new Blob([Uint8Array.from(bytes).buffer], { type: options.type }),
    );
    try {
        const link = document.createElement("a");
        link.href = url;
        link.download = options.name;
        link.click();
        notify(
            String(i18next.t("packManager:exportDownload")),
            "success",
            "export",
        );
    } finally {
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    return true;
}
