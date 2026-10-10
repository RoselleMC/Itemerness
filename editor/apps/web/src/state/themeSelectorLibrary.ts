import {
    itemKey,
    itemTheme,
    namespacedIdSchema,
    themeSelectorNodeSchema,
    type ItemNode,
    type ProjectDocument,
    type ThemeNode,
    type ThemeSelectorCase,
    type ThemeSelectorNode,
} from "@itemerness/protocol";
import { freshNamespacedId } from "./freshId.js";

/**
 * Theme selectors are reusable, data-driven theme choices. Their ids share the theme id space:
 * an item or the document default theme may reference either, while a selector's cases and
 * default always name concrete themes. A document without selectors omits the field entirely
 * so its canonical hash and older-plugin compatibility stay unchanged.
 */
export function themeSelectorsOf(
    document: Pick<ProjectDocument, "themeSelectors">,
): readonly ThemeSelectorNode[] {
    return document.themeSelectors ?? [];
}

export function themeSelectorById(
    document: Pick<ProjectDocument, "themeSelectors">,
    id: string | null | undefined,
): ThemeSelectorNode | undefined {
    return id == null
        ? undefined
        : themeSelectorsOf(document).find((entry) => entry.id === id);
}

/** Replaces the selector list, dropping the field when it becomes empty. */
export function withThemeSelectors(
    document: ProjectDocument,
    selectors: readonly ThemeSelectorNode[],
): ProjectDocument {
    if (selectors.length > 0)
        return { ...document, themeSelectors: [...selectors] };
    if (!Object.hasOwn(document, "themeSelectors")) return document;
    const { themeSelectors: _removed, ...rest } = document;
    return rest as ProjectDocument;
}

/** Concrete themes a binding can render with, in evaluation order (selector cases, then default). */
export function reachableThemes(
    document: Pick<ProjectDocument, "themes" | "themeSelectors">,
    id: string | null | undefined,
): ThemeNode[] {
    const selector = themeSelectorById(document, id);
    const ids = selector
        ? [...selector.cases.map((entry) => entry.theme), selector.defaultTheme]
        : id == null
          ? []
          : [id];
    return [...new Set(ids)].flatMap((themeId) => {
        const theme = document.themes.find((entry) => entry.id === themeId);
        return theme ? [theme] : [];
    });
}

/**
 * The theme an authoring control should consult for style roles and similar per-theme choices:
 * the theme itself, or a selector's default theme.
 */
export function representativeTheme(
    document: Pick<ProjectDocument, "themes" | "themeSelectors">,
    id: string | null | undefined,
): ThemeNode | undefined {
    const concrete = themeSelectorById(document, id)?.defaultTheme ?? id;
    return document.themes.find((entry) => entry.id === concrete);
}

export function themeSelectorIdError(
    document: ProjectDocument,
    uuid: string,
    id: string,
): "invalidId" | "duplicateId" | null {
    if (!namespacedIdSchema.safeParse(id).success) return "invalidId";
    if (
        document.themes.some((entry) => entry.id === id) ||
        themeSelectorsOf(document).some(
            (entry) => entry.uuid !== uuid && entry.id === id,
        )
    )
        return "duplicateId";
    return null;
}

function usedThemeIds(document: ProjectDocument): Set<string> {
    return new Set(
        [...document.themes, ...themeSelectorsOf(document)].map(
            (entry) => entry.id,
        ),
    );
}

/** A new selector, or a copy of `source` with a fresh uuid and id. */
export function newThemeSelector(
    document: ProjectDocument,
    source?: ThemeSelectorNode,
): ThemeSelectorNode | null {
    const fallback =
        document.themes.find((theme) => theme.id === document.defaultTheme) ??
        document.themes[0];
    if (!source && !fallback) return null;
    return themeSelectorNodeSchema.parse({
        ...(source
            ? structuredClone(source)
            : { cases: [], defaultTheme: fallback!.id }),
        uuid: crypto.randomUUID(),
        id: freshNamespacedId(
            source
                ? `${source.id}-copy`
                : `${document.namespace}:new-theme-selector`,
            usedThemeIds(document),
        ),
    });
}

export function themeSelectorItems(
    document: ProjectDocument,
    id: string,
): ItemNode[] {
    return document.items.filter((item) => itemTheme(document, item) === id);
}

/** Everything that would dangle if the selector were removed. */
export function themeSelectorReferences(
    document: ProjectDocument,
    id: string,
): string[] {
    return [
        ...(document.defaultTheme === id ? ["document.defaultTheme"] : []),
        ...themeSelectorItems(document, id).map((item) =>
            itemKey(document, item),
        ),
    ];
}

/** Theme selectors whose cases or default name the theme. */
export function selectorsReferencingTheme(
    document: Pick<ProjectDocument, "themeSelectors">,
    themeId: string,
): ThemeSelectorNode[] {
    return themeSelectorsOf(document).filter(
        (selector) =>
            selector.defaultTheme === themeId ||
            selector.cases.some((entry) => entry.theme === themeId),
    );
}

/** Points selector cases and defaults at a renamed theme. */
export function renameThemeInSelectors(
    document: ProjectDocument,
    from: string,
    to: string,
): ProjectDocument {
    if (!selectorsReferencingTheme(document, from).length) return document;
    return withThemeSelectors(
        document,
        themeSelectorsOf(document).map((selector) => ({
            ...selector,
            defaultTheme:
                selector.defaultTheme === from ? to : selector.defaultTheme,
            cases: selector.cases.map((entry) =>
                entry.theme === from ? { ...entry, theme: to } : entry,
            ),
        })),
    );
}

export function renameThemeSelector(
    document: ProjectDocument,
    uuid: string,
    id: string,
): ProjectDocument {
    const source = themeSelectorsOf(document).find(
        (entry) => entry.uuid === uuid,
    );
    if (!source || source.id === id || themeSelectorIdError(document, uuid, id))
        return document;
    return {
        ...withThemeSelectors(
            document,
            themeSelectorsOf(document).map((entry) =>
                entry.uuid === uuid ? { ...entry, id } : entry,
            ),
        ),
        ...(document.defaultTheme === source.id ? { defaultTheme: id } : {}),
        items: document.items.map((item) =>
            item.presentation.theme === source.id
                ? { ...item, presentation: { ...item.presentation, theme: id } }
                : item,
        ),
    };
}

export function removeThemeSelector(
    document: ProjectDocument,
    uuid: string,
): ProjectDocument {
    const source = themeSelectorsOf(document).find(
        (entry) => entry.uuid === uuid,
    );
    if (!source || themeSelectorReferences(document, source.id).length)
        return document;
    return withThemeSelectors(
        document,
        themeSelectorsOf(document).filter((entry) => entry.uuid !== uuid),
    );
}

export function updateThemeSelector(
    document: ProjectDocument,
    uuid: string,
    mutate: (selector: ThemeSelectorNode) => ThemeSelectorNode,
): ProjectDocument {
    const selectors = themeSelectorsOf(document);
    if (!selectors.some((entry) => entry.uuid === uuid)) return document;
    return withThemeSelectors(
        document,
        selectors.map((entry) => (entry.uuid === uuid ? mutate(entry) : entry)),
    );
}

/** A starter case: the first presentation-readable data key exists, otherwise a fact. */
export function newThemeSelectorCase(
    document: ProjectDocument,
    selector: ThemeSelectorNode,
): ThemeSelectorCase {
    const key = document.dataSchemas
        .flatMap((schema) => schema.keys)
        .find((entry) => entry.presentationReadable);
    const fact = document.viewerFacts[0];
    return {
        condition: {
            operator: "EXISTS",
            left: key
                ? { kind: "data", key: key.id }
                : fact
                  ? { kind: "fact", key: fact.id }
                  : {
                        kind: "literal",
                        value: { kind: "boolean", value: true },
                    },
            right: null,
        },
        theme: selector.defaultTheme,
    };
}
