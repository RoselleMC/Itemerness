import type { PresentationBlock, ProjectDocument } from "@itemerness/protocol";

/** Declared messages plus every static message reference checked by the production compiler. */
export function collectDocumentMessageKeys(
    document: ProjectDocument,
): string[] {
    return [
        ...new Set([
            ...document.locales.flatMap((locale) =>
                Object.keys(locale.messages),
            ),
            ...collectReferencedMessageKeys(document),
        ]),
    ].sort();
}

export function collectReferencedMessageKeys(
    document: ProjectDocument,
): string[] {
    const keys = new Set<string>();
    const collectBlocks = (blocks: readonly PresentationBlock[]) => {
        for (const block of blocks) {
            switch (block.type) {
                case "field":
                    keys.add(block.labelMessage);
                    break;
                case "description":
                    keys.add(block.message);
                    break;
                case "repeat":
                    keys.add(block.template.labelMessage);
                    keys.add(block.template.missingMessage);
                    break;
                case "conditional":
                    collectBlocks(block.thenBlocks);
                    collectBlocks(block.otherwiseBlocks);
                    break;
            }
        }
    };
    for (const item of document.items) {
        keys.add(item.presentation.nameMessage);
        collectBlocks(item.presentation.blocks);
    }
    for (const format of document.formats) {
        switch (format.kind) {
            case "decimal":
                if (format.suffixMessage !== null)
                    keys.add(format.suffixMessage);
                break;
            case "boolean":
                keys.add(format.trueMessage);
                keys.add(format.falseMessage);
                break;
            case "list":
                keys.add(format.separatorMessage);
                break;
            // Namespaced-key patterns depend on runtime values and are not literal message keys.
        }
    }
    return [...keys].sort();
}

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
    const requestedExists = document.locales.some(
        (entry) => entry.locale === locale,
    );
    // Unknown locales start from the default chain; known locales only append the default entry.
    let current: string | null = requestedExists
        ? locale
        : document.defaultLocale;
    while (current && !seen.has(current)) {
        seen.add(current);
        const node = document.locales.find((entry) => entry.locale === current);
        if (!node) break;
        if (Object.hasOwn(node.messages, key)) {
            return {
                text: node.messages[key]!,
                source: !requestedExists
                    ? "default"
                    : current === locale
                      ? "own"
                      : "fallback",
                sourceLocale: current,
            };
        }
        current = node.fallback;
    }
    const fallbackNode = document.locales.find(
        (entry) => entry.locale === document.defaultLocale,
    );
    if (
        fallbackNode &&
        Object.hasOwn(fallbackNode.messages, key) &&
        !seen.has(document.defaultLocale)
    ) {
        return {
            text: fallbackNode.messages[key]!,
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
