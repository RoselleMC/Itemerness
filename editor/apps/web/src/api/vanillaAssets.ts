import { invoke, isTauri } from "@tauri-apps/api/core";
import { unzip, zip } from "fflate";
import v12111 from "../../../../../tools/font-metrics/1.21.11.sources.json";
import v2611 from "../../../../../tools/font-metrics/26.1.1.sources.json";
import v2612 from "../../../../../tools/font-metrics/26.1.2.sources.json";
import v262 from "../../../../../tools/font-metrics/26.2.sources.json";
import { assetDigest, cachedAsset, cacheAsset } from "./assetCache.js";

const manifests = {
    "1.21.11": v12111,
    "26.1.1": v2611,
    "26.1.2": v2612,
    "26.2": v262,
};
export type VanillaVersion = keyof typeof manifests;
export const VANILLA_VERSIONS = Object.keys(manifests) as VanillaVersion[];
export const isVanillaVersion = (value: string): value is VanillaVersion =>
    Object.hasOwn(manifests, value);
export type VanillaPhase =
    "cache" | "download" | "assemble" | "cached" | "uncached";

async function verifiedDownload(
    url: string,
    sha1: string,
    signal?: AbortSignal,
): Promise<Uint8Array> {
    signal?.throwIfAborted();
    const buffer = isTauri()
        ? await invoke<ArrayBuffer>("download_asset", { url })
        : await (async () => {
              const response = await fetch(url, {
                  redirect: "error",
                  credentials: "omit",
                  signal: signal
                      ? AbortSignal.any([signal, AbortSignal.timeout(120_000)])
                      : AbortSignal.timeout(120_000),
              });
              if (!response.ok) throw new Error(`HTTP ${response.status}`);
              return response.arrayBuffer();
          })();
    const bytes = new Uint8Array(buffer);
    signal?.throwIfAborted();
    await verify(bytes, sha1);
    return bytes;
}

async function verify(bytes: Uint8Array, expected: string): Promise<void> {
    const actual = await assetDigest(bytes);
    if (actual !== expected) throw new Error("ASSET_HASH_MISMATCH");
}

/** Build in the client; no editor service or game-server asset proxy is involved. */
export async function fetchVanillaBundle(
    version: VanillaVersion = "26.1.2",
    progress: (phase: VanillaPhase) => void = () => {},
    signal?: AbortSignal,
): Promise<Uint8Array> {
    const manifest = manifests[version];
    if (!manifest) throw new Error("ASSET_VERSION_UNSUPPORTED");
    const cacheKey = `vanilla-v2:${version}:${manifest.client.sha1}:${manifest.assetIndex.sha1}`;
    progress("cache");
    const cached = await cachedAsset(cacheKey);
    signal?.throwIfAborted();
    if (cached) {
        progress("cached");
        return cached;
    }
    progress("download");
    const client = await verifiedDownload(
        manifest.client.url,
        manifest.client.sha1,
        signal,
    );
    const indexBytes = await verifiedDownload(
        manifest.assetIndex.url,
        manifest.assetIndex.sha1,
        signal,
    );
    const index = JSON.parse(new TextDecoder().decode(indexBytes))
        .objects as Record<string, { hash: string }>;
    const prefixes = [
        "assets/minecraft/textures/gui/sprites/tooltip/",
        "assets/minecraft/textures/item/",
        "assets/minecraft/models/item/",
        "assets/minecraft/models/block/",
        "assets/minecraft/items/",
    ];
    const pinned = manifest.clientResources as Record<string, string>;
    progress("assemble");
    const entries = await new Promise<Record<string, Uint8Array>>(
        (resolve, reject) =>
            unzip(
                client,
                {
                    filter: (entry) =>
                        entry.name in pinned ||
                        [
                            "pack.png",
                            "version.json",
                            "assets/minecraft/textures/misc/unknown_pack.png",
                        ].includes(entry.name) ||
                        prefixes.some((prefix) =>
                            entry.name.startsWith(prefix),
                        ),
                },
                (error, result) => (error ? reject(error) : resolve(result)),
            ),
    );
    for (const [name, hash] of Object.entries(pinned)) {
        if (!entries[name]) throw new Error("ASSET_MISSING");
        await verify(entries[name], hash);
    }
    for (const [name, hash] of Object.entries(manifest.assetResources)) {
        if (index[name]?.hash !== hash) throw new Error("ASSET_INDEX_MISMATCH");
        entries[`assets/${name}`] = await verifiedDownload(
            `https://resources.download.minecraft.net/${hash.slice(0, 2)}/${hash}`,
            hash,
            signal,
        );
    }
    const versionInfo = JSON.parse(
        new TextDecoder().decode(entries["version.json"]),
    );
    const packVersion = versionInfo.pack_version;
    entries["pack.mcmeta"] = new TextEncoder().encode(
        JSON.stringify({
            pack: {
                pack_format: packVersion.resource_major ?? packVersion.resource,
                description: `Vanilla ${manifest.clientVersion}`,
            },
        }),
    );
    const bytes = await new Promise<Uint8Array>((resolve, reject) =>
        zip(entries, { level: 6 }, (error, bytes) =>
            error ? reject(error) : resolve(bytes),
        ),
    );
    signal?.throwIfAborted();
    progress((await cacheAsset(cacheKey, bytes)) ? "cached" : "uncached");
    return bytes;
}
