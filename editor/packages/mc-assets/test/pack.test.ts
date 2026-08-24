import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import { mountArchive } from "../src/pack.js";

const CENTRAL_DIRECTORY_ENTRY = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;

function findSignature(bytes: Uint8Array, signature: number): number {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let offset = 0; offset <= bytes.byteLength - 4; offset += 1) {
        if (view.getUint32(offset, true) === signature) return offset;
    }
    throw new Error(`ZIP signature ${signature.toString(16)} not found`);
}

function fixtureArchive(): Uint8Array {
    return zipSync({
        "pack.mcmeta": new TextEncoder().encode(
            JSON.stringify({
                pack: { pack_format: 1, description: "fixture" },
            }),
        ),
    });
}

describe("mountArchive identity", () => {
    it("retains the exact archive SHA-1 used by resource-pack bindings", () => {
        const bytes = fixtureArchive();

        const mounted = mountArchive(bytes, { name: "fixture.zip" });

        expect(mounted.sha1).toBe(
            createHash("sha1").update(bytes).digest("hex"),
        );
        expect(mounted.sha1).toMatch(/^[0-9a-f]{40}$/);
        expect(mounted.id).toMatch(/^sha256:[0-9a-f]{64}$/);
    });
});

describe("mountArchive preflight", () => {
    it("rejects a zip-bomb expansion claim before decompression", () => {
        const bytes = fixtureArchive();
        const central = findSignature(bytes, CENTRAL_DIRECTORY_ENTRY);
        new DataView(
            bytes.buffer,
            bytes.byteOffset,
            bytes.byteLength,
        ).setUint32(central + 24, 64 * 1024 * 1024 + 1, true);

        expect(() => mountArchive(bytes, { name: "bomb.zip" })).toThrow(
            /entry exceeding.*expansion limit/u,
        );
    });

    it("rejects encrypted entries before decompression", () => {
        const bytes = fixtureArchive();
        const central = findSignature(bytes, CENTRAL_DIRECTORY_ENTRY);
        const view = new DataView(
            bytes.buffer,
            bytes.byteOffset,
            bytes.byteLength,
        );
        view.setUint16(
            central + 8,
            view.getUint16(central + 8, true) | 1,
            true,
        );

        expect(() => mountArchive(bytes, { name: "encrypted.zip" })).toThrow(
            /encrypted ZIP entry/u,
        );
    });

    it("rejects ZIP64 directory sentinels before decompression", () => {
        const bytes = fixtureArchive();
        const end = findSignature(bytes, END_OF_CENTRAL_DIRECTORY);
        new DataView(
            bytes.buffer,
            bytes.byteOffset,
            bytes.byteLength,
        ).setUint16(end + 10, 0xffff, true);

        expect(() => mountArchive(bytes, { name: "zip64.zip" })).toThrow(
            /unsupported ZIP64 metadata/u,
        );
    });

    it("rejects excessive directory entry counts before reading entries", () => {
        const bytes = fixtureArchive();
        const end = findSignature(bytes, END_OF_CENTRAL_DIRECTORY);
        const view = new DataView(
            bytes.buffer,
            bytes.byteOffset,
            bytes.byteLength,
        );
        view.setUint16(end + 8, 65_001, true);
        view.setUint16(end + 10, 65_001, true);

        expect(() => mountArchive(bytes, { name: "entries.zip" })).toThrow(
            /archive entry limit/u,
        );
    });
});
