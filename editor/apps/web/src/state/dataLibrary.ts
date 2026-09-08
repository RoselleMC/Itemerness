import {
    dataKeyNodeSchema,
    namespacedIdSchema,
    type DataKeyNode,
    type DataSchemaNode,
    type ItemNode,
    type PresentationBlock,
    type ProjectDocument,
} from "@itemerness/protocol";
import { freshNamespacedId as freshId } from "./freshId.js";

export function newDataSchema(
    document: ProjectDocument,
    source?: DataSchemaNode,
): DataSchemaNode {
    const ids = new Set(document.dataSchemas.map((schema) => schema.id));
    const keyIds = new Set(
        document.dataSchemas.flatMap((schema) =>
            schema.keys.map((key) => key.id),
        ),
    );
    return {
        ...structuredClone(source),
        uuid: crypto.randomUUID(),
        id: freshId(
            source ? `${source.id}-copy` : `${document.namespace}:new-schema`,
            ids,
        ),
        version: source?.version ?? 1,
        keys:
            source?.keys.map((key) => {
                const id = freshId(`${key.id}-copy`, keyIds);
                keyIds.add(id);
                return {
                    ...structuredClone(key),
                    uuid: crypto.randomUUID(),
                    id,
                };
            }) ?? [],
    };
}

export function newDataKey(
    document: ProjectDocument,
    source?: DataKeyNode,
): DataKeyNode {
    const ids = new Set(
        document.dataSchemas.flatMap((schema) =>
            schema.keys.map((key) => key.id),
        ),
    );
    return dataKeyNodeSchema.parse({
        ...(source
            ? structuredClone(source)
            : { type: { kind: "string" }, scope: "INSTANCE", nullable: true }),
        uuid: crypto.randomUUID(),
        id: freshId(
            source ? `${source.id}-copy` : `${document.namespace}:new-key`,
            ids,
        ),
        ...(document.schemaVersion === 2 && !source
            ? {
                  integration: {
                      readSources: [{ kind: "canonicalNbt" }],
                      access: { read: "INTERNAL", write: ["internal"] },
                      placeholderApi: { exposed: false, formatter: null },
                  },
              }
            : {}),
    });
}

export function schemaItems(
    document: ProjectDocument,
    schema: DataSchemaNode,
): ItemNode[] {
    return document.items.filter((item) =>
        item.definition.instance.schemas.some(
            (ref) => ref.id === schema.id && ref.version === schema.version,
        ),
    );
}

function blockReferencesKey(block: PresentationBlock, id: string): boolean {
    if (block.type === "conditional")
        return (
            [block.condition.left, block.condition.right].some(
                (value) => value?.kind === "data" && value.key === id,
            ) ||
            [...block.thenBlocks, ...block.otherwiseBlocks].some((child) =>
                blockReferencesKey(child, id),
            )
        );
    return "data" in block && block.data === id;
}

export function keyReferenceItems(
    document: ProjectDocument,
    schema: DataSchemaNode,
    key: DataKeyNode,
): ItemNode[] {
    return schemaItems(document, schema).filter(
        (item) =>
            [
                ...item.definition.definitionData,
                ...item.definition.instance.defaults,
                ...item.definition.instance.generators,
                ...item.previewData,
            ].some((entry) => entry.key === key.id) ||
            item.presentation.blocks.some((block) =>
                blockReferencesKey(block, key.id),
            ),
    );
}

export function renameDataSchema(
    document: ProjectDocument,
    uuid: string,
    id: string,
    version: number,
): ProjectDocument {
    const schema = document.dataSchemas.find((entry) => entry.uuid === uuid);
    if (
        !schema ||
        !namespacedIdSchema.safeParse(id).success ||
        !Number.isInteger(version) ||
        version < 1 ||
        version > 2147483647 ||
        document.dataSchemas.some(
            (entry) =>
                entry.uuid !== uuid &&
                entry.id === id &&
                entry.version === version,
        )
    )
        return document;
    return {
        ...document,
        dataSchemas: document.dataSchemas.map((entry) =>
            entry.uuid === uuid ? { ...entry, id, version } : entry,
        ),
        items: document.items.map((item) => ({
            ...item,
            definition: {
                ...item.definition,
                instance: {
                    ...item.definition.instance,
                    schemas: item.definition.instance.schemas.map((ref) =>
                        ref.id === schema.id && ref.version === schema.version
                            ? { id, version }
                            : ref,
                    ),
                },
            },
        })),
    };
}

function renameBlockKey(
    block: PresentationBlock,
    before: string,
    after: string,
): PresentationBlock {
    if (block.type === "conditional") {
        const rename = (value: typeof block.condition.left | null) =>
            value?.kind === "data" && value.key === before
                ? { ...value, key: after }
                : value;
        return {
            ...block,
            condition: {
                ...block.condition,
                left: rename(block.condition.left)!,
                right: rename(block.condition.right),
            },
            thenBlocks: block.thenBlocks.map((child) =>
                renameBlockKey(child, before, after),
            ),
            otherwiseBlocks: block.otherwiseBlocks.map((child) =>
                renameBlockKey(child, before, after),
            ),
        };
    }
    return "data" in block && block.data === before
        ? { ...block, data: after }
        : block;
}

export function renameDataKey(
    document: ProjectDocument,
    uuid: string,
    id: string,
): ProjectDocument {
    const schema = document.dataSchemas.find((entry) =>
        entry.keys.some((key) => key.uuid === uuid),
    );
    const key = schema?.keys.find((entry) => entry.uuid === uuid);
    if (
        !schema ||
        !key ||
        !namespacedIdSchema.safeParse(id).success ||
        document.dataSchemas.some((entry) =>
            entry.keys.some((other) => other.uuid !== uuid && other.id === id),
        )
    )
        return document;
    const bound = new Set(
        schemaItems(document, schema).map((item) => item.uuid),
    );
    const rename = <T extends { key: string }>(entry: T): T =>
        entry.key === key.id ? { ...entry, key: id } : entry;
    return {
        ...document,
        dataSchemas: document.dataSchemas.map((entry) =>
            entry.uuid === schema.uuid
                ? {
                      ...entry,
                      keys: entry.keys.map((other) =>
                          other.uuid === uuid ? { ...other, id } : other,
                      ),
                  }
                : entry,
        ),
        items: document.items.map((item) =>
            !bound.has(item.uuid)
                ? item
                : {
                      ...item,
                      previewData: item.previewData.map(rename),
                      definition: {
                          ...item.definition,
                          definitionData:
                              item.definition.definitionData.map(rename),
                          instance: {
                              ...item.definition.instance,
                              defaults:
                                  item.definition.instance.defaults.map(rename),
                              generators:
                                  item.definition.instance.generators.map(
                                      rename,
                                  ),
                          },
                      },
                      presentation: {
                          ...item.presentation,
                          blocks: item.presentation.blocks.map((block) =>
                              renameBlockKey(block, key.id, id),
                          ),
                      },
                  },
        ),
    };
}

export function removeDataSchema(
    document: ProjectDocument,
    uuid: string,
): ProjectDocument {
    const schema = document.dataSchemas.find((entry) => entry.uuid === uuid);
    return !schema || schemaItems(document, schema).length
        ? document
        : {
              ...document,
              dataSchemas: document.dataSchemas.filter(
                  (entry) => entry.uuid !== uuid,
              ),
          };
}

export function removeDataKey(
    document: ProjectDocument,
    uuid: string,
): ProjectDocument {
    const schema = document.dataSchemas.find((entry) =>
        entry.keys.some((key) => key.uuid === uuid),
    );
    const key = schema?.keys.find((entry) => entry.uuid === uuid);
    return !schema || !key || keyReferenceItems(document, schema, key).length
        ? document
        : {
              ...document,
              dataSchemas: document.dataSchemas.map((entry) =>
                  entry.uuid !== schema.uuid
                      ? entry
                      : {
                            ...entry,
                            keys: entry.keys.filter(
                                (other) => other.uuid !== uuid,
                            ),
                        },
              ),
          };
}
