import {
    assetProfileNodeSchema,
    bitmapNodeSchema,
    fontNodeSchema,
    glyphNodeSchema,
    itemKey,
    namespacedIdSchema,
    resourcePackBindingNodeSchema,
    tooltipStyleNodeSchema,
    type AssetProfileNode,
    type BitmapNode,
    type FontNode,
    type GlyphNode,
    type PresentationBlock,
    type ProjectDocument,
    type ResourcePackBindingNode,
    type ThemeNode,
    type TooltipStyleNode,
} from "@itemerness/protocol";
import { freshNamespacedId } from "./freshId.js";

export type AssetKind =
    | "fonts"
    | "glyphs"
    | "bitmaps"
    | "assetProfiles"
    | "resourcePackBindings"
    | "tooltipStyles";
export type AssetSection = AssetKind | "spacing" | "measurement";
export type AssetNode =
    | FontNode
    | GlyphNode
    | BitmapNode
    | AssetProfileNode
    | ResourcePackBindingNode
    | TooltipStyleNode;
export const ASSET_KINDS: readonly AssetKind[] = [
    "fonts",
    "glyphs",
    "bitmaps",
    "assetProfiles",
    "resourcePackBindings",
    "tooltipStyles",
];

function record(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

export function freshSemanticId(
    base: string,
    used: ReadonlySet<string>,
): string {
    for (let index = 0; ; index++) {
        const suffix = index === 0 ? "" : `-${index + 1}`;
        const value = base + suffix;
        if (!used.has(value)) return value;
    }
}

export function assetIdError(
    document: ProjectDocument,
    kind: AssetKind,
    uuid: string,
    id: string,
): string | null {
    if (kind === "glyphs" || kind === "bitmaps") {
        if (!/^[a-z0-9][a-z0-9._-]*$/.test(id)) return "semanticId";
    } else if (!namespacedIdSchema.safeParse(id).success) return "namespacedId";
    if (document[kind].some((entry) => entry.uuid !== uuid && entry.id === id))
        return "duplicateId";
    const font =
        kind === "fonts"
            ? document.fonts.find((entry) => entry.uuid === uuid)
            : null;
    if (font?.metrics.startsWith("builtin:") && font.id !== id)
        return "builtinFontId";
    return null;
}

export function nextGlyphCodePoint(
    document: ProjectDocument,
    font: string,
): number {
    const used = new Set(
        document.glyphs
            .filter((glyph) => glyph.font === font)
            .map((glyph) => glyph.codePoint),
    );
    for (let codePoint = 0xe000; codePoint <= 0xf8ff; codePoint++)
        if (!used.has(codePoint)) return codePoint;
    for (let codePoint = 0x100000; codePoint <= 0x10fffd; codePoint++)
        if (!used.has(codePoint)) return codePoint;
    return 0;
}

export function newAsset(
    document: ProjectDocument,
    kind: AssetKind,
    source?: AssetNode,
): AssetNode {
    const used = new Set(document[kind].map((entry) => entry.id));
    const base = source
        ? `${source.id}-copy`
        : kind === "glyphs"
          ? "new-glyph"
          : kind === "bitmaps"
            ? "new-bitmap"
            : `${document.namespace}:new-${kind === "assetProfiles" ? "profile" : kind === "resourcePackBindings" ? "binding" : kind === "tooltipStyles" ? "tooltip" : "font"}`;
    const identity = {
        uuid: crypto.randomUUID(),
        id:
            kind === "glyphs" || kind === "bitmaps"
                ? freshSemanticId(base, used)
                : freshNamespacedId(base, used),
    };
    if (source) {
        const copy = { ...structuredClone(source), ...identity };
        if (kind === "glyphs")
            return {
                ...copy,
                codePoint: nextGlyphCodePoint(
                    document,
                    (source as GlyphNode).font,
                ),
            };
        if (kind === "resourcePackBindings") return { ...copy, enabled: false };
        return copy;
    }
    switch (kind) {
        case "fonts":
            return {
                ...identity,
                metrics: "explicit",
                fallback: null,
                fallbackAdvancePixels: null,
                advances: null,
            };
        case "glyphs": {
            const font =
                document.fonts.find(
                    (entry) => !entry.metrics.startsWith("builtin:"),
                )?.id ?? "";
            return {
                ...identity,
                font,
                codePoint: nextGlyphCodePoint(document, font),
                advancePixels: 0,
                visualBounds: { left: 0, right: 0, top: 0, bottom: 0 },
                bitmap: null,
            };
        }
        case "bitmaps":
            return {
                ...identity,
                baselineVariant: null,
                texture: null,
                sourceWidthPixels: null,
                sourceHeightPixels: null,
                renderWidthPixels: 1,
                renderHeightPixels: 1,
                ascentPixels: 1,
                visualBounds: { left: 0, right: 1, top: -1, bottom: 0 },
            };
        case "assetProfiles":
            return {
                ...identity,
                capabilities: [],
                metricsRevision: null,
                fallback: null,
            };
        case "resourcePackBindings":
            return {
                ...identity,
                enabled: false,
                packId: null,
                sha1: null,
                assetProfile: document.assetProfiles[0]?.id ?? "",
            };
        case "tooltipStyles":
            return {
                ...identity,
                expectedBackgroundSprite: "",
                expectedFrameSprite: "",
                scaling: "nine-slice",
            };
    }
}

export function fallbackCycle(
    document: ProjectDocument,
    kind: "fonts" | "assetProfiles",
    id: string,
    fallback: string | null,
): boolean {
    const seen = new Set([id]);
    for (let current = fallback; current;) {
        if (seen.has(current)) return true;
        seen.add(current);
        current =
            document[kind].find((entry) => entry.id === current)?.fallback ??
            null;
    }
    return false;
}

export function fontMetricsError(id: string, metrics: string): string | null {
    if (!fontNodeSchema.shape.metrics.safeParse(metrics).success)
        return "metrics";
    if (!metrics.startsWith("builtin:")) return null;
    const table = /^builtin:minecraft-(default|uniform)(?:-26\.1\.2)?$/.exec(
        metrics,
    );
    if (!table) return "unknownBuiltinMetrics";
    return id === `minecraft:${table[1]}` ? null : "builtinFontId";
}

export function normalizedFontMetrics(
    font: Pick<FontNode, "id" | "metrics">,
): string {
    return font.metrics === "explicit" || font.metrics === "space-provider"
        ? `itemerness:${font.metrics}/${font.id.replace(":", "/")}`
        : font.metrics;
}

export function assetError(
    document: ProjectDocument,
    kind: AssetKind,
    value: AssetNode,
): string | null {
    const idError = assetIdError(document, kind, value.uuid, value.id);
    if (idError) return idError;
    const schemas = {
        fonts: fontNodeSchema,
        glyphs: glyphNodeSchema,
        bitmaps: bitmapNodeSchema,
        assetProfiles: assetProfileNodeSchema,
        resourcePackBindings: resourcePackBindingNodeSchema,
        tooltipStyles: tooltipStyleNodeSchema,
    };
    if (!schemas[kind].safeParse(value).success) return "requiredFields";
    if (kind === "fonts") {
        const font = value as FontNode;
        const metricsError = fontMetricsError(font.id, font.metrics);
        if (metricsError) return metricsError;
        if (
            font.fallback &&
            !document.fonts.some((entry) => entry.id === font.fallback)
        )
            return "missingFont";
        if (fallbackCycle(document, kind, font.id, font.fallback))
            return "fallbackCycle";
        if (
            font.fallbackAdvancePixels !== null &&
            Math.abs(font.fallbackAdvancePixels) > 4096
        )
            return "advanceRange";
        if (
            font.metrics.startsWith("builtin:") &&
            (font.fallback !== null ||
                font.fallbackAdvancePixels !== null ||
                document.glyphs.some((entry) => entry.font === font.id))
        )
            return "builtinFontOverrides";
    } else if (kind === "glyphs") {
        const glyph = value as GlyphNode;
        const font = document.fonts.find((entry) => entry.id === glyph.font);
        if (!font) return "missingFont";
        if (font.metrics.startsWith("builtin:")) return "builtinFontOverrides";
        if (glyph.codePoint >= 0xd800 && glyph.codePoint <= 0xdfff)
            return "codePoint";
        if (
            document.glyphs.some(
                (entry) =>
                    entry.uuid !== glyph.uuid &&
                    entry.font === glyph.font &&
                    entry.codePoint === glyph.codePoint,
            )
        )
            return "duplicateCodePoint";
        if (
            glyph.bitmap &&
            !document.bitmaps.some((entry) => entry.id === glyph.bitmap)
        )
            return "missingBitmap";
        if (Math.abs(glyph.advancePixels) > 4096) return "advanceRange";
        const bounds = glyph.visualBounds;
        if (bounds.right < bounds.left || bounds.bottom < bounds.top)
            return "boundsOrder";
        if (
            bounds.left < -document.budgets.maximumWidthPixels ||
            bounds.right > document.budgets.maximumWidthPixels ||
            bounds.right - bounds.left > document.budgets.maximumWidthPixels ||
            bounds.top < -document.budgets.maximumHeightPixels ||
            bounds.bottom > document.budgets.maximumHeightPixels ||
            bounds.bottom - bounds.top > document.budgets.maximumHeightPixels
        )
            return "boundsBudget";
    } else if (kind === "bitmaps") {
        const bitmap = value as BitmapNode;
        if (
            !bitmap.texture ||
            bitmap.sourceWidthPixels === null ||
            bitmap.sourceHeightPixels === null
        )
            return "bitmapSourceRequired";
        if (
            bitmap.renderWidthPixels > document.budgets.maximumWidthPixels ||
            bitmap.renderHeightPixels > document.budgets.maximumHeightPixels
        )
            return "boundsBudget";
        if (
            bitmap.ascentPixels < 0 ||
            bitmap.ascentPixels > bitmap.renderHeightPixels
        )
            return "ascentRange";
        if (
            bitmap.visualBounds.right < bitmap.visualBounds.left ||
            bitmap.visualBounds.bottom < bitmap.visualBounds.top
        )
            return "boundsOrder";
        if (
            bitmap.visualBounds.right - bitmap.visualBounds.left >
                document.budgets.maximumWidthPixels ||
            bitmap.visualBounds.bottom - bitmap.visualBounds.top >
                document.budgets.maximumHeightPixels
        )
            return "boundsBudget";
        if (
            bitmap.baselineVariant === null &&
            bitmapLayerReferences(document, bitmap.id).length
        )
            return "baselineRequired";
    } else if (kind === "assetProfiles") {
        const profile = value as AssetProfileNode;
        if (
            profile.fallback &&
            !document.assetProfiles.some(
                (entry) => entry.id === profile.fallback,
            )
        )
            return "missingProfile";
        if (fallbackCycle(document, kind, profile.id, profile.fallback))
            return "fallbackCycle";
    } else if (kind === "resourcePackBindings") {
        const binding = value as ResourcePackBindingNode;
        if (
            !document.assetProfiles.some(
                (entry) => entry.id === binding.assetProfile,
            )
        )
            return "missingProfile";
        if (binding.enabled) {
            if (
                !binding.packId ||
                /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(binding.packId)
            )
                return "bindingUuid";
            if (!binding.sha1 || /^0{40}$/.test(binding.sha1))
                return "bindingSha1";
            if (
                document.resourcePackBindings.some(
                    (entry) =>
                        entry.uuid !== binding.uuid &&
                        entry.enabled &&
                        entry.packId === binding.packId,
                )
            )
                return "duplicatePackId";
        }
    }
    return null;
}

function visitBlocks(
    blocks: PresentationBlock[],
    visit: (block: PresentationBlock) => PresentationBlock,
): PresentationBlock[] {
    return blocks.map((block) =>
        visit(
            block.type === "conditional"
                ? {
                      ...block,
                      thenBlocks: visitBlocks(block.thenBlocks, visit),
                      otherwiseBlocks: visitBlocks(
                          block.otherwiseBlocks,
                          visit,
                      ),
                  }
                : block,
        ),
    );
}

function glyphReferences(theme: ThemeNode): string[] {
    const frame = theme.segmentedFrame;
    return [
        ...(frame
            ? [frame.top, frame.body, frame.connector, frame.bottom].flatMap(
                  (row) => (row ? [row.left, row.fill, row.right, row.center, row.kern].filter((id): id is string => id != null) : []),
              )
            : []),
        ...(theme.canvas?.layers.map((layer) => layer.asset) ?? []),
    ];
}

export function bitmapLayerReferences(
    document: ProjectDocument,
    id: string,
): string[] {
    const glyphs = new Set(
        document.glyphs
            .filter((glyph) => glyph.bitmap === id)
            .map((glyph) => glyph.id),
    );
    return document.themes
        .filter((theme) =>
            theme.canvas?.layers.some((layer) => glyphs.has(layer.asset)),
        )
        .map((theme) => theme.id);
}

function savedProfileValues(value: unknown): Record<string, unknown> | null {
    return record(record(value)?.NAMESPACED_KEY);
}

function isStringValue(value: unknown, id: string): boolean {
    const data = record(value);
    return data?.kind === "string" && data.value === id;
}

export function assetReferences(
    document: ProjectDocument,
    kind: AssetKind,
    id: string,
): string[] {
    const references: string[] = [];
    if (kind === "fonts") {
        document.fonts.forEach((entry) => {
            if (entry.fallback === id) references.push(entry.id);
        });
        document.glyphs.forEach((entry) => {
            if (entry.font === id) references.push(entry.id);
        });
        document.themes.forEach((theme) => {
            if (Object.values(theme.fonts).includes(id))
                references.push(theme.id);
        });
        if (document.spacing?.font === id) references.push("spacing");
        const font = document.fonts.find((entry) => entry.id === id);
        if (
            font &&
            (font.metrics === "explicit" || font.metrics === "space-provider")
        )
            document.assetProfiles.forEach((profile) => {
                if (profile.metricsRevision === normalizedFontMetrics(font))
                    references.push(profile.id);
            });
    } else if (kind === "glyphs") {
        document.themes.forEach((theme) => {
            if (glyphReferences(theme).includes(id)) references.push(theme.id);
        });
        document.items.forEach((item) =>
            visitBlocks(item.presentation.blocks, (block) => {
                if (block.type === "field" && block.icon === id)
                    references.push(itemKey(document, item));
                return block;
            }),
        );
    } else if (kind === "bitmaps")
        document.glyphs.forEach((entry) => {
            if (entry.bitmap === id) references.push(entry.id);
        });
    else if (kind === "assetProfiles") {
        document.assetProfiles.forEach((entry) => {
            if (entry.fallback === id) references.push(entry.id);
        });
        document.resourcePackBindings.forEach((entry) => {
            if (entry.assetProfile === id) references.push(entry.id);
        });
        document.viewerFacts.forEach((fact) => {
            const saved = savedProfileValues(fact.extensions?.editorFactTypes);
            if (
                fact.id === "itemerness:asset-profile" &&
                [
                    ...(fact.type === "NAMESPACED_KEY"
                        ? [fact.defaultValue, fact.previewValue]
                        : []),
                    saved?.defaultValue,
                    saved?.previewValue,
                ].some((value) => isStringValue(value, id))
            )
                references.push(fact.id);
        });
    } else if (kind === "tooltipStyles")
        document.themes.forEach((theme) => {
            if (
                theme.tooltipStyle === id ||
                record(theme.extensions?.editorRendererState)?.tooltipStyle ===
                    id
            )
                references.push(theme.id);
        });
    return [...new Set(references)];
}

export function renameAsset(
    document: ProjectDocument,
    kind: AssetKind,
    uuid: string,
    id: string,
): ProjectDocument {
    const source = document[kind].find((entry) => entry.uuid === uuid);
    if (!source || source.id === id || assetIdError(document, kind, uuid, id))
        return document;
    const old = source.id;
    let next = {
        ...document,
        [kind]: document[kind].map((entry) =>
            entry.uuid === uuid ? { ...entry, id } : entry,
        ),
    } as ProjectDocument;
    if (kind === "fonts")
        next = {
            ...next,
            fonts: next.fonts.map((font) =>
                font.fallback === old ? { ...font, fallback: id } : font,
            ),
            glyphs: next.glyphs.map((glyph) =>
                glyph.font === old ? { ...glyph, font: id } : glyph,
            ),
            spacing:
                next.spacing?.font === old
                    ? { ...next.spacing, font: id }
                    : next.spacing,
            themes: next.themes.map((theme) => ({
                ...theme,
                fonts: Object.fromEntries(
                    Object.entries(theme.fonts).map(([role, font]) => [
                        role,
                        font === old ? id : font,
                    ]),
                ),
            })),
            assetProfiles: next.assetProfiles.map((profile) => {
                const font = source as FontNode;
                return (font.metrics === "explicit" ||
                    font.metrics === "space-provider") &&
                    profile.metricsRevision === normalizedFontMetrics(font)
                    ? {
                          ...profile,
                          metricsRevision: normalizedFontMetrics({
                              ...font,
                              id,
                          }),
                      }
                    : profile;
            }),
        };
    if (kind === "glyphs")
        next = {
            ...next,
            themes: next.themes.map((theme) => {
                const frame = theme.segmentedFrame;
                const row = (value: NonNullable<typeof frame>["top"]) => ({
                    ...value,
                    left: value.left === old ? id : value.left,
                    fill: value.fill === old ? id : value.fill,
                    right: value.right === old ? id : value.right,
                    ...(value.center === old ? { center: id } : {}),
                    ...(value.kern === old ? { kern: id } : {}),
                });
                return {
                    ...theme,
                    segmentedFrame: frame
                        ? {
                              ...frame,
                              top: row(frame.top),
                              body: row(frame.body),
                              connector: frame.connector
                                  ? row(frame.connector)
                                  : null,
                              bottom: row(frame.bottom),
                          }
                        : null,
                    canvas: theme.canvas
                        ? {
                              ...theme.canvas,
                              layers: theme.canvas.layers.map((layer) =>
                                  layer.asset === old
                                      ? { ...layer, asset: id }
                                      : layer,
                              ),
                          }
                        : null,
                };
            }),
            items: next.items.map((item) => ({
                ...item,
                presentation: {
                    ...item.presentation,
                    blocks: visitBlocks(item.presentation.blocks, (block) =>
                        block.type === "field" && block.icon === old
                            ? { ...block, icon: id }
                            : block,
                    ),
                },
            })),
        };
    if (kind === "bitmaps")
        next = {
            ...next,
            glyphs: next.glyphs.map((glyph) =>
                glyph.bitmap === old ? { ...glyph, bitmap: id } : glyph,
            ),
        };
    if (kind === "assetProfiles")
        next = {
            ...next,
            assetProfiles: next.assetProfiles.map((profile) =>
                profile.fallback === old
                    ? { ...profile, fallback: id }
                    : profile,
            ),
            resourcePackBindings: next.resourcePackBindings.map((binding) =>
                binding.assetProfile === old
                    ? { ...binding, assetProfile: id }
                    : binding,
            ),
            viewerFacts: next.viewerFacts.map((fact) => {
                if (fact.id !== "itemerness:asset-profile") return fact;
                const types = record(fact.extensions?.editorFactTypes);
                const saved = savedProfileValues(types);
                const replace = (value: unknown) =>
                    isStringValue(value, old)
                        ? { ...record(value), value: id }
                        : value;
                return {
                    ...fact,
                    ...(fact.type === "NAMESPACED_KEY"
                        ? {
                              defaultValue:
                                  fact.defaultValue?.kind === "string" &&
                                  fact.defaultValue.value === old
                                      ? { ...fact.defaultValue, value: id }
                                      : fact.defaultValue,
                              previewValue:
                                  fact.previewValue?.kind === "string" &&
                                  fact.previewValue.value === old
                                      ? { ...fact.previewValue, value: id }
                                      : fact.previewValue,
                          }
                        : {}),
                    ...(saved
                        ? {
                              extensions: {
                                  ...fact.extensions,
                                  editorFactTypes: {
                                      ...types,
                                      NAMESPACED_KEY: {
                                          ...saved,
                                          defaultValue: replace(
                                              saved.defaultValue,
                                          ),
                                          previewValue: replace(
                                              saved.previewValue,
                                          ),
                                      },
                                  },
                              },
                          }
                        : {}),
                };
            }),
        };
    if (kind === "tooltipStyles")
        next = {
            ...next,
            themes: next.themes.map((theme) => {
                const saved = record(theme.extensions?.editorRendererState);
                return {
                    ...theme,
                    tooltipStyle:
                        theme.tooltipStyle === old ? id : theme.tooltipStyle,
                    ...(saved?.tooltipStyle === old
                        ? {
                              extensions: {
                                  ...theme.extensions,
                                  editorRendererState: {
                                      ...saved,
                                      tooltipStyle: id,
                                  },
                              },
                          }
                        : {}),
                };
            }),
        };
    return next;
}

export function updateAsset(
    document: ProjectDocument,
    kind: AssetKind,
    uuid: string,
    mutate: (source: AssetNode) => AssetNode,
): ProjectDocument {
    const source = document[kind].find((entry) => entry.uuid === uuid);
    if (!source) return document;
    const value = mutate(source);
    let next = {
        ...document,
        [kind]: document[kind].map((entry) =>
            entry.uuid === uuid ? value : entry,
        ),
    } as ProjectDocument;
    if (kind === "bitmaps") {
        const old = source as BitmapNode;
        const bitmap = value as BitmapNode;
        if (
            bitmap.baselineVariant !== null &&
            bitmap.baselineVariant !== old.baselineVariant
        ) {
            const glyphs = new Set(
                document.glyphs
                    .filter((glyph) => glyph.bitmap === old.id)
                    .map((glyph) => glyph.id),
            );
            next = {
                ...next,
                themes: next.themes.map((theme) =>
                    theme.canvas
                        ? {
                              ...theme,
                              canvas: {
                                  ...theme.canvas,
                                  layers: theme.canvas.layers.map((layer) =>
                                      glyphs.has(layer.asset) &&
                                      layer.baselineVariant ===
                                          old.baselineVariant
                                          ? {
                                                ...layer,
                                                baselineVariant:
                                                    bitmap.baselineVariant!,
                                            }
                                          : layer,
                                  ),
                              },
                          }
                        : theme,
                ),
            };
        }
    }
    return next;
}

export function removeAsset(
    document: ProjectDocument,
    kind: AssetKind,
    uuid: string,
): ProjectDocument {
    const source = document[kind].find((entry) => entry.uuid === uuid);
    if (!source || assetReferences(document, kind, source.id).length)
        return document;
    return {
        ...document,
        [kind]: document[kind].filter((entry) => entry.uuid !== uuid),
    } as ProjectDocument;
}
