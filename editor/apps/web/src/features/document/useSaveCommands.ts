import { useEffect, useState } from "react";
import { isTauri, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import { useEditorStore } from "../../state/store.js";
import type { DocumentSync } from "./useDocumentSync.js";

export function hasUnsavedChanges(sync: DocumentSync) {
    return sync.isDirty();
}
export function useSaveCommands(sync: DocumentSync) {
    const { t } = useTranslation();
    const [error, setError] = useState(false);
    const transaction = useEditorStore((state) => state.historyTransactionId);
    useEffect(() => {
        const save = (event: KeyboardEvent) => {
            if (
                !event.isComposing &&
                (event.metaKey || event.ctrlKey) &&
                !event.altKey &&
                event.key.toLowerCase() === "s"
            ) {
                event.preventDefault();
                void sync.save();
            }
        };
        window.addEventListener("keydown", save);
        let active = true;
        let unlisten: (() => void) | undefined;
        if (isTauri())
            void listen("editor-save", () => {
                if (active) void sync.save();
            })
                .then((stop) => (active ? (unlisten = stop) : stop()))
                .catch(() => {
                    if (active) setError(true);
                });
        return () => {
            active = false;
            window.removeEventListener("keydown", save);
            unlisten?.();
        };
    }, [sync.save]);
    useEffect(() => {
        if (!isTauri()) return;
        let active = true;
        void invoke("update_editor_menu", {
            enabled:
                sync.ready &&
                transaction === null &&
                sync.status.kind !== "conflict",
            saveLabel: t("settings.save"),
        }).catch(() => {
            if (active) setError(true);
        });
        return () => {
            active = false;
        };
    }, [sync.ready, sync.status.kind, transaction, t]);
    return error;
}
