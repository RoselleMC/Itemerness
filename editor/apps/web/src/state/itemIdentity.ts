import {
    idPathSchema,
    itemKey,
    namespacedIdSchema,
    type ItemNode,
    type ProjectDocument,
} from "@itemerness/protocol";

export function itemIdIssue(
    document: ProjectDocument,
    uuid: string,
    id: string,
): "invalidId" | "legacyId" | "idTaken" | null {
    if (document.schemaVersion === 1 && !idPathSchema.safeParse(id).success)
        return "legacyId";
    const resolved = itemKey(document, id);
    if (!namespacedIdSchema.safeParse(resolved).success) return "invalidId";
    if (
        document.items.some(
            (item) =>
                item.uuid !== uuid && itemKey(document, item) === resolved,
        )
    )
        return "idTaken";
    return null;
}

/** Rename the stable node and every explicit catalog reference in one document mutation. */
export function renameItem(
    document: ProjectDocument,
    uuid: string,
    id: string,
): ProjectDocument {
    const original = document.items.find((item) => item.uuid === uuid);
    if (!original || original.id === id) return document;
    const issue = itemIdIssue(document, uuid, id);
    if (issue) throw new Error(issue);
    const before = itemKey(document, original);
    const after = itemKey(document, id);
    return {
        ...document,
        items: document.items.map((item) => {
            const renamed = item.uuid === uuid ? { ...item, id } : item;
            if (
                before === after ||
                !item.definition.contents.some((entry) => entry.item === before)
            )
                return renamed;
            return {
                ...renamed,
                definition: {
                    ...item.definition,
                    contents: item.definition.contents.map((entry) =>
                        entry.item === before
                            ? { ...entry, item: after }
                            : entry,
                    ),
                },
            };
        }),
    };
}

export function freshItemCopyId(
    document: ProjectDocument,
    source: ItemNode,
): string {
    const resolved = itemKey(document, source);
    const separator = resolved.indexOf(":");
    const namespace = resolved.slice(0, separator);
    const path = resolved.slice(separator + 1);
    const used = new Set(document.items.map((item) => itemKey(document, item)));
    const maximumPath = 255 - namespace.length;
    for (let count = 1; ; count++) {
        const suffix = count === 1 ? "-copy" : `-copy-${count}`;
        const candidatePath = `${path.slice(0, maximumPath - suffix.length)}${suffix}`;
        const candidate = `${namespace}:${candidatePath}`;
        if (!used.has(candidate))
            return source.id.includes(":") ? candidate : candidatePath;
    }
}
