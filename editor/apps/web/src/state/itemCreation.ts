import {
    itemKey,
    type ItemNode,
    type PresentationBlock,
    type ProjectDocument,
} from "@itemerness/protocol";
import { itemIdIssue } from "./itemIdentity.js";

export interface ItemCreationOptions {
    id?: string;
    sourceUuid?: string;
    layout?: string | null;
    theme?: string | null;
}

export function freshBlankItemId(document: ProjectDocument): string {
    const used = new Set(document.items.map((item) => itemKey(document, item)));
    for (let count = 1; ; count++) {
        const id = `new-item-${count}`;
        if (!used.has(itemKey(document, id))) return id;
    }
}

export function initialItemBinding(
    document: ProjectDocument,
    kind: "layout" | "theme",
): null | undefined {
    return document.schemaVersion === 2 &&
        document[kind === "layout" ? "defaultLayout" : "defaultTheme"]
        ? null
        : undefined;
}

/** Copies owned content identities and messages, retaining shared catalog references. */
export function copyItemDocument(
    document: ProjectDocument,
    source: ItemNode,
    id: string,
    options: {
        nameForLocale?: (locale: string, name: string) => string;
        separateName?: boolean;
    } = {},
): ProjectDocument {
    const messages = new Map<string, string>();
    const key = (sourceKey: string) => {
        if (!messages.has(sourceKey))
            messages.set(sourceKey, `item.copy.${crypto.randomUUID()}`);
        return messages.get(sourceKey)!;
    };
    const clone = (block: PresentationBlock): PresentationBlock => {
        const next = { ...structuredClone(block), uuid: crypto.randomUUID() };
        if (next.type === "field") next.labelMessage = key(next.labelMessage);
        if (next.type === "description") next.message = key(next.message);
        if (next.type === "repeat") {
            next.template.labelMessage = key(next.template.labelMessage);
            if (next.template.missingMessage)
                next.template.missingMessage = key(
                    next.template.missingMessage,
                );
        }
        if (next.type === "conditional") {
            next.thenBlocks = next.thenBlocks.map(clone);
            next.otherwiseBlocks = next.otherwiseBlocks.map(clone);
        }
        return next;
    };
    const nameKey = options.separateName
        ? `item.copy.${crypto.randomUUID()}`
        : key(source.presentation.nameMessage);
    const item: ItemNode = {
        ...structuredClone(source),
        uuid: crypto.randomUUID(),
        id,
        presentation: {
            ...structuredClone(source.presentation),
            nameMessage: nameKey,
            blocks: source.presentation.blocks.map(clone),
        },
    };
    return {
        ...document,
        items: [...document.items, item],
        locales: document.locales.map((locale) => {
            const copied = Object.fromEntries(
                [...messages]
                    .filter(([from]) => Object.hasOwn(locale.messages, from))
                    .map(([from, to]) => [to, locale.messages[from]!]),
            );
            if (
                options.separateName &&
                Object.hasOwn(locale.messages, source.presentation.nameMessage)
            )
                copied[nameKey] =
                    locale.messages[source.presentation.nameMessage]!;
            if (options.nameForLocale && copied[nameKey] !== undefined)
                copied[nameKey] = options.nameForLocale(
                    locale.locale,
                    copied[nameKey],
                );
            return { ...locale, messages: { ...locale.messages, ...copied } };
        }),
    };
}

function binding(
    document: ProjectDocument,
    options: ItemCreationOptions,
    kind: "layout" | "theme",
) {
    if (options[kind] !== undefined) return options[kind];
    const source = document.items.find(
        (item) => item.uuid === options.sourceUuid,
    );
    return source
        ? source.presentation[kind]
        : initialItemBinding(document, kind);
}

export function itemCreationIssue(
    document: ProjectDocument,
    name: string,
    options: ItemCreationOptions,
): string | null {
    const idIssue = itemIdIssue(
        document,
        "",
        options.id ?? freshBlankItemId(document),
    );
    if (idIssue) return idIssue;
    if (!name.trim()) return "nameRequired";
    if ([...name].length > 16_384) return "nameTooLong";
    if (
        !document.locales.some(
            (locale) => locale.locale === document.defaultLocale,
        )
    )
        return "missingLocale";
    if (
        options.sourceUuid &&
        !document.items.some((item) => item.uuid === options.sourceUuid)
    )
        return "missingSource";
    for (const kind of ["layout", "theme"] as const) {
        const selected = binding(document, options, kind);
        const resolved =
            selected ??
            (document.schemaVersion === 2
                ? document[kind === "layout" ? "defaultLayout" : "defaultTheme"]
                : undefined);
        if (
            !resolved ||
            !document[kind === "layout" ? "layouts" : "themes"].some(
                (entry) => entry.id === resolved,
            )
        )
            return kind === "layout" ? "missingLayout" : "missingTheme";
    }
    return null;
}

export function createItemDocument(
    document: ProjectDocument,
    name: string,
    options: ItemCreationOptions = {},
): ProjectDocument {
    const issue = itemCreationIssue(document, name, options);
    if (issue) throw new Error(issue);
    const id = options.id ?? freshBlankItemId(document);
    const source = document.items.find(
        (item) => item.uuid === options.sourceUuid,
    );
    const copied = source
        ? copyItemDocument(document, source, id, { separateName: true })
        : document;
    const item: ItemNode = source
        ? copied.items.at(-1)!
        : {
              uuid: crypto.randomUUID(),
              id,
              enabled: false,
              definition: {
                  material: "minecraft:paper",
                  baseComponents: [],
                  contentComponent: null,
                  contents: [],
                  definitionData: [],
                  instance: {
                      mode: "FUNGIBLE",
                      idGenerator: null,
                      schemas: [],
                      defaults: [],
                      generators: [],
                  },
              },
              presentation: {
                  nameMessage: `item.new.${crypto.randomUUID()}`,
                  blocks: [],
              },
              previewData: [],
          };
    const created: ItemNode = {
        ...item,
        enabled: false,
        presentation: {
            ...item.presentation,
            ...(options.layout !== undefined || !source
                ? { layout: binding(document, options, "layout") }
                : {}),
            ...(options.theme !== undefined || !source
                ? { theme: binding(document, options, "theme") }
                : {}),
        },
    };
    return {
        ...copied,
        items: [...document.items, created],
        locales: copied.locales.map((locale) =>
            locale.locale === document.defaultLocale
                ? {
                      ...locale,
                      messages: {
                          ...locale.messages,
                          [created.presentation.nameMessage]: name,
                      },
                  }
                : locale,
        ),
    };
}
