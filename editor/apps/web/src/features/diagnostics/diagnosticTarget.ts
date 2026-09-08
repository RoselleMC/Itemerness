import {
    itemKey,
    type Diagnostic,
    type PresentationBlock,
    type ProjectDocument,
} from "@itemerness/protocol";

export type DiagnosticTarget =
    | { kind: "item"; id: string; blockUuid: string | null }
    | { kind: "theme" | "layout"; id: string }
    | { kind: "schema" | "key" | "format" | "fact"; uuid: string };

interface Location {
    uuid: string;
    businessId: string;
    pointer: string;
    paths: string[];
    target: DiagnosticTarget;
}

function locations(document: ProjectDocument): Location[] {
    const entries: Location[] = [];
    document.items.forEach((item, index) => {
        const id = itemKey(document, item);
        const pointer = `/items/${index}`;
        const paths = [`items[${index}]`, `presentation.items.${id}`];
        entries.push({
            uuid: item.uuid,
            businessId: id,
            pointer,
            paths,
            target: { kind: "item", id, blockUuid: null },
        });
        const visit = (
            blocks: PresentationBlock[],
            pointer: string,
            paths: string[],
        ) => {
            blocks.forEach((block, index) => {
                const currentPointer = `${pointer}/${index}`;
                const currentPaths = paths.map((path) => `${path}[${index}]`);
                entries.push({
                    uuid: block.uuid,
                    businessId: id,
                    pointer: currentPointer,
                    paths: currentPaths,
                    target: { kind: "item", id, blockUuid: block.uuid },
                });
                if (block.type === "conditional") {
                    visit(
                        block.thenBlocks,
                        `${currentPointer}/thenBlocks`,
                        currentPaths.map((path) => `${path}.then`),
                    );
                    visit(
                        block.otherwiseBlocks,
                        `${currentPointer}/otherwiseBlocks`,
                        currentPaths.map((path) => `${path}.otherwise`),
                    );
                }
            });
        };
        visit(
            item.presentation.blocks,
            `${pointer}/presentation/blocks`,
            paths.map((path) => `${path}.blocks`),
        );
    });
    document.dataSchemas.forEach((schema, index) => {
        const pointer = `/dataSchemas/${index}`;
        entries.push({
            uuid: schema.uuid,
            businessId: schema.id,
            pointer,
            paths: [`schemas[${index}]`],
            target: { kind: "schema", uuid: schema.uuid },
        });
        schema.keys.forEach((key, keyIndex) =>
            entries.push({
                uuid: key.uuid,
                businessId: key.id,
                pointer: `${pointer}/keys/${keyIndex}`,
                paths: [
                    `schemas[${index}].keys[${keyIndex}]`,
                    `data-keys.${key.id}`,
                ],
                target: { kind: "key", uuid: key.uuid },
            }),
        );
    });
    for (const [collection, kind, path] of [
        ["themes", "theme", "themes"],
        ["layouts", "layout", "layouts"],
        ["formats", "format", "formats"],
        ["viewerFacts", "fact", "viewer-facts"],
    ] as const) {
        document[collection].forEach((entry, index) =>
            entries.push({
                uuid: entry.uuid,
                businessId: entry.id,
                pointer: `/${collection}/${index}`,
                paths: [`${path}[${index}]`],
                target:
                    kind === "theme" || kind === "layout"
                        ? { kind, id: entry.id }
                        : { kind, uuid: entry.uuid },
            }),
        );
    }
    return entries;
}

function unique(
    entries: readonly Location[] | undefined,
): DiagnosticTarget | null {
    return entries?.length === 1 ? entries[0]!.target : null;
}

function add(index: Map<string, Location[]>, key: string, entry: Location) {
    const existing = index.get(key);
    if (existing) existing.push(entry);
    else index.set(key, [entry]);
}

/** Build once per immutable document. Error prose is never parsed for navigation. */
export function createDiagnosticResolver(
    document: ProjectDocument,
): (diagnostic: Diagnostic) => DiagnosticTarget | null {
    const byUuid = new Map<string, Location[]>();
    const byPointer = new Map<string, Location[]>();
    const byPath = new Map<string, Location[]>();
    const byBusinessId = new Map<string, Location[]>();
    for (const entry of locations(document)) {
        add(byUuid, entry.uuid, entry);
        add(byPointer, entry.pointer, entry);
        for (const path of entry.paths) add(byPath, path, entry);
        if (!(entry.target.kind === "item" && entry.target.blockUuid))
            add(byBusinessId, entry.businessId, entry);
    }

    return (diagnostic) => {
        if (diagnostic.nodeUuid) return unique(byUuid.get(diagnostic.nodeUuid));
        if (diagnostic.pointer) {
            if (
                !diagnostic.pointer.startsWith("/") ||
                /~(?![01])/.test(diagnostic.pointer)
            )
                return null;
            const segments = diagnostic.pointer
                .slice(1)
                .split("/")
                .map((value) => value.replace(/~1/g, "/").replace(/~0/g, "~"));
            let current: unknown = document;
            for (const segment of segments) {
                if (
                    Array.isArray(current) &&
                    (!/^(0|[1-9]\d*)$/.test(segment) ||
                        Number(segment) >= current.length)
                )
                    return null;
                if (
                    current === null ||
                    typeof current !== "object" ||
                    !Object.hasOwn(current, segment)
                )
                    break;
                current = (current as Record<string, unknown>)[segment];
            }
            for (let pointer = diagnostic.pointer; pointer;) {
                const matches = byPointer.get(pointer);
                if (matches) return unique(matches);
                pointer = pointer.slice(0, pointer.lastIndexOf("/"));
            }
            return null;
        }
        if (typeof diagnostic.params.path === "string") {
            const path = diagnostic.params.path;
            const businessPath =
                path.startsWith("presentation.items.") ||
                path.startsWith("data-keys.");
            let identity: string | null = null;
            let candidates: Location[] | undefined;
            let longest = 0;
            for (let index = 0; index <= path.length; index++) {
                if (
                    index !== path.length &&
                    path[index] !== "." &&
                    path[index] !== "["
                )
                    continue;
                const matches = byPath.get(path.slice(0, index));
                if (!matches) continue;
                if (businessPath) {
                    for (const entry of matches) {
                        const next =
                            entry.target.kind === "item"
                                ? entry.target.id
                                : entry.uuid;
                        if (identity !== null && identity !== next) return null;
                        identity = next;
                    }
                }
                candidates = matches;
                longest = index;
            }
            // An absent indexed child must not silently select a nearby block or schema key.
            if (
                candidates &&
                /^\.(?:blocks|then|otherwise|keys)\[/.test(path.slice(longest))
            )
                return null;
            return unique(candidates);
        }
        return diagnostic.businessId
            ? unique(byBusinessId.get(diagnostic.businessId))
            : null;
    };
}

export function diagnosticTarget(
    document: ProjectDocument,
    diagnostic: Diagnostic,
): DiagnosticTarget | null {
    return createDiagnosticResolver(document)(diagnostic);
}
