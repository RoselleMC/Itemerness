import { beforeEach, describe, expect, it } from "vitest";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import {
    projectDocumentSchema,
    type PresentationBlock,
} from "@itemerness/protocol";
import { useEditorStore } from "../src/state/store.js";
import {
    canInsertContent,
    contentSources,
    insertContent,
    moveSelectedContent,
    type ContentKind,
} from "../src/state/contentActions.js";
import { insertBlockTree, locateBlock } from "../src/state/blocks.js";

beforeEach(() => {
    useEditorStore.getState().resetDraft();
    useEditorStore.getState().setDocument(structuredClone(baselineDocument));
});

describe("all content kinds", () => {
    it.each<ContentKind>([
        "text",
        "field",
        "description",
        "conditional",
        "repeat",
        "nestedItemList",
    ])("inserts %s as one valid undoable document change", (kind) => {
        const state = useEditorStore.getState();
        const item = state.document.items.find((entry) =>
            kind === "nestedItemList"
                ? entry.definition.contents.length > 0
                : entry.id === "ember-blade",
        )!;
        state.selectItem(`${state.document.namespace}:${item.id}`);
        const before = useEditorStore.getState().snapshotHash;
        insertContent(kind, "__name", "after", "New text");
        const after = useEditorStore.getState();
        const updated = after.document.items.find(
            (entry) => entry.uuid === item.uuid,
        )!;
        expect(updated.presentation.blocks[0]!.type).toBe(kind);
        expect(updated.presentation.blocks[0]!.uuid).toBe(
            after.selectedBlockUuid,
        );
        expect(projectDocumentSchema.safeParse(after.document).success).toBe(
            true,
        );
        expect(after.historyTransactionId).toBeNull();
        expect(after.persistenceDocument).toBe(after.document);
        after.undo();
        expect(useEditorStore.getState().snapshotHash).toBe(before);
        expect(useEditorStore.getState().canUndo).toBe(false);
        useEditorStore.getState().redo();
        expect(useEditorStore.getState().snapshotHash).toBe(after.snapshotHash);
    });

    it("uses bound readable keys and requires configured nested contents", () => {
        const document = structuredClone(baselineDocument);
        const item = document.items[0]!;
        expect(canInsertContent(document, item, "repeat")).toBe(true);
        expect(canInsertContent(document, item, "nestedItemList")).toBe(false);
        item.definition.instance.schemas = [];
        expect(canInsertContent(document, item, "field")).toBe(false);
        expect(canInsertContent(document, item, "text")).toBe(false);
        expect(canInsertContent(document, item, "repeat")).toBe(false);
        expect(canInsertContent(document, item, "description")).toBe(true);
    });

    it("derives repeat paths through nested compounds and honors repeat budgets", () => {
        const document = structuredClone(baselineDocument);
        const item = document.items[0]!;
        const listKey = document.dataSchemas[0]!.keys.find(
            (key) => key.id === "example:sockets",
        )!;
        listKey.type = {
            kind: "list",
            element: {
                kind: "compound",
                fields: [
                    {
                        name: "details",
                        nullable: false,
                        type: {
                            kind: "compound",
                            fields: [
                                {
                                    name: "label",
                                    type: { kind: "string" },
                                    nullable: false,
                                },
                            ],
                        },
                    },
                ],
            },
        };
        document.budgets.maximumRepeatElements = 3;
        expect(contentSources(document, item).repeat?.path).toBe(
            "details.label",
        );
        useEditorStore.getState().setDocument(document);
        useEditorStore
            .getState()
            .selectItem(`${document.namespace}:${item.id}`);
        insertContent("repeat", "__name", "after", "Empty");
        const block =
            useEditorStore.getState().document.items[0]!.presentation
                .blocks[0]!;
        expect(block.type === "repeat" && block.maximumElements).toBe(3);
        expect(block.type === "repeat" && block.template.valuePath).toBe(
            "details.label",
        );
    });

    it("creates conditions without requiring viewer facts or data keys", () => {
        const document = structuredClone(baselineDocument);
        document.viewerFacts = [];
        document.items[0]!.definition.instance.schemas = [];
        useEditorStore.getState().setDocument(document);
        insertContent("conditional", "__name", "after", "New text");
        const block =
            useEditorStore.getState().document.items[0]!.presentation
                .blocks[0]!;
        expect(block.type === "conditional" && block.condition).toEqual({
            operator: "EQUALS",
            left: { kind: "literal", value: { kind: "boolean", value: true } },
            right: { kind: "literal", value: { kind: "boolean", value: true } },
        });
    });
});

describe("explicit condition branch insertion", () => {
    function emptyParent(): Extract<
        PresentationBlock,
        { type: "conditional" }
    > {
        const parent = structuredClone(
            baselineDocument.items
                .flatMap((item) => item.presentation.blocks)
                .find((block) => block.type === "conditional")!,
        );
        if (parent.type !== "conditional") throw new Error("Missing fixture");
        return { ...parent, thenBlocks: [], otherwiseBlocks: [] };
    }

    it("reaches both empty branches and keeps sibling moves in the chosen branch", () => {
        const document = structuredClone(baselineDocument);
        const parent = emptyParent();
        document.items[0]!.presentation.blocks = [parent];
        useEditorStore.getState().setDocument(document);
        insertContent(
            "description",
            { parentUuid: parent.uuid, branch: "thenBlocks" },
            "after",
            "True",
        );
        const first = useEditorStore.getState().selectedBlockUuid!;
        insertContent(
            "description",
            { parentUuid: parent.uuid, branch: "otherwiseBlocks" },
            "after",
            "False",
        );
        const other = useEditorStore.getState().selectedBlockUuid!;
        insertContent("description", first, "before", "Before");
        const before = useEditorStore.getState().selectedBlockUuid!;
        moveSelectedContent(1);
        const blocks =
            useEditorStore.getState().document.items[0]!.presentation.blocks;
        expect(
            locateBlock(blocks, before)?.siblings.map((block) => block.uuid),
        ).toEqual([first, before]);
        expect(
            locateBlock(blocks, other)?.siblings.map((block) => block.uuid),
        ).toEqual([other]);
        expect(
            locateBlock(blocks, before)?.ancestors.map((block) => block.uuid),
        ).toEqual([parent.uuid]);
        expect(blocks).toHaveLength(1);
    });

    it("does not insert into a missing or non-conditional parent", () => {
        const state = useEditorStore.getState();
        const hash = state.snapshotHash;
        const ordinary = state.document.items[0]!.presentation.blocks[0]!;
        insertContent(
            "description",
            { parentUuid: ordinary.uuid, branch: "thenBlocks" },
            "after",
            "Stale",
        );
        insertContent(
            "description",
            { parentUuid: crypto.randomUUID(), branch: "thenBlocks" },
            "after",
            "Stale",
        );
        expect(useEditorStore.getState().snapshotHash).toBe(hash);
        expect(useEditorStore.getState().canUndo).toBe(false);
        const parent = emptyParent();
        expect(
            insertBlockTree(
                [parent],
                { parentUuid: "missing", branch: "thenBlocks" },
                ordinary,
            ),
        ).toEqual([parent]);
    });
});
