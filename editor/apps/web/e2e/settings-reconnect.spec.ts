import { expect, test, type Page } from "@playwright/test";
import {
    API_URL,
    HANDSHAKE,
    TEST_TOKEN,
    enterWorkspace,
    mockPlugin,
    namedDocument,
    chooseValue,
} from "./fixtures/plugin.js";

const serverId = "aac8f610-1481-496d-9d85-420de28d5945";
const info = () => ({
    ...HANDSHAKE,
    serverId,
    serverAlias: "Folia Lab",
    capabilities: [
        ...HANDSHAKE.capabilities,
        "server.identity.persistent",
        "server.alias.write",
    ],
});
async function start(page: Page) {
    const plugin = await mockPlugin(
        page,
        namedDocument("Retained draft"),
        API_URL,
        info(),
    );
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    return plugin;
}

test("automatic reconnection preserves selections and offline edits before resuming CAS saves", async ({
    page,
}) => {
    const plugin = await start(page);
    let offline = true;
    let probes = 0;
    await page.route(`${API_URL}/api/handshake`, async (route) => {
        probes++;
        if (offline) await route.abort();
        else await route.fallback();
    });
    await expect(page.getByTestId("connection-trigger")).toHaveAttribute(
        "data-state",
        "reconnecting",
    );
    await expect(page.getByTestId("name-input")).toHaveValue("Retained draft");
    await page.getByTestId("name-input").fill("Edited while offline");
    await page.getByTestId("name-input").press("Tab");
    await expect.poll(() => probes).toBeGreaterThanOrEqual(2);
    expect(plugin.writes).toHaveLength(0);
    offline = false;
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect(page.getByTestId("connection-trigger")).toHaveAttribute(
        "data-state",
        "connected",
    );
    await expect(page.getByTestId("name-input")).toHaveValue(
        "Edited while offline",
    );
    await expect.poll(() => plugin.writes.length).toBe(1);
    await expect(page.getByTestId("undo")).toBeEnabled();
    await expect(
        page.getByText("Connection restored", { exact: true }),
    ).toBeVisible();
    await page.getByTestId("connection-trigger").click();
    await page.getByTestId("disconnect-plugin").click();
    const before = probes;
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await page.waitForTimeout(3200);
    expect(probes).toBe(before);
});

test("manual recovery blocks other regions, retries only by decision, and returns after each failed attempt", async ({
    page,
}) => {
    await start(page);
    await page.getByTestId("open-settings").click();
    await chooseValue(page, page.getByTestId("reconnect-mode"), "manual");
    await page.getByTestId("mode-items").click();
    let offline = true;
    let probes = 0;
    await page.route(`${API_URL}/api/handshake`, async (route) => {
        probes++;
        if (offline) await route.abort();
        else await route.fallback();
    });
    await expect(page.getByTestId("reconnect-dialog")).toBeVisible();
    await expect(page.getByTestId("workspace")).toHaveAttribute("inert", "");
    await expect(page.getByTestId("reconnect-confirm")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("reconnect-dialog")).toBeVisible();
    const before = probes;
    await page.waitForTimeout(3200);
    expect(probes).toBe(before);
    await page.getByTestId("reconnect-confirm").click();
    await expect.poll(() => probes).toBe(before + 1);
    await expect(page.getByTestId("reconnect-dialog")).toBeVisible();
    offline = false;
    await page.getByTestId("reconnect-confirm").click();
    await expect(page.getByTestId("reconnect-dialog")).toHaveCount(0);
    await expect(page.getByTestId("connection-trigger")).toHaveAttribute(
        "data-state",
        "connected",
    );
    await expect(page.getByTestId("workspace")).not.toHaveAttribute("inert");
});

test("remote changes during an outage conflict instead of overwriting the retained local draft", async ({
    page,
}) => {
    const plugin = await start(page);
    let offline = true;
    await page.route(`${API_URL}/api/handshake`, (route) =>
        offline ? route.abort() : route.fallback(),
    );
    await expect(page.getByTestId("connection-trigger")).toHaveAttribute(
        "data-state",
        "reconnecting",
    );
    await page.getByTestId("name-input").fill("Local pending change");
    await page.getByTestId("name-input").press("Tab");
    plugin.replace(namedDocument("Remote change"));
    offline = false;
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect(page.getByTestId("connection-trigger")).toHaveAttribute(
        "data-state",
        "connected",
    );
    await expect(page.getByTestId("document-sync-status")).toHaveAttribute(
        "data-sync-kind",
        "conflict",
    );
    await expect(page.getByTestId("name-input")).toHaveValue(
        "Local pending change",
    );
    expect(plugin.writes).toHaveLength(0);
});

test("history groups validated addresses by identity and never persists credentials", async ({
    page,
}) => {
    const alternate = "http://127.0.0.1:18089";
    await mockPlugin(page, undefined, API_URL, info());
    await mockPlugin(page, undefined, alternate, info());
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    await page.getByTestId("connection-trigger").click();
    await page.getByTestId("disconnect-plugin").click();
    await page.getByTestId("plugin-api-url").fill(alternate);
    await page.getByTestId("plugin-api-token").fill(TEST_TOKEN);
    await page.getByTestId("connect-plugin").click();
    await expect(page.getByTestId("workspace")).toHaveAttribute(
        "data-ready",
        "true",
    );
    await page.getByTestId("disconnect-plugin").click();
    const history = page.getByTestId("connection-history");
    await expect(history.locator(":scope > ul > li")).toHaveCount(1);
    await history.getByText("2 addresses", { exact: true }).click();
    await expect(history).toContainText(API_URL);
    const storage = await page.evaluate(() => JSON.stringify(localStorage));
    expect(storage).not.toContain(TEST_TOKEN);
    await page.reload();
    await page.getByTestId("connection-trigger").click();
    await page
        .getByTestId("connection-history")
        .getByRole("button", { name: /^Folia Lab/ })
        .click();
    await expect(page.getByTestId("plugin-api-token")).toHaveValue("");
    await expect(page.getByTestId("plugin-api-url")).toHaveValue(alternate);
    await expect(page.getByTestId("workspace")).toHaveAttribute(
        "data-ready",
        "false",
    );
});

test("settings headings navigate separate local, remote and file groups with bounded content", async ({
    page,
}, testInfo) => {
    const plugin = await start(page);
    await page.getByTestId("open-settings").click();
    const toc = page.getByTestId("settings-toc");
    await expect(toc.locator(":scope > ul > li")).toHaveCount(3);
    await toc
        .getByRole("link", { name: "Server identity", exact: true })
        .click();
    await expect(page.getByTestId("server-alias")).toBeInViewport();
    await expect(
        page.locator("#settings-workspace").getByTestId("server-alias"),
    ).toHaveCount(0);
    await expect(
        page
            .locator("#settings-identity")
            .getByTestId("remember-server-workspace"),
    ).toHaveCount(0);
    for (const width of [2400, 1600, 760, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        await toc
            .getByRole("link", { name: "Appearance", exact: true })
            .click();
        const body = await page.getByTestId("settings-body").boundingBox();
        expect(body!.width).toBeLessThanOrEqual(681);
        expect(
            await page.evaluate(
                () => document.documentElement.scrollWidth <= innerWidth,
            ),
        ).toBe(true);
        await page.screenshot({
            path: testInfo.outputPath(`settings-${width}.png`),
        });
    }
    expect(plugin.writes).toHaveLength(0);
});

test("language follows runtime system changes without changing the globe or content locale", async ({
    page,
}) => {
    await page.addInitScript(() =>
        Object.defineProperty(navigator, "languages", {
            configurable: true,
            get: () => ["en-US"],
        }),
    );
    await mockPlugin(page);
    await page.goto("/");
    await enterWorkspace(page);
    const locale = await page
        .getByTestId("preview-language")
        .getAttribute("data-field-value");
    await expect(page.getByTestId("appearance").locator("svg")).toHaveClass(
        /lucide-sun-moon/,
    );
    await page.getByTestId("ui-language").click();
    await expect(page.getByTestId("ui-language-system")).toHaveAttribute(
        "aria-checked",
        "true",
    );
    await page.keyboard.press("Escape");
    await page.evaluate(() => {
        Object.defineProperty(navigator, "languages", {
            configurable: true,
            get: () => ["zh-CN"],
        });
        window.dispatchEvent(new Event("languagechange"));
    });
    await expect(page.getByTestId("ui-language")).toHaveAccessibleName(
        "界面语言",
    );
    await expect(page.getByTestId("ui-language").locator("svg")).toHaveClass(
        /lucide-earth/,
    );
    await expect(page.getByTestId("preview-language")).toHaveAttribute(
        "data-field-value",
        locale!,
    );
});
