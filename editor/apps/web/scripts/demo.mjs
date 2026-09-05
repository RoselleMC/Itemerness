#!/usr/bin/env node
/**
 * Opens the editor in a real browser window and leaves it there.
 *
 * The point is to see the thing rather than read about it: the script mounts the local vanilla
 * asset bundle so glyphs are drawn from the real font textures, selects an item, and then stops
 * touching the page. Everything after that is yours to click.
 *
 * Usage:
 *   node scripts/demo.mjs [url]
 *
 * Defaults to http://127.0.0.1:8080. Point it at an SSH tunnel to drive a remote deployment.
 * Ctrl-C closes the browser.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const url =
    process.argv[2] ?? process.env.E2E_BASE_URL ?? "http://127.0.0.1:8080";
const bundle = fileURLToPath(
    new URL("../../../vanilla-cache/vanilla-1.21.11.zip", import.meta.url),
);

const browser = await chromium.launch({
    headless: false,
    args: ["--window-size=1720,1080"],
});
const context = await browser.newContext({ viewport: null });
const page = await context.newPage();

async function status() {
    try {
        const response = await page.request.get(`${url}/api/v1/agent/status`);
        if (!response.ok()) return "unreachable";
        const body = await response.json();
        return body.connected
            ? `agent (${body.serverId})`
            : "no agent connected";
    } catch {
        return "unreachable";
    }
}

process.stderr.write(`opening ${url}\n`);
await page.goto(url, { waitUntil: "domcontentloaded" });
process.stderr.write(`control plane: ${await status()}\n`);

if (existsSync(bundle)) {
    // Mounting happens entirely in the page; the file never leaves this machine.
    await page.getByTestId("open-assets").click();
    await page.getByTestId("asset-file-input").setInputFiles(bundle);
    await page.getByTestId("pack-list").waitFor({ timeout: 60_000 });
    process.stderr.write("mounted vanilla 1.21.11 assets\n");
    await page.getByTestId("close-overlay").click();
} else {
    process.stderr.write(
        `no vanilla bundle at ${bundle}\n` +
            "run: node packages/mc-assets/scripts/fetch-vanilla-assets.mjs\n" +
            "the preview still has exact metrics, but glyphs will be drawn as ink-bound blocks\n",
    );
}

await page.getByTestId("item-ember-blade").click();
await page.getByTestId("gui-scale-3").click();

// The badge only flips once a target server has compiled this exact draft snapshot, which takes a
// debounce plus a round trip. Reading it immediately would report "Local" and mean nothing.
let origin = "";
for (let attempt = 0; attempt < 60; attempt += 1) {
    origin = (await page.getByTestId("preview-origin").textContent()) ?? "";
    if (origin === "Server verified" || origin === "服务器已验证") break;
    await page.waitForTimeout(500);
}
process.stderr.write(
    `preview origin: ${origin || "unknown"}\n` +
        `tooltip size  : ${await page.getByTestId("tooltip-size").textContent()}\n` +
        `theme         : ${await page.getByTestId("selected-theme").textContent()}\n` +
        "browser is open; press Ctrl-C to close it\n",
);

const close = async () => {
    await browser.close().catch(() => {});
    process.exit(0);
};
process.on("SIGINT", close);
process.on("SIGTERM", close);
browser.on("disconnected", () => process.exit(0));

// Hold the process open so the window stays up.
await new Promise(() => {});
