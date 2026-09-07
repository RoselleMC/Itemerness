import { beforeEach, expect, it } from "vitest";
import type { TFunction } from "i18next";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import { projectDocumentSchema } from "@itemerness/protocol";
import { useEditorStore } from "../src/state/store.js";
import { useConnectionStore } from "../src/state/connection.js";
import {
    contextOwner,
    resolveConfirmation,
    useInterface,
} from "../src/state/interface.js";
import { deleteItem, duplicateItem } from "../src/state/itemActions.js";
import { insertContent } from "../src/state/contentActions.js";

const t = ((key: string) =>
    key === "menus.copySuffix" ? "Copy" : key) as TFunction;
const state = () => useEditorStore.getState();
beforeEach(() => {
    resolveConfirmation(false);
    state().resetDraft();
    state().setDocument(structuredClone(baselineDocument));
});

it("duplicates an item with fresh block identities and independently copied localization", () => {
    const original = state().document.items[0]!;
    duplicateItem(original.uuid, t);
    const document = state().document,
        copy = document.items.at(-1)!;
    expect(copy.id).toBe(`${original.id}-copy`);
    expect(copy.uuid).not.toBe(original.uuid);
    expect(copy.presentation.blocks.map((block) => block.uuid)).not.toEqual(
        original.presentation.blocks.map((block) => block.uuid),
    );
    expect(copy.presentation.nameMessage).not.toBe(
        original.presentation.nameMessage,
    );
    expect(projectDocumentSchema.safeParse(document).success).toBe(true);
    state().setMessage("en_us", copy.presentation.nameMessage, "Only the copy");
    expect(
        state().document.locales.find((locale) => locale.locale === "en_us")!
            .messages[original.presentation.nameMessage],
    ).toBe("Harbor Travel Token");
    state().undo();
    state().undo();
    expect(state().document.items.map((item) => item.uuid)).toEqual(
        baselineDocument.items.map((item) => item.uuid),
    );
});

it("deletion confirms the exact item and rejects an accepted dialog from a changed document", async () => {
    const item = state().document.items[1]!;
    const pending = deleteItem(item.uuid, t);
    expect(useInterface.getState().confirmation).not.toBeNull();
    state().setMessage("en_us", "another.key", "Changed while confirming");
    resolveConfirmation(true);
    await pending;
    expect(
        state().document.items.some((entry) => entry.uuid === item.uuid),
    ).toBe(true);
    const confirmed = deleteItem(item.uuid, t);
    resolveConfirmation(true);
    await confirmed;
    expect(
        state().document.items.some((entry) => entry.uuid === item.uuid),
    ).toBe(false);
    state().undo();
    expect(
        state().document.items.some((entry) => entry.uuid === item.uuid),
    ).toBe(true);
});

it("context ownership changes even when another connection has the same empty document", () => {
    const previous = useConnectionStore.getState().address;
    const owner = contextOwner();
    useConnectionStore.setState({ address: "http://other.example:18087" });
    expect(contextOwner()).not.toBe(owner);
    useConnectionStore.setState({ address: previous });
});

it("the shared insertion action respects branch location and handles nonnumeric facts", () => {
    const original = state().document.items[0]!;
    state().selectItem(`itemerness:${original.id}`);
    state().updateDocument((document) => ({
        ...document,
        viewerFacts: document.viewerFacts.filter(
            (fact) => fact.type === "BOOLEAN",
        ),
    }));
    insertContent("conditional", "__name", "after", "New text");
    const parent = state().document.items[0]!.presentation.blocks[0]!;
    if (parent.type !== "conditional") throw new Error("Expected condition");
    expect(parent.condition.operator).toBe("EXISTS");
    insertContent(
        "description",
        parent.thenBlocks[0]!.uuid,
        "after",
        "Inside branch",
    );
    const changed = state().document.items[0]!.presentation.blocks[0]!;
    expect(changed.type === "conditional" && changed.thenBlocks.length).toBe(2);
});
