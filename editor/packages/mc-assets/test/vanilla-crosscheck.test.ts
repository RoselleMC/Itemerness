import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readFontMetricsArtifact } from "../src/ifm.js";
import { mountArchive, PackStack } from "../src/pack.js";
import { FontLibrary } from "../src/font/assemble.js";
import { crossCheckVanillaFonts } from "../src/font/crosscheck.js";
import { resolveItemIcon } from "../src/items.js";
import { loadSprite, VANILLA_TOOLTIP_SPRITES } from "../src/sprites.js";

/**
 * Proves the browser font engine derives the same metrics from the raw vanilla assets that the
 * generator derived from the client jar.
 *
 * Mojang assets cannot be committed, so the bundle is built locally by
 * `node scripts/fetch-vanilla-assets.mjs`. When it is absent the suite skips rather than passing
 * vacuously: a silent skip that looked like a pass would be the worst possible outcome for a test
 * whose entire job is to keep the browser honest.
 */
const BUNDLE_PATH = fileURLToPath(
    new URL("../../../vanilla-cache/vanilla-1.21.11.zip", import.meta.url),
);
const ARTIFACT_PATH = fileURLToPath(
    new URL(
        "../../../../itemerness-bukkit/src/main/resources/META-INF/itemerness/font-metrics/minecraft-1.21.11.ifm",
        import.meta.url,
    ),
);

const bundleAvailable = existsSync(BUNDLE_PATH);

describe.skipIf(!bundleAvailable)("vanilla asset cross-check", () => {
    const stack = new PackStack().with(
        mountArchive(new Uint8Array(readFileSync(BUNDLE_PATH)), {
            name: "vanilla-1.21.11",
            kind: "vanilla",
        }),
    );
    const library = new FontLibrary(stack);
    const artifact = readFontMetricsArtifact(
        new Uint8Array(readFileSync(ARTIFACT_PATH)),
    );

    it("assembles both vanilla fonts without incomplete metrics", () => {
        for (const fontId of ["minecraft:default", "minecraft:uniform"]) {
            const table = library.get(fontId);
            expect(
                table.diagnostics,
                `${fontId}: ${JSON.stringify(table.diagnostics)}`,
            ).toEqual([]);
            expect(table.metricsIncomplete).toBe(false);
            expect(table.glyphs.size).toBeGreaterThan(1000);
        }
    });

    it("walks the vanilla provider chain in the documented order", () => {
        expect(library.get("minecraft:default").providerTrace).toEqual([
            "reference minecraft:include/space",
            "space",
            "reference minecraft:include/default",
            // Order matters and is not alphabetical: nonlatin_european and accented are listed
            // before ascii, and first-wins resolution depends on that exact sequence.
            "bitmap minecraft:font/nonlatin_european.png",
            "bitmap minecraft:font/accented.png",
            "bitmap minecraft:font/ascii.png",
            "reference minecraft:include/unifont",
            "unihex minecraft:font/unifont.zip",
        ]);
    });

    it("matches the shipped metrics artifact for every code point", () => {
        const reports = crossCheckVanillaFonts(artifact, (fontId) =>
            library.get(fontId),
        );
        for (const report of reports) {
            expect(
                report.mismatches,
                `${report.fontId} metric drift: ${JSON.stringify(report.mismatches.slice(0, 8))}`,
            ).toEqual([]);
            expect(
                report.missingInEngine,
                `${report.fontId} missing code points: ${JSON.stringify(report.missingInEngine.slice(0, 8))}`,
            ).toEqual([]);
            expect(report.comparedGlyphs).toBeGreaterThan(1000);
        }
    });

    it("explains every extra code point through the uniform fallback table", () => {
        const reports = crossCheckVanillaFonts(artifact, (fontId) =>
            library.get(fontId),
        );
        const defaultReport = reports.find(
            (report) => report.fontId === "minecraft:default",
        )!;
        expect(defaultReport.unexplainedExtras).toEqual([]);
    });

    it("carries raster data for inked glyphs so the painter can draw real pixels", () => {
        const table = library.get("minecraft:default");
        const letter = table.glyphs.get(0x41)!;
        expect(letter.raster?.kind).toBe("bitmap");
        expect(letter.raster!.scale).toBe(1);
        const space = table.glyphs.get(0x20)!;
        expect(space.providerKind).toBe("space");
        expect(space.raster).toBeNull();
        const han = library.get("minecraft:uniform").glyphs.get(0x4f59)!;
        expect(han.raster?.kind).toBe("unihex");
        expect(han.raster!.scale).toBe(0.5);
    });

    it("reads the vanilla tooltip sprites with their nine-slice metadata", () => {
        const background = loadSprite(
            stack,
            VANILLA_TOOLTIP_SPRITES.background,
        );
        const frame = loadSprite(stack, VANILLA_TOOLTIP_SPRITES.frame);
        expect(background, "vanilla tooltip background sprite").not.toBeNull();
        expect(frame, "vanilla tooltip frame sprite").not.toBeNull();
        expect(background!.scaling.type).toBe("nine_slice");
        expect(background!.scaling.border).not.toBeNull();
    });

    it("resolves flat item icons and refuses to fake block models", () => {
        const paper = resolveItemIcon(stack, "minecraft:paper");
        expect(paper.kind).toBe("flat");
        if (paper.kind === "flat") {
            expect(paper.layers[0]!.width).toBe(16);
            expect(paper.layers[0]!.height).toBe(16);
        }
        const stone = resolveItemIcon(stack, "minecraft:stone");
        expect(stone.kind).toBe("unsupported");
        if (stone.kind === "unsupported")
            expect(stone.reason).toBe("block-model");
    });
});

describe.skipIf(bundleAvailable)("vanilla asset cross-check", () => {
    it("is skipped until the local bundle is built", () => {
        expect(bundleAvailable).toBe(false);
    });
});
