import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";

/**
 * Reader for the generated vanilla font-metrics artifact
 * (`META-INF/itemerness/font-metrics/minecraft-26.1.2.ifm`).
 *
 * This is a byte-for-byte port of `BuiltinFontMetricsLoader` in `itemerness-bukkit`, including its
 * integrity checks. It matters for two reasons:
 *
 * 1. Without mounting any Mojang asset, the browser gets the exact advances and visual bounds the
 *    server measures with, so wrapping and width anchors are metric-faithful from the first paint.
 * 2. Once a user does mount the vanilla assets, the advances computed from the raw font providers
 *    can be compared against this table code point by code point. A mismatch is objective proof
 *    that the browser font engine and the server disagree, rather than something a human has to
 *    notice by squinting at a screenshot.
 */

export interface GlyphMetric {
    /** Signed logical advance in GUI pixels. Half-pixel resolution, matching the artifact. */
    readonly advancePixels: number;
    readonly boldExtraAdvancePixels: number;
    readonly left: number;
    readonly right: number;
    readonly top: number;
    readonly bottom: number;
    readonly hasInk: boolean;
}

export interface FontMetricsTable {
    readonly fontId: string;
    readonly metricsRevision: string;
    readonly fallback: string | null;
    readonly fallbackGlyph: GlyphMetric;
    readonly glyphs: ReadonlyMap<number, GlyphMetric>;
}

export interface FontMetricsArtifact {
    readonly clientVersion: string;
    readonly clientSha1: string;
    readonly assetIndexSha1: string;
    readonly sourceSha1: string;
    readonly artifactSha256: string;
    readonly tablesByRevision: ReadonlyMap<string, FontMetricsTable>;
    readonly tablesByFont: ReadonlyMap<string, FontMetricsTable>;
}

export class FontMetricsArtifactError extends Error {
    constructor(detail: string) {
        super(`Invalid bundled font metrics artifact: ${detail}`);
        this.name = "FontMetricsArtifactError";
    }
}

const MAGIC = Uint8Array.from([0x49, 0x54, 0x4d, 0x46, 0x4f, 0x4e, 0x54, 0x00]);
const ARTIFACT_SCHEMA = 1;
const SHA1_BYTES = 20;
const SHA256_BYTES = 32;
const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;
const MAX_PAYLOAD_BYTES = 3 * 1024 * 1024;
const MAX_GLYPHS_PER_TABLE = 1_200_000;
const HAS_INK_FLAG = 1;
const HALF_PIXEL_SCALE = 2;
const MAX_CODE_POINT = 0x10ffff;
const MIN_SURROGATE = 0xd800;
const MAX_SURROGATE = 0xdfff;

/** Expected topology of the 26.1.2 artifact, mirroring `EXPECTED_TABLES` on the JVM side. */
export const EXPECTED_TABLES: ReadonlyMap<
    string,
    { fontId: string; fallback: string | null }
> = new Map([
    [
        "builtin:minecraft-default-26.1.2",
        { fontId: "minecraft:default", fallback: "minecraft:uniform" },
    ],
    [
        "builtin:minecraft-uniform-26.1.2",
        { fontId: "minecraft:uniform", fallback: null },
    ],
]);

export const EXPECTED_CLIENT_VERSION = "26.1.2";
export const EXPECTED_CLIENT_SHA1 = "4e618f09a0c649dde3fdf829df443ce0b8831e65";
export const EXPECTED_ASSET_INDEX_SHA1 =
    "3391216608325aaf428712b211476abf6d5ddffa";
export const EXPECTED_SOURCE_SHA1 = "38547c6fabdfd5adc0d2227c4dfc6cf54713fbfa";
export const EXPECTED_ARTIFACT_SHA256 =
    "c978141c91f21f40083cc4420388de0a763cef303a058142db410d35a46b8604";

class ByteCursor {
    private position = 0;
    private readonly decoder = new TextDecoder("utf-8", { fatal: true });

    constructor(
        private readonly source: Uint8Array,
        private readonly label: string,
    ) {}

    get remaining(): number {
        return this.source.length - this.position;
    }

    unsignedByte(): number {
        this.requireRemaining(1);
        return this.source[this.position++]!;
    }

    signedByte(): number {
        const value = this.unsignedByte();
        return value >= 0x80 ? value - 0x100 : value;
    }

    unsignedShort(): number {
        return (this.unsignedByte() << 8) | this.unsignedByte();
    }

    unsignedInt(): number {
        const value =
            this.unsignedByte() * 0x1000000 +
            (this.unsignedByte() << 16) +
            (this.unsignedByte() << 8) +
            this.unsignedByte();
        if (value > 0x7fffffff)
            this.invalid("unsigned integer exceeds the supported range");
        return value;
    }

    positiveVarUInt(): number {
        let value = 0;
        let shift = 0;
        for (let index = 0; index < 5; index += 1) {
            const byte = this.unsignedByte();
            value += (byte & 0x7f) * 2 ** shift;
            if ((byte & 0x80) === 0) {
                if (value <= 0)
                    this.invalid("code-point delta is not positive");
                return value;
            }
            shift += 7;
        }
        this.invalid("code-point delta is too long");
    }

    string(): string {
        const length = this.unsignedByte();
        if (length === 0) this.invalid("required string is empty");
        return this.decodeUtf8(this.bytes(length));
    }

    optionalString(): string | null {
        const length = this.unsignedByte();
        return length === 0 ? null : this.decodeUtf8(this.bytes(length));
    }

    bytes(length: number): Uint8Array {
        if (length < 0) this.invalid("negative byte length");
        this.requireRemaining(length);
        const result = this.source.subarray(
            this.position,
            this.position + length,
        );
        this.position += length;
        return result;
    }

    requireExhausted(): void {
        if (this.remaining !== 0)
            this.invalid(`contains ${this.remaining} trailing bytes`);
    }

    private decodeUtf8(bytes: Uint8Array): string {
        try {
            return this.decoder.decode(bytes);
        } catch {
            return this.invalid("contains invalid UTF-8");
        }
    }

    private requireRemaining(length: number): void {
        if (this.remaining < length) this.invalid("is truncated");
    }

    private invalid(detail: string): never {
        throw new FontMetricsArtifactError(`${this.label} ${detail}`);
    }
}

function readMetric(cursor: ByteCursor): GlyphMetric {
    const advancePixels = cursor.unsignedByte() / HALF_PIXEL_SCALE;
    const boldExtraAdvancePixels = cursor.unsignedByte() / HALF_PIXEL_SCALE;
    const left = cursor.signedByte() / HALF_PIXEL_SCALE;
    const right = cursor.signedByte() / HALF_PIXEL_SCALE;
    const top = cursor.signedByte() / HALF_PIXEL_SCALE;
    const bottom = cursor.signedByte() / HALF_PIXEL_SCALE;
    const flags = cursor.unsignedByte();
    if ((flags & ~HAS_INK_FLAG) !== 0)
        throw new FontMetricsArtifactError("glyph flags are invalid");
    const hasInk = (flags & HAS_INK_FLAG) !== 0;
    if (hasInk) {
        if (right < left || bottom < top)
            throw new FontMetricsArtifactError("glyph bounds are invalid");
    } else if (left !== 0 || right !== 0 || top !== 0 || bottom !== 0) {
        throw new FontMetricsArtifactError(
            "inkless glyph has non-empty bounds",
        );
    }
    return {
        advancePixels,
        boldExtraAdvancePixels,
        left,
        right,
        top,
        bottom,
        hasInk,
    };
}

/**
 * Decodes and fully verifies the artifact.
 *
 * Every digest in the header is checked, including the artifact's own SHA-256. A metrics table
 * that has been tampered with or regenerated from a different client build must fail loudly here
 * rather than quietly shift every advance by half a pixel.
 */
export function readFontMetricsArtifact(
    bytes: Uint8Array,
): FontMetricsArtifact {
    if (bytes.length > MAX_ARTIFACT_BYTES) {
        throw new FontMetricsArtifactError("exceeds the size limit");
    }
    const cursor = new ByteCursor(bytes, "font metrics header");
    const magic = cursor.bytes(MAGIC.length);
    if (!MAGIC.every((byte, index) => magic[index] === byte)) {
        throw new FontMetricsArtifactError("magic does not match");
    }
    const schema = cursor.unsignedShort();
    if (schema !== ARTIFACT_SCHEMA)
        throw new FontMetricsArtifactError(`unsupported schema ${schema}`);
    const clientVersion = cursor.string();
    if (clientVersion !== EXPECTED_CLIENT_VERSION) {
        throw new FontMetricsArtifactError(
            `client version ${clientVersion} does not match ${EXPECTED_CLIENT_VERSION}`,
        );
    }
    const clientSha1 = bytesToHex(cursor.bytes(SHA1_BYTES));
    if (clientSha1 !== EXPECTED_CLIENT_SHA1)
        throw new FontMetricsArtifactError("client SHA-1 does not match");
    const assetIndexSha1 = bytesToHex(cursor.bytes(SHA1_BYTES));
    if (assetIndexSha1 !== EXPECTED_ASSET_INDEX_SHA1) {
        throw new FontMetricsArtifactError("asset index SHA-1 does not match");
    }
    const sourceSha1 = bytesToHex(cursor.bytes(SHA1_BYTES));
    if (sourceSha1 !== EXPECTED_SOURCE_SHA1)
        throw new FontMetricsArtifactError("source SHA-1 does not match");

    const payloadLength = cursor.unsignedInt();
    if (
        payloadLength > MAX_PAYLOAD_BYTES ||
        payloadLength !== cursor.remaining - SHA256_BYTES
    ) {
        throw new FontMetricsArtifactError("payload length is invalid");
    }
    const expectedPayloadSha256 = bytesToHex(cursor.bytes(SHA256_BYTES));
    const payload = cursor.bytes(payloadLength);
    cursor.requireExhausted();
    if (bytesToHex(sha256(payload)) !== expectedPayloadSha256) {
        throw new FontMetricsArtifactError("payload integrity check failed");
    }
    const artifactSha256 = bytesToHex(sha256(bytes));
    if (artifactSha256 !== EXPECTED_ARTIFACT_SHA256) {
        throw new FontMetricsArtifactError("artifact integrity check failed");
    }

    const payloadCursor = new ByteCursor(payload, "font metrics payload");
    const tableCount = payloadCursor.unsignedByte();
    if (tableCount !== EXPECTED_TABLES.size)
        throw new FontMetricsArtifactError("font table count is invalid");
    const tables: FontMetricsTable[] = [];
    for (let index = 0; index < tableCount; index += 1) {
        const fontId = payloadCursor.string();
        const metricsRevision = payloadCursor.string();
        const fallback = payloadCursor.optionalString();
        const fallbackGlyph = readMetric(payloadCursor);
        const glyphCount = payloadCursor.unsignedInt();
        if (glyphCount > MAX_GLYPHS_PER_TABLE) {
            throw new FontMetricsArtifactError(
                `glyph count for ${metricsRevision} is invalid`,
            );
        }
        const glyphs = new Map<number, GlyphMetric>();
        let previousCodePoint = -1;
        for (let glyph = 0; glyph < glyphCount; glyph += 1) {
            const codePoint =
                previousCodePoint + payloadCursor.positiveVarUInt();
            if (
                codePoint > MAX_CODE_POINT ||
                (codePoint >= MIN_SURROGATE && codePoint <= MAX_SURROGATE)
            ) {
                throw new FontMetricsArtifactError(
                    `invalid code point in ${metricsRevision}`,
                );
            }
            glyphs.set(codePoint, readMetric(payloadCursor));
            previousCodePoint = codePoint;
        }
        tables.push({
            fontId,
            metricsRevision,
            fallback,
            fallbackGlyph,
            glyphs,
        });
    }
    payloadCursor.requireExhausted();

    const byRevision = new Map(
        tables.map((table) => [table.metricsRevision, table]),
    );
    if (byRevision.size !== EXPECTED_TABLES.size) {
        throw new FontMetricsArtifactError(
            "font metric revisions do not match",
        );
    }
    for (const [revision, expectation] of EXPECTED_TABLES) {
        const table = byRevision.get(revision);
        if (!table)
            throw new FontMetricsArtifactError(
                "font metric revisions do not match",
            );
        if (
            table.fontId !== expectation.fontId ||
            table.fallback !== expectation.fallback
        ) {
            throw new FontMetricsArtifactError(
                `font table topology for ${revision} does not match`,
            );
        }
        if (table.glyphs.size === 0)
            throw new FontMetricsArtifactError(
                `font table ${revision} is empty`,
            );
    }

    return {
        clientVersion,
        clientSha1,
        assetIndexSha1,
        sourceSha1,
        artifactSha256,
        tablesByRevision: byRevision,
        tablesByFont: new Map(tables.map((table) => [table.fontId, table])),
    };
}
