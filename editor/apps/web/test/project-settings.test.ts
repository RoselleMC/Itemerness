import { beforeEach, describe, expect, it } from "vitest";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import {
    itemKey,
    itemLayout,
    itemTheme,
    projectDocumentSchema,
    upgradeProjectDocument,
} from "@itemerness/protocol";
import {
    setProjectNamespace,
    namespaceIssue,
} from "../src/state/projectSettings.js";
import { useEditorStore } from "../src/state/store.js";
import {
    renameThemeLayout,
    themeLayoutItems,
    themeLayoutReferences,
} from "../src/state/themeLayoutLibrary.js";

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
describe("project settings", () => {
    it("moves only relative item identities and their explicit content references in one undo", () => {
        const document = fixture();
        document.items[1]!.id = "other:travel-token";
        document.items[2]!.definition.contents = [
            { item: "itemerness:travel-token", amount: 1 },
            { item: "other:travel-token", amount: 2 },
        ];
        document.defaultTheme = document.themes[0]!.id;
        const state = useEditorStore.getState();
        state.setDocument(document);
        state.updateDocument((draft) => setProjectNamespace(draft, "migrated"));
        const next = useEditorStore.getState();
        expect(next.selectedItemId).toBe("migrated:travel-token");
        expect(next.document.items[0]!.id).toBe("travel-token");
        expect(next.document.items[1]!.id).toBe("other:travel-token");
        expect(
            next.document.items[2]!.definition.contents.map(
                (entry) => entry.item,
            ),
        ).toEqual(["migrated:travel-token", "other:travel-token"]);
        expect(next.document.defaultTheme).toBe(document.defaultTheme);
        expect(next.document.items[0]!.previewData).toBe(
            document.items[0]!.previewData,
        );
        expect(next.document.dataSchemas).toBe(document.dataSchemas);
        next.undo();
        expect(useEditorStore.getState().document).toBe(document);
        expect(useEditorStore.getState().selectedItemId).toBe(
            "itemerness:travel-token",
        );
        expect(useEditorStore.getState().canUndo).toBe(false);
    });
    it("rejects namespace aliases and resolved lengths without changing data", () => {
        const document = fixture();
        document.items[1]!.id = "other:travel-token";
        expect(namespaceIssue(document, "other")).toBe("namespaceCollision");
        expect(namespaceIssue(document, "namespace:invalid")).toBe(
            "namespaceInvalid",
        );
        document.items[0]!.id = "p".repeat(245);
        expect(namespaceIssue(document, "namespace-too-long")).toBe(
            "namespaceLength",
        );
        expect(() =>
            setProjectNamespace(document, "namespace-too-long"),
        ).toThrow("namespaceLength");
    });
    it("updates defaults on shared library rename without freezing inherited item bindings", () => {
        const document = fixture();
        const theme = document.themes[0]!;
        const layout = document.layouts[0]!;
        document.defaultTheme = theme.id;
        document.defaultLayout = layout.id;
        document.items[0]!.presentation = {
            ...document.items[0]!.presentation,
            theme: null,
            layout: null,
        };
        expect(themeLayoutItems(document, "themes", theme.id)).toContain(
            document.items[0],
        );
        expect(themeLayoutReferences(document, "themes", theme.id)).toContain(
            "document.defaultTheme",
        );
        expect(themeLayoutReferences(document, "layouts", layout.id)).toContain(
            itemKey(document, document.items[0]!),
        );
        const renamed = renameThemeLayout(
            renameThemeLayout(document, "themes", theme.uuid, "other:theme"),
            "layouts",
            layout.uuid,
            "other:layout",
        );
        expect(renamed.defaultTheme).toBe("other:theme");
        expect(renamed.defaultLayout).toBe("other:layout");
        expect(renamed.items[0]!.presentation).toMatchObject({
            theme: null,
            layout: null,
        });
        expect(itemTheme(renamed, renamed.items[0]!)).toBe("other:theme");
        expect(itemLayout(renamed, renamed.items[0]!)).toBe("other:layout");
        expect(projectDocumentSchema.safeParse(renamed).success).toBe(true);
    });
    it("new items inherit configured defaults and legacy upgrades retain existing metadata", () => {
        const document = fixture();
        document.defaultTheme = document.themes[0]!.id;
        document.defaultLayout = document.layouts[0]!.id;
        useEditorStore.getState().setDocument(document);
        useEditorStore.getState().addItem("New");
        expect(
            useEditorStore.getState().document.items.at(-1)!.presentation,
        ).toMatchObject({ theme: null, layout: null });
        expect(
            projectDocumentSchema.safeParse(useEditorStore.getState().document)
                .success,
        ).toBe(true);
        const legacy = {
            ...baselineDocument,
            extensions: { retained: { note: "keep" } },
        };
        const upgraded = upgradeProjectDocument(
            legacy,
            (_schema, key) =>
                document.dataSchemas
                    .flatMap((schema) => schema.keys)
                    .find((entry) => entry.uuid === key.uuid)!.integration!,
        );
        expect(upgraded.extensions).toEqual(legacy.extensions);
        expect(upgraded).not.toHaveProperty("defaultTheme");
    });
});
