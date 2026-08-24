import type { ProjectDocument } from "@itemerness/protocol";

/**
 * Message resolution for the editing surface.
 *
 * The editor's core promise is that people edit *text they can read*, not message keys. Every
 * inline input in the inspector shows the resolved message for the language being previewed and
 * writes back to that language. To do that honestly the input has to know where the text it shows
 * actually came from: the language itself, a fallback, or the document default — because editing a
 * string that was inherited creates a translation, and the UI should say so instead of silently
 * pretending the language was already translated.
 */

export type MessageSource = "own" | "fallback" | "default" | "missing";

export interface ResolvedMessage {
    readonly text: string;
    readonly source: MessageSource;
    /** The locale that actually supplied the text, when one did. */
    readonly sourceLocale: string | null;
}

export function resolveMessage(
    document: ProjectDocument,
    locale: string,
    key: string,
): ResolvedMessage {
    const seen = new Set<string>();
    let current: string | null = locale;
    while (current && !seen.has(current)) {
        seen.add(current);
        const node = document.locales.find((entry) => entry.locale === current);
        if (!node) break;
        const text = node.messages[key];
        if (text !== undefined) {
            return {
                text,
                source: current === locale ? "own" : "fallback",
                sourceLocale: current,
            };
        }
        current = node.fallback;
    }
    const fallbackNode = document.locales.find(
        (entry) => entry.locale === document.defaultLocale,
    );
    const text = fallbackNode?.messages[key];
    if (text !== undefined && !seen.has(document.defaultLocale)) {
        return {
            text,
            source: "default",
            sourceLocale: document.defaultLocale,
        };
    }
    return { text: key, source: "missing", sourceLocale: null };
}

/** The localized display name of an item, for lists and captions. */
export function itemDisplayName(
    document: ProjectDocument,
    locale: string,
    nameMessage: string,
): string {
    return resolveMessage(document, locale, nameMessage).text;
}

/** `attack-damage` → `Attack damage`, for auto-generated labels. */
export function humanizePath(path: string): string {
    const words = path
        .split(/[-_./]+/)
        .filter(Boolean)
        .join(" ");
    return words.length === 0 ? path : words[0]!.toUpperCase() + words.slice(1);
}
