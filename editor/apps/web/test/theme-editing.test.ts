import { describe, expect, it } from "vitest";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import { themeNodeSchema, type ThemeNode } from "@itemerness/protocol";
import { useEditorStore } from "../src/state/store.js";
import {
    createCanvasLayer,
    initializeThemeGeometry,
    numericThemeError,
    semanticRoleError,
    switchThemeRenderer,
    incompatibleThemeSettings,
} from "../src/features/inspector/themeEditing.js";

describe("theme renderer transitions", () => {
    it.each<ThemeNode["renderer"]>([
        "PLAIN",
        "VANILLA_CHARACTER_FRAME",
        "NATIVE_TOOLTIP_STYLE",
        "SEGMENTED_FRAME",
        "BITMAP_CANVAS",
    ])(
        "applies %s requirements without discarding retained settings",
        (renderer) => {
            const source = baselineDocument.themes.find(
                (theme) => theme.renderer === "NATIVE_TOOLTIP_STYLE",
            )!;
            const changed = switchThemeRenderer(source, renderer);
            expect(changed.renderer).toBe(renderer);
            expect(changed.requiresResourcePack).toBe(
                !["PLAIN", "VANILLA_CHARACTER_FRAME"].includes(renderer),
            );
            if (["SEGMENTED_FRAME", "BITMAP_CANVAS"].includes(renderer))
                expect(changed.vanillaTooltipLines).toBe("REQUIRE_MANAGED");
            if (renderer === "VANILLA_CHARACTER_FRAME")
                expect(changed.vanillaTooltipLines).toBe(
                    "PRESERVE_OUTSIDE_FRAME",
                );
            expect(changed.content).toEqual(
                renderer === "NATIVE_TOOLTIP_STYLE" ? source.content : null,
            );
            expect(changed.tooltipStyle).toBe(
                [
                    "NATIVE_TOOLTIP_STYLE",
                    "BITMAP_CANVAS",
                    "SEGMENTED_FRAME",
                ].includes(renderer)
                    ? source.tooltipStyle
                    : null,
            );
            expect(changed.fallback).toBe(
                renderer === "PLAIN" ? null : source.fallback,
            );
            expect(themeNodeSchema.safeParse(changed).success).toBe(true);
        },
    );

    it("records the coupled transition as one document undo step", () => {
        const store = useEditorStore.getState();
        store.resetDraft();
        store.setDocument(structuredClone(baselineDocument));
        const original = useEditorStore.getState().document;
        const theme = original.themes[0]!;
        store.updateTheme(theme.uuid, (current) =>
            switchThemeRenderer(current, "BITMAP_CANVAS"),
        );
        expect(useEditorStore.getState().persistenceDocument).toBe(
            useEditorStore.getState().document,
        );
        useEditorStore.getState().undo();
        expect(useEditorStore.getState().document).toEqual(original);
        expect(useEditorStore.getState().canUndo).toBe(false);
    });

    it("stores forbidden plain fields separately and restores them without dropping unknown extensions", () => {
        const source = {
            ...baselineDocument.themes.find(
                (theme) => theme.renderer === "NATIVE_TOOLTIP_STYLE",
            )!,
            extensions: {
                futureSetting: { revision: 2 },
                editorRendererState: { futureFlag: "keep" },
            },
        };
        const plain = switchThemeRenderer(source, "PLAIN");
        expect(plain.fallback).toBeNull();
        expect(plain.tooltipStyle).toBeNull();
        expect(plain.extensions).toEqual({
            futureSetting: { revision: 2 },
            editorRendererState: {
                futureFlag: "keep",
                fallback: source.fallback,
                tooltipStyle: source.tooltipStyle,
                content: source.content,
            },
        });
        const restored = switchThemeRenderer(plain, "NATIVE_TOOLTIP_STYLE");
        expect(restored.fallback).toBe(source.fallback);
        expect(restored.tooltipStyle).toBe(source.tooltipStyle);
        expect(restored.content).toEqual(source.content);
        expect(restored.extensions).toEqual(plain.extensions);
        expect(switchThemeRenderer(plain, "PLAIN").extensions).toEqual(
            plain.extensions,
        );
    });

    it("normalizes only on explicit mutation and retains legacy content exact metrics and bidi values", () => {
        const original = baselineDocument.themes.find(
            (theme) => theme.renderer === "VANILLA_CHARACTER_FRAME",
        )!;
        const source = {
            ...original,
            content: baselineDocument.themes.find((theme) => theme.content)!
                .content,
            requireExactFontMetrics: true,
            characterFrame: {
                ...original.characterFrame!,
                fallbackBidirectionalText: false,
            },
            extensions: {
                editorRendererState: { opaque: "keep" },
                vendor: true,
            },
        };
        expect(incompatibleThemeSettings(source)).toEqual([
            "content",
            "requireExactFontMetrics",
            "fallbackBidirectionalText",
        ]);
        const normalized = switchThemeRenderer(source, source.renderer);
        expect(normalized.content).toBeNull();
        expect(normalized.requireExactFontMetrics).toBe(false);
        expect(normalized.characterFrame?.fallbackBidirectionalText).toBe(true);
        expect(normalized.extensions).toMatchObject({
            vendor: true,
            editorRendererState: {
                opaque: "keep",
                content: source.content,
                requireExactFontMetrics: true,
                characterFallbackBidirectionalText: false,
            },
        });
        expect(source.content).not.toBeNull();
        expect(source.characterFrame.fallbackBidirectionalText).toBe(false);
        expect(
            switchThemeRenderer(normalized, "NATIVE_TOOLTIP_STYLE").content,
        ).toEqual(source.content);
        expect(
            switchThemeRenderer(normalized, "BITMAP_CANVAS")
                .requireExactFontMetrics,
        ).toBe(true);
        expect(incompatibleThemeSettings(normalized)).toEqual([]);
    });
});

describe("explicit theme geometry", () => {
    it.each(["content", "characterFrame", "canvas"] as const)(
        "initializes %s within effective budgets without replacing existing settings",
        (kind) => {
            const document = structuredClone(baselineDocument);
            document.budgets.maximumWidthPixels = 100;
            document.budgets.maximumHeightPixels = 50;
            document.budgets.maximumLines = 4;
            const source = { ...document.themes[0]!, [kind]: null };
            const initialized = initializeThemeGeometry(source, document, kind);
            expect(initialized[kind]).not.toBeNull();
            expect(themeNodeSchema.safeParse(initialized).success).toBe(true);
            expect(initializeThemeGeometry(initialized, document, kind)).toBe(
                initialized,
            );
            if (kind === "canvas") {
                expect(initialized.canvas!.widthPixels).toBe(100);
                expect(initialized.canvas!.heightPixels).toBe(50);
                expect(initialized.canvas!.reserveTooltipLines).toBe(4);
                expect(initialized.canvas!.layers).toEqual([]);
            }
        },
    );

    it("requires real frame/spacing assets rather than inventing references", () => {
        const document = structuredClone(baselineDocument);
        const theme = {
            ...document.themes[0]!,
            segmentedFrame: null,
            canvas: null,
        };
        document.spacing = null;
        expect(initializeThemeGeometry(theme, document, "segmentedFrame")).toBe(
            theme,
        );
        expect(initializeThemeGeometry(theme, document, "canvas")).toBe(theme);
        const configured = baselineDocument.themes.find(
            (entry) => entry.renderer === "SEGMENTED_FRAME",
        )!;
        const initialized = initializeThemeGeometry(
            { ...configured, segmentedFrame: null },
            baselineDocument,
            "segmentedFrame",
        );
        expect(initialized.segmentedFrame).not.toBeNull();
        expect(
            baselineDocument.glyphs.some(
                (glyph) => glyph.id === initialized.segmentedFrame!.top.left,
            ),
        ).toBe(true);
    });

    it("adds layers only from real bitmap glyphs and applies the manifest baseline", () => {
        const canvas = baselineDocument.themes.find(
            (entry) => entry.canvas,
        )!.canvas!;
        const layer = createCanvasLayer(baselineDocument, canvas)!;
        const glyph = baselineDocument.glyphs.find(
            (entry) => entry.id === layer.asset,
        )!;
        expect(layer.baselineVariant).toBe(
            baselineDocument.bitmaps.find((entry) => entry.id === glyph.bitmap)!
                .baselineVariant,
        );
        expect(
            createCanvasLayer({ ...baselineDocument, glyphs: [] }, canvas),
        ).toBeNull();
        expect(
            createCanvasLayer(
                {
                    ...baselineDocument,
                    budgets: {
                        ...baselineDocument.budgets,
                        maximumCanvasLayers: 1,
                    },
                },
                canvas,
            ),
        ).toBeNull();
    });
});

describe("theme inputs", () => {
    it("rejects incomplete and out-of-range values without clamping them", () => {
        for (const raw of ["", "-", "1.", "4.5", "NaN", "1000"])
            expect(numericThemeError(raw, -8, 8)).toBe(true);
        expect(numericThemeError("-8", -8, 8)).toBe(false);
        expect(numericThemeError("8", -8, 8)).toBe(false);
        expect(semanticRoleError("custom-role", [])).toBeNull();
        expect(semanticRoleError("custom-role", ["custom-role"])).toBe(
            "duplicateRole",
        );
        expect(semanticRoleError("Invalid Role", [])).toBe("invalidRole");
    });
});
