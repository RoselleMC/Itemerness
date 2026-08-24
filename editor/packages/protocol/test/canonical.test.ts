import { describe, expect, it } from "vitest";
import {
    CanonicalizationError,
    bytesHash,
    canonicalize,
    contentHash,
    resourcePackSha1,
} from "../src/canonical.js";

describe("canonicalize", () => {
    it("sorts object keys by UTF-16 code unit", () => {
        expect(canonicalize({ b: 1, a: 2, A: 3, ä: 4 })).toBe(
            '{"A":3,"a":2,"b":1,"ä":4}',
        );
    });

    it("is insensitive to insertion order", () => {
        expect(canonicalize({ x: { p: 1, q: 2 } })).toBe(
            canonicalize({ x: { q: 2, p: 1 } }),
        );
    });

    it("drops undefined members the way JSON.stringify does", () => {
        expect(canonicalize({ a: 1, b: undefined })).toBe('{"a":1}');
    });

    it("serializes undefined array elements as null", () => {
        expect(canonicalize([1, undefined, 3])).toBe("[1,null,3]");
    });

    it("collapses negative zero so two documents cannot differ only by sign", () => {
        expect(canonicalize({ v: -0 })).toBe('{"v":0}');
        expect(contentHash({ v: -0 })).toBe(contentHash({ v: 0 }));
    });

    it("emits ECMAScript number forms", () => {
        expect(canonicalize([1, 1.5, -8.5, 1e21, 1e-7])).toBe(
            "[1,1.5,-8.5,1e+21,1e-7]",
        );
    });

    it("rejects non-finite numbers with the offending path", () => {
        expect(() => canonicalize({ a: { b: Number.NaN } })).toThrowError(
            CanonicalizationError,
        );
        try {
            canonicalize({ a: { b: Number.POSITIVE_INFINITY } });
        } catch (error) {
            expect((error as CanonicalizationError).path).toBe("/a/b");
        }
    });

    it("rejects BigInt so precision loss cannot slip into a hash", () => {
        expect(() => canonicalize({ a: 1n })).toThrowError(
            CanonicalizationError,
        );
    });

    it("escapes the JSON pointer separators in error paths", () => {
        try {
            canonicalize({ "a/b~c": Number.NaN });
        } catch (error) {
            expect((error as CanonicalizationError).path).toBe("/a~1b~0c");
        }
    });

    it("preserves non-ASCII text verbatim", () => {
        expect(canonicalize({ name: "余烬之刃" })).toBe('{"name":"余烬之刃"}');
    });
});

describe("contentHash", () => {
    it("produces a stable prefixed digest", () => {
        expect(contentHash({})).toBe(
            "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
        );
    });

    it("survives a JSON round trip", () => {
        const value = { z: [1, { y: "x" }], a: null };
        expect(contentHash(JSON.parse(JSON.stringify(value)))).toBe(
            contentHash(value),
        );
    });
});

describe("bytesHash", () => {
    it("hashes raw bytes", () => {
        expect(bytesHash(new Uint8Array())).toBe(
            "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        );
    });
});

describe("resourcePackSha1", () => {
    it("emits the unprefixed lowercase digest used by resource-pack bindings", () => {
        expect(resourcePackSha1(new Uint8Array())).toBe(
            "da39a3ee5e6b4b0d3255bfef95601890afd80709",
        );
    });
});
