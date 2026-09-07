import { isTauri } from "@tauri-apps/api/core";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";

/** Clipboard access is only performed by an explicit menu command, never to probe availability. */
export const readClipboard = () =>
    isTauri() ? readText() : navigator.clipboard.readText();
export const writeClipboard = (value: string) =>
    isTauri() ? writeText(value) : navigator.clipboard.writeText(value);
