import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end configuration.
 *
 * CI runs against the same static SPA embedded by Tauri. Screenshots are renderer goldens:
 * the browser preview is stable across changes. They are not evidence about the Minecraft client,
 * and the specs say so where they are taken.
 */
export default defineConfig({
    testDir: "./e2e",
    // Canvas PNGs contain resource-pack pixels, not OS-rendered text or window decorations.
    snapshotPathTemplate:
        "{testDir}/{testFilePath}-snapshots/{arg}-{projectName}{ext}",
    timeout: 60_000,
    expect: { timeout: 10_000 },
    fullyParallel: false,
    workers: 1,
    reporter: process.env.CI
        ? [["github"], ["list"], ["html", { open: "never" }]]
        : [["list"]],
    use: {
        baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:5173",
        trace: "retain-on-failure",
        viewport: { width: 1600, height: 1000 },
        deviceScaleFactor: 1,
    },
    projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
    webServer: process.env.E2E_BASE_URL
        ? undefined
        : {
              command: process.env.CI
                  ? "pnpm preview --host 127.0.0.1 --port 5173 --strictPort"
                  : "pnpm dev",
              url: "http://127.0.0.1:5173",
              reuseExistingServer: !process.env.CI,
          },
});
