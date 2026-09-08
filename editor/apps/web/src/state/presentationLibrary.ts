import { itemKey } from "@itemerness/protocol";
import {
    namespacedIdSchema,
    type FormatNode,
    type ItemNode,
    type PresentationBlock,
    type ProjectDocument,
    type ViewerFactNode,
} from "@itemerness/protocol";
import { freshNamespacedId } from "./freshId.js";

export type PresentationLibraryKind = "formats" | "facts";

export const BUILTIN_FACT_TYPES = {
    "itemerness:locale": "LOCALE",
    "itemerness:theme": "NAMESPACED_KEY",
    "itemerness:resource-pack-ready": "BOOLEAN",
    "itemerness:asset-profile": "NAMESPACED_KEY",
} as const;

export function builtinFactType(id: string): ViewerFactNode["type"] | null {
    return BUILTIN_FACT_TYPES[id as keyof typeof BUILTIN_FACT_TYPES] ?? null;
}

export function libraryIdError(
    document: ProjectDocument,
    kind: PresentationLibraryKind,
    uuid: string,
    id: string,
): "invalidId" | "duplicateId" | null {
    if (!namespacedIdSchema.safeParse(id).success) return "invalidId";
    const entries =
        kind === "formats" ? document.formats : document.viewerFacts;
    if (entries.some((entry) => entry.uuid !== uuid && entry.id === id))
        return "duplicateId";
    return null;
}

function freshId(base: string, used: readonly { id: string }[]) {
    return freshNamespacedId(base, new Set(used.map((entry) => entry.id)));
}

export function newFormat(
    document: ProjectDocument,
    source?: FormatNode,
): FormatNode {
    return source
        ? {
              ...structuredClone(source),
              uuid: crypto.randomUUID(),
              id: freshId(`${source.id}-copy`, document.formats),
          }
        : {
              uuid: crypto.randomUUID(),
              id: freshId(`${document.namespace}:new-format`, document.formats),
              kind: "integer",
              pattern: "0",
          };
}

export function newViewerFact(
    document: ProjectDocument,
    source?: ViewerFactNode,
): ViewerFactNode {
    return source
        ? {
              ...structuredClone(source),
              uuid: crypto.randomUUID(),
              id: freshId(`${source.id}-copy`, document.viewerFacts),
          }
        : {
              uuid: crypto.randomUUID(),
              id: freshId(
                  `${document.namespace}:new-fact`,
                  document.viewerFacts,
              ),
              type: "STRING",
              providers: ["api"],
              defaultValue: null,
              nullable: true,
              cacheKey: true,
              previewValue: null,
          };
}

function mapBlocks(
    blocks: PresentationBlock[],
    visit: (block: PresentationBlock) => PresentationBlock,
): PresentationBlock[] {
    return blocks.map((block) =>
        visit(
            block.type === "conditional"
                ? {
                      ...block,
                      thenBlocks: mapBlocks(block.thenBlocks, visit),
                      otherwiseBlocks: mapBlocks(block.otherwiseBlocks, visit),
                  }
                : block,
        ),
    );
}

export function formatDependsOn(
    document: ProjectDocument,
    id: string,
    target: string,
    seen = new Set<string>(),
): boolean {
    if (id === target) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    const format = document.formats.find((entry) => entry.id === id);
    return (
        format?.kind === "list" &&
        formatDependsOn(document, format.elementFormat, target, seen)
    );
}

function retainedList(format: FormatNode): Record<string, unknown> | null {
    const variants = format.extensions?.editorFormatVariants;
    if (!variants || typeof variants !== "object" || Array.isArray(variants))
        return null;
    const list = (variants as Record<string, unknown>).list;
    return list && typeof list === "object" && !Array.isArray(list)
        ? (list as Record<string, unknown>)
        : null;
}

function blockUses(
    document: ProjectDocument,
    block: PresentationBlock,
    kind: PresentationLibraryKind,
    id: string,
): boolean {
    if (block.type === "conditional") {
        if (
            kind === "facts" &&
            [block.condition.left, block.condition.right].some(
                (ref) => ref?.kind === "fact" && ref.key === id,
            )
        )
            return true;
        return [...block.thenBlocks, ...block.otherwiseBlocks].some((child) =>
            blockUses(document, child, kind, id),
        );
    }
    const format =
        block.type === "field"
            ? block.format
            : block.type === "repeat"
              ? block.template.format
              : null;
    return (
        kind === "formats" &&
        format !== null &&
        formatDependsOn(document, format, id)
    );
}

export function presentationLibraryItems(
    document: ProjectDocument,
    kind: PresentationLibraryKind,
    id: string,
): ItemNode[] {
    return document.items.filter(
        (item) =>
            item.presentation.blocks.some((block) =>
                blockUses(document, block, kind, id),
            ) ||
            (kind === "formats" &&
                item.definition.instance.schemas.some((reference) =>
                    document.dataSchemas
                        .find(
                            (schema) =>
                                schema.id === reference.id &&
                                schema.version === reference.version,
                        )
                        ?.keys.some((key) => {
                            const formatter =
                                key.integration?.placeholderApi.formatter;
                            return (
                                formatter &&
                                formatDependsOn(document, formatter, id)
                            );
                        }),
                )),
    );
}

export function presentationLibraryReferences(
    document: ProjectDocument,
    kind: PresentationLibraryKind,
    id: string,
): string[] {
    const references = presentationLibraryItems(document, kind, id).map(
        (item) => itemKey(document, item),
    );
    if (kind === "formats") {
        document.formats.forEach((format) => {
            if (format.kind === "list" && format.elementFormat === id)
                references.push(format.id);
        });
        document.formats.forEach((format) => {
            if (retainedList(format)?.elementFormat === id)
                references.push(`${format.id} (retained list)`);
        });
        document.dataSchemas.forEach((schema) =>
            schema.keys.forEach((key) => {
                if (key.integration?.placeholderApi.formatter === id)
                    references.push(
                        `${schema.id}@${schema.version}: ${key.id}`,
                    );
            }),
        );
    }
    return [...new Set(references)];
}

export function renamePresentationEntry(
    document: ProjectDocument,
    kind: PresentationLibraryKind,
    uuid: string,
    id: string,
): ProjectDocument {
    const entries =
        kind === "formats" ? document.formats : document.viewerFacts;
    const source = entries.find((entry) => entry.uuid === uuid);
    if (!source || source.id === id || libraryIdError(document, kind, uuid, id))
        return document;
    const previous = source.id;
    return {
        ...document,
        formats:
            kind === "facts"
                ? document.formats
                : document.formats.map((format) => {
                      const saved = retainedList(format);
                      return {
                          ...format,
                          ...(format.uuid === uuid ? { id } : {}),
                          ...(format.kind === "list" &&
                          format.elementFormat === previous
                              ? { elementFormat: id }
                              : {}),
                          ...(saved?.elementFormat === previous
                              ? {
                                    extensions: {
                                        ...format.extensions,
                                        editorFormatVariants: {
                                            ...(format.extensions
                                                ?.editorFormatVariants as Record<
                                                string,
                                                unknown
                                            >),
                                            list: {
                                                ...saved,
                                                elementFormat: id,
                                            },
                                        },
                                    },
                                }
                              : {}),
                      };
                  }),
        viewerFacts:
            kind === "formats"
                ? document.viewerFacts
                : document.viewerFacts.map((fact) =>
                      fact.uuid === uuid ? { ...fact, id } : fact,
                  ),
        dataSchemas:
            kind === "facts"
                ? document.dataSchemas
                : document.dataSchemas.map((schema) => ({
                      ...schema,
                      keys: schema.keys.map((key) =>
                          key.integration?.placeholderApi.formatter === previous
                              ? {
                                    ...key,
                                    integration: {
                                        ...key.integration,
                                        placeholderApi: {
                                            ...key.integration.placeholderApi,
                                            formatter: id,
                                        },
                                    },
                                }
                              : key,
                      ),
                  })),
        items: document.items.map((item) => ({
            ...item,
            presentation: {
                ...item.presentation,
                blocks: mapBlocks(item.presentation.blocks, (block) => {
                    if (kind === "formats") {
                        if (block.type === "field" && block.format === previous)
                            return { ...block, format: id };
                        if (
                            block.type === "repeat" &&
                            block.template.format === previous
                        )
                            return {
                                ...block,
                                template: { ...block.template, format: id },
                            };
                    } else if (block.type === "conditional") {
                        const { left, right } = block.condition;
                        return {
                            ...block,
                            condition: {
                                ...block.condition,
                                left:
                                    left.kind === "fact" &&
                                    left.key === previous
                                        ? { ...left, key: id }
                                        : left,
                                right:
                                    right?.kind === "fact" &&
                                    right.key === previous
                                        ? { ...right, key: id }
                                        : right,
                            },
                        };
                    }
                    return block;
                }),
            },
        })),
    };
}

export function removePresentationEntry(
    document: ProjectDocument,
    kind: PresentationLibraryKind,
    uuid: string,
): ProjectDocument {
    const source = (
        kind === "formats" ? document.formats : document.viewerFacts
    ).find((entry) => entry.uuid === uuid);
    if (
        !source ||
        presentationLibraryReferences(document, kind, source.id).length
    )
        return document;
    return kind === "formats"
        ? {
              ...document,
              formats: document.formats.filter((entry) => entry.uuid !== uuid),
          }
        : {
              ...document,
              viewerFacts: document.viewerFacts.filter(
                  (entry) => entry.uuid !== uuid,
              ),
          };
}
