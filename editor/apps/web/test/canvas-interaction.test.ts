import { describe, expect, it } from "vitest";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import {
    type PresentationBlock,
    type PreviewDisplay,
} from "@itemerness/protocol";
import {
    editBlockTree,
    insertBlockTree,
    locateBlock,
    moveBlockTree,
} from "../src/state/blocks.js";
import { clampZoom, fitZoom, wheelZoom } from "../src/state/zoom.js";
import { alignLineOrigins } from "../src/features/preview/lineOrigins.js";
import { useEditorStore } from "../src/state/store.js";

const text = (uuid: string): PresentationBlock => ({
    uuid,
    type: "description",
    message: uuid,
    style: null,
    anchor: null,
    wrapping: null,
});
const parent: PresentationBlock = {
    uuid: "parent",
    type: "conditional",
    style: null,
    anchor: null,
    condition: {
        operator: "EQUALS",
        left: { kind: "fact", key: "example:level" },
        right: { kind: "literal", value: { kind: "integer", value: "1" } },
    },
    thenBlocks: [text("a"), text("b")],
    otherwiseBlocks: [text("c")],
};

describe("canvas content tree edits", () => {
    it("inserts beside the selected sibling, or first after the name", () => {
        const blocks = [parent, text("tail")];
        expect(insertBlockTree(blocks, "__name", text("first"))[0]!.uuid).toBe(
            "first",
        );
        const before = insertBlockTree(blocks, "b", text("new"), "before");
        expect(
            locateBlock(before, "new")?.siblings.map((block) => block.uuid),
        ).toEqual(["a", "new", "b"]);
        const after = insertBlockTree(blocks, "c", text("new"), "after");
        expect(
            locateBlock(after, "new")?.siblings.map((block) => block.uuid),
        ).toEqual(["c", "new"]);
        expect(
            locateBlock(after, "new")?.ancestors.map((block) => block.uuid),
        ).toEqual(["parent"]);
        expect(insertBlockTree(blocks, "stale", text("new"))).toEqual(blocks);
        expect(locateBlock(blocks, "new")).toBeNull();
    });
    it("moves and removes within a branch without changing adjacent branches", () => {
        const moved = moveBlockTree([parent], "b", -1);
        expect(locateBlock(moved, "b")?.index).toBe(0);
        expect(locateBlock(moved, "c")?.index).toBe(0);
        const removed = editBlockTree(moved, "b", () => null);
        expect(locateBlock(removed, "b")).toBeNull();
        expect(locateBlock(removed, "a")?.siblings).toHaveLength(1);
    });
    it("selection and view zoom never update the document, and deletion clears selection", () => {
        useEditorStore.getState().setDocument(baselineDocument);
        const state = useEditorStore.getState();
        const item = state.document.items[0]!;
        state.selectItem(`${state.document.namespace}:${item.id}`);
        state.selectBlock(item.presentation.blocks[0]!.uuid);
        state.setGuiScale(1.2345);
        expect(useEditorStore.getState().document).toBe(state.document);
        state.updateItem(item.uuid, (current) => ({
            ...current,
            presentation: { ...current.presentation, blocks: [] },
        }));
        expect(useEditorStore.getState().selectedBlockUuid).toBeNull();
        state.selectBlock("__name");
        state.setMode("themes");
        expect(useEditorStore.getState().selectedBlockUuid).toBeNull();
    });
});

describe("viewport zoom", () => {
    it("supports continuous bounded wheel zoom", () => {
        expect(wheelZoom(1, -53)).toBeGreaterThan(1);
        expect(wheelZoom(1, -53) % 1).not.toBe(0);
        expect(wheelZoom(wheelZoom(1, -53), 53)).toBeCloseTo(1, 3);
        expect(clampZoom(Infinity)).toBe(1);
        expect(clampZoom(-1)).toBe(0.01);
        expect(clampZoom(100)).toBe(32);
    });
    it("fits both dimensions and includes comparison gaps and insertion margins", () => {
        expect(
            fitZoom({ width: 448, height: 248 }, [{ width: 200, height: 100 }]),
        ).toBe(2);
        expect(
            fitZoom({ width: 480, height: 500 }, [
                { width: 200, height: 100 },
                { width: 200, height: 300 },
            ]),
        ).toBe(1);
    });
});

describe("displayed line provenance", () => {
    const line = (text: string) => ({
        runs: [{ text }],
        logicalWidthPixels: text.length,
        visualBounds: { left: 0, right: text.length, top: 0, bottom: 8 },
    });
    const display = (...rows: string[]) =>
        ({ lore: rows.map(line) }) as PreviewDisplay;
    it("preserves repeated rows when complete geometry matches", () => {
        expect(
            alignLineOrigins(
                display("A", "A"),
                ["one", "two"],
                display("A", "A"),
            ),
        ).toEqual(["one", "two"]);
    });
    it("never clamps extra server rows or guesses ambiguous rows", () => {
        expect(
            alignLineOrigins(
                display("A", "A", "B"),
                ["one", "two", "three"],
                display("frame", "A", "B", "tail"),
            ),
        ).toEqual([null, null, "three", null]);
        expect(
            alignLineOrigins(
                display("A", "A"),
                ["one", "one"],
                display("frame", "A"),
            ),
        ).toEqual([null, "one"]);
    });
});
