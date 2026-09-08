import {
    canonicalize,
    itemKey,
    type ProjectDocument,
} from "@itemerness/protocol";

export const CATALOG_DIFF_KINDS = [
    "items",
    "dataSchemas",
    "locales",
    "themes",
    "layouts",
    "formats",
    "viewerFacts",
    "fonts",
    "glyphs",
    "bitmaps",
    "assetProfiles",
    "resourcePackBindings",
    "tooltipStyles",
    "spacing",
    "measurement",
] as const;
export type CatalogDiffKind = (typeof CATALOG_DIFF_KINDS)[number];
type Changes = { added: number; removed: number; changed: number };
export interface CatalogTransferDiff {
    settings: {
        key:
            | "schemaVersion"
            | "namespace"
            | "defaultLocale"
            | "defaultLayout"
            | "defaultTheme";
        before: string | number | null;
        after: string | number | null;
    }[];
    counts: ({
        kind: CatalogDiffKind;
        before: number;
        after: number;
    } & Changes)[];
    enabled: { before: number; after: number };
    messages: Changes;
}

function authoringValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(authoringValue);
    if (!value || typeof value !== "object") return value;
    const record = value as Record<string, unknown>;
    const node = typeof record.uuid === "string";
    return Object.fromEntries(
        Object.entries(record)
            .filter(
                ([key]) =>
                    !node ||
                    !(
                        key === "uuid" ||
                        key === "extensions" ||
                        (key === "previewData" && "definition" in record) ||
                        (key === "previewValue" && "providers" in record)
                    ),
            )
            .map(([key, child]) => [key, authoringValue(child)]),
    );
}

function changes(
    before: Map<string, unknown>,
    after: Map<string, unknown>,
): Changes {
    let added = 0,
        removed = 0,
        changed = 0;
    for (const [id, value] of after) {
        if (!before.has(id)) added++;
        else if (
            canonicalize(authoringValue(value)) !==
            canonicalize(authoringValue(before.get(id)))
        )
            changed++;
    }
    for (const id of before.keys()) if (!after.has(id)) removed++;
    return { added, removed, changed };
}

function entries(
    document: ProjectDocument | null,
    kind: CatalogDiffKind,
): Map<string, unknown> {
    if (!document) return new Map();
    if (kind === "spacing" || kind === "measurement")
        return new Map(document[kind] ? [[kind, document[kind]]] : []);
    if (kind === "items")
        return new Map(
            document.items.map((item) => {
                const id = itemKey(document, item);
                return [
                    id,
                    {
                        ...item,
                        id,
                        presentation: {
                            ...item.presentation,
                            layout: item.presentation.layout ?? null,
                            theme: item.presentation.theme ?? null,
                        },
                    },
                ];
            }),
        );
    if (kind === "dataSchemas")
        return new Map(
            document.dataSchemas.map((schema) => [
                `${schema.id}@${schema.version}`,
                schema,
            ]),
        );
    if (kind === "locales")
        return new Map(
            document.locales.map((locale) => [locale.locale, locale]),
        );
    return new Map(document[kind].map((entry) => [entry.id, entry]));
}

function messages(document: ProjectDocument | null): Map<string, string> {
    return new Map(
        document?.locales.flatMap((locale) =>
            Object.entries(locale.messages).map(([key, value]) => [
                `${locale.locale}\0${key}`,
                value,
            ]),
        ) ?? [],
    );
}

/** A declarative replacement summary, excluding editor identity, extensions and preview samples. */
export function catalogTransferDiff(
    current: ProjectDocument | null,
    candidate: ProjectDocument,
): CatalogTransferDiff {
    return {
        settings: (
            [
                "schemaVersion",
                "namespace",
                "defaultLocale",
                "defaultLayout",
                "defaultTheme",
            ] as const
        ).map((key) => ({
            key,
            before: current?.[key] ?? null,
            after: candidate[key] ?? null,
        })),
        counts: CATALOG_DIFF_KINDS.map((kind) => {
            const before = entries(current, kind),
                after = entries(candidate, kind);
            return {
                kind,
                before: before.size,
                after: after.size,
                ...changes(before, after),
            };
        }),
        enabled: {
            before: current?.items.filter((item) => item.enabled).length ?? 0,
            after: candidate.items.filter((item) => item.enabled).length,
        },
        messages: changes(messages(current), messages(candidate)),
    };
}
