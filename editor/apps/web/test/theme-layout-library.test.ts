import { describe, expect, it } from "vitest";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import { projectDocumentSchema } from "@itemerness/protocol";
import { freshNamespacedId } from "../src/state/freshId.js";
import { newDataSchema } from "../src/state/dataLibrary.js";
import {
    newLayout,
    newTheme,
    removeThemeLayout,
    renameThemeLayout,
    themeLayoutReferences,
} from "../src/state/themeLayoutLibrary.js";
import { useEditorStore } from "../src/state/store.js";

describe("theme and layout library commands", () => {
    it("generates valid unique IDs even when the source exhausts the path budget", () => {
        const source = `example:${"x".repeat(248)}`;
        const used = new Set([source]);
        const id = freshNamespacedId(`${source}-copy`, used);
        expect(id.length).toBe(256);
        expect(id).not.toBe(source);
        used.add(id);
        expect(freshNamespacedId(`${source}-copy`, used)).not.toBe(id);
        const document = structuredClone(baselineDocument);
        document.dataSchemas[0]!.id = source;
        document.dataSchemas[0]!.keys[0]!.id = source;
        expect(() =>
            newDataSchema(document, document.dataSchemas[0]),
        ).not.toThrow();
    });
    it("creates minimal blank entries and duplicates independent recursive geometry", () => {
        const document = structuredClone(baselineDocument);
        document.themes.push(newTheme(document));
        document.layouts.push(
            newLayout(document, "flow"),
            newLayout(document, "canvas"),
        );
        expect(projectDocumentSchema.safeParse(document).success).toBe(true);
        const source = document.themes.find((entry) => entry.canvas)!;
        const copy = newTheme(document, source);
        expect(copy.uuid).not.toBe(source.uuid);
        expect(copy.canvas).toEqual(source.canvas);
        expect(copy.canvas).not.toBe(source.canvas);
        const layout = document.layouts.find(
            (entry) => entry.kind === "canvas",
        )!;
        expect(newLayout(document, "flow", layout).kind).toBe("canvas");
    });
    it("atomically renames item, theme fallback, retained renderer state and system fact references", () => {
        const document = structuredClone(baselineDocument);
        const source = document.themes.find(
            (entry) => entry.id === "itemerness:default",
        )!;
        const retained = document.themes.find(
            (entry) => entry.uuid !== source.uuid,
        )!;
        retained.extensions = {
            other: "preserved",
            editorRendererState: { fallback: source.id, tooltipStyle: null },
        };
        const fact = document.viewerFacts.find(
            (entry) => entry.id === "itemerness:theme",
        )!;
        fact.defaultValue = { kind: "string", value: source.id };
        fact.previewValue = { kind: "string", value: source.id };
        const state = () => useEditorStore.getState();
        state().resetDraft();
        state().setDocument(document);
        state().updateDocument((document) =>
            renameThemeLayout(document, "themes", source.uuid, "example:plain"),
        );
        expect(
            state().document.themes.some(
                (entry) => entry.fallback === source.id,
            ),
        ).toBe(false);
        expect(
            state().document.items.some(
                (entry) => entry.presentation.theme === source.id,
            ),
        ).toBe(false);
        expect(
            state().document.viewerFacts.find(
                (entry) => entry.uuid === fact.uuid,
            )!.defaultValue,
        ).toEqual({ kind: "string", value: "example:plain" });
        expect(
            state().document.themes.find(
                (entry) => entry.uuid === retained.uuid,
            )!.extensions,
        ).toEqual({
            other: "preserved",
            editorRendererState: {
                fallback: "example:plain",
                tooltipStyle: null,
            },
        });
        state().undo();
        expect(state().document).toEqual(document);
    });
    it("renames layouts without touching theme identities and refuses duplicate names", () => {
        const document = structuredClone(baselineDocument);
        const source = document.layouts[0]!;
        const renamed = renameThemeLayout(
            document,
            "layouts",
            source.uuid,
            "example:flow",
        );
        expect(
            renamed.items.some(
                (entry) => entry.presentation.layout === source.id,
            ),
        ).toBe(false);
        expect(renamed.themes).toBe(document.themes);
        expect(
            renameThemeLayout(
                document,
                "layouts",
                source.uuid,
                document.layouts[1]!.id,
            ),
        ).toBe(document);
    });
    it("refuses referenced deletion and allows removal of unused copies", () => {
        const document = structuredClone(baselineDocument);
        for (const kind of ["themes", "layouts"] as const) {
            const source = document[kind][0]!;
            expect(
                themeLayoutReferences(document, kind, source.id).length,
            ).toBeGreaterThan(0);
            expect(removeThemeLayout(document, kind, source.uuid)).toBe(
                document,
            );
        }
        const unused = newTheme(document);
        document.themes.push(unused);
        expect(
            removeThemeLayout(document, "themes", unused.uuid).themes,
        ).not.toContainEqual(unused);
    });
});
