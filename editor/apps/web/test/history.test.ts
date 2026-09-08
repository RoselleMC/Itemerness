import { beforeEach, describe, expect, it } from "vitest";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import { useEditorStore } from "../src/state/store.js";
import { documentSnapshot, DocumentHistory } from "../src/state/history.js";
import {
    deleteSelectedContent,
    duplicateSelectedContent,
    moveSelectedContent,
} from "../src/state/contentActions.js";
import { smoothZoomStep } from "../src/state/zoom.js";

const state = () => useEditorStore.getState();
beforeEach(() => {
    state().resetDraft();
    state().setDocument(structuredClone(baselineDocument));
});

describe("document-wide history", () => {
    it("undoing an unchanged gesture cannot leave persistence permanently suspended", () => {
        state().beginTransaction();
        state().undo();
        expect(state().historyTransactionId).toBeNull();
        expect(state().canUndo).toBe(false);
        state().setMessage("en_us", "test", "saved");
        expect(state().persistenceDocument).toBe(state().document);
    });
    it("undoes and redoes names, themes, item creation and deletion with matching hashes", () => {
        const initial = state().snapshotHash;
        const item = state().document.items[0]!;
        state().setMessage("en_us", item.presentation.nameMessage, "Edited");
        const renamed = state().snapshotHash;
        state().updateTheme(state().document.themes[0]!.uuid, (theme) => ({
            ...theme,
            requireExactFontMetrics: !theme.requireExactFontMetrics,
        }));
        state().addItem("Added", {
            layout: "itemerness:plain",
            theme: "itemerness:default",
        });
        const afterAdd = state().snapshotHash;
        state().removeItem(state().document.items.at(-1)!.uuid);
        state().undo();
        expect(state().snapshotHash).toBe(afterAdd);
        state().undo();
        if (state().snapshotHash !== renamed) state().undo();
        expect(state().snapshotHash).toBe(renamed);
        state().undo();
        expect(state().snapshotHash).toBe(initial);
        state().redo();
        expect(state().snapshotHash).toBe(renamed);
        expect(state().persistenceDocument).toBe(state().document);
    });
    it("groups a gesture, defers persistence, preserves redo when cancelled, and rejects expired tokens", () => {
        const block = state().document.items[0]!.presentation.blocks[0]!;
        state().selectBlock(block.uuid);
        const initial = state().snapshotHash,
            persisted = state().persistenceDocument;
        const token = state().beginTransaction();
        moveSelectedContent(1);
        moveSelectedContent(1);
        expect(state().canUndo).toBe(true);
        expect(state().persistenceDocument).toBe(persisted);
        const after = state().snapshotHash;
        state().commitTransaction(token);
        state().undo();
        expect(state().snapshotHash).toBe(initial);
        const cancelled = state().beginTransaction();
        moveSelectedContent(1);
        state().cancelTransaction(cancelled);
        expect(state().snapshotHash).toBe(initial);
        expect(state().canRedo).toBe(true);
        state().redo();
        expect(state().snapshotHash).toBe(after);
        const stale = state().beginTransaction();
        state().setDocument(baselineDocument);
        state().cancelTransaction(stale);
        expect(state().canUndo).toBe(false);
        expect(state().canRedo).toBe(false);
    });
    it("coalesces only adjacent edits in the same text burst and bounds history", () => {
        const history = new DocumentHistory(2);
        const before = documentSnapshot(state());
        history.setGroup("input-a");
        history.record(before, 1000);
        history.record({ ...before, snapshotHash: "b" }, 1400);
        expect(
            history.undo({ ...before, snapshotHash: "c" })?.snapshotHash,
        ).toBe(before.snapshotHash);
        expect(history.undo(before)).toBeNull();
        history.clear();
        history.record(before, 2000);
        history.record({ ...before, snapshotHash: "b" }, 3000);
        history.record({ ...before, snapshotHash: "c" }, 4000);
        expect(history.undo(before)?.snapshotHash).toBe("c");
        expect(history.undo(before)?.snapshotHash).toBe("b");
        expect(history.undo(before)).toBeNull();
    });
    it("clears redo on a new edit but ignores no-ops, selection, zoom and mounted-preview controls", () => {
        state().setMessage("en_us", "new.key", "one");
        state().undo();
        state().setGuiScale(4);
        state().selectBlock("__name");
        state().setAnnotations(true);
        state().updateDocument((document) => structuredClone(document));
        expect(state().canRedo).toBe(true);
        state().setMessage("en_us", "new.key", "two");
        expect(state().canRedo).toBe(false);
    });
    it("duplicates nested blocks with independent message keys and undoes deletion", () => {
        const item = state().document.items[1]!;
        const parent = item.presentation.blocks.find(
            (block) => block.type === "conditional",
        )!;
        state().selectItem(`itemerness:${item.id}`);
        state().selectBlock(parent.uuid);
        const before = state().snapshotHash;
        duplicateSelectedContent();
        const copyId = state().selectedBlockUuid;
        const copy = state().document.items[1]!.presentation.blocks.find(
            (block) => block.uuid === copyId,
        )!;
        expect(copy.uuid).not.toBe(parent.uuid);
        if (parent.type !== "conditional" || copy.type !== "conditional")
            throw new Error("conditional fixture");
        expect(copy.thenBlocks[0]!.uuid).not.toBe(parent.thenBlocks[0]!.uuid);
        expect(JSON.stringify(copy)).not.toContain("data.required-level.label");
        state().undo();
        expect(state().snapshotHash).toBe(before);
        state().redo();
        expect(state().selectedBlockUuid).toBe(copyId);
        deleteSelectedContent();
        expect(state().selectedBlockUuid).toBeNull();
        state().undo();
        expect(state().selectedBlockUuid).toBe(copyId);
        state().resetDraft();
        expect(state().canUndo).toBe(false);
    });
});

it("smooth zoom approaches either target monotonically and terminates exactly", () => {
    for (const goal of [0.25, 8]) {
        let current = 1;
        for (let frame = 0; frame < 100; frame++) {
            const next = smoothZoomStep(current, goal, 16);
            expect(Math.abs(next - goal)).toBeLessThanOrEqual(
                Math.abs(current - goal),
            );
            current = next;
        }
        expect(current).toBe(goal);
    }
});
