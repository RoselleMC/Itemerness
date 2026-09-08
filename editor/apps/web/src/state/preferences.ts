import { create } from "zustand";

const KEY = "itemerness.auto-save";
const PACK_INTERVAL_KEY = "itemerness.pack-check-interval";
const RECONNECT_KEY = "itemerness.reconnect-mode";
const CANVAS_PAN_KEY = "itemerness.canvas-pan-buttons";
export type CanvasPanButtons = "middle" | "middle-right";
function readCanvasPanButtons(): CanvasPanButtons {
    try {
        return localStorage.getItem(CANVAS_PAN_KEY) === "middle"
            ? "middle"
            : "middle-right";
    } catch {
        return "middle-right";
    }
}
function readReconnect(): "automatic" | "manual" {
    try {
        return localStorage.getItem(RECONNECT_KEY) === "manual"
            ? "manual"
            : "automatic";
    } catch {
        return "automatic";
    }
}
export const DEFAULT_PACK_CHECK_INTERVAL = 1000;
export function validPackCheckInterval(value: number) {
    return Number.isInteger(value) && value >= 250 && value <= 60000;
}
function readPackInterval() {
    try {
        const value = Number(localStorage.getItem(PACK_INTERVAL_KEY));
        return validPackCheckInterval(value)
            ? value
            : DEFAULT_PACK_CHECK_INTERVAL;
    } catch {
        return DEFAULT_PACK_CHECK_INTERVAL;
    }
}
function readAutoSave() {
    try {
        return localStorage.getItem(KEY) !== "false";
    } catch {
        return true;
    }
}
export const usePreferences = create<{
    canvasPanButtons: CanvasPanButtons;
    setCanvasPanButtons(value: CanvasPanButtons): void;
    autoSave: boolean;
    setAutoSave(value: boolean): void;
    packCheckInterval: number;
    setPackCheckInterval(value: number): void;
    reconnectMode: "automatic" | "manual";
    setReconnectMode(value: "automatic" | "manual"): void;
}>((set) => ({
    canvasPanButtons: readCanvasPanButtons(),
    setCanvasPanButtons(canvasPanButtons) {
        set({ canvasPanButtons });
        try {
            localStorage.setItem(CANVAS_PAN_KEY, canvasPanButtons);
        } catch {
            /* Session-only preference. */
        }
    },
    reconnectMode: readReconnect(),
    setReconnectMode(reconnectMode) {
        set({ reconnectMode });
        try {
            localStorage.setItem(RECONNECT_KEY, reconnectMode);
        } catch {
            /* Session-only preference. */
        }
    },
    autoSave: readAutoSave(),
    packCheckInterval: readPackInterval(),
    setPackCheckInterval(packCheckInterval) {
        if (!validPackCheckInterval(packCheckInterval)) return;
        set({ packCheckInterval });
        try {
            localStorage.setItem(PACK_INTERVAL_KEY, String(packCheckInterval));
        } catch {
            /* Session preference remains available. */
        }
    },
    setAutoSave(autoSave) {
        set({ autoSave });
        try {
            localStorage.setItem(KEY, String(autoSave));
        } catch {
            /* The preference remains active for this session. */
        }
    },
}));
