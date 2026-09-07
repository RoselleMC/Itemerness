import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readFontMetricsArtifact } from "@itemerness/mc-assets";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import {
    previewViewerSchema,
    type PreviewDisplay,
    type PreviewLine,
    type ProjectDocument,
} from "@itemerness/protocol";
import { composeLocalPreview } from "../src/compose.js";
import { PresentationFonts } from "../src/fonts.js";

const metrics = readFontMetricsArtifact(
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
const fontsOf = (document: ProjectDocument) =>
    new PresentationFonts({
        artifact: metrics,
        fonts: document.fonts,
        glyphs: document.glyphs,
        spacing: document.spacing,
    });
const viewer = previewViewerSchema.parse({ locale: "en_us" });
const preview = (document = baselineDocument, changes = {}) =>
    composeLocalPreview({
        document,
        itemId: "itemerness:travel-token",
        viewer: { ...viewer, ...changes },
        fonts: fontsOf(document),
    });

describe("cold local frame composition", () => {
    it("draws the segmented frame immediately when its viewer capabilities are present", () => {
        const document = structuredClone(baselineDocument);
        document.items[0]!.presentation.theme = "itemerness:segmented";
        const profile = document.assetProfiles.find(
            (entry) => entry.id === "itemerness:example-pack-v1",
        )!;
        const result = preview(document, {
            resourcePackLoaded: true,
            managesVanillaTooltipLines: true,
            capabilities: profile.capabilities,
            assetProfile: profile.id,
            metricsRevision: profile.metricsRevision,
        });
        expect(result.display.renderer).toBe("SEGMENTED_FRAME");
        expect(
            result.display.lore.every((line) =>
                line.runs.some((run) => run.kind === "FRAME"),
            ),
        ).toBe(true);
        expect(result.lineOrigins[0]).toBeNull();
    });
    it("renders all character-frame presets without a server or warmed cache", () => {
        for (const preset of [
            "UNICODE_SINGLE",
            "UNICODE_DOUBLE",
            "ASCII_SAFE",
            "BRACKETED_SECTION",
            "SEPARATOR_ONLY",
        ] as const) {
            const document = structuredClone(baselineDocument);
            document.themes.find(
                (theme) => theme.id === "itemerness:vanilla-frame",
            )!.characterFrame!.preset = preset;
            const result = preview(document);
            expect(result.display.renderer).toBe("VANILLA_CHARACTER_FRAME");
            expect(
                result.display.lore[0]!.runs.some(
                    (run) => run.kind === "FRAME",
                ),
            ).toBe(true);
            expect(result.lineOrigins[0]).toBeNull();
            expect(result.lineOrigins.at(-1)).toBeNull();
        }
    });
    it("updates geometry and frame colors from the current document immediately", () => {
        const document = structuredClone(baselineDocument);
        const before = preview(document);
        const frame = document.themes.find(
            (theme) => theme.id === "itemerness:vanilla-frame",
        )!;
        frame.styles.frame = {
            color: "red",
            bold: false,
            italic: false,
            underlined: false,
            strikethrough: false,
        };
        frame.characterFrame!.maximumWidthPixels = 120;
        const after = preview(document);
        expect(after.display.renderer).toBe("VANILLA_CHARACTER_FRAME");
        expect(after.display.lore[0]!.logicalWidthPixels).toBeLessThan(
            before.display.lore[0]!.logicalWidthPixels,
        );
        expect(after.display.lore[0]!.runs[0]!.style.color).toBe(0xff5555);
        expect(after.display.lore.length).toBeGreaterThan(
            before.display.lore.length,
        );
    });
    it("falls back safely when frame padding is impossible rather than throwing during a render", () => {
        const document = structuredClone(baselineDocument);
        document.themes.find(
            (theme) => theme.id === "itemerness:vanilla-frame",
        )!.characterFrame!.leftPaddingPixels = 300;
        expect(preview(document).display.renderer).toBe("PLAIN");
        expect(
            preview(document).display.fallbackReasons.some(
                (reason) => reason.code === "LAYOUT_OVERFLOW",
            ),
        ).toBe(true);
    });
});

const audit = fileURLToPath(
    new URL(
        "../../../../build/tooltip-geometry-20260907/plugin-previews.json",
        import.meta.url,
    ),
);
const variantsPath = fileURLToPath(
    new URL(
        "../../../../build/canvas-refresh-20260907/parity.json",
        import.meta.url,
    ),
);
function canonical(line: PreviewLine) {
    return {
        width: line.logicalWidthPixels,
        glyphs: line.runs.flatMap((run) =>
            [...run.text].map((text) => ({
                text,
                kind: run.kind,
                ...run.style,
            })),
        ),
    };
}
describe.skipIf(!existsSync(variantsPath))(
    "production refresh variants",
    () => {
        const records = existsSync(variantsPath)
            ? (JSON.parse(readFileSync(variantsPath, "utf8")) as Array<{
                  label: string;
                  document: ProjectDocument;
                  itemId: string;
                  viewer: typeof viewer;
                  artifact: { display: PreviewDisplay | null };
              }>)
            : [];
        for (const record of records.filter(
            (entry) => entry.artifact.display !== null,
        ))
            it(record.label, () => {
                const actual = composeLocalPreview({
                    document: record.document,
                    itemId: record.itemId,
                    viewer: record.viewer,
                    fonts: fontsOf(record.document),
                }).display;
                const expected = record.artifact.display!;
                expect(actual.renderer).toBe(expected.renderer);
                expect(canonical(actual.displayName)).toEqual(
                    canonical(expected.displayName),
                );
                expect(actual.lore.map(canonical)).toEqual(
                    expected.lore.map(canonical),
                );
            });
    },
);
describe.skipIf(!existsSync(audit))(
    "production compiler cold-preview cross-check",
    () => {
        const evidence = existsSync(audit)
            ? (JSON.parse(readFileSync(audit, "utf8")) as {
                  document: ProjectDocument;
                  previews: {
                      itemId: string;
                      locale: string;
                      artifact: {
                          viewer: typeof viewer;
                          display: PreviewDisplay;
                      };
                  }[];
              })
            : null;
        for (const entry of evidence?.previews ?? []) {
            it(`${entry.itemId} ${entry.locale} agrees before the server reply is used`, () => {
                const result = composeLocalPreview({
                    document: evidence!.document,
                    itemId: entry.itemId,
                    viewer: entry.artifact.viewer,
                    fonts: fontsOf(evidence!.document),
                });
                expect(result.display.renderer).toBe(
                    entry.artifact.display.renderer,
                );
                expect(canonical(result.display.displayName)).toEqual(
                    canonical(entry.artifact.display.displayName),
                );
                expect(result.display.lore.map(canonical)).toEqual(
                    entry.artifact.display.lore.map(canonical),
                );
            });
        }
    },
);
