import { beforeEach, describe, expect, it } from "vitest";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import {
    projectDocumentSchema,
    type BitmapNode,
    type FontNode,
    type GlyphNode,
    type ProjectDocument,
    type ResourcePackBindingNode,
} from "@itemerness/protocol";
import {
    ASSET_KINDS,
    assetError,
    assetReferences,
    bitmapLayerReferences,
    fallbackCycle,
    fontMetricsError,
    freshSemanticId,
    newAsset,
    normalizedFontMetrics,
    removeAsset,
    renameAsset,
    updateAsset,
} from "../src/state/assetLibrary.js";
import { codePointError } from "../src/features/assets/AssetFields.js";
import { spacingError } from "../src/features/assets/ResourcePolicies.js";
import { useEditorStore } from "../src/state/store.js";

const document = () => structuredClone(baselineDocument);
const state = () => useEditorStore.getState();
const font = (id = "test:font"): FontNode => ({
    uuid: crypto.randomUUID(),
    id,
    metrics: "explicit",
    fallback: null,
    fallbackAdvancePixels: null,
    advances: null,
});
const bitmap = (): BitmapNode => ({
    uuid: crypto.randomUUID(),
    id: "test-bitmap",
    texture: "test:font/source.png",
    sourceWidthPixels: 8192,
    sourceHeightPixels: 20,
    renderWidthPixels: 10,
    renderHeightPixels: 10,
    ascentPixels: 10,
    baselineVariant: "test-baseline",
    visualBounds: { left: 0, right: 10, top: -10, bottom: 0 },
});
const glyph = (font: string, bitmap: string | null = null): GlyphNode => ({
    uuid: crypto.randomUUID(),
    id: "test-glyph",
    font,
    bitmap,
    codePoint: 0xe000,
    advancePixels: 10,
    visualBounds: { left: 0, right: 10, top: -10, bottom: 0 },
});

describe("resource declaration factories and validation", () => {
    it("creates fresh bounded identities without inventing image metadata", () => {
        const doc = document();
        for (const kind of ASSET_KINDS) {
            const value = newAsset(doc, kind);
            expect(
                doc[kind].some(
                    (entry) =>
                        entry.uuid === value.uuid || entry.id === value.id,
                ),
            ).toBe(false);
            expect(value.id.length).toBeLessThanOrEqual(256);
        }
        const value = newAsset(doc, "bitmaps") as BitmapNode;
        expect(value.texture).toBeNull();
        expect(value.sourceWidthPixels).toBeNull();
        expect(assetError(doc, "bitmaps", value)).toBe("bitmapSourceRequired");
        const semanticId = "a".repeat(200);
        expect(freshSemanticId(semanticId, new Set([semanticId]))).toBe(
            `${semanticId}-2`,
        );
    });
    it("duplicates glyphs with an unused code point and bindings disabled", () => {
        const doc = document();
        const value = doc.glyphs[0]!;
        expect(
            (newAsset(doc, "glyphs", value) as GlyphNode).codePoint,
        ).not.toBe(value.codePoint);
        const binding = newAsset(
            doc,
            "resourcePackBindings",
        ) as ResourcePackBindingNode;
        expect(
            (
                newAsset(doc, "resourcePackBindings", {
                    ...binding,
                    enabled: true,
                }) as ResourcePackBindingNode
            ).enabled,
        ).toBe(false);
    });
    it("accepts actual metric revisions and rejects unavailable or mismatched builtin tables", () => {
        expect(
            fontMetricsError("test:font", "example:metrics/version-2"),
        ).toBeNull();
        expect(
            fontMetricsError(
                "minecraft:default",
                "builtin:minecraft-default-26.1.2",
            ),
        ).toBeNull();
        expect(fontMetricsError("test:font", "builtin:minecraft-default")).toBe(
            "builtinFontId",
        );
        expect(fontMetricsError("minecraft:default", "builtin:unknown")).toBe(
            "unknownBuiltinMetrics",
        );
    });
    it.each(["1.21.11", "26.1.1", "26.1.2", "26.2"])(
        "accepts both explicit builtin tables for %s",
        (version) => {
            for (const name of ["default", "uniform"]) {
                expect(
                    fontMetricsError(
                        `minecraft:${name}`,
                        `builtin:minecraft-${name}-${version}`,
                    ),
                ).toBeNull();
                expect(
                    fontMetricsError(
                        "test:font",
                        `builtin:minecraft-${name}-${version}`,
                    ),
                ).toBe("builtinFontId");
            }
        },
    );
    it.each(["1.21.10", "26.2.1", "26.1.2-extra"])(
        "rejects unavailable builtin version %s",
        (version) =>
            expect(
                fontMetricsError(
                    "minecraft:default",
                    `builtin:minecraft-default-${version}`,
                ),
            ).toBe("unknownBuiltinMetrics"),
    );
    it("protects fallback chains, duplicate code points and built-in font overrides", () => {
        const doc = document();
        const first = font(),
            second = font("test:second");
        second.fallback = first.id;
        doc.fonts.push(first, second);
        expect(fallbackCycle(doc, "fonts", first.id, second.id)).toBe(true);
        doc.glyphs.push(glyph(first.id));
        const copied = {
            ...doc.glyphs.at(-1)!,
            uuid: crypto.randomUUID(),
            id: "other-glyph",
        };
        expect(assetError(doc, "glyphs", copied)).toBe("duplicateCodePoint");
        expect(
            assetError(doc, "glyphs", { ...copied, font: "minecraft:default" }),
        ).toBe("builtinFontOverrides");
    });
    it.each(["U+D800", "U+DFFF", "U+110000", "-1", "1.2"])(
        "rejects invalid Unicode scalar %s",
        (value) => expect(codePointError(value)).toBe("codePoint"),
    );
    it("accepts decimal and hexadecimal scalar notation", () => {
        expect(codePointError("U+10FFFF")).toBeNull();
        expect(codePointError("0")).toBeNull();
    });
    it("keeps source dimensions and actual visual overhang without clamping", () => {
        const doc = document();
        const value = bitmap();
        value.visualBounds = {
            left: 10000,
            right: 10010,
            top: -10010,
            bottom: -10000,
        };
        expect(assetError(doc, "bitmaps", value)).toBeNull();
        expect(assetError(doc, "bitmaps", { ...value, ascentPixels: 11 })).toBe(
            "ascentRange",
        );
        expect(assetError(doc, "bitmaps", { ...value, texture: null })).toBe(
            "bitmapSourceRequired",
        );
    });
    it("requires enabled binding identity and detects duplicate active pack UUIDs", () => {
        const doc = document();
        const value = newAsset(
            doc,
            "resourcePackBindings",
        ) as ResourcePackBindingNode;
        expect(assetError(doc, "resourcePackBindings", value)).toBeNull();
        expect(
            assetError(doc, "resourcePackBindings", {
                ...value,
                enabled: true,
            }),
        ).toBe("bindingUuid");
        const enabled = {
            ...value,
            enabled: true,
            packId: crypto.randomUUID(),
            sha1: "a".repeat(40),
        };
        doc.resourcePackBindings.push(enabled);
        expect(
            assetError(doc, "resourcePackBindings", {
                ...enabled,
                uuid: crypto.randomUUID(),
                id: "test:duplicate",
            }),
        ).toBe("duplicatePackId");
    });
    it("validates signed spacing cardinality without rewriting either range", () => {
        const value = document().spacing!;
        expect(spacingError(value)).toBeNull();
        const mismatch = {
            ...value,
            negative: {
                ...value.negative,
                lastCodePoint: value.negative.lastCodePoint - 1,
            },
        };
        expect(spacingError(mismatch)).toBe("spacingSize");
        expect(
            spacingError({
                ...value,
                positive: { ...value.positive, minimumAdvancePixels: 0 },
            }),
        ).toBe("spacingAdvances");
    });
});

describe("reference-aware resource mutations", () => {
    it("migrates font references and only its exact derived metrics revision", () => {
        const doc = document(),
            value = font();
        doc.fonts.push(value, {
            ...font("test:fallback-user"),
            fallback: value.id,
        });
        doc.glyphs.push(glyph(value.id));
        doc.themes[0]!.fonts.custom = value.id;
        doc.spacing = { ...doc.spacing!, font: value.id };
        doc.assetProfiles[0]!.metricsRevision = normalizedFontMetrics(value);
        expect(removeAsset(doc, "fonts", value.uuid)).toBe(doc);
        const next = renameAsset(doc, "fonts", value.uuid, "test:renamed/font");
        expect(next.glyphs.at(-1)!.font).toBe("test:renamed/font");
        expect(next.themes[0]!.fonts.custom).toBe("test:renamed/font");
        expect(next.spacing!.font).toBe("test:renamed/font");
        expect(next.assetProfiles[0]!.metricsRevision).toBe(
            "itemerness:explicit/test/renamed/font",
        );
        expect(assetReferences(next, "fonts", value.id)).toHaveLength(0);
        expect(projectDocumentSchema.safeParse(next).success).toBe(true);
    });
    it("renames glyph references across retained segmented frames and canvas layers", () => {
        const doc = document();
        const theme = doc.themes.find((theme) => theme.canvas)!;
        const id = theme.canvas!.layers[0]!.asset;
        const value = doc.glyphs.find((entry) => entry.id === id)!;
        const originalField = doc.items
            .flatMap((item) => item.presentation.blocks)
            .find((block) => block.type === "field")!;
        if (originalField.type !== "field")
            throw new Error("Expected field fixture");
        doc.items[0]!.presentation.blocks = [
            {
                uuid: crypto.randomUUID(),
                type: "conditional",
                style: null,
                anchor: null,
                condition: {
                    operator: "EQUALS",
                    left: { kind: "fact", key: "itemerness:locale" },
                    right: { kind: "fact", key: "itemerness:locale" },
                },
                thenBlocks: [],
                otherwiseBlocks: [
                    { ...originalField, uuid: crypto.randomUUID(), icon: id },
                ],
            },
        ];
        const next = renameAsset(doc, "glyphs", value.uuid, "changed-glyph");
        expect(
            next.themes.find((entry) => entry.uuid === theme.uuid)!.canvas!
                .layers[0]!.asset,
        ).toBe("changed-glyph");
        expect(assetReferences(next, "glyphs", id)).toHaveLength(0);
        const conditional = next.items[0]!.presentation.blocks[0]!;
        expect(
            conditional.type === "conditional" &&
                conditional.otherwiseBlocks[0]!.type === "field" &&
                conditional.otherwiseBlocks[0]!.icon,
        ).toBe("changed-glyph");
        expect(removeAsset(doc, "glyphs", value.uuid)).toBe(doc);
    });
    it("protects and atomically renames optional center and kern references in retained frames", () => {
        const doc = document();
        const theme = doc.themes.find((entry) => entry.segmentedFrame)!;
        const glyph = doc.glyphs[0]!;
        theme.renderer = "PLAIN";
        theme.segmentedFrame!.top.center = glyph.id;
        theme.segmentedFrame!.body.kern = glyph.id;
        expect(removeAsset(doc, "glyphs", glyph.uuid)).toBe(doc);
        const renamed = renameAsset(
            doc,
            "glyphs",
            glyph.uuid,
            "test.decorative-part",
        );
        const frame = renamed.themes.find(
            (entry) => entry.uuid === theme.uuid,
        )!.segmentedFrame!;
        expect(frame.top.center).toBe("test.decorative-part");
        expect(frame.body.kern).toBe("test.decorative-part");
        expect(frame.bottom).not.toHaveProperty("center");
        expect(frame.bottom).not.toHaveProperty("kern");
        expect(assetReferences(renamed, "glyphs", glyph.id)).toHaveLength(0);
    });
    it("renames bitmap references and baseline variants in one mutation", () => {
        const doc = document();
        const theme = doc.themes.find((theme) => theme.canvas)!;
        const layer = theme.canvas!.layers[0]!;
        const ref = doc.glyphs.find((entry) => entry.id === layer.asset)!;
        const value = doc.bitmaps.find((entry) => entry.id === ref.bitmap)!;
        const renamed = renameAsset(
            doc,
            "bitmaps",
            value.uuid,
            "changed-bitmap",
        );
        expect(
            renamed.glyphs.find((entry) => entry.uuid === ref.uuid)!.bitmap,
        ).toBe("changed-bitmap");
        for (const baselineVariant of [
            "next-variant",
            "",
            "custom baseline / 1",
        ]) {
            const updated = updateAsset(
                doc,
                "bitmaps",
                value.uuid,
                (source) => ({
                    ...source,
                    baselineVariant,
                }),
            );
            expect(
                updated.themes.find((entry) => entry.uuid === theme.uuid)!
                    .canvas!.layers[0]!.baselineVariant,
            ).toBe(baselineVariant);
            expect(projectDocumentSchema.safeParse(updated).success).toBe(true);
        }
        expect(bitmapLayerReferences(doc, value.id)).toContain(theme.id);
    });
    it("migrates profile references including retained namespaced fact values but not arbitrary STRING values", () => {
        const doc = document(),
            profile = doc.assetProfiles[0]!;
        const fact = doc.viewerFacts.find(
            (entry) => entry.id === "itemerness:asset-profile",
        )!;
        fact.type = "STRING";
        fact.defaultValue = { kind: "string", value: profile.id };
        fact.extensions = {
            private: { untouched: true },
            editorFactTypes: {
                NAMESPACED_KEY: {
                    defaultValue: { kind: "string", value: profile.id },
                    previewValue: { kind: "string", value: profile.id },
                    unknown: 4,
                },
            },
        };
        const next = renameAsset(
            doc,
            "assetProfiles",
            profile.uuid,
            "test:profile",
        );
        const changed = next.viewerFacts.find(
            (entry) => entry.uuid === fact.uuid,
        )!;
        expect(changed.defaultValue).toEqual(fact.defaultValue);
        expect(changed.extensions).toEqual({
            private: { untouched: true },
            editorFactTypes: {
                NAMESPACED_KEY: {
                    defaultValue: { kind: "string", value: "test:profile" },
                    previewValue: { kind: "string", value: "test:profile" },
                    unknown: 4,
                },
            },
        });
    });
    it("keeps inactive tooltip references and unknown renderer state intact", () => {
        const doc = document(),
            style = doc.tooltipStyles[0]!;
        doc.themes[0]!.extensions = {
            custom: 1,
            editorRendererState: { tooltipStyle: style.id, unknown: true },
        };
        expect(removeAsset(doc, "tooltipStyles", style.uuid)).toBe(doc);
        const next = renameAsset(
            doc,
            "tooltipStyles",
            style.uuid,
            "test:tooltip",
        );
        expect(next.themes[0]!.extensions).toEqual({
            custom: 1,
            editorRendererState: {
                tooltipStyle: "test:tooltip",
                unknown: true,
            },
        });
    });
});

describe("asset selection and document history", () => {
    beforeEach(() => {
        state().resetDraft();
        state().setDocument(document());
    });
    it("reconciles removed entries and restores their selection on undo", () => {
        const value = font();
        state().updateDocument((doc) => ({
            ...doc,
            fonts: [...doc.fonts, value],
        }));
        state().selectAsset("fonts", value.uuid);
        state().updateDocument((doc) => removeAsset(doc, "fonts", value.uuid));
        expect(state().selectedAssetUuid).not.toBe(value.uuid);
        state().undo();
        expect(state().selectedAssetUuid).toBe(value.uuid);
        expect(state().document.fonts.at(-1)!.id).toBe(value.id);
        expect(state().persistenceDocument).toBe(state().document);
    });
    it("restores complete resource references in one undo and clears resource selection on disconnect", () => {
        const value = state().document.glyphs[0]!;
        state().selectAsset("glyphs", value.uuid);
        const before = state().snapshotHash;
        state().updateDocument((doc: ProjectDocument) =>
            renameAsset(doc, "glyphs", value.uuid, "renamed-resource"),
        );
        state().undo();
        expect(state().snapshotHash).toBe(before);
        state().resetDraft();
        expect(state().selectedAssetKind).toBe("fonts");
        expect(state().selectedAssetUuid).toBeNull();
    });
});
