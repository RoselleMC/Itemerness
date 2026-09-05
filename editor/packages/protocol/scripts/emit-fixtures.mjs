#!/usr/bin/env node
/**
 * Emits the golden fixture as JSON plus its canonical hash.
 *
 * The JSON is what the JVM codec test reads; the hash file is what proves both languages
 * canonicalize the same document to the same bytes. Regenerate with
 * `pnpm --filter @itemerness/protocol gen:fixtures` and commit both files.
 */
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { register } = require("tsx/esm/api");
const unregister = register();

const { baselineDocument } = await import(
    pathToFileURL(resolve(here, "../fixtures/baseline.ts")).href
);
const { canonicalize, contentHash } = await import(
    pathToFileURL(resolve(here, "../src/canonical.ts")).href
);
await unregister();

const jsonPath = resolve(here, "../fixtures/baseline.json");
const hashPath = resolve(here, "../fixtures/baseline.sha256");

writeFileSync(jsonPath, `${JSON.stringify(baselineDocument, null, 2)}\n`);
writeFileSync(hashPath, `${contentHash(baselineDocument)}\n`);

process.stderr.write(
    `wrote ${jsonPath} (${canonicalize(baselineDocument).length} canonical bytes)\n` +
        `wrote ${hashPath} (${contentHash(baselineDocument)})\n`,
);
