import { describe, expect, it } from "vitest";
import { baselineDocument } from "../fixtures/baseline.js";
import { contentHash } from "../src/canonical.js";
import {
    emptyProjectDocument,
    projectDocumentSchema,
} from "../src/document.js";

describe("baseline fixture", () => {
    it("validates against the document schema", () => {
        expect(() =>
            projectDocumentSchema.parse(baselineDocument),
        ).not.toThrow();
    });

    it("carries the five bundled example items", () => {
        expect(baselineDocument.items.map((item) => item.id)).toEqual([
            "travel-token",
            "ember-blade",
            "survey-codex",
            "nested-satchel",
            "framed-relic",
        ]);
    });

    it("exercises every theme renderer", () => {
        expect(
            new Set(baselineDocument.themes.map((theme) => theme.renderer)),
        ).toEqual(
            new Set([
                "PLAIN",
                "VANILLA_CHARACTER_FRAME",
                "NATIVE_TOOLTIP_STYLE",
                "SEGMENTED_FRAME",
                "BITMAP_CANVAS",
            ]),
        );
    });

    it("gives every item a theme and layout that exist in the document", () => {
        const themes = new Set(
            baselineDocument.themes.map((theme) => theme.id),
        );
        const layouts = new Set(
            baselineDocument.layouts.map((layout) => layout.id),
        );
        for (const item of baselineDocument.items) {
            expect(themes).toContain(item.presentation.theme);
            expect(layouts).toContain(item.presentation.layout);
        }
    });

    it("keeps every theme fallback chain terminating in a resource-pack-free theme", () => {
        const byId = new Map(
            baselineDocument.themes.map((theme) => [theme.id, theme]),
        );
        for (const theme of baselineDocument.themes) {
            const seen = new Set<string>();
            let current = theme;
            while (current.fallback !== null) {
                expect(seen.has(current.id)).toBe(false);
                seen.add(current.id);
                const next = byId.get(current.fallback);
                expect(
                    next,
                    `missing fallback ${current.fallback}`,
                ).toBeDefined();
                current = next!;
            }
            expect(current.requiresResourcePack).toBe(false);
        }
    });

    it("references only declared glyph assets from themes", () => {
        const glyphIds = new Set(
            baselineDocument.glyphs.map((glyph) => glyph.id),
        );
        for (const theme of baselineDocument.themes) {
            for (const row of [
                theme.segmentedFrame?.top,
                theme.segmentedFrame?.body,
                theme.segmentedFrame?.connector,
                theme.segmentedFrame?.bottom,
            ]) {
                if (!row) continue;
                expect(glyphIds).toContain(row.left);
                expect(glyphIds).toContain(row.fill);
                expect(glyphIds).toContain(row.right);
            }
            for (const layer of theme.canvas?.layers ?? []) {
                expect(glyphIds).toContain(layer.asset);
            }
        }
    });

    it("declares a zh_cn message for every en_us key, so the locale matrix starts complete", () => {
        const english = baselineDocument.locales.find(
            (locale) => locale.locale === "en_us",
        )!;
        const chinese = baselineDocument.locales.find(
            (locale) => locale.locale === "zh_cn",
        )!;
        expect(Object.keys(chinese.messages).sort()).toEqual(
            Object.keys(english.messages).sort(),
        );
    });

    it("hashes deterministically across regenerations", () => {
        const first = contentHash(baselineDocument);
        const second = contentHash(
            projectDocumentSchema.parse(
                JSON.parse(JSON.stringify(baselineDocument)),
            ),
        );
        expect(second).toBe(first);
    });
});

describe("emptyProjectDocument", () => {
    it("produces a valid document", () => {
        const document = emptyProjectDocument(
            "00000000-0000-4000-8000-000000000001",
        );
        expect(document.items).toHaveLength(0);
        expect(document.budgets.maximumWidthPixels).toBe(220);
    });
});
