import { unzipSync } from "fflate";
import { bytesHash, resourcePackSha1 } from "@itemerness/protocol";

/**
 * A virtual file system over a stack of mounted resource packs.
 *
 * Mounting is how the browser stops guessing. Font advances, glyph pixels, tooltip sprites, and
 * item textures are all resource-pack data; without them a preview is a stylized drawing. With
 * them, the browser reads the same bytes the client would.
 *
 * Priority runs from index 0 downwards, matching Minecraft's pack list: the pack at the top of the
 * list wins, and the vanilla base sits at the bottom. Overrides are per file, not per key inside a
 * file, which is also what the client does for `assets/<ns>/font/<name>.json`.
 */

export interface ResourceLocation {
    readonly namespace: string;
    readonly path: string;
}

export class ResourceLocationError extends Error {}

const LOCATION_PATTERN = /^(?:([a-z0-9_.-]+):)?([a-z0-9_./-]+)$/;

/** Parses `namespace:path`, defaulting the namespace to `minecraft` as the client does. */
export function parseLocation(value: string): ResourceLocation {
    const match = LOCATION_PATTERN.exec(value);
    if (!match)
        throw new ResourceLocationError(`Invalid resource location: ${value}`);
    const path = match[2]!;
    if (path.includes(".."))
        throw new ResourceLocationError(
            `Resource location escapes its root: ${value}`,
        );
    return { namespace: match[1] ?? "minecraft", path };
}

export function locationToString(location: ResourceLocation): string {
    return `${location.namespace}:${location.path}`;
}

/** `assets/<namespace>/<prefix><path>` — the layout inside a pack or a client jar. */
export function assetPath(location: ResourceLocation, prefix = ""): string {
    return `assets/${location.namespace}/${prefix}${location.path}`;
}

export interface PackMeta {
    readonly packFormat: number | null;
    readonly description: string | null;
    readonly supportedFormats: readonly number[] | null;
}

export type PackKind = "vanilla" | "resource-pack";

export interface MountedPack {
    /** Content-addressed identity, so the same file mounted twice is recognised. */
    readonly id: string;
    /** Exact archive digest compared with a document resource-pack binding. */
    readonly sha1: string;
    readonly name: string;
    readonly kind: PackKind;
    readonly meta: PackMeta | null;
    readonly byteLength: number;
    has(path: string): boolean;
    read(path: string): Uint8Array | undefined;
    list(prefix: string): readonly string[];
}

export class PackMountError extends Error {}

const MAX_PACK_BYTES = 512 * 1024 * 1024;
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_EXPANDED_PACK_BYTES = 512 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 65_000;

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;
const ZIP64_EXTRA_FIELD = 0x0001;
const AES_EXTRA_FIELD = 0x9901;
const MAX_ZIP_COMMENT_BYTES = 65_535;

function archiveView(bytes: Uint8Array): DataView {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function findEndOfCentralDirectory(bytes: Uint8Array, view: DataView): number {
    const minimum = Math.max(0, bytes.byteLength - 22 - MAX_ZIP_COMMENT_BYTES);
    for (let offset = bytes.byteLength - 22; offset >= minimum; offset -= 1) {
        if (view.getUint32(offset, true) !== END_OF_CENTRAL_DIRECTORY) continue;
        const commentLength = view.getUint16(offset + 20, true);
        if (offset + 22 + commentLength === bytes.byteLength) return offset;
    }
    return -1;
}

function containsForbiddenExtraField(
    view: DataView,
    start: number,
    length: number,
): "ZIP64" | "encrypted" | null {
    const end = start + length;
    let cursor = start;
    while (cursor < end) {
        if (cursor + 4 > end) return "ZIP64";
        const header = view.getUint16(cursor, true);
        const dataLength = view.getUint16(cursor + 2, true);
        cursor += 4;
        if (cursor + dataLength > end) return "ZIP64";
        if (header === ZIP64_EXTRA_FIELD) return "ZIP64";
        if (header === AES_EXTRA_FIELD) return "encrypted";
        cursor += dataLength;
    }
    return null;
}

/**
 * Reads the central directory before `fflate` sees the archive.
 *
 * Synchronous inflate must never be the operation that discovers a resource limit: by then a
 * forged archive may already have reserved its claimed output. Classic ZIP gives us every size and
 * entry count in a bounded tail structure, so reject unsupported or excessive claims first.
 */
function validateArchiveDirectory(bytes: Uint8Array, label: string): void {
    if (bytes.byteLength < 22) {
        throw new PackMountError(
            `${label} is not a readable archive: missing ZIP directory`,
        );
    }
    const view = archiveView(bytes);
    const endOffset = findEndOfCentralDirectory(bytes, view);
    if (endOffset < 0) {
        throw new PackMountError(
            `${label} is not a readable archive: missing ZIP directory`,
        );
    }

    const diskNumber = view.getUint16(endOffset + 4, true);
    const directoryDisk = view.getUint16(endOffset + 6, true);
    const entriesOnDisk = view.getUint16(endOffset + 8, true);
    const entryCount = view.getUint16(endOffset + 10, true);
    const directorySize = view.getUint32(endOffset + 12, true);
    const directoryOffset = view.getUint32(endOffset + 16, true);
    if (
        entriesOnDisk === 0xffff ||
        entryCount === 0xffff ||
        directorySize === 0xffffffff ||
        directoryOffset === 0xffffffff
    ) {
        throw new PackMountError(`${label} uses unsupported ZIP64 metadata`);
    }
    if (
        diskNumber !== 0 ||
        directoryDisk !== 0 ||
        entriesOnDisk !== entryCount
    ) {
        throw new PackMountError(
            `${label} uses an unsupported multi-disk ZIP layout`,
        );
    }
    if (entryCount > MAX_ARCHIVE_ENTRIES) {
        throw new PackMountError(
            `${label} exceeds the ${MAX_ARCHIVE_ENTRIES} archive entry limit`,
        );
    }
    const directoryEnd = directoryOffset + directorySize;
    if (directoryEnd !== endOffset || directoryEnd > bytes.byteLength) {
        throw new PackMountError(
            `${label} has an invalid ZIP central directory`,
        );
    }

    let cursor = directoryOffset;
    let totalExpandedBytes = 0;
    for (let index = 0; index < entryCount; index += 1) {
        if (
            cursor + 46 > directoryEnd ||
            view.getUint32(cursor, true) !== CENTRAL_DIRECTORY_ENTRY
        ) {
            throw new PackMountError(
                `${label} has an invalid ZIP central directory entry`,
            );
        }
        const flags = view.getUint16(cursor + 8, true);
        const compressedSize = view.getUint32(cursor + 20, true);
        const expandedSize = view.getUint32(cursor + 24, true);
        const nameLength = view.getUint16(cursor + 28, true);
        const extraLength = view.getUint16(cursor + 30, true);
        const commentLength = view.getUint16(cursor + 32, true);
        const entryDisk = view.getUint16(cursor + 34, true);
        const localOffset = view.getUint32(cursor + 42, true);
        const recordEnd =
            cursor + 46 + nameLength + extraLength + commentLength;
        if (recordEnd > directoryEnd) {
            throw new PackMountError(
                `${label} has a truncated ZIP central directory entry`,
            );
        }
        if (flags & 0x0041) {
            throw new PackMountError(
                `${label} contains an encrypted ZIP entry`,
            );
        }
        if (
            compressedSize === 0xffffffff ||
            expandedSize === 0xffffffff ||
            localOffset === 0xffffffff ||
            entryDisk === 0xffff
        ) {
            throw new PackMountError(
                `${label} uses unsupported ZIP64 metadata`,
            );
        }
        const forbiddenExtra = containsForbiddenExtraField(
            view,
            cursor + 46 + nameLength,
            extraLength,
        );
        if (forbiddenExtra === "ZIP64") {
            throw new PackMountError(
                `${label} uses unsupported ZIP64 metadata`,
            );
        }
        if (forbiddenExtra === "encrypted") {
            throw new PackMountError(
                `${label} contains an encrypted ZIP entry`,
            );
        }
        if (entryDisk !== 0) {
            throw new PackMountError(
                `${label} uses an unsupported multi-disk ZIP layout`,
            );
        }
        if (expandedSize > MAX_ENTRY_BYTES) {
            throw new PackMountError(
                `${label} contains an entry exceeding the ${MAX_ENTRY_BYTES} byte expansion limit`,
            );
        }
        totalExpandedBytes += expandedSize;
        if (totalExpandedBytes > MAX_EXPANDED_PACK_BYTES) {
            throw new PackMountError(
                `${label} exceeds the ${MAX_EXPANDED_PACK_BYTES} byte total expansion limit`,
            );
        }

        if (
            localOffset + 30 > directoryOffset ||
            view.getUint32(localOffset, true) !== LOCAL_FILE_HEADER
        ) {
            throw new PackMountError(
                `${label} has an invalid ZIP local file header`,
            );
        }
        const localFlags = view.getUint16(localOffset + 6, true);
        const localCompressedSize = view.getUint32(localOffset + 18, true);
        const localExpandedSize = view.getUint32(localOffset + 22, true);
        const localNameLength = view.getUint16(localOffset + 26, true);
        const localExtraLength = view.getUint16(localOffset + 28, true);
        const localDataOffset =
            localOffset + 30 + localNameLength + localExtraLength;
        if (localFlags & 0x0041) {
            throw new PackMountError(
                `${label} contains an encrypted ZIP entry`,
            );
        }
        if (localDataOffset + compressedSize > directoryOffset) {
            throw new PackMountError(
                `${label} has an invalid ZIP entry boundary`,
            );
        }
        const localForbiddenExtra = containsForbiddenExtraField(
            view,
            localOffset + 30 + localNameLength,
            localExtraLength,
        );
        if (localForbiddenExtra === "ZIP64") {
            throw new PackMountError(
                `${label} uses unsupported ZIP64 metadata`,
            );
        }
        if (localForbiddenExtra === "encrypted") {
            throw new PackMountError(
                `${label} contains an encrypted ZIP entry`,
            );
        }
        // Bit 3 means the sizes intentionally live in the trailing descriptor and central entry.
        if (
            !(localFlags & 0x0008) &&
            (localCompressedSize !== compressedSize ||
                localExpandedSize !== expandedSize)
        ) {
            throw new PackMountError(
                `${label} has inconsistent ZIP entry sizes`,
            );
        }
        cursor = recordEnd;
    }
    if (cursor !== directoryEnd) {
        throw new PackMountError(
            `${label} has an invalid ZIP central directory size`,
        );
    }
}

function readPackMeta(
    read: (path: string) => Uint8Array | undefined,
): PackMeta | null {
    const raw = read("pack.mcmeta");
    if (!raw) return null;
    try {
        const parsed = JSON.parse(new TextDecoder().decode(raw)) as {
            pack?: {
                pack_format?: unknown;
                description?: unknown;
                supported_formats?: unknown;
            };
        };
        const pack = parsed.pack ?? {};
        const supported = Array.isArray(pack.supported_formats)
            ? pack.supported_formats.filter(
                  (entry): entry is number => typeof entry === "number",
              )
            : null;
        return {
            packFormat:
                typeof pack.pack_format === "number" ? pack.pack_format : null,
            description:
                typeof pack.description === "string" ? pack.description : null,
            supportedFormats: supported,
        };
    } catch {
        // A malformed pack.mcmeta is worth surfacing, but it must not stop the pack from mounting:
        // most of what this engine needs lives under assets/ and is readable regardless.
        return null;
    }
}

/**
 * Mounts a `.zip` or `.jar` held entirely in memory.
 *
 * Entries are rejected rather than sanitised when they try to escape the archive root, and both
 * total and per-entry sizes are bounded. A resource pack is untrusted input that arrives by drag
 * and drop, so a zip bomb or a `../` path is an expected case, not a theoretical one.
 */
export function mountArchive(
    bytes: Uint8Array,
    options: { name: string; kind?: PackKind },
): MountedPack {
    if (bytes.byteLength > MAX_PACK_BYTES) {
        throw new PackMountError(
            `${options.name} exceeds the ${MAX_PACK_BYTES} byte mount limit`,
        );
    }
    validateArchiveDirectory(bytes, options.name);
    let entries: Record<string, Uint8Array>;
    try {
        entries = unzipSync(bytes);
    } catch (error) {
        throw new PackMountError(
            `${options.name} is not a readable archive: ${(error as Error).message}`,
        );
    }

    const files = new Map<string, Uint8Array>();
    for (const [rawName, data] of Object.entries(entries)) {
        if (rawName.endsWith("/")) continue;
        const name = rawName.replace(/\\/g, "/");
        if (name.startsWith("/") || name.split("/").includes("..")) {
            throw new PackMountError(
                `${options.name} contains an entry that escapes the archive root: ${rawName}`,
            );
        }
        if (data.byteLength > MAX_ENTRY_BYTES) {
            throw new PackMountError(
                `${options.name} entry ${name} exceeds the per-entry size limit`,
            );
        }
        files.set(name, data);
    }

    const read = (path: string) => files.get(path);
    const sortedNames = [...files.keys()].sort();
    return {
        id: bytesHash(bytes),
        sha1: resourcePackSha1(bytes),
        name: options.name,
        kind: options.kind ?? "resource-pack",
        meta: readPackMeta(read),
        byteLength: bytes.byteLength,
        has: (path) => files.has(path),
        read,
        list(prefix) {
            return sortedNames.filter((name) => name.startsWith(prefix));
        },
    };
}

/** An ordered stack of packs, highest priority first. */
export class PackStack {
    constructor(readonly packs: readonly MountedPack[] = []) {}

    with(pack: MountedPack): PackStack {
        return new PackStack([
            pack,
            ...this.packs.filter((existing) => existing.id !== pack.id),
        ]);
    }

    without(packId: string): PackStack {
        return new PackStack(this.packs.filter((pack) => pack.id !== packId));
    }

    reordered(packIds: readonly string[]): PackStack {
        const byId = new Map(this.packs.map((pack) => [pack.id, pack]));
        const ordered = packIds.flatMap((id) =>
            byId.has(id) ? [byId.get(id)!] : [],
        );
        const remaining = this.packs.filter(
            (pack) => !packIds.includes(pack.id),
        );
        return new PackStack([...ordered, ...remaining]);
    }

    get isEmpty(): boolean {
        return this.packs.length === 0;
    }

    /** Returns the highest-priority pack that provides `path`. */
    resolve(
        path: string,
    ): { pack: MountedPack; bytes: Uint8Array } | undefined {
        for (const pack of this.packs) {
            const bytes = pack.read(path);
            if (bytes) return { pack, bytes };
        }
        return undefined;
    }

    read(path: string): Uint8Array | undefined {
        return this.resolve(path)?.bytes;
    }

    readJson<T>(path: string): T | undefined {
        const bytes = this.read(path);
        if (!bytes) return undefined;
        return JSON.parse(new TextDecoder().decode(bytes)) as T;
    }

    /** All namespaces that appear under `assets/` in any mounted pack. */
    namespaces(): readonly string[] {
        const found = new Set<string>();
        for (const pack of this.packs) {
            for (const name of pack.list("assets/")) {
                const namespace = name.slice("assets/".length).split("/")[0];
                if (namespace) found.add(namespace);
            }
        }
        return [...found].sort();
    }

    /** Union of entries under a prefix across the stack, deduplicated by path. */
    listAll(prefix: string): readonly string[] {
        const found = new Set<string>();
        for (const pack of this.packs)
            for (const name of pack.list(prefix)) found.add(name);
        return [...found].sort();
    }

    /** A digest of the mounted stack, usable as a cache key for derived font tables. */
    get digest(): string {
        return this.packs.map((pack) => pack.id).join("|") || "empty";
    }
}
