import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { unzipSync, zipSync } from "fflate";

/**
 * Server-side vanilla asset proxy.
 *
 * Mojang assets are not redistributed with this project, so the control plane fetches them on
 * demand from the official CDN using the URLs and digests pinned in
 * `tools/font-metrics/26.1.2.sources.json` — the same manifest the metrics artifact was generated
 * from. Every download is SHA-1 verified against that manifest before anything is cached or
 * served, so a poisoned mirror cannot quietly change a glyph advance.
 *
 * The result is one content-addressed bundle holding only the font, GUI, and item assets the
 * preview needs, which the browser mounts like any other resource pack.
 */

export interface SourceManifest {
    readonly schemaVersion: number;
    readonly clientVersion: string;
    readonly client: { sha1: string; url: string };
    readonly assetIndex: { id: string; sha1: string; url: string };
    readonly clientResources: Record<string, string>;
    readonly assetResources: Record<string, string>;
}

const EXTRA_PREFIXES = [
    "assets/minecraft/textures/gui/sprites/tooltip/",
    "assets/minecraft/textures/item/",
    "assets/minecraft/models/item/",
    "assets/minecraft/models/block/",
    "assets/minecraft/items/",
];

const sha1 = (bytes: Uint8Array) =>
    createHash("sha1").update(bytes).digest("hex");

export class VanillaAssetError extends Error {}

async function download(url: string, label: string): Promise<Uint8Array> {
    const response = await fetch(url);
    if (!response.ok)
        throw new VanillaAssetError(`${label}: HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
}

function requireSha1(label: string, bytes: Uint8Array, expected: string): void {
    const actual = sha1(bytes);
    if (actual !== expected) {
        throw new VanillaAssetError(
            `${label} SHA-1 mismatch: expected ${expected}, got ${actual}`,
        );
    }
}

export interface VanillaAssetOptions {
    /** Where `26.1.2.sources.json` lives, relative to the repository root. */
    readonly manifestPath: string;
    /** Directory for the derived bundle. Ephemeral container disks are fine; it is a cache. */
    readonly cacheDirectory: string;
    /** Set false in air-gapped deployments; the endpoint then reports unavailable. */
    readonly allowNetwork: boolean;
}

export class VanillaAssetService {
    private building: Promise<Uint8Array> | null = null;

    constructor(private readonly options: VanillaAssetOptions) {}

    private get bundlePath(): string {
        return resolve(this.options.cacheDirectory, "vanilla-bundle.zip");
    }

    async manifest(): Promise<SourceManifest> {
        const raw = await readFile(resolve(this.options.manifestPath), "utf8");
        const manifest = JSON.parse(raw) as SourceManifest;
        if (manifest.schemaVersion !== 1)
            throw new VanillaAssetError("Unsupported font source manifest");
        return manifest;
    }

    /** Returns the cached bundle, building it once if several requests race. */
    async bundle(version: string): Promise<Uint8Array> {
        const manifest = await this.manifest();
        if (version !== manifest.clientVersion) {
            throw new VanillaAssetError(
                `Only ${manifest.clientVersion} assets are pinned by this deployment`,
            );
        }
        if (existsSync(this.bundlePath))
            return new Uint8Array(await readFile(this.bundlePath));
        if (!this.options.allowNetwork) {
            throw new VanillaAssetError(
                "Outbound asset fetching is disabled; mount a client jar in the browser instead",
            );
        }
        this.building ??= this.build(manifest).finally(() => {
            this.building = null;
        });
        return this.building;
    }

    private async build(manifest: SourceManifest): Promise<Uint8Array> {
        const clientBytes = await download(
            manifest.client.url,
            `client.jar ${manifest.clientVersion}`,
        );
        requireSha1("client JAR", clientBytes, manifest.client.sha1);

        const indexBytes = await download(
            manifest.assetIndex.url,
            `asset index ${manifest.assetIndex.id}`,
        );
        requireSha1("asset index", indexBytes, manifest.assetIndex.sha1);
        const assetIndex = JSON.parse(new TextDecoder().decode(indexBytes))
            .objects as Record<string, { hash: string }>;

        const clientEntries = unzipSync(clientBytes);
        const bundle: Record<string, Uint8Array> = {};

        for (const [name, expected] of Object.entries(
            manifest.clientResources,
        )) {
            const data = clientEntries[name];
            if (!data)
                throw new VanillaAssetError(`Client JAR is missing ${name}`);
            requireSha1(name, data, expected);
            bundle[name] = data;
        }
        for (const name of Object.keys(clientEntries)) {
            if (name.endsWith("/")) continue;
            if (!EXTRA_PREFIXES.some((prefix) => name.startsWith(prefix)))
                continue;
            bundle[name] = clientEntries[name]!;
        }
        for (const [name, expected] of Object.entries(
            manifest.assetResources,
        )) {
            const indexed = assetIndex[name];
            if (!indexed || indexed.hash !== expected) {
                throw new VanillaAssetError(
                    `Asset index does not map ${name} to ${expected}`,
                );
            }
            const data = await download(
                `https://resources.download.minecraft.net/${expected.slice(0, 2)}/${expected}`,
                `asset object ${name}`,
            );
            requireSha1(name, data, expected);
            bundle[`assets/${name}`] = data;
        }
        bundle["pack.mcmeta"] = new TextEncoder().encode(
            JSON.stringify({
                pack: {
                    pack_format: 0,
                    description: `Vanilla ${manifest.clientVersion} assets (fetched from Mojang, not redistributed)`,
                },
            }),
        );

        const zipped = zipSync(bundle, { level: 6 });
        await mkdir(dirname(this.bundlePath), { recursive: true });
        await writeFile(this.bundlePath, zipped);
        return zipped;
    }
}

export function defaultVanillaOptions(
    repositoryRoot: string,
): VanillaAssetOptions {
    return {
        manifestPath: join(
            repositoryRoot,
            "tools/font-metrics/26.1.2.sources.json",
        ),
        cacheDirectory:
            process.env.ITEMERNESS_ASSET_CACHE ??
            join(repositoryRoot, "editor/vanilla-cache"),
        allowNetwork: process.env.ITEMERNESS_ALLOW_ASSET_FETCH !== "false",
    };
}
