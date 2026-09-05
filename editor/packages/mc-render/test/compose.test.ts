import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readFontMetricsArtifact } from "@itemerness/mc-assets";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import type { PreviewViewer } from "@itemerness/protocol";
import { PresentationFonts } from "../src/fonts.js";
import { composeLocalPreview, resolveTheme } from "../src/compose.js";

const artifact = readFontMetricsArtifact(
    new Uint8Array(
        readFileSync(
            fileURLToPath(
                new URL(
                    "../../../../itemerness-bukkit/src/main/resources/META-INF/itemerness/font-metrics/minecraft-1.21.11.ifm",
                    import.meta.url,
                ),
            ),
        ),
    ),
);

const fonts = new PresentationFonts({
    artifact,
    fonts: baselineDocument.fonts,
    glyphs: baselineDocument.glyphs,
    spacing: baselineDocument.spacing,
});

const viewer = (overrides: Partial<PreviewViewer> = {}): PreviewViewer => ({
    locale: "en_us",
    requestedTheme: null,
    assetProfile: null,
    capabilities: [],
    metricsRevision: null,
    resourcePackLoaded: false,
    managesVanillaTooltipLines: false,
    direction: "LEFT_TO_RIGHT",
    ...overrides,
});

const packViewer = viewer({
    resourcePackLoaded: true,
    managesVanillaTooltipLines: true,
    capabilities: [
        "itemerness:native-tooltip-style-v1",
        "itemerness:segmented-frame-v1",
        "itemerness:signed-advance-v1",
        "itemerness:bitmap-canvas-v1",
    ],
});

const visibleText = (runs: readonly { text: string; kind: string }[]) =>
    runs
        .filter((run) => run.kind !== "SPACING" && run.kind !== "WIDTH_ANCHOR")
        .map((run) => run.text)
        .join("");

describe("resolveTheme", () => {
    it("falls back to a pack-free theme when no pack is loaded", () => {
        const result = resolveTheme(
            baselineDocument,
            "itemerness:aurora-canvas",
            viewer(),
        );
        // The chain stops at vanilla-frame: it needs no pack and only claims the lines Itemerness
        // manages, so there is no reason to drop all the way to plain.
        expect(result.theme!.id).toBe("itemerness:vanilla-frame");
        expect(result.chain).toEqual([
            "itemerness:aurora-canvas",
            "itemerness:ember",
            "itemerness:vanilla-frame",
        ]);
        expect(result.reasons[0]!.code).toBe("RESOURCE_PACK_UNAVAILABLE");
    });

    it("keeps the requested theme when the viewer has every capability", () => {
        expect(
            resolveTheme(
                baselineDocument,
                "itemerness:aurora-canvas",
                packViewer,
            ).theme!.id,
        ).toBe("itemerness:aurora-canvas");
    });

    it("rejects a require-managed theme when vanilla lines are not managed", () => {
        const result = resolveTheme(
            baselineDocument,
            "itemerness:segmented",
            viewer({
                resourcePackLoaded: true,
                capabilities: ["itemerness:segmented-frame-v1"],
            }),
        );
        expect(result.reasons[0]!.code).toBe("UNMANAGED_TOOLTIP_LINES");
        expect(result.theme!.id).toBe("itemerness:vanilla-frame");
    });
});

describe("composeLocalPreview", () => {
    it("renders the ember blade with formatted values and a resolved condition", () => {
        const preview = composeLocalPreview({
            document: baselineDocument,
            itemId: "itemerness:ember-blade",
            viewer: packViewer,
            fonts,
        });
        const text = preview.display.lore
            .map((line) => visibleText(line.runs))
            .join("\n");
        expect(preview.display.displayName.runs[0]!.text).toBe("Ember Blade");
        expect(text).toContain("Attack Damage: 38.5");
        expect(text).toContain("Quality: Rare");
        // example:level is 8 and the item requires 12, so the unmet branch is taken.
        expect(text).toContain("Required Level: 12");
        const requirement = preview.display.lore.find((line) =>
            line.runs.some((run) => run.text.includes("12")),
        )!;
        expect(
            requirement.runs.find((run) => run.text === "12")!.style.color,
        ).toBe(0xff6961);
    });

    it("matches the server equipment geometry before the agent preview arrives", () => {
        const preview = composeLocalPreview({
            document: baselineDocument,
            itemId: "itemerness:ember-blade",
            viewer: { ...packViewer, locale: "zh_cn" },
            fonts,
        });
        const fieldLines = preview.display.lore.filter((line) =>
            line.runs.some((run) =>
                ["攻击伤害: ", "品质: ", "需求等级: ", "插槽: "].includes(
                    run.text,
                ),
            ),
        );
        expect(fieldLines).toHaveLength(5);
        expect(
            fieldLines.every((line) => line.logicalWidthPixels === 220),
        ).toBe(true);

        const iconGaps = fieldLines.flatMap((line) =>
            line.runs.flatMap((run, index) =>
                run.kind === "ICON" ? [line.runs[index + 1]] : [],
            ),
        );
        expect(iconGaps).toHaveLength(4);
        expect(
            iconGaps.every(
                (run) =>
                    run?.kind === "SPACING" &&
                    run.style.font === "itemerness:spacing" &&
                    run.text.codePointAt(0) === 0xe402,
            ),
        ).toBe(true);

        const firstDescription = preview.display.lore.findIndex((line) =>
            visibleText(line.runs).includes("余烬灰"),
        );
        expect(firstDescription).toBeGreaterThan(0);
        expect(preview.display.lore[firstDescription - 1]!.runs).toHaveLength(
            0,
        );
    });

    it("builds the local character frame at one exact width", () => {
        const preview = composeLocalPreview({
            document: baselineDocument,
            itemId: "itemerness:framed-relic",
            viewer: {
                ...packViewer,
                locale: "zh_cn",
                requestedTheme: "itemerness:vanilla-frame",
            },
            fonts,
        });
        const texts = preview.display.lore.map((line) =>
            visibleText(line.runs),
        );
        expect(texts[0]!.startsWith("┌")).toBe(true);
        expect(texts.at(-1)!.endsWith("┘")).toBe(true);
        expect(
            new Set(preview.display.lore.map((line) => line.logicalWidthPixels))
                .size,
        ).toBe(1);
    });

    it("switches language without touching the document", () => {
        const preview = composeLocalPreview({
            document: baselineDocument,
            itemId: "itemerness:ember-blade",
            viewer: { ...packViewer, locale: "zh_cn" },
            fonts,
        });
        expect(preview.display.displayName.runs[0]!.text).toBe("余烬之刃");
        expect(preview.display.displayName.logicalWidthPixels).toBeGreaterThan(
            0,
        );
    });

    it("expands a repeat block once per list element", () => {
        const preview = composeLocalPreview({
            document: baselineDocument,
            itemId: "itemerness:ember-blade",
            viewer: packViewer,
            fonts,
        });
        const sockets = preview.display.lore.filter((line) =>
            line.runs.some((run) => run.text.startsWith("Socket")),
        );
        expect(sockets).toHaveLength(2);
        expect(visibleText(sockets[1]!.runs)).toContain("Socket: Empty");
    });

    it("builds a canvas with signed spacing and a width anchor", () => {
        const preview = composeLocalPreview({
            document: baselineDocument,
            itemId: "itemerness:survey-codex",
            viewer: packViewer,
            fonts,
        });
        expect(preview.display.renderer).toBe("BITMAP_CANVAS");
        expect(preview.display.tooltipStyle).toBe(
            "itemerness:transparent-canvas",
        );
        expect(preview.display.lore.length).toBeGreaterThanOrEqual(10);
        const first = preview.display.lore[0]!;
        expect(first.runs.some((run) => run.kind === "WIDTH_ANCHOR")).toBe(
            true,
        );
        // The width anchor exists precisely so the canvas measures its declared width rather than
        // collapsing to whatever the negative spacing left behind.
        expect(first.logicalWidthPixels).toBe(176);
    });

    it("falls back to a resource-pack-free theme and records why when nothing is mounted", () => {
        const preview = composeLocalPreview({
            document: baselineDocument,
            itemId: "itemerness:survey-codex",
            viewer: viewer(),
            fonts,
        });
        expect(preview.display.renderer).toBe("VANILLA_CHARACTER_FRAME");
        expect(preview.display.selectedTheme).toBe("itemerness:vanilla-frame");
        expect(preview.display.tooltipStyle).toBeNull();
        expect(
            preview.display.fallbackReasons.map((reason) => reason.code),
        ).toContain("RESOURCE_PACK_UNAVAILABLE");
    });

    it("reports an unknown item instead of rendering nothing silently", () => {
        const preview = composeLocalPreview({
            document: baselineDocument,
            itemId: "itemerness:does-not-exist",
            viewer: viewer(),
            fonts,
        });
        expect(preview.diagnostics[0]!.code).toBe("ITEM.UNKNOWN");
    });
});

describe("composeSegmentedFrame", () => {
    const compose = (tier: string) =>
        composeLocalPreview({
            document: baselineDocument,
            itemId: "itemerness:ember-blade",
            viewer: {
                ...packViewer,
                requestedTheme: `itemerness:quality-${tier}`,
            },
            fonts,
        });

    const glyph = (id: string) =>
        baselineDocument.glyphs.find((entry) => entry.id === id)!;

    it("draws the quality ladder through the segmented renderer", () => {
        const preview = compose("legendary");
        expect(preview.display.renderer).toBe("SEGMENTED_FRAME");
        expect(preview.display.selectedTheme).toBe(
            "itemerness:quality-legendary",
        );
        // The pieces carry their own panel, so vanilla's background is blanked rather than left to
        // show as a second border around the frame.
        expect(preview.display.tooltipStyle).toBe(
            "itemerness:transparent-canvas",
        );
        expect(
            preview.diagnostics.filter((entry) => entry.severity === "ERROR"),
        ).toEqual([]);
    });

    it("kerns each piece so the fill tiles one pixel at a time", () => {
        // Minecraft advances a bitmap glyph one pixel past its ink, so a 1px fill would otherwise
        // step 2px and leave a gap at every seam -- a dashed break in the frame's highlight line.
        expect(glyph("frame.legendary.top-fill").advancePixels).toBe(2);
        expect(glyph("frame.kern.minus-one").advancePixels).toBe(-1);
        expect(
            glyph("frame.legendary.top-fill").advancePixels +
                glyph("frame.kern.minus-one").advancePixels,
        ).toBe(1);
    });

    it("gives the name row, the body rows and the bottom border one identical width", () => {
        for (const tier of ["common", "legendary", "corruption"]) {
            const preview = compose(tier);
            const widths = new Set([
                preview.display.displayName.logicalWidthPixels,
                ...preview.display.lore.map((line) => line.logicalWidthPixels),
            ]);
            expect(widths.size, `${tier} rows disagree on width`).toBe(1);
        }
    });

    it("frames the item name instead of stranding it above the border", () => {
        const preview = compose("legendary");
        const name = preview.display.displayName;
        // The name shares the top row, so it carries the top pieces and its own text. Epic's font
        // is meant to be used this way; without it the name floats outside a frame that has already
        // blanked vanilla's background out from under it.
        const framePieces = name.runs.filter((run) => run.kind === "FRAME");
        expect(framePieces.length).toBeGreaterThan(0);
        expect(
            name.runs.some((run) => run.text.includes("Ember Blade")),
        ).toBe(true);
        // The old shape put a standalone top border at lore[0]; nothing should sit above the name.
        expect(preview.display.lore[0]!.runs.some((run) => run.kind === "TEXT")).toBe(
            true,
        );
    });

    it("splits the fill around the ornament so it stays centred", () => {
        const preview = compose("legendary");
        const bottom = preview.display.lore.at(-1)!;
        // left, fill, center, fill, right -- each piece already carries its kern.
        expect(bottom.runs).toHaveLength(5);
        const kernedLength = (run: { text: string }) => run.text.length / 2;
        const leading = kernedLength(bottom.runs[1]!);
        const trailing = kernedLength(bottom.runs[3]!);
        expect(Math.abs(leading - trailing)).toBeLessThanOrEqual(1);
        // The odd pixel biases left, matching PresentationEngine.frameStrip.
        expect(leading).toBeGreaterThanOrEqual(trailing);
    });

    it("rewinds over the fill so body text sits on the panel", () => {
        const preview = compose("legendary");
        const body = preview.display.lore[1]!;
        const rewind = body.runs.find(
            (run) =>
                run.kind === "SPACING" &&
                fonts.spacingAdvance(run.text.codePointAt(0)!)! < 0,
        );
        expect(rewind, "body row never rewinds over its fill").toBeDefined();
    });

    it("has no ornament on the body row, whose art is shared across tiers", () => {
        for (const tier of ["common", "legendary", "corruption"]) {
            const theme = baselineDocument.themes.find(
                (entry) => entry.id === `itemerness:quality-${tier}`,
            )!;
            expect(theme.segmentedFrame!.body.center).toBeNull();
            expect(theme.segmentedFrame!.top.center).toBe(
                `frame.${tier}.top-center`,
            );
        }
    });
});
