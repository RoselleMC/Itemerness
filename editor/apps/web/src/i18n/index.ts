import i18next from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { initReactI18next } from "react-i18next";
import enCommon from "./locales/en-US/common.json";
import enDiagnostics from "./locales/en-US/diagnostics.json";
import enFidelity from "./locales/en-US/fidelity.json";
import zhCommon from "./locales/zh-CN/common.json";
import zhDiagnostics from "./locales/zh-CN/diagnostics.json";
import zhFidelity from "./locales/zh-CN/fidelity.json";

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
 * Diagnostics arrive from the control plane and the agent as a `messageKey` plus typed `params`
 * and are rendered through the `diagnostics` namespace here, so a Chinese editor never receives an
 * English sentence assembled on a server.
 */

export const SUPPORTED_UI_LANGUAGES = [
    { code: "en-US", label: "English" },
    { code: "zh-CN", label: "简体中文" },
] as const;

export type UiLanguage = (typeof SUPPORTED_UI_LANGUAGES)[number]["code"];

const resources = {
    "en-US": {
        common: enCommon,
        diagnostics: enDiagnostics,
        fidelity: enFidelity,
    },
    "zh-CN": {
        common: zhCommon,
        diagnostics: zhDiagnostics,
        fidelity: zhFidelity,
    },
} as const;

export function initialiseI18n(): typeof i18next {
    if (i18next.isInitialized) return i18next;
    void i18next
        .use(LanguageDetector)
        .use(initReactI18next)
        .init({
            resources,
            fallbackLng: "en-US",
            supportedLngs: SUPPORTED_UI_LANGUAGES.map((entry) => entry.code),
            defaultNS: "common",
            ns: ["common", "diagnostics", "fidelity"],
            interpolation: { escapeValue: false },
            detection: {
                order: ["querystring", "localStorage", "navigator"],
                lookupQuerystring: "lang",
                lookupLocalStorage: "itemerness.ui-language",
                caches: ["localStorage"],
            },
            returnNull: false,
        });
    return i18next;
}

export default i18next;
