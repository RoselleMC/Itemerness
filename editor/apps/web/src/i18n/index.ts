import i18next from "i18next";
import { create } from "zustand";
import { initReactI18next } from "react-i18next";
import enCommon from "./locales/en-US/common.json";
import enDiagnostics from "./locales/en-US/diagnostics.json";
import enFidelity from "./locales/en-US/fidelity.json";
import zhCommon from "./locales/zh-CN/common.json";
import zhDiagnostics from "./locales/zh-CN/diagnostics.json";
import zhFidelity from "./locales/zh-CN/fidelity.json";
import enLocalOperations from "./locales/en-US/localOperations.json";
import zhLocalOperations from "./locales/zh-CN/localOperations.json";
import enPackMetadata from "./locales/en-US/packMetadata.json";
import zhPackMetadata from "./locales/zh-CN/packMetadata.json";
import enPackManager from "./locales/en-US/packManager.json";
import zhPackManager from "./locales/zh-CN/packManager.json";
import enServerWorkspace from "./locales/en-US/serverWorkspace.json";
import zhServerWorkspace from "./locales/zh-CN/serverWorkspace.json";

/**
 * Interface localisation.
 *
 * There are two completely separate translation problems in this product and they must not share
 * storage or lifecycle:
 *
 * - *interface* strings — buttons, labels, error text — live here and follow the editor's own
 *   language preference;
 * - *content* strings — item names, lore, format suffixes — live in the project document's locale
 *   nodes, are edited in the locale matrix, and follow the previewed player's language.
 *
 * Diagnostics arrive from the plugin API as a `messageKey` plus typed `params`
 * and are rendered through the `diagnostics` namespace here, so a Chinese editor never receives an
 * English sentence assembled on a server.
 */

export const SUPPORTED_UI_LANGUAGES = [
    { code: "en-US", label: "English" },
    { code: "zh-CN", label: "简体中文" },
] as const;

export type UiLanguage = (typeof SUPPORTED_UI_LANGUAGES)[number]["code"];
export type UiLanguageMode = UiLanguage | "system";
const LANGUAGE_KEY = "itemerness.ui-language";
function readLanguageMode(): UiLanguageMode {
    try {
        const value =
            localStorage.getItem(LANGUAGE_KEY) ??
            new URLSearchParams(location.search).get("lang");
        if (value === "en-US" || value === "zh-CN") return value;
    } catch {
        /* Use the system language when preferences are unavailable. */
    }
    return "system";
}
export function systemLanguage(languages: readonly string[]): UiLanguage {
    for (const language of languages) {
        if (/^zh(?:-|$)/i.test(language)) return "zh-CN";
        if (/^en(?:-|$)/i.test(language)) return "en-US";
    }
    return "en-US";
}
function resolveLanguage(mode: UiLanguageMode): UiLanguage {
    return mode === "system" ? systemLanguage(navigator.languages) : mode;
}
export const useUiLanguage = create<{
    mode: UiLanguageMode;
    setMode(mode: UiLanguageMode): void;
}>((set) => ({
    mode: readLanguageMode(),
    setMode(mode) {
        set({ mode });
        try {
            localStorage.setItem(LANGUAGE_KEY, mode);
        } catch {
            /* Session-only preference. */
        }
        void i18next.changeLanguage(resolveLanguage(mode));
    },
}));

const resources = {
    "en-US": {
        common: enCommon,
        diagnostics: enDiagnostics,
        fidelity: enFidelity,
        localOperations: enLocalOperations,
        packMetadata: enPackMetadata,
        packManager: enPackManager,
        serverWorkspace: enServerWorkspace,
    },
    "zh-CN": {
        common: zhCommon,
        diagnostics: zhDiagnostics,
        fidelity: zhFidelity,
        localOperations: zhLocalOperations,
        packMetadata: zhPackMetadata,
        packManager: zhPackManager,
        serverWorkspace: zhServerWorkspace,
    },
} as const;

export function initialiseI18n(): typeof i18next {
    if (i18next.isInitialized) return i18next;
    void i18next.use(initReactI18next).init({
        resources,
        lng: resolveLanguage(useUiLanguage.getState().mode),
        fallbackLng: "en-US",
        supportedLngs: SUPPORTED_UI_LANGUAGES.map((entry) => entry.code),
        defaultNS: "common",
        ns: [
            "common",
            "diagnostics",
            "fidelity",
            "localOperations",
            "packMetadata",
            "packManager",
            "serverWorkspace",
        ],
        interpolation: { escapeValue: false },
        returnNull: false,
    });
    window.addEventListener("languagechange", () => {
        if (useUiLanguage.getState().mode === "system")
            void i18next.changeLanguage(resolveLanguage("system"));
    });
    return i18next;
}

export default i18next;
