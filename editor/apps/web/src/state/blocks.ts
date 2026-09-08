import type { PresentationBlock } from "@itemerness/protocol";

export interface BlockLocation {
    block: PresentationBlock;
    ancestors: PresentationBlock[];
    siblings: readonly PresentationBlock[];
    index: number;
}

export type ContentBranch = "thenBlocks" | "otherwiseBlocks";
export type ContentInsertionTarget =
    string | { parentUuid: string; branch: ContentBranch };

export function locateBlock(
    blocks: readonly PresentationBlock[],
    uuid: string,
    ancestors: PresentationBlock[] = [],
): BlockLocation | null {
    for (const [index, block] of blocks.entries()) {
        if (block.uuid === uuid)
            return { block, ancestors, siblings: blocks, index };
        if (block.type === "conditional") {
            const next = [...ancestors, block];
            const found =
                locateBlock(block.thenBlocks, uuid, next) ??
                locateBlock(block.otherwiseBlocks, uuid, next);
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
            block.type === "conditional"
                ? {
                      ...block,
                      thenBlocks: editBlockTree(block.thenBlocks, uuid, update),
                      otherwiseBlocks: editBlockTree(
                          block.otherwiseBlocks,
                          uuid,
                          update,
                      ),
                  }
                : block,
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
        block.type === "conditional"
            ? {
                  ...block,
                  thenBlocks: moveBlockTree(block.thenBlocks, uuid, delta),
                  otherwiseBlocks: moveBlockTree(
                      block.otherwiseBlocks,
                      uuid,
                      delta,
                  ),
              }
            : block,
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
        if (parent?.type !== "conditional") return [...blocks];
        return editBlockTree(blocks, anchor.parentUuid, (block) =>
            block.type === "conditional"
                ? {
                      ...block,
                      [anchor.branch]: [...block[anchor.branch], addition],
                  }
                : block,
        );
    }
    if (anchor === "__name") return [addition, ...blocks];
    if (!anchor || !locateBlock(blocks, anchor)) return [...blocks];
    return blocks.flatMap((block) =>
        block.uuid === anchor
            ? position === "before"
                ? [addition, block]
                : [block, addition]
            : [
                  block.type === "conditional"
                      ? {
                            ...block,
                            thenBlocks: locateBlock(block.thenBlocks, anchor)
                                ? insertBlockTree(
                                      block.thenBlocks,
                                      anchor,
                                      addition,
                                      position,
                                  )
                                : block.thenBlocks,
                            otherwiseBlocks: locateBlock(
                                block.otherwiseBlocks,
                                anchor,
                            )
                                ? insertBlockTree(
                                      block.otherwiseBlocks,
                                      anchor,
                                      addition,
                                      position,
                                  )
                                : block.otherwiseBlocks,
                        }
                      : block,
              ],
    );
}
