import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
    FontLibrary,
    loadSprite,
    mountArchive,
    PackStack,
    rasterPixel,
    readFontMetricsArtifact,
    VANILLA_TOOLTIP_SPRITES,
} from "@itemerness/mc-assets";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import type { PreviewLine, PreviewRun } from "@itemerness/protocol";
import {
    PresentationFonts,
    measureLine,
    renderTooltip,
    type SpriteOp,
} from "../src/index.js";

const bundle = fileURLToPath(
    new URL("../../../vanilla-cache/vanilla-26.1.2.zip", import.meta.url),
);
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

function alphaAt(ops: readonly SpriteOp[], x: number, y: number): number {
    for (const op of ops) {
        if (
            x < op.x ||
            x >= op.x + op.width ||
            y < op.y ||
            y >= op.y + op.height
        )
            continue;
        const sx =
            op.sourceX + Math.floor(((x - op.x) / op.width) * op.sourceWidth);
        const sy =
            op.sourceY + Math.floor(((y - op.y) / op.height) * op.sourceHeight);
        return op.image.data[(sy * op.image.width + sx) * 4 + 3]!;
    }
    return 0;
}

describe.skipIf(!existsSync(bundle))(
    "26.1.2 tooltip sprite containment",
    () => {
        const stack = existsSync(bundle)
            ? new PackStack([
                  mountArchive(new Uint8Array(readFileSync(bundle)), {
                      name: "vanilla",
                      kind: "vanilla",
                  }),
              ])
            : new PackStack();
        const fonts = new PresentationFonts({
            artifact,
            library: new FontLibrary(stack),
            fonts: baselineDocument.fonts,
            glyphs: baselineDocument.glyphs,
            spacing: baselineDocument.spacing,
        });
        const background = loadSprite(
            stack,
            VANILLA_TOOLTIP_SPRITES.background,
        )!;
        const frame = loadSprite(stack, VANILLA_TOOLTIP_SPRITES.frame)!;

        it.each([
            ["A"],
            [
                "Harbor Travel Token",
                "Consumed when travelling to the recorded region.",
            ],
            ["港口旅行凭证", "前往记录区域时消耗。"],
        ])(
            "keeps normal text and its shadow on the actual background: %s",
            (...texts) => {
                const lines: PreviewLine[] = texts.map((text) => {
                    const runs: PreviewRun[] = [
                        {
                            text,
                            kind: "TEXT",
                            unbreakable: false,
                            style: {
                                font: "minecraft:default",
                                color: 0xffffff,
                                bold: false,
                                italic: false,
                                underlined: false,
                                strikethrough: false,
                            },
                        },
                    ];
                    const measured = measureLine(runs, fonts);
                    return {
                        runs,
                        logicalWidthPixels: measured.logicalWidthPixels,
                        visualBounds: measured.visualBounds,
                    };
                });
                const { geometry, drawList } = renderTooltip(lines, fonts, {
                    backgroundSprite: background,
                    frameSprite: frame,
                });
                const backgrounds = drawList.ops.filter(
                    (op): op is SpriteOp =>
                        op.kind === "sprite" && op.image === background.image,
                );
                let checked = 0;
                for (const op of drawList.ops) {
                    if (op.kind !== "glyph") continue;
                    const raster = op.placed.glyph.raster!;
                    for (let y = 0; y < raster.sourceHeight; y++)
                        for (let x = 0; x < raster.sourceWidth; x++) {
                            if (rasterPixel(raster, x, y)[3] === 0) continue;
                            const dx =
                                op.x +
                                (x + 0.5 - raster.originX) * raster.scale;
                            const dy =
                                op.baselineY -
                                raster.ascent +
                                (y + 0.5) * raster.scale;
                            expect(
                                alphaAt(backgrounds, dx, dy),
                                `ink at ${dx},${dy}, shadow=${op.shadow}`,
                            ).toBeGreaterThanOrEqual(128);
                            checked++;
                        }
                }
                expect(checked).toBeGreaterThan(0);
                expect(geometry.inkOutsideBackground).toBe(false);
                // TooltipRenderUtil expands by 3 padding + 9 sprite margin on each edge.
                expect(drawList.width).toBe(geometry.contentWidthPixels + 24);
                expect(drawList.height).toBe(geometry.contentHeightPixels + 24);
            },
        );
    },
);
