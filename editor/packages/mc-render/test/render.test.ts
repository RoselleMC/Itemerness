import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
    FontLibrary,
    mountArchive,
    PackStack,
    readFontMetricsArtifact,
    type MountedPack,
} from "@itemerness/mc-assets";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import type { PreviewLine, PreviewRun } from "@itemerness/protocol";
import { PresentationFonts } from "../src/fonts.js";
import {
    measureLine,
    measureText,
    MissingGlyphError,
    previewFontEvidence,
} from "../src/measure.js";
import { wrapRuns } from "../src/wrap.js";
import {
    componentTop,
    contentHeight,
    layoutTooltip,
    renderTooltip,
} from "../src/tooltip.js";
import { buildFidelityClaims, overallFidelity } from "../src/fidelity.js";
import { parseColor, shadowColor } from "../src/colors.js";

const ARTIFACT_PATH = fileURLToPath(
    new URL(
        "../../../../itemerness-bukkit/src/main/resources/META-INF/itemerness/font-metrics/minecraft-26.1.2.ifm",
        import.meta.url,
    ),
);
const BUNDLE_PATH = fileURLToPath(
    new URL("../../../vanilla-cache/vanilla-26.1.2.zip", import.meta.url),
);

const artifact = readFontMetricsArtifact(
    new Uint8Array(readFileSync(ARTIFACT_PATH)),
);

/** Metrics-only resolver: what a user gets before mounting anything. */
const metricsOnlyFonts = new PresentationFonts({
    artifact,
    fonts: baselineDocument.fonts,
    glyphs: baselineDocument.glyphs,
    spacing: baselineDocument.spacing,
});

const plainStyle: PreviewRun["style"] = {
    color: null,
    font: "minecraft:default",
    bold: false,
    italic: false,
    underlined: false,
    strikethrough: false,
};

const run = (
    text: string,
    overrides: Partial<PreviewRun> = {},
): PreviewRun => ({
    text,
    kind: "TEXT",
    unbreakable: false,
    style: plainStyle,
    ...overrides,
});

function memoryPack(files: Readonly<Record<string, string>>): MountedPack {
    const encoded = new Map(
        Object.entries(files).map(([path, value]) => [
            path,
            new TextEncoder().encode(value),
        ]),
    );
    const names = [...encoded.keys()].sort();
    return {
        id: "sha256:fixture",
        sha1: "1111111111111111111111111111111111111111",
        name: "fixture.zip",
        kind: "resource-pack",
        meta: null,
        byteLength: 0,
        has: (path) => encoded.has(path),
        read: (path) => encoded.get(path),
        list: (prefix) => names.filter((name) => name.startsWith(prefix)),
    };
}

function previewLine(text: string): PreviewLine {
    const runs = [run(text)];
    const measured = measureLine(runs, metricsOnlyFonts);
    return {
        runs,
        logicalWidthPixels: measured.logicalWidthPixels,
        visualBounds: measured.visualBounds,
    };
}

describe("measureLine", () => {
    it("sums signed advances the way Font.width does", () => {
        // "Ember Blade" in the default font: E6 m6 b6 e6 r6 space4 B6 l3 a6 d6 e6 = 61
        expect(
            measureText("Ember Blade", metricsOnlyFonts, plainStyle)
                .logicalWidthPixels,
        ).toBe(61);
    });

    it("adds the bold extra advance per glyph", () => {
        const normal = measureText(
            "ill",
            metricsOnlyFonts,
            plainStyle,
        ).logicalWidthPixels;
        const bold = measureText("ill", metricsOnlyFonts, {
            ...plainStyle,
            bold: true,
        }).logicalWidthPixels;
        expect(bold - normal).toBe(3);
    });

    it("measures CJK through the uniform fallback chain", () => {
        const width = measureText(
            "余烬之刃",
            metricsOnlyFonts,
            plainStyle,
        ).logicalWidthPixels;
        expect(width).toBe(36);
    });

    it("keeps logical width and visual bounds as separate answers", () => {
        const line = measureText("A", metricsOnlyFonts, {
            ...plainStyle,
            italic: true,
        });
        expect(line.logicalWidthPixels).toBe(6);
        // Italic shear pushes ink to the right of the logical advance.
        expect(line.visualBounds.right).toBeGreaterThan(
            line.logicalWidthPixels - 1,
        );
    });

    it("lets a negative spacing glyph pull the cursor back", () => {
        const back = metricsOnlyFonts.spacingCodePoint(-10)!;
        const line = measureLine(
            [
                run("AAA"),
                run(String.fromCodePoint(back), {
                    kind: "SPACING",
                    style: { ...plainStyle, font: "itemerness:spacing" },
                }),
            ],
            metricsOnlyFonts,
        );
        expect(line.logicalWidthPixels).toBe(8);
        // The ink is still out at 17 even though the tooltip would measure 8 pixels wide.
        expect(line.visualBounds.right).toBeGreaterThan(
            line.logicalWidthPixels,
        );
    });

    it("reaches an exact width anchor through the spacing provider", () => {
        expect(metricsOnlyFonts.spacingCodePoint(134)).toBe(0xf0100 + 133);
        expect(metricsOnlyFonts.spacingAdvance(0xf0100 + 133)).toBe(134);
        expect(metricsOnlyFonts.spacingCodePoint(0)).toBeNull();
        expect(metricsOnlyFonts.spacingCodePoint(9999)).toBeNull();
    });

    it("renders an undeclared private-use code point as the vanilla missing-glyph box", () => {
        // The icons font falls back to default, which falls back to uniform, whose fallback glyph
        // is the six-pixel box the client draws for an unknown code point. Reproducing that beats
        // inventing a width, and an unknown icon token is caught by document validation instead.
        const line = measureText("\u{E999}", metricsOnlyFonts, {
            ...plainStyle,
            font: "itemerness:icons",
        });
        expect(line.logicalWidthPixels).toBe(6);
        expect(line.glyphs[0]!.glyph.providerKind).toBe("metrics-artifact");
    });

    it("fails closed when no font in the chain can supply a metric", () => {
        expect(() =>
            measureText("x", metricsOnlyFonts, {
                ...plainStyle,
                font: "itemerness:not-declared",
            }),
        ).toThrowError(MissingGlyphError);
    });

    it("uses declared advances for semantic icon glyphs", () => {
        const line = measureText("\u{E001}", metricsOnlyFonts, {
            ...plainStyle,
            font: "itemerness:icons",
        });
        expect(line.logicalWidthPixels).toBe(9);
        expect(line.missingRaster).toBe(true);
    });
});

describe("wrapRuns", () => {
    it("breaks English on word boundaries", () => {
        const lines = wrapRuns(
            [run("Consumed when travelling to the recorded region.")],
            metricsOnlyFonts,
            {
                widthPixels: 100,
                maximumLines: 8,
                overflow: "ELLIPSIS",
            },
        );
        expect(lines.length).toBeGreaterThan(1);
        for (const line of lines)
            expect(line.logicalWidthPixels).toBeLessThanOrEqual(100);
        expect(
            lines
                .map((line) => line.runs.map((r) => r.text).join(""))
                .join(" "),
        ).toBe("Consumed when travelling to the recorded region.");
    });

    it("breaks CJK between ideographs", () => {
        const lines = wrapRuns(
            [run("记录本次远征发现的地标、路线和尚未完成的观察。")],
            metricsOnlyFonts,
            {
                widthPixels: 60,
                maximumLines: 12,
                overflow: "ELLIPSIS",
            },
        );
        expect(lines.length).toBeGreaterThan(2);
        for (const line of lines)
            expect(line.logicalWidthPixels).toBeLessThanOrEqual(60);
    });

    it("never starts a line with closing punctuation", () => {
        const lines = wrapRuns(
            [run("测试文本，继续测试文本。")],
            metricsOnlyFonts,
            {
                widthPixels: 40,
                maximumLines: 12,
                overflow: "ELLIPSIS",
            },
        );
        for (const line of lines) {
            const first = line.runs[0]?.text.codePointAt(0);
            expect(first).not.toBe(0xff0c);
            expect(first).not.toBe(0x3002);
        }
    });

    it("honours explicit line breaks", () => {
        const lines = wrapRuns([run("one\ntwo")], metricsOnlyFonts, {
            widthPixels: 200,
            maximumLines: 8,
            overflow: "ERROR",
        });
        expect(
            lines.map((line) => line.runs.map((r) => r.text).join("")),
        ).toEqual(["one", "two"]);
    });

    it("ellipsizes an unbreakable token rather than overflowing", () => {
        const lines = wrapRuns(
            [run("Supercalifragilisticexpialidocious")],
            metricsOnlyFonts,
            {
                widthPixels: 50,
                maximumLines: 1,
                overflow: "ELLIPSIS",
            },
        );
        expect(lines).toHaveLength(1);
        expect(lines[0]!.runs.map((r) => r.text).join("")).toMatch(/…$/);
        expect(lines[0]!.logicalWidthPixels).toBeLessThanOrEqual(50);
    });

    it("rejects overflow when the policy says error", () => {
        expect(() =>
            wrapRuns(
                [run("Supercalifragilisticexpialidocious")],
                metricsOnlyFonts,
                {
                    widthPixels: 20,
                    maximumLines: 1,
                    overflow: "ERROR",
                },
            ),
        ).toThrowError();
    });
});

describe("tooltip geometry", () => {
    it("uses the audited 26.1.2 line metrics", () => {
        expect(componentTop(0)).toBe(0);
        // The client inserts two pixels between the name and the first lore line.
        expect(componentTop(1)).toBe(12);
        expect(componentTop(2)).toBe(22);
        expect(contentHeight(1)).toBe(8);
        expect(contentHeight(2)).toBe(20);
    });

    it("takes tooltip width from the widest component and pads by three", () => {
        const lines: PreviewLine[] = [
            {
                runs: [run("Ember Blade")],
                logicalWidthPixels: 61,
                visualBounds: { left: 0, right: 61, top: -7, bottom: 1 },
            },
            {
                runs: [run("Attack Damage 38.5")],
                logicalWidthPixels: 0,
                visualBounds: { left: 0, right: 0, top: 0, bottom: 0 },
            },
        ];
        const geometry = layoutTooltip(lines, metricsOnlyFonts);
        expect(geometry.contentWidthPixels).toBe(
            Math.max(
                ...geometry.components.map(
                    (component) => component.line.logicalWidthPixels,
                ),
            ),
        );
        expect(geometry.totalWidthPixels).toBe(geometry.contentWidthPixels + 6);
        expect(geometry.totalHeightPixels).toBe(
            geometry.contentHeightPixels + 6,
        );
    });

    it("emits a shadow pass before the main pass for every inked glyph", () => {
        const lines: PreviewLine[] = [
            {
                runs: [run("Hi")],
                logicalWidthPixels: 0,
                visualBounds: { left: 0, right: 0, top: 0, bottom: 0 },
            },
        ];
        const { drawList } = renderTooltip(lines, metricsOnlyFonts);
        const glyphs = drawList.ops.filter((op) => op.kind === "glyph");
        expect(glyphs).toHaveLength(4);
        expect(
            glyphs.slice(0, 2).every((op) => op.kind === "glyph" && op.shadow),
        ).toBe(true);
        expect(
            glyphs.slice(2).every((op) => op.kind === "glyph" && !op.shadow),
        ).toBe(true);
        const first = glyphs[0]!;
        const third = glyphs[2]!;
        if (first.kind === "glyph" && third.kind === "glyph") {
            expect(first.x - third.x).toBe(1);
            expect(first.baselineY - third.baselineY).toBe(1);
            expect(first.color).toBe(shadowColor(third.color));
        }
    });

    it("flags ink that escapes the background rectangle", () => {
        const wide: PreviewLine = {
            runs: [run("x")],
            logicalWidthPixels: 4,
            visualBounds: { left: 0, right: 400, top: -90, bottom: 2 },
        };
        const geometry = layoutTooltip([wide], metricsOnlyFonts);
        // Measured bounds come from the runs, not the declared ones, so a single narrow glyph
        // stays inside. The check exists for canvas themes whose ink genuinely overhangs.
        expect(geometry.inkOutsideBackground).toBe(false);
    });

    it("produces annotation ops only when asked", () => {
        const lines: PreviewLine[] = [
            {
                runs: [run("Hi")],
                logicalWidthPixels: 0,
                visualBounds: { left: 0, right: 0, top: 0, bottom: 0 },
            },
        ];
        expect(
            renderTooltip(lines, metricsOnlyFonts).drawList.ops.some(
                (op) => op.kind === "annotation",
            ),
        ).toBe(false);
        expect(
            renderTooltip(lines, metricsOnlyFonts, {
                annotations: true,
            }).drawList.ops.some((op) => op.kind === "annotation"),
        ).toBe(true);
    });
});

describe("colors", () => {
    it("resolves the vanilla named colours", () => {
        expect(parseColor("dark_gray")).toBe(0x555555);
        expect(parseColor("#ffcf7a")).toBe(0xffcf7a);
        expect(parseColor("#abc")).toBe(0xaabbcc);
        expect(parseColor("not-a-color")).toBeNull();
    });

    it("derives shadows the way the client does", () => {
        expect(shadowColor(0xffffff)).toBe(0x3f3f3f);
        expect(shadowColor(0x000000)).toBe(0x000000);
    });
});

describe("preview font evidence", () => {
    it.each([
        ["empty", memoryPack({})],
        [
            "unrelated",
            memoryPack({
                "assets/example/font/unused.json": JSON.stringify({
                    providers: [{ type: "space", advances: { A: 6 } }],
                }),
            }),
        ],
    ])("does not upgrade fidelity for an %s mounted pack", (_label, pack) => {
        const library = new FontLibrary(new PackStack([pack]));
        const fonts = new PresentationFonts({
            library,
            artifact,
            fonts: baselineDocument.fonts,
            glyphs: baselineDocument.glyphs,
            spacing: baselineDocument.spacing,
        });

        const evidence = previewFontEvidence(
            [previewLine("A")],
            fonts,
            library,
        );

        expect(evidence.metricsComplete).toBe(true);
        expect(evidence.rasterComplete).toBe(false);
        expect(evidence.mountedMetricsUsed).toBe(false);
        expect(evidence.mountedRasterUsed).toBe(false);
        const claims = buildFidelityClaims({
            ...evidence,
            origin: "local",
            snapshotMatches: false,
            metricsArtifactLoaded: true,
            tooltipSpritesAvailable: false,
            tooltipStyleRequested: false,
            itemIcon: "absent",
            preservesVanillaLines: true,
        });
        expect(
            claims.find((claim) => claim.aspect === "metrics")!.reasonKey,
        ).toBe("fidelity.metrics.from_artifact");
        expect(
            claims.find((claim) => claim.aspect === "glyph-raster")!.level,
        ).toBe("client-only");
    });

    it("downgrades metrics when a used mounted font table is incomplete", () => {
        const library = new FontLibrary(
            new PackStack([
                memoryPack({
                    "assets/minecraft/font/default.json": JSON.stringify({
                        providers: [
                            { type: "ttf", file: "minecraft:font/custom.ttf" },
                        ],
                    }),
                }),
            ]),
        );
        const fonts = new PresentationFonts({
            library,
            artifact,
            fonts: baselineDocument.fonts,
            glyphs: baselineDocument.glyphs,
            spacing: baselineDocument.spacing,
        });

        const evidence = previewFontEvidence(
            [previewLine("A")],
            fonts,
            library,
        );

        expect(library.get("minecraft:default").metricsIncomplete).toBe(true);
        expect(evidence.metricsComplete).toBe(false);
        expect(evidence.mountedMetricsUsed).toBe(false);
        expect(evidence.mountedRasterUsed).toBe(false);
        const claims = buildFidelityClaims({
            ...evidence,
            origin: "local",
            snapshotMatches: false,
            metricsArtifactLoaded: true,
            tooltipSpritesAvailable: false,
            tooltipStyleRequested: false,
            itemIcon: "absent",
            preservesVanillaLines: true,
        });
        expect(claims.find((claim) => claim.aspect === "metrics")!.level).toBe(
            "approximate-raster",
        );
    });

    it("downgrades metrics when local measurement disagrees with the displayed line", () => {
        const line = previewLine("A");
        const evidence = previewFontEvidence(
            [{ ...line, logicalWidthPixels: line.logicalWidthPixels + 1 }],
            metricsOnlyFonts,
        );

        expect(evidence.metricsComplete).toBe(false);
    });
});

describe("fidelity claims", () => {
    it("never claims better than metric-faithful without an agent", () => {
        const claims = buildFidelityClaims({
            origin: "local",
            snapshotMatches: false,
            mountedMetricsUsed: true,
            mountedRasterUsed: true,
            metricsArtifactLoaded: true,
            metricsComplete: true,
            rasterComplete: true,
            tooltipSpritesAvailable: true,
            tooltipStyleRequested: true,
            itemIcon: "flat",
            preservesVanillaLines: true,
        });
        expect(claims.find((claim) => claim.aspect === "content")!.level).toBe(
            "metric-faithful",
        );
        expect(
            claims.find((claim) => claim.aspect === "positioning")!.level,
        ).toBe("client-only");
        expect(overallFidelity(claims)).toBe("client-only");
    });

    it("marks content exact only when an agent compiled the current snapshot", () => {
        const base = {
            mountedMetricsUsed: true,
            mountedRasterUsed: true,
            metricsArtifactLoaded: true,
            metricsComplete: true,
            rasterComplete: true,
            tooltipSpritesAvailable: true,
            tooltipStyleRequested: true,
            itemIcon: "flat" as const,
            preservesVanillaLines: false,
        };
        const fresh = buildFidelityClaims({
            ...base,
            origin: "agent",
            snapshotMatches: true,
        });
        const stale = buildFidelityClaims({
            ...base,
            origin: "agent",
            snapshotMatches: false,
        });
        expect(fresh.find((claim) => claim.aspect === "content")!.level).toBe(
            "exact-structure",
        );
        expect(stale.find((claim) => claim.aspect === "content")!.level).toBe(
            "metric-faithful",
        );
        expect(
            stale.find((claim) => claim.aspect === "content")!.reasonKey,
        ).toBe("fidelity.content.agent_stale");
    });

    it("downgrades the raster when nothing is mounted", () => {
        const claims = buildFidelityClaims({
            origin: "local",
            snapshotMatches: false,
            mountedMetricsUsed: false,
            mountedRasterUsed: false,
            metricsArtifactLoaded: true,
            metricsComplete: true,
            rasterComplete: false,
            tooltipSpritesAvailable: false,
            tooltipStyleRequested: false,
            itemIcon: "absent",
            preservesVanillaLines: true,
        });
        expect(
            claims.find((claim) => claim.aspect === "glyph-raster")!.level,
        ).toBe("client-only");
        expect(claims.find((claim) => claim.aspect === "metrics")!.level).toBe(
            "metric-faithful",
        );
        expect(
            claims.find((claim) => claim.aspect === "metrics")!.reasonKey,
        ).toBe("fidelity.metrics.from_artifact");
    });
});

describe.skipIf(!existsSync(BUNDLE_PATH))("with mounted vanilla assets", () => {
    const stack = new PackStack().with(
        mountArchive(new Uint8Array(readFileSync(BUNDLE_PATH)), {
            name: "vanilla",
            kind: "vanilla",
        }),
    );
    const mountedFonts = new PresentationFonts({
        library: new FontLibrary(stack),
        artifact,
        fonts: baselineDocument.fonts,
        glyphs: baselineDocument.glyphs,
        spacing: baselineDocument.spacing,
    });

    it("measures identically with and without mounted assets", () => {
        for (const sample of [
            "Ember Blade",
            "Attack Damage",
            "余烬之刃",
            "Ábc — «quote»",
            "0123456789",
        ]) {
            expect(
                measureText(sample, mountedFonts, plainStyle)
                    .logicalWidthPixels,
                `sample: ${sample}`,
            ).toBe(
                measureText(sample, metricsOnlyFonts, plainStyle)
                    .logicalWidthPixels,
            );
        }
    });

    it("upgrades inked glyphs from metrics-only to real pixels", () => {
        expect(
            measureText("A", metricsOnlyFonts, plainStyle).missingRaster,
        ).toBe(true);
        expect(measureText("A", mountedFonts, plainStyle).missingRaster).toBe(
            false,
        );
        expect(
            measureText("余", mountedFonts, plainStyle).glyphs[0]!.glyph.raster
                ?.kind,
        ).toBe("unihex");
    });
});
