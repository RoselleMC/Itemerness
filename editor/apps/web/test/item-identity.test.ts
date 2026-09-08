import { beforeEach, describe, expect, it } from "vitest";
import type { TFunction } from "i18next";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import {
    itemKey,
    projectDocumentSchema,
    upgradeProjectDocument,
} from "@itemerness/protocol";
import { useEditorStore } from "../src/state/store.js";
import { duplicateItem } from "../src/state/itemActions.js";
import {
    freshItemCopyId,
    itemIdIssue,
    renameItem,
} from "../src/state/itemIdentity.js";
import {
    duplicateSelectedContent,
    insertContent,
} from "../src/state/contentActions.js";

function fixture() {
    return upgradeProjectDocument(baselineDocument, (_schema, key) => ({
        readSources: [
            {
                kind:
                    key.scope === "DEFINITION"
                        ? "catalogDefinition"
                        : "canonicalNbt",
            },
        ],
        access: {
            read: "PUBLIC",
            write: [key.scope === "DEFINITION" ? "definition" : "internal"],
        },
        placeholderApi: { exposed: false, formatter: null },
    }));
}
beforeEach(() => useEditorStore.getState().resetDraft());

describe("item identities", () => {
    it("renames explicit nested references in one history step and keeps the stable selection", () => {
        const document = fixture();
        const original = document.items[0]!;
        const old = itemKey(document, original);
        document.items[1]!.definition.contents = [
            { item: old, amount: 2 },
            { item: "other:travel-token", amount: 1 },
        ];
        document.items[2]!.previewData.push({
            key: "example:label",
            value: { kind: "string", value: old },
        });
        const state = useEditorStore.getState();
        state.setDocument(document);
        state.selectBlock(original.presentation.blocks[0]!.uuid);
        state.updateDocument((draft) =>
            renameItem(draft, original.uuid, "equipment:tools/token"),
        );
        const next = useEditorStore.getState();
        expect(next.selectedItemId).toBe("equipment:tools/token");
        expect(next.selectedBlockUuid).toBe(
            original.presentation.blocks[0]!.uuid,
        );
        expect(next.document.items[1]!.definition.contents).toEqual([
            { item: "equipment:tools/token", amount: 2 },
            { item: "other:travel-token", amount: 1 },
        ]);
        expect(next.document.items[0]!.previewData).toBe(original.previewData);
        expect(next.document.items[2]!.previewData.at(-1)!.value).toEqual({
            kind: "string",
            value: old,
        });
        expect(next.persistenceDocument).toBe(next.document);
        next.undo();
        expect(useEditorStore.getState().document).toBe(document);
        expect(useEditorStore.getState().selectedItemId).toBe(old);
        expect(useEditorStore.getState().canUndo).toBe(false);
        useEditorStore.getState().redo();
        expect(useEditorStore.getState().selectedItemId).toBe(
            "equipment:tools/token",
        );
    });

    it("allows another namespace but rejects root-qualified aliases and invalid legacy edits", () => {
        const document = fixture();
        const uuid = document.items[1]!.uuid;
        expect(itemIdIssue(document, uuid, "other:travel-token")).toBeNull();
        expect(itemIdIssue(document, uuid, "itemerness:travel-token")).toBe(
            "idTaken",
        );
        expect(itemIdIssue(document, uuid, "Bad:key")).toBe("invalidId");
        expect(itemIdIssue(baselineDocument, uuid, "other:travel-token")).toBe(
            "legacyId",
        );
        expect(() =>
            renameItem(document, uuid, "itemerness:travel-token"),
        ).toThrow("idTaken");
    });

    it("copies namespaced paths with valid independent message keys and fresh recursive UUIDs", () => {
        const document = fixture();
        document.items[0]!.id = "other:tools/token";
        const original = document.items[0]!;
        const state = useEditorStore.getState();
        state.setDocument(document);
        duplicateItem(original.uuid, ((key: string) => key) as TFunction);
        const copied = useEditorStore.getState().document.items.at(-1)!;
        expect(copied.id).toBe("other:tools/token-copy");
        expect(useEditorStore.getState().selectedItemId).toBe(copied.id);
        expect(copied.presentation.nameMessage).not.toBe(
            original.presentation.nameMessage,
        );
        expect(copied.presentation.blocks[0]!.uuid).not.toBe(
            original.presentation.blocks[0]!.uuid,
        );
        expect(
            projectDocumentSchema.safeParse(useEditorStore.getState().document)
                .success,
        ).toBe(true);
        insertContent("description", "__name", "after", "New");
        duplicateSelectedContent();
        expect(
            projectDocumentSchema.safeParse(useEditorStore.getState().document)
                .success,
        ).toBe(true);
    });

    it("reserves suffix room and detects local and qualified collisions when copying and adding", () => {
        const document = fixture();
        document.items[0]!.id = "travel-token";
        document.items[1]!.id = "itemerness:travel-token-copy";
        expect(freshItemCopyId(document, document.items[0]!)).toBe(
            "travel-token-copy-2",
        );
        document.items[0]!.id = `x:${"p".repeat(254)}`;
        expect(freshItemCopyId(document, document.items[0]!)).toHaveLength(256);
        document.items[1]!.id = "itemerness:new-item-1";
        useEditorStore.getState().setDocument(document);
        expect(
            useEditorStore
                .getState()
                .addItem("New", {
                    layout: "itemerness:plain",
                    theme: "itemerness:default",
                }),
        ).toBe("new-item-2");
        const legacy = structuredClone(baselineDocument);
        legacy.items[0]!.id = "p".repeat(200);
        expect(freshItemCopyId(legacy, legacy.items[0]!)).toBe(
            `${"p".repeat(200)}-copy`,
        );
    });
});
