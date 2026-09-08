import { describe, expect, it } from "vitest";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import {
    projectDocumentSchema,
    type PresentationBlock,
} from "@itemerness/protocol";
import { useEditorStore } from "../src/state/store.js";
import {
    addWrapping,
    canvasThemeMismatches,
    defaultWrappingName,
    layoutEntryReferences,
    layoutNameError,
    layoutNumberError,
    removeLayoutEntry,
    renameLayoutEntry,
} from "../src/features/inspector/layoutEditing.js";

const description = (
    wrapping: string | null,
    anchor: string | null = null,
): PresentationBlock => ({
    uuid: crypto.randomUUID(),
    type: "description",
    message: "item.survey-codex.description",
    style: null,
    anchor,
    wrapping,
});
const conditional = (
    thenBlocks: PresentationBlock[],
    otherwiseBlocks: PresentationBlock[],
): PresentationBlock => ({
    uuid: crypto.randomUUID(),
    type: "conditional",
    condition: {
        operator: "EQUALS",
        left: { kind: "literal", value: { kind: "integer", value: "1" } },
        right: { kind: "literal", value: { kind: "integer", value: "1" } },
    },
    style: null,
    anchor: null,
    thenBlocks,
    otherwiseBlocks,
});

function fixture() {
    const document = structuredClone(baselineDocument);
    const layout = document.layouts.find((entry) => entry.kind === "canvas")!;
    const item = document.items.find(
        (entry) => entry.presentation.layout === layout.id,
    )!;
    item.presentation.blocks = [
        conditional(
            [description("canvas-body", "body")],
            [description(null, "body")],
        ),
    ];
    return { document, layout, item };
}

describe("layout entry references", () => {
    it("renames recursive anchor references only for items bound to this layout", () => {
        const { document, layout, item } = fixture();
        const unrelated = document.items.find(
            (entry) => entry.presentation.layout !== layout.id,
        )!;
        unrelated.presentation.blocks = [description(null, "body")];
        const result = renameLayoutEntry(
            document,
            layout.uuid,
            "anchors",
            "body",
            "details",
        );
        expect(result.error).toBeNull();
        const changed = result.document!;
        const block = changed.items.find((entry) => entry.uuid === item.uuid)!
            .presentation.blocks[0]!;
        expect(block.type).toBe("conditional");
        if (block.type !== "conditional")
            throw new Error("Expected conditional");
        expect(block.thenBlocks[0]!.anchor).toBe("details");
        expect(block.otherwiseBlocks[0]!.anchor).toBe("details");
        expect(
            changed.items.find((entry) => entry.uuid === unrelated.uuid),
        ).toBe(unrelated);
        expect(
            document.layouts.find((entry) => entry.uuid === layout.uuid),
        ).toBe(layout);
        expect(projectDocumentSchema.safeParse(changed).success).toBe(true);
    });

    it("protects explicit and implicit references against deletion", () => {
        const { document, layout } = fixture();
        expect(layoutEntryReferences(document, layout, "anchors", "body")).toBe(
            2,
        );
        expect(
            layoutEntryReferences(document, layout, "wrapping", "canvas-body"),
        ).toBe(2);
        expect(
            removeLayoutEntry(document, layout.uuid, "anchors", "body").error,
        ).toBe("referenced");
        expect(
            removeLayoutEntry(document, layout.uuid, "wrapping", "canvas-body")
                .error,
        ).toBe("referenced");
        expect(
            removeLayoutEntry(document, layout.uuid, "anchors", "subtitle")
                .error,
        ).toBeNull();
    });

    it("migrates explicit wrapping references without renaming other layouts", () => {
        const { document, layout, item } = fixture();
        const unrelated = document.items.find(
            (entry) => entry.presentation.layout !== layout.id,
        )!;
        unrelated.presentation.blocks = [description("canvas-body")];
        const next = renameLayoutEntry(
            document,
            layout.uuid,
            "wrapping",
            "canvas-body",
            "details",
        ).document!;
        const block = next.items.find((entry) => entry.uuid === item.uuid)!
            .presentation.blocks[0]!;
        if (block.type !== "conditional")
            throw new Error("Expected conditional");
        expect(block.thenBlocks[0]).toMatchObject({ wrapping: "details" });
        expect(block.otherwiseBlocks[0]).toMatchObject({ wrapping: null });
        expect(next.items.find((entry) => entry.uuid === unrelated.uuid)).toBe(
            unrelated,
        );
        expect(
            defaultWrappingName(
                next.layouts.find((entry) => entry.uuid === layout.uuid)!,
            ),
        ).toBe("details");
    });

    it("preserves an implicit policy when adding a new body default", () => {
        const { document, layout, item } = fixture();
        const next = addWrapping(document, layout.uuid, "body").document!;
        const block = next.items.find((entry) => entry.uuid === item.uuid)!
            .presentation.blocks[0]!;
        if (block.type !== "conditional")
            throw new Error("Expected conditional");
        expect(block.otherwiseBlocks[0]).toMatchObject({
            wrapping: "canvas-body",
        });
        expect(
            next.layouts.find((entry) => entry.uuid === layout.uuid)!.wrapping
                .body,
        ).toMatchObject({ widthPixels: null, maximumLines: 16 });
    });

    it("rejects changing implicit defaults for blocks without a wrapping selector", () => {
        const { document, layout, item } = fixture();
        item.presentation.blocks.push({
            uuid: crypto.randomUUID(),
            type: "nestedItemList",
            anchor: "body",
            style: null,
        });
        expect(addWrapping(document, layout.uuid, "body").error).toBe(
            "implicitDefault",
        );
        expect(
            renameLayoutEntry(
                document,
                layout.uuid,
                "wrapping",
                "canvas-body",
                "body",
            ).error,
        ).toBeNull();
    });

    it("preserves scalar implicit references when renaming a non-first body policy", () => {
        const { document, layout, item } = fixture();
        const policy = layout.wrapping["canvas-body"]!;
        layout.wrapping = {
            lead: { ...policy, widthPixels: 50 },
            body: policy,
        };
        item.presentation.blocks = [
            conditional([description("body")], [description(null)]),
        ];
        const renamed = renameLayoutEntry(
            document,
            layout.uuid,
            "wrapping",
            "body",
            "details",
        );
        expect(renamed.error).toBeNull();
        const next = renamed.document!.items.find(
            (entry) => entry.uuid === item.uuid,
        )!.presentation.blocks[0]!;
        if (next.type !== "conditional")
            throw new Error("Expected conditional");
        expect(next.thenBlocks[0]).toMatchObject({ wrapping: "details" });
        expect(next.otherwiseBlocks[0]).toMatchObject({ wrapping: "details" });
        item.presentation.blocks.push({
            uuid: crypto.randomUUID(),
            type: "nestedItemList",
            anchor: "body",
            style: null,
        });
        expect(
            renameLayoutEntry(
                document,
                layout.uuid,
                "wrapping",
                "body",
                "details",
            ).error,
        ).toBe("implicitDefault");
    });

    it("keeps coupled reference migration as one undo and redo transaction", () => {
        const { document, layout } = fixture();
        const store = useEditorStore.getState();
        store.resetDraft();
        store.setDocument(document);
        store.updateDocument(
            (current) =>
                renameLayoutEntry(
                    current,
                    layout.uuid,
                    "anchors",
                    "body",
                    "details",
                ).document ?? current,
        );
        const changed = useEditorStore.getState().document;
        expect(useEditorStore.getState().persistenceDocument).toBe(changed);
        useEditorStore.getState().undo();
        expect(useEditorStore.getState().document).toEqual(document);
        expect(useEditorStore.getState().canUndo).toBe(false);
        useEditorStore.getState().redo();
        expect(useEditorStore.getState().document).toEqual(changed);
    });
});

describe("layout scalar validation", () => {
    it("reports matching-dimension constraints through the used theme fallback chain", () => {
        const { document, layout, item } = fixture();
        if (layout.kind !== "canvas") throw new Error("Expected canvas");
        expect(canvasThemeMismatches(document, layout)).toEqual([]);
        layout.widthPixels++;
        expect(
            canvasThemeMismatches(document, layout).map((theme) => theme.id),
        ).toEqual(["itemerness:aurora-canvas"]);
        const source = document.themes.find(
            (theme) => theme.id === "itemerness:ember",
        )!;
        source.fallback = "itemerness:aurora-canvas";
        item.presentation.theme = source.id;
        expect(canvasThemeMismatches(document, layout)).toHaveLength(1);
        item.presentation.theme = "itemerness:default";
        expect(canvasThemeMismatches(document, layout)).toEqual([]);
    });
    it.each(["", "-", "1.5", "1e2", "Infinity", "12x", "9007199254740992"])(
        "keeps unfinished or invalid %s out of documents",
        (value) => {
            expect(layoutNumberError(value, 0, 4096)).toBe("integerRange");
        },
    );
    it("enforces exact vertical gap steps without rounding", () => {
        expect(layoutNumberError("15", 0, 256, 10)).toBe("step");
        expect(layoutNumberError("20", 0, 256, 10)).toBeNull();
        expect(layoutNumberError("120", 140, 220)).toBe("integerRange");
    });
    it("validates semantic names and uniqueness within one map", () => {
        expect(layoutNameError("new-policy", ["body"])).toBeNull();
        expect(layoutNameError("Bad Name", [])).toBe("invalidName");
        expect(layoutNameError("a".repeat(65), [])).toBeNull();
        expect(layoutNameError("body", ["body"])).toBe("duplicateName");
        expect(layoutNameError("body", ["body"], "body")).toBeNull();
    });
});
