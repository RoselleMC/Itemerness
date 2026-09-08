import { itemKey, itemLayout, itemTheme } from "@itemerness/protocol";
import {
    layoutNodeSchema,
    namespacedIdSchema,
    themeNodeSchema,
    type LayoutNode,
    type ProjectDocument,
    type ThemeNode,
} from "@itemerness/protocol";
import { freshNamespacedId } from "./freshId.js";

export type ThemeLayoutKind = "themes" | "layouts";

function retainedRendererState(
    theme: ThemeNode,
): Record<string, unknown> | null {
    const state = theme.extensions?.editorRendererState;
    return state && typeof state === "object" && !Array.isArray(state)
        ? (state as Record<string, unknown>)
        : null;
}

export function themeLayoutIdError(
    document: ProjectDocument,
    kind: ThemeLayoutKind,
    uuid: string,
    id: string,
): "invalidId" | "duplicateId" | null {
    if (!namespacedIdSchema.safeParse(id).success) return "invalidId";
    if (document[kind].some((entry) => entry.uuid !== uuid && entry.id === id))
        return "duplicateId";
    return null;
}

export function newTheme(
    document: ProjectDocument,
    source?: ThemeNode,
): ThemeNode {
    const font =
        document.fonts.find((entry) => entry.id === "minecraft:default") ??
        document.fonts[0];
    return themeNodeSchema.parse({
        ...(source
            ? structuredClone(source)
            : {
                  renderer: "PLAIN",
                  requiresResourcePack: false,
                  vanillaTooltipLines: "PRESERVE",
                  fonts: font ? { text: font.id } : {},
              }),
        uuid: crypto.randomUUID(),
        id: freshNamespacedId(
            source ? `${source.id}-copy` : `${document.namespace}:new-theme`,
            new Set(document.themes.map((entry) => entry.id)),
        ),
    });
}

export function newLayout(
    document: ProjectDocument,
    kind: LayoutNode["kind"],
    source?: LayoutNode,
): LayoutNode {
    const wrapping = {
        body: {
            widthPixels: null,
            maximumLines: 16,
            overflow: "ELLIPSIS",
            preserveExplicitLines: true,
            continuationIndentPixels: 0,
            lineHeightPixels: 10,
        },
    };
    return layoutNodeSchema.parse({
        ...(source
            ? structuredClone(source)
            : kind === "flow"
              ? {
                    kind,
                    minimumWidthPixels: 1,
                      maximumWidthPixels: document.budgets.maximumWidthPixels,
                    wrapping,
                }
              : {
                    kind,
                    widthPixels: 160,
                    heightPixels: 80,
                    maximumWidthPixels: 160,
                    maximumHeightPixels: 80,
                    reserveTooltipLines: 8,
                    anchors: {
                        name: {
                            x: 0,
                            y: 0,
                            width: 160,
                            height: 10,
                            overflow: "ELLIPSIS",
                        },
                        body: {
                            x: 0,
                            y: 10,
                            width: 160,
                            height: 70,
                            overflow: "ELLIPSIS",
                        },
                    },
                    wrapping,
                }),
        uuid: crypto.randomUUID(),
        id: freshNamespacedId(
            source
                ? `${source.id}-copy`
                : `${document.namespace}:new-${kind}-layout`,
            new Set(document.layouts.map((entry) => entry.id)),
        ),
    });
}

export function themeLayoutItems(
    document: ProjectDocument,
    kind: ThemeLayoutKind,
    id: string,
) {
    return document.items.filter(
        (item) =>
            (kind === "themes" ? itemTheme(document, item) : itemLayout(document, item)) === id,
    );
}

export function themeLayoutReferences(
    document: ProjectDocument,
    kind: ThemeLayoutKind,
    id: string,
): string[] {
    return [
        ...(kind === "themes" ? document.defaultTheme === id ? ["document.defaultTheme"] : []
            : document.defaultLayout === id ? ["document.defaultLayout"] : []),
        ...themeLayoutItems(document, kind, id).map(
            (item) => itemKey(document, item),
        ),
        ...(kind === "themes"
            ? [
                  ...document.themes
                      .filter(
                          (theme) =>
                              theme.fallback === id ||
                              retainedRendererState(theme)?.fallback === id,
                      )
                      .map((theme) => theme.id),
                  ...document.viewerFacts
                      .filter(
                          (fact) =>
                              fact.id === "itemerness:theme" &&
                              fact.type === "NAMESPACED_KEY" &&
                              [fact.defaultValue, fact.previewValue].some(
                                  (value) =>
                                      value?.kind === "string" &&
                                      value.value === id,
                              ),
                      )
                      .map((fact) => fact.id),
              ]
            : []),
    ];
}

export function renameThemeLayout(
    document: ProjectDocument,
    kind: ThemeLayoutKind,
    uuid: string,
    id: string,
): ProjectDocument {
    const source = document[kind].find((entry) => entry.uuid === uuid);
    if (
        !source ||
        source.id === id ||
        themeLayoutIdError(document, kind, uuid, id)
    )
        return document;
    return {
        ...document,
        ...(kind === "themes" && document.defaultTheme === source.id ? { defaultTheme: id } : {}),
        ...(kind === "layouts" && document.defaultLayout === source.id ? { defaultLayout: id } : {}),
        themes:
            kind === "layouts"
                ? document.themes
                : document.themes.map((theme) => ({
                      ...theme,
                      ...(theme.uuid === uuid ? { id } : {}),
                      fallback:
                          theme.fallback === source.id ? id : theme.fallback,
                      ...(retainedRendererState(theme)?.fallback === source.id
                          ? {
                                extensions: {
                                    ...theme.extensions,
                                    editorRendererState: {
                                        ...retainedRendererState(theme),
                                        fallback: id,
                                    },
                                },
                            }
                          : {}),
                  })),
        layouts:
            kind === "themes"
                ? document.layouts
                : document.layouts.map((layout) =>
                      layout.uuid === uuid ? { ...layout, id } : layout,
                  ),
        items: document.items.map((item) => {
            const field = kind === "themes" ? "theme" : "layout";
            return item.presentation[field] === source.id
                ? {
                      ...item,
                      presentation: { ...item.presentation, [field]: id },
                  }
                : item;
        }),
        viewerFacts:
            kind === "layouts"
                ? document.viewerFacts
                : document.viewerFacts.map((fact) =>
                      fact.id !== "itemerness:theme" ||
                      fact.type !== "NAMESPACED_KEY"
                          ? fact
                          : {
                                ...fact,
                                defaultValue:
                                    fact.defaultValue?.kind === "string" &&
                                    fact.defaultValue.value === source.id
                                        ? { kind: "string", value: id }
                                        : fact.defaultValue,
                                previewValue:
                                    fact.previewValue?.kind === "string" &&
                                    fact.previewValue.value === source.id
                                        ? { kind: "string", value: id }
                                        : fact.previewValue,
                            },
                  ),
    };
}

export function removeThemeLayout(
    document: ProjectDocument,
    kind: ThemeLayoutKind,
    uuid: string,
): ProjectDocument {
    const source = document[kind].find((entry) => entry.uuid === uuid);
    if (!source || themeLayoutReferences(document, kind, source.id).length)
        return document;
    return kind === "themes"
        ? {
              ...document,
              themes: document.themes.filter((entry) => entry.uuid !== uuid),
          }
        : {
              ...document,
              layouts: document.layouts.filter((entry) => entry.uuid !== uuid),
          };
}
