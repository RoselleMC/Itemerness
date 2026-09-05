/**
 * Cross-language parity for the segmented frame.
 *
 * `composeSegmentedFrame` and `PresentationEngine.renderSegmentedFrame` are two implementations of
 * one layout, and the whole point of the editor is that what it previews is what the client will
 * draw. A unit test can only check the TypeScript half against itself; this sends the live document
 * to the running plugin and compares the runs it composes with the ones composed here.
 *
 * Needs a reachable editor with a connected agent, so it is gated behind ITEMERNESS_PARITY_URL:
 *     ITEMERNESS_PARITY_URL=http://172.20.0.38:8080 npx vitest run segmented-parity
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readFontMetricsArtifact } from "@itemerness/mc-assets";
import { contentHash } from "@itemerness/protocol";
import type { PreviewViewer } from "@itemerness/protocol";
import { PresentationFonts } from "../src/fonts.js";
import { composeLocalPreview } from "../src/compose.js";

const baseUrl = process.env.ITEMERNESS_PARITY_URL;

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

const viewer = (tier: string): PreviewViewer => ({
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
});

/** Runs compared as text plus font: colours are styling, geometry is the contract. */
const shape = (line: {
    runs: readonly { text: string; style: { font: string | null } }[];
    logicalWidthPixels: number;
}) => ({
    width: line.logicalWidthPixels,
    runs: line.runs.map(
        (run) =>
            `${run.style.font}:${[...run.text].map((c) => c.codePointAt(0)!.toString(16)).join(",")}`,
    ),
});

describe.skipIf(!baseUrl)("segmented frame parity with the plugin", () => {
    it("composes the same runs as the server compiler for every tier", async () => {
        const documentResponse = await fetch(`${baseUrl}/api/v1/document`);
        expect(documentResponse.ok).toBe(true);
        const { document } = (await documentResponse.json()) as {
            document: Parameters<typeof composeLocalPreview>[0]["document"];
        };
        const fonts = new PresentationFonts({
            artifact,
            fonts: document.fonts,
            glyphs: document.glyphs,
            spacing: document.spacing,
        });
        const snapshotHash = contentHash(document);

        for (const tier of [
            "common",
            "uncommon",
            "rare",
            "unique",
            "legendary",
            "corruption",
        ]) {
            const response = await fetch(`${baseUrl}/api/v1/preview`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    document,
                    itemId: "itemerness:ember-blade",
                    viewer: viewer(tier),
                    snapshotHash,
                    targetServerId: "runocraft-main",
                }),
            });
            expect(response.ok, `${tier}: preview request failed`).toBe(true);
            const { artifact: previewArtifact } = (await response.json()) as {
                artifact: {
                    origin: string;
                    display: {
                        displayName: Parameters<typeof shape>[0];
                        lore: Parameters<typeof shape>[0][];
                        renderer: string;
                        tooltipStyle: string | null;
                    } | null;
                    diagnostics: { code: string; severity: string; params: Record<string, unknown> }[];
                    failure: { code: string } | null;
                };
            };

            const errors = previewArtifact.diagnostics.filter(
                (entry) => entry.severity === "ERROR",
            );
            expect(
                errors.map((entry) => `${entry.code} ${JSON.stringify(entry.params)}`),
                `${tier}: agent reported errors`,
            ).toEqual([]);
            expect(
                previewArtifact.failure,
                `${tier}: server refused to compile`,
            ).toBeNull();
            // A mock or local origin would compare the TypeScript against itself and prove nothing.
            expect(
                previewArtifact.origin,
                `${tier}: not compiled by the agent`,
            ).toBe("agent");
            const remote = previewArtifact.display!;

            const local = composeLocalPreview({
                document,
                itemId: "itemerness:ember-blade",
                viewer: viewer(tier),
                fonts,
            }).display;

            expect(remote.renderer, `${tier}: renderer`).toBe("SEGMENTED_FRAME");
            expect(remote.tooltipStyle, `${tier}: tooltip style`).toBe(
                local.tooltipStyle,
            );
            expect(shape(remote.displayName), `${tier}: name row`).toEqual(
                shape(local.displayName),
            );
            expect(remote.lore.length, `${tier}: row count`).toBe(
                local.lore.length,
            );
            for (const [index, line] of remote.lore.entries()) {
                expect(shape(line), `${tier}: lore row ${index}`).toEqual(
                    shape(local.lore[index]!),
                );
            }
        }
    }, 120_000);
});
