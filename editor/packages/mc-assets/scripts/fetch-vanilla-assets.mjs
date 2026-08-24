#!/usr/bin/env node
/**
 * Builds the local vanilla asset bundle used by the metrics cross-check and by local preview work.
 *
 * Mojang assets are never committed. This script downloads only the files pinned in
 * `tools/font-metrics/26.1.2.sources.json` plus the GUI and item textures the preview needs,
 * verifies every SHA-1 the manifest declares, and writes one zip into a gitignored cache. The
 * control plane's CDN proxy performs the same steps server-side for users who prefer not to hunt
 * down a client jar.
 *
 * Usage: node scripts/fetch-vanilla-assets.mjs [--out <path>]
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync, zipSync } from "fflate";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../..");
const manifestPath = resolve(
    repoRoot,
    "tools/font-metrics/26.1.2.sources.json",
);

const outFlag = process.argv.indexOf("--out");
const outputPath =
    outFlag >= 0 && process.argv[outFlag + 1]
        ? resolve(process.argv[outFlag + 1])
        : resolve(repoRoot, "editor/vanilla-cache/vanilla-26.1.2.zip");

const sha1 = (bytes) => createHash("sha1").update(bytes).digest("hex");

async function download(url, label) {
    process.stderr.write(`fetching ${label}\n`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${label}: HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
}

function requireSha1(label, bytes, expected) {
    const actual = sha1(bytes);
    if (actual !== expected)
        throw new Error(
            `${label} SHA-1 mismatch: expected ${expected}, got ${actual}`,
        );
}

/** Extra client-jar prefixes the preview renderer needs but the metrics manifest does not pin. */
const EXTRA_PREFIXES = [
    "assets/minecraft/textures/gui/sprites/tooltip/",
    "assets/minecraft/textures/item/",
    "assets/minecraft/models/item/",
    // Block models are bundled without their textures: the resolver needs the parent chain to
    // prove an item is a 3D block model rather than reporting it as a missing file.
    "assets/minecraft/models/block/",
    "assets/minecraft/items/",
    "assets/minecraft/lang/en_us.json",
    "assets/minecraft/lang/zh_cn.json",
];

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (manifest.schemaVersion !== 1)
    throw new Error("Unsupported font source manifest");

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
const assetIndex = JSON.parse(new TextDecoder().decode(indexBytes)).objects;

const clientEntries = unzipSync(clientBytes);
const bundle = {};

for (const [name, expected] of Object.entries(manifest.clientResources)) {
    const data = clientEntries[name];
    if (!data) throw new Error(`Client JAR is missing ${name}`);
    requireSha1(name, data, expected);
    bundle[name] = data;
}

let extraCount = 0;
for (const name of Object.keys(clientEntries)) {
    if (name.endsWith("/")) continue;
    if (!EXTRA_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
    bundle[name] = clientEntries[name];
    extraCount += 1;
}

for (const [name, expected] of Object.entries(manifest.assetResources)) {
    const indexed = assetIndex[name];
    if (!indexed || indexed.hash !== expected)
        throw new Error(`Asset index does not map ${name} to ${expected}`);
    const data = await download(
        `https://resources.download.minecraft.net/${expected.slice(0, 2)}/${expected}`,
        `asset object ${name}`,
    );
    requireSha1(name, data, expected);
    bundle[`assets/${name}`] = data;
}

bundle["pack.mcmeta"] = new TextEncoder().encode(
    JSON.stringify(
        {
            pack: {
                pack_format: 0,
                description: `Vanilla ${manifest.clientVersion} font, GUI, and item assets (locally cached, not redistributed)`,
            },
        },
        null,
        2,
    ),
);

mkdirSync(dirname(outputPath), { recursive: true });
const zipped = zipSync(bundle, { level: 6 });
writeFileSync(outputPath, zipped);

process.stderr.write(
    `wrote ${outputPath} (${zipped.byteLength} bytes, ${Object.keys(bundle).length} entries, ${extraCount} extra client textures)\n`,
);
