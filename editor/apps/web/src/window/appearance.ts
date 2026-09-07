import { useEffect, useLayoutEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

export type ColorMode = "light" | "dark" | "system";
const KEY = "itemerness.color-mode";
const QUERY = "(prefers-color-scheme: dark)";

function readMode(): ColorMode {
    try {
        const stored = localStorage.getItem(KEY);
        if (stored === "light" || stored === "dark") return stored;
    } catch {
        /* Preferences remain usable without persistent storage. */
    }
    return "system";
}

function apply(mode: ColorMode, dark: boolean) {
    document.documentElement.dataset.colorMode = mode;
    document.documentElement.dataset.theme =
        mode === "system" ? (dark ? "dark" : "light") : mode;
}

export function initializeAppearance() {
    apply(readMode(), matchMedia(QUERY).matches);
}

export function useAppearance() {
    const [mode, setMode] = useState<ColorMode>(readMode);
    const [systemDark, setSystemDark] = useState(
        () => matchMedia(QUERY).matches,
    );
    const [error, setError] = useState(false);
    useEffect(() => {
        const query = matchMedia(QUERY);
        const update = () => setSystemDark(query.matches);
        update();
        query.addEventListener("change", update);
        return () => query.removeEventListener("change", update);
    }, []);
    useLayoutEffect(() => apply(mode, systemDark), [mode, systemDark]);
    useEffect(() => {
        try {
            localStorage.setItem(KEY, mode);
        } catch {
            /* Keep the session preference. */
        }
        if (!isTauri()) return;
        let active = true;
        void getCurrentWindow()
            .setTheme(mode === "system" ? null : mode)
            .then(() => {
                if (active) setError(false);
            })
            .catch(() => {
                if (active) setError(true);
            });
        return () => {
            active = false;
        };
    }, [mode]);
    return { mode, setMode, error };
}
