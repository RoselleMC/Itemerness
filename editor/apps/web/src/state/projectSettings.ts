import {
    itemKey,
    namespacedIdSchema,
    type ProjectDocument,
} from "@itemerness/protocol";

export function namespaceIssue(
    document: ProjectDocument,
    namespace: string,
): "namespaceInvalid" | "namespaceCollision" | "namespaceLength" | null {
    if (!namespacedIdSchema.safeParse(`${namespace}:validation`).success)
        return "namespaceInvalid";
    const target = { namespace };
    const keys = new Set<string>();
    for (const item of document.items) {
        const id = itemKey(target, item);
        if (!namespacedIdSchema.safeParse(id).success) return "namespaceLength";
        if (keys.has(id)) return "namespaceCollision";
        keys.add(id);
    }
    return null;
}

/** Only relative item identities follow the root namespace. Payload strings and library IDs do not. */
export function setProjectNamespace(
    document: ProjectDocument,
    namespace: string,
): ProjectDocument {
    if (namespace === document.namespace) return document;
    const issue = namespaceIssue(document, namespace);
    if (issue) throw new Error(issue);
    const renamed = new Map(
        document.items
            .filter((item) => !item.id.includes(":"))
            .map((item) => [
                itemKey(document, item),
                itemKey({ namespace }, item),
            ]),
    );
    return {
        ...document,
        namespace,
        items: document.items.map((item) =>
            item.definition.contents.some((entry) => renamed.has(entry.item))
                ? {
                      ...item,
                      definition: {
                          ...item.definition,
                          contents: item.definition.contents.map((entry) =>
                              renamed.has(entry.item)
                                  ? { ...entry, item: renamed.get(entry.item)! }
                                  : entry,
                          ),
                      },
                  }
                : item,
        ),
    };
}
