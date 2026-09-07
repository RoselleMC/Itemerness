import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

export type WindowPlatform = "macos" | "windows" | "browser";

export function windowPlatform(): WindowPlatform {
    if (!isTauri()) return "browser";
    return /Macintosh|Mac OS X/.test(navigator.userAgent) ? "macos" : "windows";
}

export type WindowAction = "drag" | "zoom" | "minimize" | "close";

export async function windowAction(action: WindowAction): Promise<void> {
    if (!isTauri()) return;
    const window = getCurrentWindow();
    switch (action) {
        case "drag":
            return window.startDragging();
        case "zoom":
            return window.toggleMaximize();
        case "minimize":
            return window.minimize();
        case "close":
            return window.close();
    }
}

/** Explicit drag dispatch also works after text selection in WKWebView. */
export function titlebarAction(event: {
    button: number;
    detail: number;
    target: EventTarget | null;
}): WindowAction | null {
    if (event.button !== 0) return null;
    const target = event.target;
    if (
        target instanceof Element &&
        target.closest(
            "button,a,input,select,textarea,label,[contenteditable],[data-no-drag]",
        )
    )
        return null;
    return event.detail >= 2 ? "zoom" : "drag";
}
