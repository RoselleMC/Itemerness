/**
 * Dumps the composed segmented-frame tooltips so they can be rasterised and looked at.
 *
 * The unit tests assert the arithmetic — equal row widths, a 1px fill step, a centred ornament —
 * but none of them can tell you the frame actually *looks* right. This writes the run structure to
 * disk for `tools/rasterise-preview.py`, which pastes the real resource-pack pieces and produces a
 * PNG. Skipped unless ITEMERNESS_DUMP_PREVIEW is set, so it stays out of the normal suite.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import { readFontMetricsArtifact } from "@itemerness/mc-assets";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import { PresentationFonts } from "../src/fonts.js";
import { composeLocalPreview } from "../src/compose.js";
import { measureLine } from "../src/measure.js";
import type { PreviewRun } from "@itemerness/protocol";

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

describe.skipIf(!process.env.ITEMERNESS_DUMP_PREVIEW)(
    "segmented frame dump",
    () => {
        it("writes every tier's composed runs", () => {
            const tiers = [
                "common",
                "uncommon",
                "rare",
                "unique",
                "legendary",
                "corruption",
            ];
            const output: Record<string, unknown> = {};
            for (const tier of tiers) {
                const preview = composeLocalPreview({
                    document: baselineDocument,
                    itemId: "itemerness:ember-blade",
                    viewer: {
                        locale: "en_us",
                        requestedTheme: `itemerness:quality-${tier}`,
                        assetProfile: null,
                        capabilities: [
                            "itemerness:segmented-frame-v1",
                            "itemerness:signed-advance-v1",
                        ],
                        metricsRevision: null,
                        resourcePackLoaded: true,
                        managesVanillaTooltipLines: true,
                        direction: "LEFT_TO_RIGHT",
                    },
                    fonts,
                });
                // The rasteriser cannot measure vanilla text itself, so each run carries its own
                // width; without it a text run's stand-in block drifts and appears to overrun the
                // border that is in fact drawn correctly.
                const withWidths = (line: {
                    runs: readonly PreviewRun[];
                    logicalWidthPixels: number;
                }) => ({
                    logicalWidthPixels: line.logicalWidthPixels,
                    runs: line.runs.map((run) => ({
                        ...run,
                        widthPixels: measureLine([run], fonts, { lenient: true })
                            .logicalWidthPixels,
                    })),
                });
                output[tier] = {
                    renderer: preview.display.renderer,
                    selectedTheme: preview.display.selectedTheme,
                    diagnostics: preview.diagnostics,
                    displayName: withWidths(preview.display.displayName),
                    lore: preview.display.lore.map(withWidths),
                };
            }
            const target = fileURLToPath(
                new URL(
                    "../../../../tooltip-frames-work/preview-dump.json",
                    import.meta.url,
                ),
            );
            mkdirSync(fileURLToPath(new URL("../../../../tooltip-frames-work/", import.meta.url)), {
                recursive: true,
            });
            writeFileSync(target, JSON.stringify(output, null, 2), "utf8");
            console.log(`wrote ${target}`);
        });
    },
);
