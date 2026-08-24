import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
    EXPECTED_ARTIFACT_SHA256,
    EXPECTED_CLIENT_VERSION,
    FontMetricsArtifactError,
    readFontMetricsArtifact,
} from "../src/ifm.js";

/**
 * Reads the artifact the plugin ships. If this file ever moves, the browser loses its zero-upload
 * metric-faithful baseline, so the test failing here is a real signal rather than a path nit.
 */
const ARTIFACT_PATH = fileURLToPath(
    new URL(
        "../../../../itemerness-bukkit/src/main/resources/META-INF/itemerness/font-metrics/minecraft-26.1.2.ifm",
        import.meta.url,
    ),
);

const artifactBytes = new Uint8Array(readFileSync(ARTIFACT_PATH));

describe("readFontMetricsArtifact", () => {
    const artifact = readFontMetricsArtifact(artifactBytes);

    it("accepts the artifact bundled with the plugin", () => {
        expect(artifact.clientVersion).toBe(EXPECTED_CLIENT_VERSION);
        expect(artifact.artifactSha256).toBe(EXPECTED_ARTIFACT_SHA256);
    });

    it("exposes both vanilla font tables with the expected topology", () => {
        expect([...artifact.tablesByFont.keys()].sort()).toEqual([
            "minecraft:default",
            "minecraft:uniform",
        ]);
        expect(artifact.tablesByFont.get("minecraft:default")!.fallback).toBe(
            "minecraft:uniform",
        );
        expect(
            artifact.tablesByFont.get("minecraft:uniform")!.fallback,
        ).toBeNull();
    });

    it("decodes the well-known ASCII advances of the default font", () => {
        const table = artifact.tablesByFont.get("minecraft:default")!;
        // These are the advances every Minecraft text-width implementation must agree on.
        expect(table.glyphs.get(0x20 /* space */)!.advancePixels).toBe(4);
        expect(table.glyphs.get(0x41 /* A */)!.advancePixels).toBe(6);
        expect(table.glyphs.get(0x69 /* i */)!.advancePixels).toBe(2);
        expect(table.glyphs.get(0x6c /* l */)!.advancePixels).toBe(3);
        expect(table.glyphs.get(0x2e /* . */)!.advancePixels).toBe(2);
    });

    it("reports the space glyph as inkless and letters as inked", () => {
        const table = artifact.tablesByFont.get("minecraft:default")!;
        expect(table.glyphs.get(0x20)!.hasInk).toBe(false);
        expect(table.glyphs.get(0x41)!.hasInk).toBe(true);
    });

    it("gives CJK code points a uniform-font metric", () => {
        const uniform = artifact.tablesByFont.get("minecraft:uniform")!;
        // U+4F59 is the first character of the Chinese name of the bundled ember-blade example.
        const glyph = uniform.glyphs.get(0x4f59);
        expect(glyph).toBeDefined();
        expect(glyph!.advancePixels).toBeGreaterThan(0);
    });

    it("covers enough code points to be a real table rather than a stub", () => {
        expect(
            artifact.tablesByFont.get("minecraft:default")!.glyphs.size,
        ).toBeGreaterThan(1000);
        expect(
            artifact.tablesByFont.get("minecraft:uniform")!.glyphs.size,
        ).toBeGreaterThan(10_000);
    });

    it("rejects a truncated artifact", () => {
        expect(() =>
            readFontMetricsArtifact(artifactBytes.subarray(0, 64)),
        ).toThrowError(FontMetricsArtifactError);
    });

    it("rejects a single flipped payload byte", () => {
        const tampered = artifactBytes.slice();
        tampered[tampered.length - 1] =
            (tampered[tampered.length - 1]! ^ 0xff) & 0xff;
        expect(() => readFontMetricsArtifact(tampered)).toThrowError(
            FontMetricsArtifactError,
        );
    });

    it("rejects a wrong magic", () => {
        const tampered = artifactBytes.slice();
        tampered[0] = 0x00;
        expect(() => readFontMetricsArtifact(tampered)).toThrowError(
            /magic does not match/,
        );
    });
});
