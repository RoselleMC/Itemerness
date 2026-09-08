import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readFontMetricsArtifact } from "@itemerness/mc-assets";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import type { PreviewViewer, ProjectDocument } from "@itemerness/protocol";
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
    requestedTheme: null,
    assetProfile: "itemerness:example-pack-v1",
    metricsRevision: "itemerness:example-pack-v1",
    capabilities: [
        "itemerness:native-tooltip-style-v1",
        "itemerness:segmented-frame-v1",
        "itemerness:signed-advance-v1",
        "itemerness:bitmap-canvas-v1",
    ],
    resourcePackLoaded: true,
    managesVanillaTooltipLines: true,
    direction: "LEFT_TO_RIGHT",
};
const cases = JSON.parse(
    readFileSync(
        new URL(
            "../../protocol/fixtures/canvas-layout-cases.json",
            import.meta.url,
        ),
        "utf8",
    ),
) as Array<{
    name: string;
    changes: Array<{ path: Array<string | number>; value: unknown }>;
}>;
const golden = JSON.parse(
    readFileSync(
        new URL(
            "../../protocol/fixtures/canvas-layout-golden.json",
            import.meta.url,
        ),
        "utf8",
    ),
) as Record<string, unknown>;

function fontsFor(document: ProjectDocument) {
    return new PresentationFonts({
        artifact,
        fonts: document.fonts,
        glyphs: document.glyphs,
        spacing: document.spacing,
    });
}
function render(document = structuredClone(baselineDocument)) {
    return composeLocalPreview({
        document,
        itemId: "itemerness:survey-codex",
        viewer,
        fonts: fontsFor(document),
    });
}
function fixture() {
    const document = structuredClone(baselineDocument);
    const layout = document.layouts[2]!;
    if (layout.kind !== "canvas") throw new Error("Expected canvas fixture");
    return {
        document,
        layout,
        canvas: document.themes[4]!.canvas!,
        item: document.items[2]!,
    };
}

describe("cold bitmap canvas compiler parity", () => {
    it.each(cases)(
        "matches the production Kotlin golden: $name",
        ({ name, changes }) => {
            const document = structuredClone(baselineDocument);
            for (const change of changes) {
                let target = document as unknown as Record<
                    string | number,
                    unknown
                >;
                for (const segment of change.path.slice(0, -1))
                    target = target[segment] as Record<
                        string | number,
                        unknown
                    >;
                target[change.path.at(-1)!] = change.value;
            }
            const { display } = render(document);
            expect({
                displayName: display.displayName,
                lore: display.lore,
                renderer: display.renderer,
                selectedTheme: display.selectedTheme,
                tooltipStyle: display.tooltipStyle,
            }).toEqual(golden[name]);
        },
    );

    it("anchors every reserved row and subtracts bitmap width for top-right layers", () => {
        const preview = render();
        expect(preview.display.renderer).toBe("BITMAP_CANVAS");
        expect(preview.display.lore).toHaveLength(10);
        expect(
            preview.display.lore.every(
                (line) => line.logicalWidthPixels === 176,
            ),
        ).toBe(true);
        const glyphs = measureLine(
            preview.display.lore[2]!.runs,
            fontsFor(baselineDocument),
        ).glyphs;
        expect(glyphs.find((glyph) => glyph.run.kind === "BITMAP")!.x).toBe(
            136,
        );
        expect(
            preview.canvasElements?.map((element) => [
                element.anchor,
                element.baselineLine,
            ]),
        ).toEqual([
            ["subtitle", 2],
            ["region", 4],
            ["body", 6],
            ["body", 7],
            ["body", 8],
            ["body", 9],
        ]);
    });

    it("renaming or reordering anchor keys never changes output pixels", () => {
        const { document, layout, item } = fixture();
        const before = render(document);
        const { body, ...others } = layout.anchors;
        layout.anchors = { details: body!, ...others };
        item.presentation.blocks[2]!.anchor = "details";
        const after = render(document);
        expect(after.display).toEqual(before.display);
        expect(after.lineOrigins).toEqual(before.lineOrigins);
        expect(
            after.canvasElements?.filter((entry) => entry.anchor === "details"),
        ).toHaveLength(4);
    });

    it("preserves separate UUIDs when two anchors share a baseline", () => {
        const { document, layout, item } = fixture();
        layout.anchors.region!.y = 16;
        const preview = render(document);
        expect(preview.display.renderer).toBe("BITMAP_CANVAS");
        expect(preview.lineOrigins[2]).toBeNull();
        expect(
            preview.canvasElements
                ?.filter((entry) => entry.baselineLine === 2)
                .map((entry) => entry.origin),
        ).toEqual(
            item.presentation.blocks.slice(0, 2).map((block) => block.uuid),
        );
    });

    it("resolves a conditional child's anchor without inheriting its parent's", () => {
        const { document, item } = fixture();
        const child = item.presentation.blocks[2]!;
        item.presentation.blocks = [
            {
                uuid: "00000000-0000-4000-8000-000000000101",
                type: "conditional",
                style: null,
                anchor: "subtitle",
                condition: {
                    operator: "EXISTS",
                    left: { kind: "data", key: "example:region" },
                    right: null,
                },
                thenBlocks: [child],
                otherwiseBlocks: [],
            },
        ];
        const preview = render(document);
        expect(preview.display.renderer).toBe("BITMAP_CANVAS");
        expect(
            preview.canvasElements?.every(
                (element) =>
                    element.anchor === "body" && element.origin === child.uuid,
            ),
        ).toBe(true);
        child.anchor = null;
        expect(render(document).display.renderer).not.toBe("BITMAP_CANVAS");
    });

    it("keeps every repeat row on its logical UUID and shares anchor capacity", () => {
        const { document, item } = fixture();
        const repeat = structuredClone(
            document.items[1]!.presentation.blocks[3]!,
        );
        repeat.anchor = "body";
        item.presentation.blocks = [repeat];
        item.previewData = structuredClone(document.items[1]!.previewData);
        item.definition.instance.defaults = structuredClone(
            document.items[1]!.definition.instance.defaults,
        );
        const preview = render(document);
        expect(preview.display.renderer).toBe("BITMAP_CANVAS");
        expect(
            preview.canvasElements?.map((entry) => [
                entry.origin,
                entry.baselineLine,
            ]),
        ).toEqual([
            [repeat.uuid, 6],
            [repeat.uuid, 7],
        ]);
    });

    it("falls back atomically for missing anchors and out-of-range baselines", () => {
        const { document, item, canvas } = fixture();
        item.presentation.blocks[0]!.anchor = "missing";
        const missing = render(document);
        expect(missing.display.renderer).not.toBe("BITMAP_CANVAS");
        expect(
            missing.display.lore
                .flatMap((line) => line.runs)
                .some((run) => run.kind === "BITMAP"),
        ).toBe(false);
        item.presentation.blocks[0]!.anchor = "subtitle";
        canvas.layers[0]!.baselineLine = 10;
        expect(render(document).display.renderer).not.toBe("BITMAP_CANVAS");
    });

    it("splits signed spacing across provider ranges", () => {
        const { document } = fixture();
        document.spacing!.positive.maximumAdvancePixels = 32;
        document.spacing!.negative.minimumAdvancePixels = -32;
        const preview = render(document);
        expect(preview.display.renderer).toBe("BITMAP_CANVAS");
        expect(
            preview.display.lore[0]!.runs.filter(
                (run) => run.kind === "WIDTH_ANCHOR",
            ),
        ).toHaveLength(6);
        expect(
            preview.display.lore.every(
                (line) => line.logicalWidthPixels === 176,
            ),
        ).toBe(true);
    });

    it("honors the final-advance rejection flag without silently moving layers", () => {
        const { document, canvas, item } = fixture();
        item.presentation.blocks = [];
        canvas.layers = [canvas.layers[0]!];
        canvas.layers[0]!.xPixels = 20;
        canvas.rejectOutOfBoundsLayer = false;
        expect(render(document).display.renderer).not.toBe("BITMAP_CANVAS");
        canvas.rejectNegativeFinalAdvance = false;
        const allowed = render(document);
        expect(allowed.display.renderer).toBe("BITMAP_CANVAS");
        expect(allowed.display.lore[9]!.logicalWidthPixels).toBe(176);
        expect(allowed.display.lore[9]!.visualBounds.right).toBe(196);
    });

    it("keeps the compiler's independent character-frame content cap", () => {
        const document = structuredClone(baselineDocument);
        const layout = document.layouts[1]!;
        if (layout.kind !== "flow") throw new Error("Expected flow fixture");
        layout.minimumWidthPixels = 80;
        const frameViewer = {
            ...viewer,
            requestedTheme: "itemerness:vanilla-frame",
        };
        const preview = () =>
            composeLocalPreview({
                document,
                itemId: "itemerness:ember-blade",
                viewer: frameViewer,
                fonts: fontsFor(document),
            });
        const before = preview().display;
        layout.maximumWidthPixels = 120;
        const after = preview().display;
        expect(after.renderer).toBe("VANILLA_CHARACTER_FRAME");
        expect(after.lore).toEqual(before.lore);
        expect(
            after.lore.some(
                (line) => line.logicalWidthPixels > layout.maximumWidthPixels,
            ),
        ).toBe(true);
    });
});
