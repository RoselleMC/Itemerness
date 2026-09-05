#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = resolve(
    repositoryRoot,
    "resource-pack/assets/itemerness/font/spacing.json",
);
const advances = {};

for (let advance = -256; advance <= -1; advance += 1) {
    advances[String.fromCodePoint(0xe300 + (advance + 256))] = advance;
}
for (let advance = 1; advance <= 256; advance += 1) {
    advances[String.fromCodePoint(0xe400 + (advance - 1))] = advance;
}

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(
    outputPath,
    `${JSON.stringify({ providers: [{ type: "space", advances }] }, null, 4)}\n`,
    "utf8",
);
process.stdout.write(`${outputPath}\n`);
