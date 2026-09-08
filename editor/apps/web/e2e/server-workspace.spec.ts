import { expect, test, type Page } from "@playwright/test";
import { zipSync } from "fflate";
import {
    enterWorkspace,
    mockPlugin,
    HANDSHAKE,
    API_URL,
    setZoom,
} from "./fixtures/plugin.js";
const first = "0807ed00-2fd5-45d6-8214-16b77148533e";
const second = "d94af8ea-843a-4c1c-8bd8-24c8a1e5bb62";
const identity = (serverId: string) => ({
    ...HANDSHAKE,
    serverId,
    serverName: "Folia :25565",
    capabilities: [
        ...HANDSHAKE.capabilities,
        "server.identity.persistent",
        "server.alias.write",
    ],
});
const bytes = Array.from(
    zipSync({
        "pack.mcmeta": new TextEncoder().encode(
            JSON.stringify({
                pack: { pack_format: 84, description: "Remembered path" },
            }),
        ),
    }),
);

async function setup(page: Page) {
    const firstServer = identity(first);
    await mockPlugin(page, undefined, API_URL, firstServer);
    await mockPlugin(
        page,
        undefined,
        "http://127.0.0.1:18088",
        identity(second),
    );
    await mockPlugin(page, undefined, "http://127.0.0.1:18089", firstServer);
    await page.route("https://**/*", (route) => route.abort());
    await page.addInitScript(() => {
        // Real structured-cloneable browser handles, not serialized pack bytes.
        Object.defineProperty(window, "showOpenFilePicker", {
            value: async () => [
                await (
                    await navigator.storage.getDirectory()
                ).getFileHandle("Remembered.zip"),
            ],
            configurable: true,
        });
    });
    await page.goto("/?lang=en-US");
    await page.evaluate(async (bytes) => {
        const handle = await (
            await navigator.storage.getDirectory()
        ).getFileHandle("Remembered.zip", { create: true });
        const writer = await handle.createWritable();
        await writer.write(new Uint8Array(bytes));
        await writer.close();
    }, bytes);
    await enterWorkspace(page);
}

test("resource tabs, actual switches, and server records survive restart and address changes without crossing identities", async ({
    page,
}, testInfo) => {
    await setup(page);
    await setZoom(page, 2);
    await page.getByTestId("open-assets").click();
    const tabs = page.getByRole("tablist");
    await expect(tabs.getByRole("button")).toHaveCount(0);
    await expect(
        page.getByTestId("mounted-pack-heading").getByRole("button"),
    ).toHaveCount(2);
    const tab = tabs.getByRole("tab").first();
    await expect(tab).toHaveCSS("border-bottom-width", "2px");
    await page
        .getByRole("button", { name: "Import pack", exact: true })
        .click();
    const pack = page.getByTestId("pack-0");
    await expect(pack).toContainText("Remembered path");
    const toggle = pack.getByRole("switch", { name: "Auto reload" });
    await expect(toggle).toHaveJSProperty("tagName", "BUTTON");
    await expect(toggle).toHaveCSS("border-radius", "10px");
    await toggle.focus();
    await page.keyboard.press("Space");
    await expect(toggle).not.toBeChecked();
    await page.screenshot({
        path: testInfo.outputPath("resource-tabs-switches-desktop.png"),
    });
    await page.getByTestId("open-settings").click();
    await expect(page.getByTestId("server-identity")).toHaveText(first);
    await page.getByTestId("server-alias").fill("Test workspace");
    await page.getByTestId("server-alias").press("Enter");
    await expect(page.getByTestId("connection-trigger")).toContainText(
        "Test workspace",
    );
    await expect(page.getByTestId("server-workspace-settings")).toContainText(
        "Saved on this device",
    );
    await page.reload();
    await expect(page.getByTestId("workspace")).toHaveAttribute(
        "data-ready",
        "false",
    );
    await enterWorkspace(page);
    await expect(page.getByTestId("connection-trigger")).toContainText(
        "Test workspace",
    );
    await expect(page.getByTestId("canvas-viewport")).toHaveAttribute(
        "data-zoom",
        "2",
    );
    await page.getByTestId("open-assets").click();
    await expect(pack).toContainText("Remembered path");
    await expect(toggle).not.toBeChecked();
    await enterWorkspace(page, "http://127.0.0.1:18088");
    await expect(pack).toHaveCount(0);
    await expect(page.getByTestId("connection-trigger")).not.toContainText(
        "Test workspace",
    );
    await enterWorkspace(page, "http://127.0.0.1:18089");
    await expect(pack).toContainText("Remembered path");
    await expect(page.getByTestId("connection-trigger")).toContainText(
        "Test workspace",
    );
    await page.setViewportSize({ width: 760, height: 900 });
    await page.screenshot({
        path: testInfo.outputPath("resource-tabs-switches-compact.png"),
    });
    const geometry = await page
        .getByTestId("mounted-pack-heading")
        .evaluate((el) => ({ width: el.clientWidth, scroll: el.scrollWidth }));
    expect(geometry.scroll).toBeLessThanOrEqual(geometry.width);
});

test("opting out clears the persisted preferences and mount handles", async ({
    page,
}) => {
    await setup(page);
    await page.getByTestId("open-assets").click();
    await page
        .getByRole("button", { name: "Import pack", exact: true })
        .click();
    await expect(page.getByTestId("pack-0")).toBeVisible();
    await page.getByTestId("open-settings").click();
    await page.getByTestId("remember-server-workspace").uncheck();
    await expect(page.getByTestId("server-workspace-settings")).toContainText(
        "Disabled for this server",
    );
    await page.reload();
    await enterWorkspace(page);
    await page.getByTestId("open-assets").click();
    await expect(page.getByTestId("pack-0")).toHaveCount(0);
    await page.getByTestId("open-settings").click();
    await expect(
        page.getByTestId("remember-server-workspace"),
    ).not.toBeChecked();
    await expect(page.getByTestId("server-alias")).toBeEnabled();
});

test("a reused endpoint cannot discard pending edits or receive writes from the previous server", async ({
    page,
}) => {
    await setup(page);
    await page.getByTestId("open-settings").click();
    await page.getByTestId("auto-save-toggle").uncheck();
    await page.getByTestId("mode-items").click();
    await page.getByTestId("name-input").fill("Retain my edits");
    await page.getByTestId("name-input").press("Tab");
    let writes = 0;
    await page.route(`${API_URL}/api/handshake`, (route) =>
        route.fulfill({ json: identity(second) }),
    );
    await page.route(`${API_URL}/api/v2/document`, (route) => {
        if (route.request().method() === "PUT") writes++;
        return route.fulfill({
            status: 409,
            json: { code: "TARGET_MISMATCH", serverId: second },
        });
    });
    await expect(page.getByTestId("connection-trigger")).toContainText(
        "Connection failed",
        { timeout: 10000 },
    );
    await expect(page.getByTestId("name-input")).toHaveValue("Retain my edits");
    await expect(page.getByTestId("reconnect-dialog")).toContainText("Server identity changed");
    await page.getByTestId("reconnect-disconnect").click();
    await expect(page.getByTestId("unsaved-dialog")).toBeVisible();
    await page.getByTestId("leave-cancel").click();
    expect(writes).toBe(0);
});

test("full pages keep bounded centered columns across wide and narrow windows", async ({
    page,
}, testInfo) => {
    await setup(page);
    const pages = [
        ["open-settings", ".settings-layout", 920],
        ["open-assets", ".asset-page-tabs", 960],
        ["open-translations", ".locale-matrix", 1280],
    ] as const;
    for (const width of [2400, 1600, 760, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        for (const [button, selector, maximum] of pages) {
            await page.getByTestId(button).click();
            const frame = await page
                .getByTestId("workspace-page")
                .boundingBox();
            const box = await page.locator(selector).boundingBox();
            expect(box!.width).toBeLessThanOrEqual(maximum + 1);
            expect(
                Math.abs(
                    box!.x + box!.width / 2 - (frame!.x + frame!.width / 2),
                ),
            ).toBeLessThan(10);
            expect(box!.x).toBeGreaterThanOrEqual(frame!.x);
            expect(box!.x + box!.width).toBeLessThanOrEqual(
                frame!.x + frame!.width,
            );
            await page.screenshot({
                path: testInfo.outputPath(`${button}-${width}.png`),
            });
        }
    }
});

test("server aliases are shared metadata, not local preferences or draft writes", async ({
    page,
    context,
}) => {
    const shared = identity(first);
    const plugin = await mockPlugin(page, undefined, API_URL, shared);
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    await page.getByTestId("open-settings").click();
    await page.getByTestId("remember-server-workspace").uncheck();
    await page.getByTestId("server-alias").fill("Shared server name");
    await page.getByTestId("server-alias").press("Enter");
    await expect(page.getByTestId("connection-trigger")).toContainText(
        "Shared server name",
    );
    await expect(page.getByTestId("server-alias")).toBeFocused();
    expect(plugin.writes).toHaveLength(0);
    const otherEditor = await context.newPage();
    await mockPlugin(otherEditor, undefined, API_URL, shared);
    await otherEditor.goto("/?lang=en-US");
    await enterWorkspace(otherEditor);
    await expect(otherEditor.getByTestId("connection-trigger")).toContainText(
        "Shared server name",
    );
    await otherEditor.close();
    await page.route(`${API_URL}/api/v2/server`, (route) =>
        route.fulfill({ status: 409, json: { code: "SERVER_ALIAS_CONFLICT" } }),
    );
    await page.getByTestId("server-alias").fill("Stale change");
    await page.getByTestId("server-alias").press("Enter");
    await expect(page.locator(".server-alias-error")).toContainText(
        "Another editor changed this alias",
    );
    await expect(page.getByTestId("connection-trigger")).toContainText(
        "Shared server name",
    );
    expect(shared.serverAlias).toBe("Shared server name");
});
