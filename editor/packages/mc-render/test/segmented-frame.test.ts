import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readFontMetricsArtifact } from "@itemerness/mc-assets";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import {
    segmentedFrameCases,
    segmentedFrameDocument,
} from "../../protocol/fixtures/segmented-frame.js";
import {
    projectDocumentSchema,
    contentHash,
    type PreviewViewer,
    type ProjectDocument,
} from "@itemerness/protocol";
import { composeLocalPreview } from "../src/compose.js";
import { PresentationFonts } from "../src/fonts.js";
import { measureLine } from "../src/measure.js";

const artifact = readFontMetricsArtifact(
    new Uint8Array(
        readFileSync(
            new URL(
                "../../../../itemerness-bukkit/src/main/resources/META-INF/itemerness/font-metrics/minecraft-26.1.2.ifm",
                import.meta.url,
            ),
        ),
    ),
);
const viewer: PreviewViewer = {
    locale: "en_us",
    requestedTheme: "itemerness:segmented",
    assetProfile: "itemerness:example-pack-v1",
    metricsRevision: "itemerness:example-pack-v1",
    capabilities: [
        "itemerness:segmented-frame-v1",
        "itemerness:signed-advance-v1",
    ],
    resourcePackLoaded: true,
    managesVanillaTooltipLines: true,
    direction: "LEFT_TO_RIGHT",
};
function render(document = segmentedFrameDocument()) {
    const fonts = new PresentationFonts({
        artifact,
        fonts: document.fonts,
        glyphs: document.glyphs,
        spacing: document.spacing,
    });
    return {
        ...composeLocalPreview({
            document,
            itemId: "itemerness:travel-token",
            viewer,
            fonts,
        }),
        fonts,
    };
}
function theme(document: ProjectDocument) {
    return document.themes.find(
        (entry) => entry.renderer === "SEGMENTED_FRAME",
    )!;
}

describe("optional decorated segmented frames", () => {
    it("preserves old document values and hash when new fields are absent", () => {
        const parsed = projectDocumentSchema.parse(baselineDocument);
        expect(contentHash(parsed)).toBe(contentHash(baselineDocument));
        expect(theme(parsed).segmentedFrame).not.toHaveProperty("includeName");
        expect(theme(parsed).segmentedFrame!.top).not.toHaveProperty("center");
        const { display } = render(parsed);
        expect(
            display.displayName.runs.every((run) => run.kind !== "FRAME"),
        ).toBe(true);
        expect(display.lore[0]!.runs.some((run) => run.kind === "FRAME")).toBe(
            true,
        );
    });

    it("keeps name and body at one content inset despite wider top caps", () => {
        const document = segmentedFrameDocument(),
            { display, fonts, lineOrigins } = render(document);
        expect(display.renderer).toBe("SEGMENTED_FRAME");
        expect(display.tooltipStyle).toBe("itemerness:transparent-canvas");
        const nameGlyph = measureLine(
            display.displayName.runs,
            fonts,
        ).glyphs.find(
            (placed) => placed.glyph.codePoint === "N".codePointAt(0),
        )!;
        const bodyIndex = display.lore.findIndex((line) =>
            line.runs.some((run) => run.text.includes("Body")),
        );
        const bodyGlyph = measureLine(
            display.lore[bodyIndex]!.runs,
            fonts,
        ).glyphs.find(
            (placed) => placed.glyph.codePoint === "B".codePointAt(0),
        )!;
        expect(nameGlyph.x).toBe(6);
        expect(bodyGlyph.x).toBe(nameGlyph.x);
        expect(display.displayName.runs[0]!.kind).toBe("FRAME");
        expect(lineOrigins[bodyIndex]).toBe(
            document.items[0]!.presentation.blocks.find(
                (block) => block.type === "description",
            )!.uuid,
        );
        expect(lineOrigins.at(-1)).toBeNull();
        expect(
            new Set(
                [display.displayName, ...display.lore].map(
                    (line) => line.logicalWidthPixels,
                ),
            ).size,
        ).toBe(1);
    });

    it("keeps frame strips outside name unless explicitly enabled", () => {
        const document = segmentedFrameDocument();
        theme(document).segmentedFrame!.includeName = false;
        const { display, lineOrigins } = render(document);
        expect(
            display.displayName.runs.every((run) => run.kind !== "FRAME"),
        ).toBe(true);
        expect(lineOrigins[0]).toBeNull();
    });

    it("centers ornaments and emits the declared seam kern for every piece", () => {
        const { display, fonts } = render();
        const measured = measureLine(display.displayName.runs, fonts);
        const center = measured.glyphs.find(
            (placed) => placed.glyph.codePoint === 59651,
        )!;
        expect(
            Math.abs(
                center.x + 11 / 2 - display.displayName.logicalWidthPixels / 2,
            ),
        ).toBeLessThanOrEqual(0.5);
        const frameRuns = display.displayName.runs.filter(
            (run) => run.kind === "FRAME",
        );
        const points = [...frameRuns.map((run) => run.text).join("")].map(
            (point) => point.codePointAt(0),
        );
        expect(points.length % 2).toBe(0);
        expect(
            points
                .filter((_point, index) => index % 2 === 1)
                .every((point) => point === 59656),
        ).toBe(true);
    });

    it.each([
        "missing-center",
        "wrong-font-kern",
        "zero-net-fill",
        "visual-budget",
        "height-budget",
        "text-budget",
        "impossible-width",
    ])("falls back without relaxing safety: %s", (failure) => {
        const document = segmentedFrameDocument(),
            frame = theme(document).segmentedFrame!;
        if (failure === "missing-center") frame.top.center = "test.missing";
        if (failure === "wrong-font-kern")
            document.glyphs.find(
                (glyph) => glyph.id === "test.frame.kern",
            )!.font = "itemerness:icons";
        if (failure === "zero-net-fill")
            document.glyphs.find(
                (glyph) => glyph.id === "test.frame.top-fill",
            )!.advancePixels = 1;
        if (failure === "visual-budget")
            document.glyphs.find(
                (glyph) => glyph.id === "test.frame.center",
            )!.visualBounds.right = 500;
        if (failure === "height-budget")
            document.glyphs.find(
                (glyph) => glyph.id === "test.frame.center",
            )!.visualBounds.top = -500;
        if (failure === "text-budget")
            document.budgets.maximumTextCodePoints = 10;
        if (failure === "impossible-width") frame.maximumWidthPixels = 50;
        expect(render(document).display.renderer).not.toBe("SEGMENTED_FRAME");
    });

    const goldenPath = new URL(
        "../../protocol/fixtures/segmented-frame-golden.json",
        import.meta.url,
    );
    it.each(segmentedFrameCases)(
        "matches the production golden: $name",
        ({ name, frame }) => {
            const document = segmentedFrameDocument();
            Object.assign(theme(document).segmentedFrame!, frame);
            const display = render(document).display;
            const actual = {
                displayName: display.displayName,
                lore: display.lore,
                renderer: display.renderer,
                selectedTheme: display.selectedTheme,
                tooltipStyle: display.tooltipStyle,
            };
            expect(actual).toEqual(
                JSON.parse(readFileSync(goldenPath, "utf8"))[name],
            );
        },
    );
});
