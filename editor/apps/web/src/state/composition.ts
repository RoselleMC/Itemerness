import type {
    Fragment,
    ItemNode,
    PresentationBlock,
} from "@itemerness/protocol";

/** Summary slot ids follow the compiler's semantic id rule. */
export const SLOT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/** The fragment lists a block shows itself; containers contribute none. */
export function blockFragments(block: PresentationBlock): readonly Fragment[] {
    if (block.type === "row") return [...block.left, ...block.right];
    if (block.type === "rule") return block.title;
    return [];
}

function* walk(
    blocks: readonly PresentationBlock[],
): Generator<PresentationBlock> {
    for (const block of blocks) {
        yield block;
        if (block.type === "conditional") {
            yield* walk(block.thenBlocks);
            yield* walk(block.otherwiseBlocks);
        }
        if (block.type === "group") {
            if (block.header) yield* walk([block.header]);
            yield* walk(block.children);
        }
    }
}

/** Every slot an item declares, in its name decorations and composed rows. */
export function itemSlotIds(item: ItemNode): string[] {
    const fragments = [
        ...(item.presentation.nameBefore ?? []),
        ...(item.presentation.nameAfter ?? []),
        ...[...walk(item.presentation.blocks)].flatMap(blockFragments),
    ];
    return [
        ...new Set(
            fragments.flatMap((fragment) =>
                fragment.kind === "slot" ? [fragment.id] : [],
            ),
        ),
    ];
}

/**
 * Copies a fragment with its own messages and slot ids, so a duplicate edits independently and
 * never declares a slot twice.
 */
export function remapFragment(
    fragment: Fragment,
    message: (key: string) => string,
    slot: (id: string) => string,
): Fragment {
    switch (fragment.kind) {
        case "message":
            return { ...fragment, message: message(fragment.message) };
        case "slot": {
            const next = { ...fragment, id: slot(fragment.id) };
            if (fragment.prefix)
                next.prefix = remapFragment(fragment.prefix, message, slot);
            if (fragment.suffix)
                next.suffix = remapFragment(fragment.suffix, message, slot);
            if (fragment.separator)
                next.separator = remapFragment(
                    fragment.separator,
                    message,
                    slot,
                );
            if (fragment.overflowCountMessage)
                next.overflowCountMessage = message(
                    fragment.overflowCountMessage,
                );
            return next;
        }
        default:
            return fragment;
    }
}

/** A slot id unused by the item, derived from the original so its purpose stays readable. */
export function freshSlotId(id: string, taken: Set<string>): string {
    for (let index = 2; ; index += 1) {
        const candidate = `${id}-${index}`.slice(0, 64);
        if (!taken.has(candidate)) {
            taken.add(candidate);
            return candidate;
        }
    }
}

/**
 * Maps the element paths a preview reports as hidden (`blocks[2].children[0][#1]`) to the
 * content blocks that own them. A repeat element resolves to its repeat block; paths that no
 * longer match the document are ignored rather than guessed.
 */
export function hiddenBlockUuids(
    blocks: readonly PresentationBlock[],
    paths: readonly string[],
): Map<string, number> {
    const hidden = new Map<string, number>();
    for (const path of paths) {
        const uuid = resolveElementPath(blocks, path);
        if (uuid) hidden.set(uuid, (hidden.get(uuid) ?? 0) + 1);
    }
    return hidden;
}

function resolveElementPath(
    blocks: readonly PresentationBlock[],
    path: string,
): string | null {
    const first = /^blocks\[(\d+)\]/.exec(path);
    if (!first) return null;
    let block = blocks[Number(first[1])];
    let rest = path.slice(first[0].length);
    while (block && rest.length > 0) {
        const element = /^\[#\d+\]/.exec(rest);
        if (element) {
            rest = rest.slice(element[0].length);
            continue;
        }
        if (rest.startsWith(".header")) {
            block = block.type === "group" ? block.header : undefined;
            rest = rest.slice(".header".length);
            continue;
        }
        const child = /^\.(then|otherwise|children)\[(\d+)\]/.exec(rest);
        if (!child) return null;
        const index = Number(child[2]);
        block =
            child[1] === "then" && block.type === "conditional"
                ? block.thenBlocks[index]
                : child[1] === "otherwise" && block.type === "conditional"
                  ? block.otherwiseBlocks[index]
                  : child[1] === "children" && block.type === "group"
                    ? block.children[index]
                    : undefined;
        rest = rest.slice(child[0].length);
    }
    return block?.uuid ?? null;
}

/**
 * Applies a message and slot mapping to a block's own fragments and summary piece; children are
 * left to the caller's traversal.
 */
export function remapBlockFragments<T extends PresentationBlock>(
    block: T,
    message: (key: string) => string,
    slot: (id: string) => string,
): T {
    const fragments = (list: readonly Fragment[]) =>
        list.map((fragment) => remapFragment(fragment, message, slot));
    let next: PresentationBlock = block;
    if (next.type === "row")
        next = {
            ...next,
            left: fragments(next.left),
            right: fragments(next.right),
        };
    if (next.type === "rule") next = { ...next, title: fragments(next.title) };
    if (next.summary?.piece)
        next = {
            ...next,
            summary: {
                ...next.summary,
                piece: remapFragment(next.summary.piece, message, slot),
            },
        };
    return next as T;
}

/** Remaps the name decorations of an item presentation. */
export function remapNameFragments<
    T extends { nameBefore?: Fragment[]; nameAfter?: Fragment[] },
>(presentation: T, message: (key: string) => string): T {
    const same = (id: string) => id;
    const map = (list: Fragment[] | undefined) =>
        list?.map((fragment) => remapFragment(fragment, message, same));
    return {
        ...presentation,
        ...(presentation.nameBefore
            ? { nameBefore: map(presentation.nameBefore) }
            : {}),
        ...(presentation.nameAfter
            ? { nameAfter: map(presentation.nameAfter) }
            : {}),
    };
}
