import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
    FontLibrary,
    PackStack,
    readFontMetricsArtifact,
    type MountedPack,
    type MinecraftClientVersion,
} from "@itemerness/mc-assets";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import type { PreviewLine, PreviewRun } from "@itemerness/protocol";
import {
    PresentationFonts,
    type PresentationFontsOptions,
} from "../src/fonts.js";
import {
    measureLine,
    previewFontEvidence,
    type PreviewMetricsContext,
} from "../src/measure.js";
import { buildFidelityClaims } from "../src/fidelity.js";

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
const options: PresentationFontsOptions = {
    artifact,
    fonts: baselineDocument.fonts,
    glyphs: baselineDocument.glyphs,
    spacing: baselineDocument.spacing,
};

function line(
    fonts: PresentationFonts,
    text = "A",
    font = "minecraft:default",
): PreviewLine {
    const runs: PreviewRun[] = [
        {
            text,
            kind: "TEXT",
            unbreakable: false,
            style: {
                font,
                color: null,
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
}

function evidence(
    fonts: PresentationFonts,
    context: PreviewMetricsContext = { serverClientVersion: "26.2" },
    text = "A",
    font = "minecraft:default",
    library: FontLibrary | null = null,
) {
    return previewFontEvidence(
        [line(fonts, text, font)],
        fonts,
        library,
        context,
    );
}

function claims(
    value: ReturnType<typeof evidence>,
    verified = false,
    artifactLoaded = true,
) {
    return buildFidelityClaims({
        ...value,
        origin: verified ? "agent" : "local",
        snapshotMatches: verified,
        metricsArtifactLoaded: artifactLoaded,
        tooltipSpritesAvailable: false,
        tooltipStyleRequested: false,
        itemIcon: "absent",
        preservesVanillaLines: false,
    });
}

function pack(
    files: Record<string, string | Uint8Array>,
    kind: MountedPack["kind"] = "resource-pack",
    clientVersion?: MinecraftClientVersion,
): MountedPack {
    const encoded = new Map(
        Object.entries(files).map(([path, value]) => [
            path,
            typeof value === "string" ? new TextEncoder().encode(value) : value,
        ]),
    );
    return {
        id: `fixture:${kind}`,
        sha1: "0".repeat(40),
        name: "fixture",
        kind,
        clientVersion,
        meta: null,
        byteLength: 0,
        has: (path) => encoded.has(path),
        read: (path) => encoded.get(path),
        list: (prefix) =>
            [...encoded.keys()].filter((path) => path.startsWith(prefix)),
    };
}

describe("version-scoped metric fidelity", () => {
    it.each(["1.21.11", "26.1.1", "26.1.2", "26.2"] as const)(
        "uses the mounted vanilla provider's actual version for %s",
        (version) => {
            const selectedArtifact = readFontMetricsArtifact(
                new Uint8Array(
                    readFileSync(
                        new URL(
                            `../../../../itemerness-bukkit/src/main/resources/META-INF/itemerness/font-metrics/minecraft-${version}.ifm`,
                            import.meta.url,
                        ),
                    ),
                ),
            );
            const declaration = {
                "assets/minecraft/font/default.json": JSON.stringify({
                    providers: [
                        {
                            type: "bitmap",
                            file: "minecraft:font/test.png",
                            height: 8,
                            ascent: 7,
                            chars: ["A"],
                        },
                        { type: "space", advances: { B: 6 } },
                    ],
                }),
                "assets/minecraft/textures/font/test.png": new Uint8Array(
                    readFileSync(
                        new URL(
                            "../../../apps/web/src-tauri/icons/32x32.png",
                            import.meta.url,
                        ),
                    ),
                ),
            };
            for (const mountedVersion of [
                version,
                version === "26.2" ? "1.21.11" : "26.2",
                undefined,
            ] as const) {
                const library = new FontLibrary(
                    new PackStack([
                        pack(declaration, "vanilla", mountedVersion),
                    ]),
                );
                const fonts = new PresentationFonts({
                    ...options,
                    artifact: selectedArtifact,
                    library,
                    fonts: options.fonts.map((font) =>
                        font.id === "minecraft:default"
                            ? {
                                  ...font,
                                  metrics: `builtin:minecraft-default-${version}`,
                              }
                            : font,
                    ),
                });
                const value = evidence(
                    fonts,
                    { serverClientVersion: version },
                    "AB",
                    "minecraft:default",
                    library,
                );
                for (const codePoint of [65, 66])
                    expect(
                        fonts.resolve("minecraft:default", codePoint, "TEXT")
                            ?.metricsClientVersion,
                    ).toBe(mountedVersion ?? "unknown");
                expect(value.metricsVersionMismatch).toBe(
                    mountedVersion !== version,
                );
                expect(value.metricsRevisionMismatch).toBe(false);
            }
        },
    );
    it.each([
        {},
        { serverClientVersion: "26.1.2" },
        { measurementClientVersion: "server", serverClientVersion: "26.1.2" },
        { measurementClientVersion: "26.1.2", serverClientVersion: "26.1.2" },
    ])("keeps matching or legacy context compatible: %j", (context) => {
        const value = evidence(new PresentationFonts(options), context);
        expect(value.metricsVersionMismatch).toBe(false);
        expect(value.metricsRevisionMismatch).toBe(false);
        expect(
            claims(value).find((entry) => entry.aspect === "metrics")?.level,
        ).toBe("metric-faithful");
    });

    it.each([
        { serverClientVersion: "1.21.11" },
        { serverClientVersion: "26.1.1", measurementClientVersion: "server" },
        { serverClientVersion: "26.2", measurementClientVersion: "26.1.2" },
        { serverClientVersion: "26.1.2", measurementClientVersion: "26.2" },
    ])("does not verify a different client baseline: %j", (context) => {
        const value = evidence(new PresentationFonts(options), context);
        expect(value.metricsComplete).toBe(true);
        expect(value.metricsVersionMismatch).toBe(true);
        const result = claims(value);
        for (const aspect of ["metrics", "wrapping"]) {
            expect(
                result.find((entry) => entry.aspect === aspect),
            ).toMatchObject({
                level: "approximate-raster",
                reasonKey: "fidelity.metrics.version_mismatch",
            });
        }
        const verified = claims(value, true);
        for (const aspect of [
            "content",
            "locale",
            "theme-selection",
            "wrapping",
        ]) {
            expect(
                verified.find((entry) => entry.aspect === aspect)?.level,
            ).toBe("exact-structure");
        }
        expect(
            verified.find((entry) => entry.aspect === "metrics")?.level,
        ).toBe("approximate-raster");
    });

    it.each(["builtin:minecraft-default", "builtin:minecraft-uniform"])(
        "resolves valid unversioned alias %s",
        (metrics) => {
            const fontId = metrics.endsWith("uniform")
                ? "minecraft:uniform"
                : "minecraft:default";
            const fonts = new PresentationFonts({
                ...options,
                fonts: options.fonts.map((font) =>
                    font.id === fontId ? { ...font, metrics } : font,
                ),
            });
            const value = evidence(
                fonts,
                { serverClientVersion: "26.1.2" },
                "A",
                fontId,
            );
            expect(value.metricsRevisionMismatch).toBe(false);
            expect(
                claims(value).find((entry) => entry.aspect === "metrics")
                    ?.level,
            ).toBe("metric-faithful");
        },
    );

    it.each([
        "builtin:minecraft-default-26.2",
        "builtin:unknown",
        "builtin:minecraft-uniform-26.1.2",
        "example:custom/revision",
    ])("marks font-id fallback for unavailable revision %s", (metrics) => {
        const fonts = new PresentationFonts({
            ...options,
            fonts: options.fonts.map((font) =>
                font.id === "minecraft:default" ? { ...font, metrics } : font,
            ),
        });
        for (const text of ["A", String.fromCodePoint(0x4f59)]) {
            const value = evidence(
                fonts,
                { serverClientVersion: "26.1.2" },
                text,
            );
            expect(value.metricsRevisionMismatch).toBe(true);
            expect(
                claims(value).find((entry) => entry.aspect === "metrics")
                    ?.reasonKey,
            ).toBe("fidelity.metrics.revision_mismatch");
        }
    });

    it("tracks artifact metrics through explicit font fallbacks", () => {
        const value = evidence(
            new PresentationFonts(options),
            undefined,
            "A",
            "itemerness:body",
        );
        expect(value.metricsVersionMismatch).toBe(true);
        expect(value.metricsRevisionMismatch).toBe(false);
    });

    it("retains a different mounted version through a builtin fallback", () => {
        const text = String.fromCodePoint(0x4f59);
        const library = new FontLibrary(
            new PackStack([
                pack(
                    {
                        "assets/minecraft/font/uniform.json": JSON.stringify({
                            providers: [
                                { type: "space", advances: { [text]: 9 } },
                            ],
                        }),
                    },
                    "vanilla",
                    "1.21.11",
                ),
            ]),
        );
        const fonts = new PresentationFonts({ ...options, library });
        expect(
            evidence(
                fonts,
                { serverClientVersion: "26.1.2" },
                text,
                "minecraft:default",
                library,
            ).metricsVersionMismatch,
        ).toBe(true);
    });

    it("does not downgrade complete declared glyphs or flat fallbacks without a vanilla artifact", () => {
        const declared = new PresentationFonts({ ...options, artifact: null });
        const glyph = baselineDocument.glyphs[0]!;
        const declaredValue = evidence(
            declared,
            undefined,
            String.fromCodePoint(glyph.codePoint),
            glyph.font,
        );
        expect(declaredValue.metricsVersionMismatch).toBe(false);
        expect(
            claims(declaredValue, false, false).find(
                (entry) => entry.aspect === "metrics",
            ),
        ).toMatchObject({
            level: "metric-faithful",
            reasonKey: "fidelity.metrics.from_declarations",
        });
        const flat = new PresentationFonts({
            ...options,
            artifact: null,
            fonts: [
                {
                    ...options.fonts[0]!,
                    id: "example:flat",
                    metrics: "example:flat",
                    fallback: null,
                    fallbackAdvancePixels: 7,
                },
            ],
        });
        expect(
            claims(
                evidence(flat, undefined, "A", "example:flat"),
                false,
                false,
            ).find((entry) => entry.aspect === "metrics")?.level,
        ).toBe("metric-faithful");
    });

    it("uses actual referenced space providers, not the builtin font declaration", () => {
        const source = {
            "assets/minecraft/font/default.json": JSON.stringify({
                providers: [{ type: "reference", id: "example:actual" }],
            }),
        };
        const data = {
            "assets/example/font/actual.json": JSON.stringify({
                providers: [{ type: "space", advances: { A: 6 } }],
            }),
        };
        for (const kind of ["vanilla", "resource-pack"] as const) {
            const library = new FontLibrary(
                new PackStack([pack(data, kind), pack(source, "vanilla")]),
            );
            const value = evidence(
                new PresentationFonts({ ...options, library }),
                undefined,
                "A",
                "minecraft:default",
                library,
            );
            expect(value.mountedMetricsUsed).toBe(true);
            expect(value.metricsVersionMismatch).toBe(kind === "vanilla");
        }
    });

    it("keeps a custom texture override independent of the vanilla font definition", () => {
        const png = new Uint8Array(
            readFileSync(
                new URL(
                    "../../../apps/web/src-tauri/icons/32x32.png",
                    import.meta.url,
                ),
            ),
        );
        const definition = pack(
            {
                "assets/minecraft/font/default.json": JSON.stringify({
                    providers: [
                        {
                            type: "bitmap",
                            file: "minecraft:font/custom.png",
                            height: 8,
                            ascent: 7,
                            chars: ["A"],
                        },
                    ],
                }),
            },
            "vanilla",
        );
        const library = new FontLibrary(
            new PackStack([
                pack({ "assets/minecraft/textures/font/custom.png": png }),
                definition,
            ]),
        );
        expect(library.get("minecraft:default").diagnostics).toEqual([]);
        const value = evidence(
            new PresentationFonts({ ...options, library }),
            undefined,
            "A",
            "minecraft:default",
            library,
        );
        expect(value.metricsVersionMismatch).toBe(false);
        expect(value.metricsRevisionMismatch).toBe(false);
        expect(
            claims(value).find((entry) => entry.aspect === "metrics"),
        ).toMatchObject({
            level: "metric-faithful",
            reasonKey: "fidelity.metrics.from_mounted_assets",
        });
    });
});
