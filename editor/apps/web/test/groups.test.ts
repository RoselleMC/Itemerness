import { beforeEach, describe, expect, it } from "vitest";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import {
    contentHash,
    projectDocumentSchema,
    type PresentationBlock,
} from "@itemerness/protocol";
import { useEditorStore } from "../src/state/store.js";
import {
    duplicateSelectedContent,
    insertContent,
    setGroupHeader,
    ungroupContent,
    wrapContentInGroup,
} from "../src/state/contentActions.js";
import {
    editBlockTree,
    insertBlockTree,
    locateBlock,
    moveBlockTree,
} from "../src/state/blocks.js";
import { collectReferencedMessageKeys } from "../src/features/common/messages.js";

const state = () => useEditorStore.getState();
const item = () =>
    state().document.items.find((entry) => entry.id === "travel-token")!;

function field(uuid: string): PresentationBlock {
    return {
        uuid,
        type: "field",
        labelMessage: `label.${uuid}`,
        data: "example:charges",
        format: null,
        icon: null,
        style: null,
        anchor: null,
        wrapping: null,
        missingPolicy: "OMIT",
    };
}
const group = (
    uuid: string,
    children: PresentationBlock[],
    header?: PresentationBlock,
): PresentationBlock => ({
    uuid,
    type: "group",
    ...(header ? { header } : {}),
    children,
    marker: "TREE",
    style: null,
    anchor: null,
});

beforeEach(() => {
    state().resetDraft();
    state().setDocument(structuredClone(baselineDocument));
    state().selectItem(`${state().document.namespace}:travel-token`);
});

describe("group block tree", () => {
    const tree = [
        field("a"),
        group("g", [field("c"), group("h", [field("d")])], field("b")),
        field("e"),
    ];

    it("locates headers and nested children with their group ancestors", () => {
        const header = locateBlock(tree, "b")!;
        expect(header.siblings).toHaveLength(1);
        expect(header.ancestors.map((block) => block.uuid)).toEqual(["g"]);
        expect(
            locateBlock(tree, "d")!.ancestors.map((block) => block.uuid),
        ).toEqual(["g", "h"]);
    });

    it("inserts below a header as the first child and above it before the group", () => {
        const below = insertBlockTree(tree, "b", field("x"), "after");
        const g = below[1]!;
        if (g.type !== "group") throw new Error("group fixture");
        expect(g.children.map((block) => block.uuid)).toEqual(["x", "c", "h"]);
        const above = insertBlockTree(tree, "b", field("y"), "before");
        expect(above.map((block) => block.uuid)).toEqual(["a", "y", "g", "e"]);
        const appended = insertBlockTree(
            tree,
            { parentUuid: "h", branch: "children" },
            field("z"),
        );
        expect(locateBlock(appended, "z")!.ancestors.at(-1)!.uuid).toBe("h");
    });

    it("reorders only within one sibling list and deletes a header without a hole", () => {
        const moved = moveBlockTree(tree, "h", -1);
        const g = moved[1]!;
        if (g.type !== "group") throw new Error("group fixture");
        expect(g.children.map((block) => block.uuid)).toEqual(["h", "c"]);
        expect(moved.map((block) => block.uuid)).toEqual(["a", "g", "e"]);
        const headless = editBlockTree(tree, "b", () => null)[1]!;
        expect(Object.hasOwn(headless, "header")).toBe(false);
    });
});

describe("group content actions", () => {
    it("wraps a block and ungroups it again as single undo steps", () => {
        const original = item().presentation.blocks.map((block) => block.uuid);
        const before = state().snapshotHash;
        wrapContentInGroup(original[1]!);
        const wrapped = item().presentation.blocks;
        expect(wrapped).toHaveLength(original.length);
        const g = wrapped[1]!;
        if (g.type !== "group") throw new Error("expected a group");
        expect(g.marker).toBe("TREE");
        expect(g.children.map((block) => block.uuid)).toEqual([original[1]]);
        expect(state().selectedBlockUuid).toBe(g.uuid);
        expect(projectDocumentSchema.safeParse(state().document).success).toBe(
            true,
        );
        state().undo();
        expect(state().snapshotHash).toBe(before);
        state().redo();

        ungroupContent(g.uuid);
        expect(item().presentation.blocks.map((block) => block.uuid)).toEqual(
            original,
        );
        expect(contentHash(state().document)).toBe(before);
        state().undo();
        expect(item().presentation.blocks[1]!.type).toBe("group");
    });

    it("never wraps a header on its own", () => {
        insertContent("group", "__name", "after", "New text");
        const g = state().selectedBlockUuid!;
        setGroupHeader(g, "field");
        const header = locateBlock(item().presentation.blocks, g)!.block;
        if (header.type !== "group" || !header.header)
            throw new Error("expected a header");
        const before = state().snapshotHash;
        wrapContentInGroup(header.header.uuid);
        expect(state().snapshotHash).toBe(before);
    });

    it("adds and removes a header with its label message in one undo step", () => {
        insertContent("group", "__name", "after", "New text");
        const g = state().selectedBlockUuid!;
        const before = state().snapshotHash;
        setGroupHeader(g, "field");
        const node = locateBlock(item().presentation.blocks, g)!.block;
        if (node.type !== "group" || node.header?.type !== "field")
            throw new Error("expected a field header");
        expect(collectReferencedMessageKeys(state().document)).toContain(
            node.header.labelMessage,
        );
        state().undo();
        expect(state().snapshotHash).toBe(before);
        state().redo();
        setGroupHeader(g, null);
        expect(
            Object.hasOwn(
                locateBlock(item().presentation.blocks, g)!.block,
                "header",
            ),
        ).toBe(false);
    });

    it("duplicates a group with fresh recursive ids and independent messages", () => {
        insertContent("group", "__name", "after", "New text");
        const g = state().selectedBlockUuid!;
        setGroupHeader(g, "field");
        insertContent(
            "field",
            { parentUuid: g, branch: "children" },
            "after",
            "x",
        );
        state().selectBlock(g);
        duplicateSelectedContent();
        const copyId = state().selectedBlockUuid!;
        const source = locateBlock(item().presentation.blocks, g)!.block;
        const copy = locateBlock(item().presentation.blocks, copyId)!.block;
        if (source.type !== "group" || copy.type !== "group")
            throw new Error("expected groups");
        expect(copy.uuid).not.toBe(source.uuid);
        expect(copy.header!.uuid).not.toBe(source.header!.uuid);
        expect(copy.children[0]!.uuid).not.toBe(source.children[0]!.uuid);
        if (copy.header!.type !== "field" || source.header!.type !== "field")
            throw new Error("expected field headers");
        expect(copy.header!.labelMessage).not.toBe(source.header!.labelMessage);
    });
});
