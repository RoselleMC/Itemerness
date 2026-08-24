import { sha1 } from "@noble/hashes/legacy";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";

/**
 * Deterministic serialization, shared by the browser, the control plane, and the JVM agent.
 *
 * Two sides must be able to hash the same document and get the same string, otherwise the
 * snapshot fence that stops a late preview from overwriting a newer draft becomes a coin flip.
 * The rules below are RFC 8785 (JSON Canonicalization Scheme):
 *
 * - object keys sorted by UTF-16 code unit, which is also Kotlin's natural `String` ordering;
 * - no insignificant whitespace;
 * - `undefined` and function values dropped, as in `JSON.stringify`;
 * - numbers serialized by the ECMAScript `Number::toString` algorithm.
 *
 * The JVM implementation added in the editor-protocol module must implement the same number rule
 * rather than `Double.toString`, which formats exponents differently. Document fields that need
 * more range or precision than a double (64-bit integers, `BigDecimal`) travel as strings for
 * exactly this reason; see `longStringSchema` and `decimalStringSchema`.
 */

export class CanonicalizationError extends Error {
    constructor(
        message: string,
        readonly path: string,
    ) {
        super(`${message} at ${path || "<root>"}`);
        this.name = "CanonicalizationError";
    }
}

function writeString(value: string, out: string[]): void {
    // JSON.stringify already implements RFC 8785's string escaping: the shortest escape for the
    // mandatory set, lowercase \u00xx for other control characters, and lone surrogates preserved.
    out.push(JSON.stringify(value));
}

function writeNumber(value: number, path: string, out: string[]): void {
    if (!Number.isFinite(value)) {
        throw new CanonicalizationError(`Non-finite number ${value}`, path);
    }
    // Number.prototype.toString is the ECMAScript algorithm RFC 8785 mandates. `-0` collapses to
    // `0` so that two documents differing only in the sign of zero cannot produce two hashes.
    out.push(Object.is(value, -0) ? "0" : String(value));
}

function write(value: unknown, path: string, out: string[]): void {
    if (value === null) {
        out.push("null");
        return;
    }
    switch (typeof value) {
        case "string":
            writeString(value, out);
            return;
        case "number":
            writeNumber(value, path, out);
            return;
        case "boolean":
            out.push(value ? "true" : "false");
            return;
        case "bigint":
            throw new CanonicalizationError(
                "BigInt is not representable; use a decimal string",
                path,
            );
        case "object":
            break;
        default:
            throw new CanonicalizationError(
                `Unsupported value of type ${typeof value}`,
                path,
            );
    }

    if (Array.isArray(value)) {
        out.push("[");
        value.forEach((element, index) => {
            if (index > 0) out.push(",");
            write(
                element === undefined ? null : element,
                `${path}/${index}`,
                out,
            );
        });
        out.push("]");
        return;
    }

    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
        .filter(
            (key) =>
                record[key] !== undefined && typeof record[key] !== "function",
        )
        .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    out.push("{");
    keys.forEach((key, index) => {
        if (index > 0) out.push(",");
        writeString(key, out);
        out.push(":");
        write(
            record[key],
            `${path}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`,
            out,
        );
    });
    out.push("}");
}

/** Serializes `value` to its canonical JSON form. */
export function canonicalize(value: unknown): string {
    const out: string[] = [];
    write(value, "", out);
    return out.join("");
}

const encoder = new TextEncoder();

/** Returns `sha256:<hex>` over the canonical form of `value`. */
export function contentHash(value: unknown): string {
    return `sha256:${bytesToHex(sha256(encoder.encode(canonicalize(value))))}`;
}

/** Returns `sha256:<hex>` over raw bytes, for assets and uploads. */
export function bytesHash(bytes: Uint8Array): string {
    return `sha256:${bytesToHex(sha256(bytes))}`;
}

/**
 * Returns the lowercase SHA-1 Minecraft uses to identify a server resource-pack download.
 *
 * SHA-1 is retained here only as a protocol compatibility digest. It is not used as a security
 * primitive or as the browser's content-addressed asset identity.
 */
export function resourcePackSha1(bytes: Uint8Array): string {
    return bytesToHex(sha1(bytes));
}
