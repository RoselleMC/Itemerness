import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readFontMetricsArtifact } from "@itemerness/mc-assets";
import {
    composeLocalPreview,
    layoutTooltip,
    PresentationFonts,
} from "@itemerness/mc-render";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import type { PreviewViewer } from "@itemerness/protocol";
import {
    canvasAnchorOrigin,
    draggedCanvasAnchor,
} from "../src/features/stage/canvasAnchorGeometry.js";

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
    requestedTheme: null,
    assetProfile: "itemerness:example-pack-v1",
    metricsRevision: "itemerness:example-pack-v1",
    capabilities: [
        "itemerness:native-tooltip-style-v1",
        "itemerness:bitmap-canvas-v1",
        "itemerness:signed-advance-v1",
    ],
    resourcePackLoaded: true,
    managesVanillaTooltipLines: true,
    direction: "LEFT_TO_RIGHT",
};
function fixture() {
    const document = structuredClone(baselineDocument);
    const theme = document.themes.find(
        (entry) => entry.renderer === "BITMAP_CANVAS",
    )!;
    const layout = document.layouts.find((entry) => entry.kind === "canvas")!;
    if (layout.kind !== "canvas") throw new Error("Expected canvas layout");
    const fonts = new PresentationFonts({
        artifact,
        fonts: document.fonts,
        glyphs: document.glyphs,
        spacing: document.spacing,
    });
    const render = () =>
        composeLocalPreview({
            document,
            itemId: "itemerness:survey-codex",
            viewer,
            fonts,
        });
    return { document, theme, layout, fonts, render };
}

describe("canvas anchor authoring geometry", () => {
    it("includes the name gap, text ascent and normalized bitmap origin", () => {
        const { document, theme, layout, fonts, render } = fixture();
        const preview = render();
        const geometry = layoutTooltip(
            [preview.display.displayName, ...preview.display.lore],
            fonts,
        );
        const origin = canvasAnchorOrigin(document, theme, fonts, geometry);
        expect(origin).toEqual({ x: 12, y: 27 });
        const region = preview.canvasElements!.find(
            (entry) => entry.anchor === "region",
        )!;
        expect(origin.y + layout.anchors.region!.y).toBe(
            geometry.contentOriginPixels.y +
                geometry.components[1]!.baselineY +
                region.visualBounds.top,
        );
    });

    it("uses the raw canvas baseline when normalization is disabled", () => {
        const { document, theme, fonts, render } = fixture();
        const preview = render();
        const geometry = layoutTooltip(
            [preview.display.displayName, ...preview.display.lore],
            fonts,
        );
        theme.canvas!.normalizeVisualOrigin = false;
        expect(canvasAnchorOrigin(document, theme, fonts, geometry)).toEqual({
            x: 12,
            y: 31,
        });
        theme.canvas!.normalizeVisualOrigin = true;
        theme.canvas!.layers = [];
        expect(canvasAnchorOrigin(document, theme, fonts, geometry)).toEqual({
            x: 12,
            y: 31,
        });
    });

    it("reports the same invalid grid phase until the anchor is moved or enlarged", () => {
        const { layout, render } = fixture();
        expect(render().display.renderer).toBe("BITMAP_CANVAS");
        layout.anchors.region!.y = 40;
        expect(render().display.fallbackReasons).toContainEqual(
            expect.objectContaining({
                theme: "itemerness:aurora-canvas",
                code: "LAYOUT_OVERFLOW",
            }),
        );
        layout.anchors.region!.height = 16;
        expect(render().display.renderer).toBe("BITMAP_CANVAS");
        layout.anchors.region!.height = 10;
        layout.anchors.region!.y = 56;
        expect(render().display.renderer).toBe("BITMAP_CANVAS");
    });

    it("preserves authored sub-line phases and permits every integer pixel", () => {
        const origin = { x: 18, y: 36, width: 9 };
        expect(draggedCanvasAnchor(origin, "move", 0, 0)).toEqual({
            x: 18,
            y: 36,
        });
        expect(draggedCanvasAnchor(origin, "move", 2, 4)).toEqual({
            x: 20,
            y: 40,
        });
        expect(draggedCanvasAnchor(origin, "move", 0, 20)).toEqual({
            x: 18,
            y: 56,
        });
        expect(draggedCanvasAnchor(origin, "resize", 0, 0)).toEqual({
            width: 9,
        });
        expect(draggedCanvasAnchor(origin, "resize", -8, 0)).toEqual({
            width: 1,
        });
    });
});
