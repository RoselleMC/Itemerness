import { beforeEach, describe, expect, it } from "vitest";
import {
    itemTheme,
    projectDocumentSchema,
    upgradeProjectDocument,
    type PresentationBlock,
} from "@itemerness/protocol";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import {
    createItemDocument,
    copyItemDocument,
    itemCreationIssue,
} from "../src/state/itemCreation.js";
import { useEditorStore } from "../src/state/store.js";

const appearance = { layout: "itemerness:plain", theme: "itemerness:default" };
const fixture = () => structuredClone(baselineDocument);
function version2() {
    return upgradeProjectDocument(fixture(), (_schema, key) => ({
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
function flatten(blocks: PresentationBlock[]): PresentationBlock[] {
    return blocks.flatMap((block) => [
        block,
        ...(block.type === "conditional"
            ? [...flatten(block.thenBlocks), ...flatten(block.otherwiseBlocks)]
            : []),
    ]);
}
function messages(block: PresentationBlock): string[] {
    if (block.type === "field") return [block.labelMessage];
    if (block.type === "description") return [block.message];
    if (block.type === "repeat")
        return [block.template.labelMessage, block.template.missingMessage];
    return [];
}
beforeEach(() => useEditorStore.getState().resetDraft());

describe("explicit item creation", () => {
    it("creates a genuinely blank disabled definition without borrowing schemas or Lore", () => {
        const source = fixture();
        const next = createItemDocument(source, "New item", {
            id: "blank",
            ...appearance,
        });
        const item = next.items.at(-1)!;
        expect(item.enabled).toBe(false);
        expect(item.definition).toMatchObject({
            material: "minecraft:paper",
            baseComponents: [],
            definitionData: [],
            contents: [],
            instance: {
                mode: "FUNGIBLE",
                schemas: [],
                defaults: [],
                generators: [],
            },
        });
        expect(item.presentation.blocks).toEqual([]);
        expect(item.previewData).toEqual([]);
        expect(next.locales[0]!.messages[item.presentation.nameMessage]).toBe(
            "New item",
        );
        expect(source.items).toHaveLength(5);
        expect(projectDocumentSchema.safeParse(next).success).toBe(true);
    });
    it("requires explicit appearance when there are no project defaults and never seeds libraries", () => {
        const source = fixture();
        expect(() => createItemDocument(source, "New")).toThrow(
            "missingLayout",
        );
        expect(
            itemCreationIssue(source, "New", { layout: appearance.layout }),
        ).toBe("missingTheme");
        source.themes = [];
        expect(() => createItemDocument(source, "New", appearance)).toThrow(
            "missingTheme",
        );
        useEditorStore.getState().setDocument(source);
        expect(() => useEditorStore.getState().addItem("New")).toThrow(
            "missingLayout",
        );
        expect(useEditorStore.getState().document).toBe(source);
        expect(useEditorStore.getState().canUndo).toBe(false);
    });
    it("copies complete definitions, all owned messages and recursive UUIDs without propagating future edits", () => {
        const document = fixture();
        const source = document.items.find(
            (item) => item.id === "ember-blade",
        )!;
        const next = createItemDocument(document, "New blade", {
            id: "new-blade",
            sourceUuid: source.uuid,
        });
        const created = next.items.at(-1)!;
        expect(created.definition).toEqual(source.definition);
        expect(created.definition).not.toBe(source.definition);
        expect(created.previewData).toEqual(source.previewData);
        expect(created.enabled).toBe(false);
        expect(created.presentation.theme).toBe(source.presentation.theme);
        const originalBlocks = flatten(source.presentation.blocks);
        const copiedBlocks = flatten(created.presentation.blocks);
        expect(copiedBlocks).toHaveLength(originalBlocks.length);
        expect(new Set(copiedBlocks.map((block) => block.uuid)).size).toBe(
            copiedBlocks.length,
        );
        for (let index = 0; index < originalBlocks.length; index++) {
            expect(copiedBlocks[index]!.uuid).not.toBe(
                originalBlocks[index]!.uuid,
            );
            const from = messages(originalBlocks[index]!);
            const to = messages(copiedBlocks[index]!);
            for (let key = 0; key < from.length; key++) {
                expect(to[key]).not.toBe(from[key]);
                for (let locale = 0; locale < document.locales.length; locale++)
                    expect(next.locales[locale]!.messages[to[key]!]).toEqual(
                        document.locales[locale]!.messages[from[key]!],
                    );
            }
        }
        expect(
            next.locales[1]!.messages[created.presentation.nameMessage],
        ).toBe(document.locales[1]!.messages[source.presentation.nameMessage]);
        created.definition.instance.defaults.length = 0;
        expect(source.definition.instance.defaults.length).toBeGreaterThan(0);
        expect(projectDocumentSchema.safeParse(next).success).toBe(true);
    });
    it("retains shared nested item references instead of duplicating the catalog graph", () => {
        const document = fixture();
        const source = document.items.find(
            (item) => item.id === "nested-satchel",
        )!;
        const next = createItemDocument(document, "New satchel", {
            sourceUuid: source.uuid,
        });
        expect(next.items).toHaveLength(document.items.length + 1);
        expect(next.items.at(-1)!.definition.contents).toEqual(
            source.definition.contents,
        );
        expect(next.dataSchemas).toBe(document.dataSchemas);
        expect(next.themes).toBe(document.themes);
        expect(next.layouts).toBe(document.layouts);
    });
    it("preserves omitted and null inheritance and only pins explicitly overridden appearance", () => {
        const document = version2();
        document.defaultLayout = appearance.layout;
        document.defaultTheme = appearance.theme;
        const source = document.items[0]!;
        delete source.presentation.theme;
        source.presentation.layout = null;
        const next = createItemDocument(document, "Inherited", {
            sourceUuid: source.uuid,
            id: "other:inherited",
        });
        expect(Object.hasOwn(next.items.at(-1)!.presentation, "theme")).toBe(
            false,
        );
        expect(next.items.at(-1)!.presentation.layout).toBeNull();
        expect(itemTheme(next, next.items.at(-1)!)).toBe(appearance.theme);
        const explicit = createItemDocument(document, "Pinned", {
            sourceUuid: source.uuid,
            theme: "itemerness:ember",
        });
        expect(explicit.items.at(-1)!.presentation.theme).toBe(
            "itemerness:ember",
        );
        expect(explicit.items.at(-1)!.definition).toEqual(source.definition);
        const blank = createItemDocument(document, "Blank");
        expect(blank.items.at(-1)!.presentation).toMatchObject({
            theme: null,
            layout: null,
        });
        expect(projectDocumentSchema.safeParse(next).success).toBe(true);
    });
    it("rejects invalid identity, missing sources, empty names and missing default locales without mutation", () => {
        const document = fixture();
        expect(
            itemCreationIssue(document, "New", {
                ...appearance,
                id: "travel-token",
            }),
        ).toBe("idTaken");
        expect(
            itemCreationIssue(document, "New", {
                ...appearance,
                id: "other:item",
            }),
        ).toBe("legacyId");
        expect(itemCreationIssue(document, "  ", appearance)).toBe(
            "nameRequired",
        );
        expect(
            itemCreationIssue(document, "New", {
                ...appearance,
                sourceUuid: "missing",
            }),
        ).toBe("missingSource");
        document.locales = [];
        expect(itemCreationIssue(document, "New", appearance)).toBe(
            "missingLocale",
        );
        expect(document.items).toHaveLength(5);
    });
    it("shares clone semantics with duplicate while only creation forces disabled", () => {
        const document = fixture();
        const source = document.items[0]!;
        const duplicate = copyItemDocument(document, source, "copy", {
            nameForLocale: (_locale, name) => `${name} (copy)`,
        });
        expect(duplicate.items.at(-1)!.enabled).toBe(source.enabled);
        expect(
            duplicate.locales[0]!.messages[
                duplicate.items.at(-1)!.presentation.nameMessage
            ],
        ).toMatch(/\(copy\)$/);
        expect(
            createItemDocument(document, "New", {
                sourceUuid: source.uuid,
            }).items.at(-1)!.enabled,
        ).toBe(false);
    });
    it("separates an explicitly created name from source Lore aliases without changing duplicate semantics", () => {
        const document = fixture();
        const source = document.items[0]!;
        source.presentation.blocks = [
            {
                uuid: crypto.randomUUID(),
                type: "description",
                message: source.presentation.nameMessage,
                style: "description",
                anchor: null,
                wrapping: null,
            },
        ];
        const next = createItemDocument(document, "Independent name", {
            sourceUuid: source.uuid,
        });
        const created = next.items.at(-1)!;
        const description = created.presentation.blocks[0]!;
        if (description.type !== "description")
            throw new Error("Missing description");
        expect(description.message).not.toBe(created.presentation.nameMessage);
        for (let index = 0; index < document.locales.length; index++)
            expect(next.locales[index]!.messages[description.message]).toBe(
                document.locales[index]!.messages[
                    source.presentation.nameMessage
                ],
            );
        expect(
            next.locales[0]!.messages[created.presentation.nameMessage],
        ).toBe("Independent name");
        expect(
            next.locales[1]!.messages[created.presentation.nameMessage],
        ).toBe(document.locales[1]!.messages[source.presentation.nameMessage]);
        expect(
            document.locales[0]!.messages[source.presentation.nameMessage],
        ).not.toBe("Independent name");
        const duplicated = copyItemDocument(document, source, "copy").items.at(
            -1,
        )!;
        const copiedDescription = duplicated.presentation.blocks[0]!;
        expect(
            copiedDescription.type === "description" &&
                copiedDescription.message,
        ).toBe(duplicated.presentation.nameMessage);
    });
    it("records item plus localized messages in one undoable transaction and keeps ID return semantics", () => {
        const document = fixture();
        const state = useEditorStore.getState();
        state.setDocument(document);
        const id = state.addItem("Created", { ...appearance, id: "created" });
        const next = useEditorStore.getState().document;
        expect(id).toBe("created");
        expect(useEditorStore.getState().selectedItemId).toBe(
            "itemerness:created",
        );
        expect(useEditorStore.getState().persistenceDocument).toBe(next);
        expect(useEditorStore.getState().historyTransactionId).toBeNull();
        state.undo();
        expect(useEditorStore.getState().document).toEqual(document);
        expect(useEditorStore.getState().canUndo).toBe(false);
        state.redo();
        expect(useEditorStore.getState().document).toEqual(next);
    });
});
