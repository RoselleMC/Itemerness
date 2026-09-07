#!/usr/bin/env node
/**
 * Opens the editor in a real browser window and leaves it there.
 *
 * Starts disconnected unless E2E_PLUGIN_URL is explicitly supplied. No example document is seeded.
 * E2E_PLUGIN_TOKEN is optional; runtime verification must use the project's authorized test host.
 *
 * Usage:
 *   node scripts/demo.mjs [url]
 *
 * Defaults to the static development UI at http://127.0.0.1:5173.
 * Ctrl-C closes the browser.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const url =
    process.argv[2] ?? process.env.E2E_BASE_URL ?? "http://127.0.0.1:5173";
const bundle = fileURLToPath(
    new URL("../../../vanilla-cache/vanilla-26.1.2.zip", import.meta.url),
);

const browser = await chromium.launch({
    headless: false,
    args: ["--window-size=1720,1080"],
});
const context = await browser.newContext({ viewport: null });
const page = await context.newPage();

process.stderr.write(`opening ${url}\n`);
await page.goto(url, { waitUntil: "domcontentloaded" });

if (process.env.E2E_PLUGIN_URL) {
    await page.getByTestId("connection-trigger").click();
    await page.getByTestId("plugin-api-url").fill(process.env.E2E_PLUGIN_URL);
    await page
        .getByTestId("plugin-api-token")
        .fill(process.env.E2E_PLUGIN_TOKEN ?? "");
    await page.getByTestId("connect-plugin").click();
    await page.waitForFunction(
        () =>
            document
                .querySelector('[data-testid="workspace"]')
                ?.getAttribute("data-ready") === "true" ||
            document
                .querySelector('[data-testid="document-sync-status"]')
                ?.getAttribute("data-sync-kind") === "empty" ||
            document
                .querySelector('[data-testid="connection-trigger"]')
                ?.getAttribute("data-state") === "error",
    );
    await page.getByTestId("close-connection").click();
}
const ready =
    (await page.getByTestId("workspace").getAttribute("data-ready")) === "true";

if (ready && existsSync(bundle)) {
    // Mounting happens entirely in the page; the file never leaves this machine.
    await page.getByTestId("open-assets").click();
    await page.getByTestId("asset-file-input").setInputFiles(bundle);
    await page.getByTestId("pack-list").waitFor({ timeout: 60_000 });
    process.stderr.write("mounted vanilla 26.1.2 assets\n");
    await page.getByTestId("mode-items").click();
}

process.stderr.write(
    `${ready ? "plugin document loaded" : "no plugin document loaded"}\nbrowser is open; press Ctrl-C to close it\n`,
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
