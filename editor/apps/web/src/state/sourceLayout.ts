import type { ProjectDocument } from "@itemerness/protocol";

const SEGMENT = /^[A-Za-z0-9_.-]+$/;

/** Mirrors the plugin's export rule: a plain relative YAML path inside the node's own directory. */
export function validSourcePath(path: string, domain: string): boolean {
    const segments = path.split("/");
    return (
        path.length <= 256 &&
        segments.length >= 2 &&
        segments.length <= 8 &&
        segments[0] === domain &&
        segments.every(
            (segment) =>
                segment !== "." && segment !== ".." && SEGMENT.test(segment),
        ) &&
        /\.ya?ml$/i.test(segments[segments.length - 1]!)
    );
}

/** Item files already known to this document, offered when assigning another item. */
export function itemSourceFiles(document: ProjectDocument): string[] {
    const itemUuids = new Set(document.items.map((item) => item.uuid));
    return [
        ...new Set(
            Object.entries(document.sourceLayout?.files ?? {})
                .filter(([uuid]) => itemUuids.has(uuid))
                .map(([, path]) => path),
        ),
    ].sort();
}

/** Assigns or clears one node's source file; a document without a layout is left unchanged. */
export function setSourceFile(
    document: ProjectDocument,
    uuid: string,
    path: string | null,
): ProjectDocument {
    const layout = document.sourceLayout;
    if (!layout) return document;
    const files = { ...layout.files };
    if (path === null) delete files[uuid];
    else files[uuid] = path;
    return { ...document, sourceLayout: { ...layout, files } };
}
