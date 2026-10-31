import {
    localeSchema,
    messageKeySchema,
    type PresentationBlock,
    type ProjectDocument,
} from "@itemerness/protocol";
import {
    remapBlockFragments,
    remapNameFragments,
} from "../../state/composition.js";
import {
    collectDocumentMessageKeys,
    collectReferencedMessageKeys,
} from "../common/messages.js";
import { mapChildBlocks } from "../../state/blocks.js";

export function canSetFallback(
    document: ProjectDocument,
    uuid: string,
    fallback: string | null,
): boolean {
    const locale = document.locales.find((entry) => entry.uuid === uuid);
    if (!locale) return false;
    const seen = new Set([locale.locale]);
    let current = fallback;
    while (current) {
        if (seen.has(current)) return false;
        seen.add(current);
        const entry = document.locales.find(
            (entry) => entry.locale === current,
        );
        if (!entry) return false;
        current = entry.fallback;
    }
    return true;
}

export function localeInUse(document: ProjectDocument, code: string): boolean {
    return (
        document.defaultLocale === code ||
        document.locales.some((entry) => entry.fallback === code) ||
        document.viewerFacts.some(
            (fact) =>
                fact.type === "LOCALE" &&
                [fact.defaultValue, fact.previewValue].some(
                    (value) => value?.kind === "string" && value.value === code,
                ),
        )
    );
}

export function renameLocale(
    document: ProjectDocument,
    uuid: string,
    code: string,
): ProjectDocument {
    const locale = document.locales.find((entry) => entry.uuid === uuid);
    if (
        !locale ||
        !localeSchema.safeParse(code).success ||
        document.locales.some(
            (entry) => entry.uuid !== uuid && entry.locale === code,
        )
    )
        return document;
    const rename = (value: string | null) =>
        value === locale.locale ? code : value;
    return {
        ...document,
        defaultLocale: rename(document.defaultLocale)!,
        locales: document.locales.map((entry) => ({
            ...entry,
            locale: entry.uuid === uuid ? code : entry.locale,
            fallback: rename(entry.fallback),
        })),
        viewerFacts: document.viewerFacts.map((fact) =>
            fact.type !== "LOCALE"
                ? fact
                : {
                      ...fact,
                      defaultValue:
                          fact.defaultValue?.kind === "string" &&
                          fact.defaultValue.value === locale.locale
                              ? { kind: "string", value: code }
                              : fact.defaultValue,
                      previewValue:
                          fact.previewValue?.kind === "string" &&
                          fact.previewValue.value === locale.locale
                              ? { kind: "string", value: code }
                              : fact.previewValue,
                  },
        ),
    };
}

export function addLocale(
    document: ProjectDocument,
    code: string,
    sourceUuid?: string,
): ProjectDocument {
    const source = sourceUuid
        ? document.locales.find((entry) => entry.uuid === sourceUuid)
        : undefined;
    if (
        !localeSchema.safeParse(code).success ||
        document.locales.some((entry) => entry.locale === code) ||
        (sourceUuid && !source)
    )
        return document;
    return {
        ...document,
        defaultLocale: document.locales.length ? document.defaultLocale : code,
        locales: [
            ...document.locales,
            {
                uuid: crypto.randomUUID(),
                locale: code,
                fallback: source
                    ? source.fallback
                    : document.locales.length
                      ? document.defaultLocale
                      : null,
                messages: { ...source?.messages },
            },
        ],
    };
}

export function removeLocale(
    document: ProjectDocument,
    uuid: string,
): ProjectDocument {
    const locale = document.locales.find((entry) => entry.uuid === uuid);
    if (!locale || localeInUse(document, locale.locale)) return document;
    return {
        ...document,
        locales: document.locales.filter((entry) => entry.uuid !== uuid),
    };
}

// Documents are immutable snapshots, so their references can be computed once per snapshot.
const referencedKeys = new WeakMap<ProjectDocument, ReadonlySet<string>>();
const dynamicPatterns = new WeakMap<ProjectDocument, readonly RegExp[]>();

/** Runtime-derived message references cannot be rewritten safely by renaming one concrete key. */
export function hasDynamicMessageReference(
    document: ProjectDocument,
    key: string,
): boolean {
    let patterns = dynamicPatterns.get(document);
    if (!patterns) {
        patterns = messagePatterns(document);
        dynamicPatterns.set(document, patterns);
    }
    return patterns.some((pattern) => pattern.test(key));
}

function messagePatterns(document: ProjectDocument): RegExp[] {
    return document.formats.flatMap((format) => {
        if (
            format.kind !== "namespacedKey" ||
            format.mode !== "MESSAGE" ||
            !format.messagePattern
        )
            return [];
        const pattern = format.messagePattern
            .split(/(\{namespace\}|\{path\})/)
            .map((part) =>
                part === "{namespace}"
                    ? "[a-z0-9_.-]+"
                    : part === "{path}"
                      ? "[a-z0-9_./-]+"
                      : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
            )
            .join("");
        return [new RegExp(`^${pattern}$`)];
    });
}

/** Called once per message row; a translation matrix has thousands, so this must not rescan the document. */
export function messageInUse(document: ProjectDocument, key: string): boolean {
    let referenced = referencedKeys.get(document);
    if (!referenced) {
        referenced = new Set(collectReferencedMessageKeys(document));
        referencedKeys.set(document, referenced);
    }
    return referenced.has(key) || hasDynamicMessageReference(document, key);
}

export function renameMessage(
    document: ProjectDocument,
    key: string,
    next: string,
): ProjectDocument {
    if (
        key === next ||
        !messageKeySchema.safeParse(next).success ||
        collectDocumentMessageKeys(document).includes(next) ||
        hasDynamicMessageReference(document, key)
    )
        return document;
    const rename = (value: string) => (value === key ? next : value);
    const blocks = (
        entries: readonly PresentationBlock[],
    ): PresentationBlock[] =>
        entries.map((source) => {
            const block = remapBlockFragments(source, rename, (id) => id);
            switch (block.type) {
                case "field":
                    return {
                        ...block,
                        labelMessage: rename(block.labelMessage),
                    };
                case "description":
                    return { ...block, message: rename(block.message) };
                case "repeat":
                    return {
                        ...block,
                        template: {
                            ...block.template,
                            labelMessage: rename(block.template.labelMessage),
                            missingMessage: rename(
                                block.template.missingMessage,
                            ),
                        },
                    };
                case "conditional":
                case "group":
                    return mapChildBlocks(block, blocks);
                default:
                    return block;
            }
        });
    return {
        ...document,
        locales: document.locales.map((locale) => ({
            ...locale,
            messages: Object.fromEntries(
                Object.entries(locale.messages).map(([id, value]) => [
                    rename(id),
                    value,
                ]),
            ),
        })),
        items: document.items.map((item) => ({
            ...item,
            presentation: {
                ...remapNameFragments(item.presentation, rename),
                nameMessage: rename(item.presentation.nameMessage),
                blocks: blocks(item.presentation.blocks),
            },
        })),
        formats: document.formats.map((format) => {
            switch (format.kind) {
                case "decimal":
                    return {
                        ...format,
                        suffixMessage:
                            format.suffixMessage === null
                                ? null
                                : rename(format.suffixMessage),
                    };
                case "boolean":
                    return {
                        ...format,
                        trueMessage: rename(format.trueMessage),
                        falseMessage: rename(format.falseMessage),
                    };
                case "list":
                    return {
                        ...format,
                        separatorMessage: rename(format.separatorMessage),
                    };
                default:
                    return format;
            }
        }),
    };
}

export function removeMessage(
    document: ProjectDocument,
    key: string,
): ProjectDocument {
    if (messageInUse(document, key)) return document;
    return {
        ...document,
        locales: document.locales.map((locale) => ({
            ...locale,
            messages: Object.fromEntries(
                Object.entries(locale.messages).filter(([id]) => id !== key),
            ),
        })),
    };
}
