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
                    "../../../../itemerness-bukkit/src/main/resources/META-INF/itemerness/font-metrics/minecraft-26.1.2.ifm",
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
            .map((line) => line.runs.map((run) => run.text).join(""))
            .join("\n");
        expect(preview.display.displayName.runs[0]!.text).toBe("Ember Blade");
        expect(text).toContain("Attack Damage 38.5");
        expect(text).toContain("Quality Rare");
        // example:level is 8 and the item requires 12, so the unmet branch is taken.
        expect(text).toContain("Required Level 12");
        const requirement = preview.display.lore.find((line) =>
            line.runs.some((run) => run.text.includes("12")),
        )!;
        expect(requirement.runs.at(-1)!.style.color).toBe(0xff6961);
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
        expect(sockets[1]!.runs.at(-1)!.text).toBe("Empty");
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
