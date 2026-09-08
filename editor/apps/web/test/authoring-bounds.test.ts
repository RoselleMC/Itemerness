import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import { useEditorStore } from "../src/state/store.js";
import {
    addKey,
    addSchema,
} from "../src/features/common/dataLibraryActions.js";
import { addThemeLayout } from "../src/features/common/themeLayoutActions.js";
import { addPresentationEntry } from "../src/features/common/presentationLibraryActions.js";
import { addLocale } from "../src/features/locales/localeEditing.js";
import { assetIdError, freshSemanticId } from "../src/state/assetLibrary.js";
import { layoutNameError } from "../src/features/inspector/layoutEditing.js";
import { semanticRoleError } from "../src/features/inspector/themeEditing.js";
import { providerError } from "../src/features/inspector/factEditing.js";
import { validCompoundFieldName } from "../src/features/inspector/dataKeyEditing.js";

const state = () => useEditorStore.getState();
const doc = () => structuredClone(baselineDocument);

function fill<T extends { uuid: string; id: string }>(
    entries: T[],
    count: number,
) {
    const source = entries[0]!;
    while (entries.length < count)
        entries.push({
            ...structuredClone(source),
            uuid: crypto.randomUUID(),
            id: `bounds:entry-${entries.length}`,
        });
}

beforeEach(() => {
    vi.stubGlobal("window", new EventTarget());
    state().resetDraft();
});
afterEach(() => vi.unstubAllGlobals());

describe("authoring uses runtime limits instead of library-size assumptions", () => {
    it("uses Kotlin's nonblank semantics for compound keys", () => {
        expect(validCompoundFieldName("\ufeff")).toBe(true);
        expect(validCompoundFieldName("\u00a0")).toBe(false);
        expect(validCompoundFieldName("\u001c")).toBe(false);
        expect(validCompoundFieldName("x".repeat(128))).toBe(true);
        expect(validCompoundFieldName("x".repeat(129))).toBe(false);
    });
    it("creates a schema and key beyond the former library caps with undo", () => {
        const document = doc();
        fill(document.dataSchemas, 256);
        const schema = document.dataSchemas[0]!;
        fill(schema.keys, 512);
        state().setDocument(document);
        addSchema();
        expect(state().document.dataSchemas).toHaveLength(257);
        addKey(schema.uuid);
        expect(state().document.dataSchemas[0]!.keys).toHaveLength(513);
        state().undo();
        expect(state().document.dataSchemas[0]!.keys).toHaveLength(512);
    });

    it("creates themes, layouts and formats beyond the former caps", () => {
        const document = doc();
        fill(document.themes, 256);
        fill(document.layouts, 256);
        fill(document.formats, 512);
        state().setDocument(document);
        addThemeLayout("themes");
        addThemeLayout("layouts");
        addPresentationEntry("formats");
        expect(state().document.themes).toHaveLength(257);
        expect(state().document.layouts).toHaveLength(257);
        expect(state().document.formats).toHaveLength(513);
    });

    it("retains the real viewer-fact hard limit", () => {
        const document = doc();
        fill(document.viewerFacts, 256);
        state().setDocument(document);
        addPresentationEntry("facts");
        expect(state().document.viewerFacts).toHaveLength(256);
    });

    it("adds locales beyond 128 and preserves long semantic identities", () => {
        let document = doc();
        for (let index = document.locales.length; index < 128; index++)
            document = addLocale(document, `en_us_x${index}`);
        document = addLocale(document, "en_us_next");
        expect(document.locales).toHaveLength(129);
        const id = "a".repeat(180);
        expect(assetIdError(document, "glyphs", "", id)).toBeNull();
        expect(layoutNameError(id, [])).toBeNull();
        expect(semanticRoleError(id, [])).toBeNull();
        expect(providerError(id, [])).toBeNull();
        expect(freshSemanticId(id, new Set([id]))).toBe(`${id}-2`);
    });
});
