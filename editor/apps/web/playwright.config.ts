import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end configuration.
 *
 * The suite runs against the built SPA served by the control plane, which is the same topology a
 * self-hosted deployment uses. Screenshots taken here are goldens for *this renderer*: they prove
 * the browser preview is stable across changes. They are not evidence about the Minecraft client,
 * and the specs say so where they are taken.
 */
export default defineConfig({
    testDir: "./e2e",
    timeout: 60_000,
    expect: { timeout: 10_000 },
    fullyParallel: false,
    workers: 1,
    reporter: process.env.CI
        ? [["list"], ["html", { open: "never" }]]
        : [["list"]],
    use: {
        baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:8080",
        trace: "retain-on-failure",
        viewport: { width: 1600, height: 1000 },
        deviceScaleFactor: 1,
    },
    projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
