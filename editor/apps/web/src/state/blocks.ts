import type { PresentationBlock } from "@itemerness/protocol";

export interface BlockLocation {
    block: PresentationBlock;
    ancestors: PresentationBlock[];
    siblings: readonly PresentationBlock[];
    index: number;
}

export type ContentBranch = "thenBlocks" | "otherwiseBlocks" | "children";
export type ContentInsertionTarget =
    string | { parentUuid: string; branch: ContentBranch };

type GroupBlock = Extract<PresentationBlock, { type: "group" }>;

/** Every block directly nested in a container: conditional branches, a group header and children. */
export function childBlocks(block: PresentationBlock): PresentationBlock[] {
    if (block.type === "conditional")
        return [...block.thenBlocks, ...block.otherwiseBlocks];
    if (block.type === "group")
        return [...(block.header ? [block.header] : []), ...block.children];
    return [];
}

/**
 * Rebuilds a container with each nested list mapped. A header mapped to nothing is removed, so
 * structural edits never leave a group with an empty header slot.
 */
export function mapChildBlocks(
    block: PresentationBlock,
    map: (blocks: readonly PresentationBlock[]) => PresentationBlock[],
): PresentationBlock {
    if (block.type === "conditional")
        return {
            ...block,
            thenBlocks: map(block.thenBlocks),
            otherwiseBlocks: map(block.otherwiseBlocks),
        };
    if (block.type === "group") {
        const { header, ...rest } = block;
        const mapped = header ? map([header])[0] : undefined;
        return {
            ...rest,
            ...(mapped ? { header: mapped } : {}),
            children: map(block.children),
        };
    }
    return block;
}

/** The group whose header is `uuid`, if any. */
export function groupOfHeader(
    blocks: readonly PresentationBlock[],
    uuid: string,
): GroupBlock | null {
    for (const block of blocks) {
        if (block.type === "group" && block.header?.uuid === uuid) return block;
        const nested = groupOfHeader(childBlocks(block), uuid);
        if (nested) return nested;
    }
    return null;
}

export function locateBlock(
    blocks: readonly PresentationBlock[],
    uuid: string,
    ancestors: PresentationBlock[] = [],
): BlockLocation | null {
    for (const [index, block] of blocks.entries()) {
        if (block.uuid === uuid)
            return { block, ancestors, siblings: blocks, index };
        const next = [...ancestors, block];
        if (block.type === "conditional") {
            const found =
                locateBlock(block.thenBlocks, uuid, next) ??
                locateBlock(block.otherwiseBlocks, uuid, next);
            if (found) return found;
        }
        if (block.type === "group") {
            // A header is a single-row slot: it has no siblings to reorder with.
            const found =
                (block.header
                    ? locateBlock([block.header], uuid, next)
                    : null) ?? locateBlock(block.children, uuid, next);
            if (found) return found;
        }
    }
    return null;
}

export function editBlockTree(
    blocks: readonly PresentationBlock[],
    uuid: string,
    update: (block: PresentationBlock) => PresentationBlock | null,
): PresentationBlock[] {
    return blocks.flatMap((block) => {
        if (block.uuid === uuid) {
            const next = update(block);
            return next ? [next] : [];
        }
        return [
            mapChildBlocks(block, (children) =>
                editBlockTree(children, uuid, update),
            ),
        ];
    });
}

export function moveBlockTree(
    blocks: readonly PresentationBlock[],
    uuid: string,
    delta: number,
): PresentationBlock[] {
    const index = blocks.findIndex((block) => block.uuid === uuid);
    if (index >= 0) {
        const target = index + delta;
        const next = [...blocks];
        if (target >= 0 && target < next.length) {
            const [block] = next.splice(index, 1);
            next.splice(target, 0, block!);
        }
        return next;
    }
    return blocks.map((block) =>
        mapChildBlocks(block, (children) =>
            moveBlockTree(children, uuid, delta),
        ),
    );
}

export function insertBlockTree(
    blocks: readonly PresentationBlock[],
    anchor: ContentInsertionTarget | null,
    addition: PresentationBlock,
    position: "before" | "after" = "after",
): PresentationBlock[] {
    if (anchor && typeof anchor !== "string") {
        const parent = locateBlock(blocks, anchor.parentUuid)?.block;
        const valid =
            anchor.branch === "children"
                ? parent?.type === "group"
                : parent?.type === "conditional";
        if (!valid) return [...blocks];
        return editBlockTree(blocks, anchor.parentUuid, (block) =>
            block.type === "conditional" && anchor.branch !== "children"
                ? {
                      ...block,
                      [anchor.branch]: [...block[anchor.branch], addition],
                  }
                : block.type === "group" && anchor.branch === "children"
                  ? { ...block, children: [...block.children, addition] }
                  : block,
        );
    }
    if (anchor === "__name") return [addition, ...blocks];
    if (!anchor || !locateBlock(blocks, anchor)) return [...blocks];
    // Like the item name, a header only has content below it: its group's first child. Above it
    // is the group's own position in the parent list.
    const headed = groupOfHeader(blocks, anchor);
    if (headed)
        return position === "after"
            ? editBlockTree(blocks, headed.uuid, (block) =>
                  block.type === "group"
                      ? { ...block, children: [addition, ...block.children] }
                      : block,
              )
            : insertBlockTree(blocks, headed.uuid, addition, "before");
    return blocks.flatMap((block) =>
        block.uuid === anchor
            ? position === "before"
                ? [addition, block]
                : [block, addition]
            : [
                  childBlocks(block).some((child) =>
                      locateBlock([child], anchor),
                  )
                      ? mapChildBlocks(block, (children) =>
                            locateBlock(children, anchor)
                                ? insertBlockTree(
                                      children,
                                      anchor,
                                      addition,
                                      position,
                                  )
                                : [...children],
                        )
                      : block,
              ],
    );
}

/** Replaces one block with a new group containing it, in the same sibling position. */
export function wrapBlockInGroup(
    blocks: readonly PresentationBlock[],
    uuid: string,
    group: Omit<GroupBlock, "children">,
): PresentationBlock[] {
    return editBlockTree(blocks, uuid, (block) => ({
        ...group,
        children: [block],
    }));
}

/** Replaces a group with its header followed by its children, in the same sibling position. */
export function ungroupBlock(
    blocks: readonly PresentationBlock[],
    uuid: string,
): PresentationBlock[] {
    return blocks.flatMap((block) =>
        block.uuid === uuid && block.type === "group"
            ? [...(block.header ? [block.header] : []), ...block.children]
            : [
                  mapChildBlocks(block, (children) =>
                      ungroupBlock(children, uuid),
                  ),
              ],
    );
}
