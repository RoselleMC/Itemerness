/** Resolve the runtime identity without normalizing the document's authored ID spelling. */
export function itemKey(
    document: { namespace: string },
    item: { id: string } | string,
): string {
    const id = typeof item === "string" ? item : item.id;
    return id.includes(":") ? id : `${document.namespace}:${id}`;
}
