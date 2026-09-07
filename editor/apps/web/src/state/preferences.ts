import { create } from "zustand";

const KEY = "itemerness.auto-save";
function readAutoSave() {
    try {
        return localStorage.getItem(KEY) !== "false";
    } catch {
        return true;
    }
}
export const usePreferences = create<{
    autoSave: boolean;
    setAutoSave(value: boolean): void;
}>((set) => ({
    autoSave: readAutoSave(),
    setAutoSave(autoSave) {
        set({ autoSave });
        try {
            localStorage.setItem(KEY, String(autoSave));
        } catch {
            /* The preference remains active for this session. */
        }
    },
}));
