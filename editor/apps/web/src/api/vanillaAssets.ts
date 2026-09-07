import { invoke, isTauri } from "@tauri-apps/api/core";
import { unzip, zip } from "fflate";
import manifest from "../../../../../tools/font-metrics/26.1.2.sources.json";

async function verifiedDownload(
    url: string,
    sha1: string,
): Promise<Uint8Array> {
    const buffer = isTauri()
        ? await invoke<ArrayBuffer>("download_asset", { url })
        : await (async () => {
              const response = await fetch(url, {
                  redirect: "error",
                  credentials: "omit",
                  signal: AbortSignal.timeout(120_000),
              });
              if (!response.ok) throw new Error(`HTTP ${response.status}`);
              return response.arrayBuffer();
          })();
    const bytes = new Uint8Array(buffer);
    await verify(bytes, sha1);
    return bytes;
}

async function verify(bytes: Uint8Array, expected: string): Promise<void> {
    const digest = await crypto.subtle.digest("SHA-1", new Uint8Array(bytes));
    const actual = [...new Uint8Array(digest)]
        .map((value) => value.toString(16).padStart(2, "0"))
        .join("");
    if (actual !== expected) throw new Error("ASSET_HASH_MISMATCH");
}

/** Build in the client; no editor service or game-server asset proxy is involved. */
export async function fetchVanillaBundle(): Promise<Uint8Array> {
    const client = await verifiedDownload(
        manifest.client.url,
        manifest.client.sha1,
    );
    const indexBytes = await verifiedDownload(
        manifest.assetIndex.url,
        manifest.assetIndex.sha1,
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
    const entries = await new Promise<Record<string, Uint8Array>>(
        (resolve, reject) =>
            unzip(
                client,
                {
                    filter: (entry) =>
                        entry.name in pinned ||
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
        );
    }
    entries["pack.mcmeta"] = new TextEncoder().encode(
        JSON.stringify({
            pack: {
                pack_format: 0,
                description: `Vanilla ${manifest.clientVersion}`,
            },
        }),
    );
    return new Promise((resolve, reject) =>
        zip(entries, { level: 6 }, (error, bytes) =>
            error ? reject(error) : resolve(bytes),
        ),
    );
}
