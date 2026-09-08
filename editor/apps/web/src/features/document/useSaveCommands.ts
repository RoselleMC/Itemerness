import { useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { DocumentSync } from "./useDocumentSync.js";

export function hasUnsavedChanges(sync: DocumentSync) {
    return sync.isDirty();
}
export function useSaveCommands(sync: DocumentSync, blocked = false) {
    const [error, setError] = useState(false);
    useEffect(() => {
        const save = (event: KeyboardEvent) => {
            if (
                !event.isComposing &&
                (event.metaKey || event.ctrlKey) &&
                !event.altKey &&
                event.key.toLowerCase() === "s"
            ) {
                event.preventDefault();
                if (!blocked) void sync.save();
            }
        };
        window.addEventListener("keydown", save);
        let active = true;
        let unlisten: (() => void) | undefined;
        if (isTauri())
            void listen("editor-save", () => {
                if (active && !blocked) void sync.save();
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
    }, [sync.save, blocked]);
    return error;
}
