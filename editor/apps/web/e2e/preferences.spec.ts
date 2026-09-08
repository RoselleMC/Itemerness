import { setZoom } from "./fixtures/plugin.js";
import { expect, test } from "@playwright/test";
import {
    enterWorkspace,
    mockPlugin,
    setNavigationExpanded,
} from "./fixtures/plugin.js";

test("language uses an application menu, supports keyboard selection, and stays independent of content", async ({
    page,
}) => {
    await mockPlugin(page);
    await page.goto("/");
    await enterWorkspace(page);
    const preview = await page.getByTestId("preview-name").textContent();
    await expect(
        page.getByTestId("titlebar").getByTestId("document-sync-status"),
    ).toBeVisible();
    await expect(
        page.locator(
            ".sidebar .ui-language, .sidebar [data-testid=document-sync-status]",
        ),
    ).toHaveCount(0);
    const language = page.getByTestId("ui-language");
    expect(await language.evaluate((element) => element.tagName)).toBe(
        "BUTTON",
    );
    await language.press("ArrowDown");
    await expect(page.getByTestId("ui-language-system")).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await expect(page.getByTestId("ui-language-zh-CN")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(language).toBeFocused();
    await expect(language).toHaveAccessibleName("界面语言");
    await expect(page.getByTestId("preview-name")).toHaveText(preview!);
    await language.click();
    await expect(page.getByTestId("ui-language-zh-CN")).toHaveAttribute(
        "aria-checked",
        "true",
    );
    await page.keyboard.press("Escape");
    await expect(language).toBeFocused();
    await expect(page.getByRole("menu")).toHaveCount(0);
    await page.reload();
    await expect(language).toHaveAccessibleName("界面语言");
});

test("appearance defaults to system, tracks changes, persists explicit overrides, and does not recolor game pixels", async ({
    page,
}) => {
    await page.emulateMedia({ colorScheme: "light" });
    await mockPlugin(page);
    await page.goto("/");
    const html = page.locator("html");
    await expect(html).toHaveAttribute("data-color-mode", "system");
    await expect(html).toHaveAttribute("data-theme", "light");
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(html).toHaveAttribute("data-theme", "dark");
    await enterWorkspace(page);
    const pixels = () =>
        page
            .getByTestId("tooltip-canvas")
            .evaluate((canvas) => (canvas as HTMLCanvasElement).toDataURL());
    const before = await pixels();
    await page.getByTestId("appearance").click();
    await page.getByTestId("appearance-light").click();
    await expect(html).toHaveAttribute("data-color-mode", "light");
    await expect(html).toHaveAttribute("data-theme", "light");
    expect(await pixels()).toBe(before);
    await page.emulateMedia({ colorScheme: "light" });
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(html).toHaveAttribute("data-theme", "light");
    await page.reload();
    await expect(html).toHaveAttribute("data-theme", "light");
    await page.getByTestId("appearance").click();
    await page.getByTestId("appearance-dark").click();
    await expect(html).toHaveAttribute("data-theme", "dark");
    await page.getByTestId("appearance").click();
    await page.getByTestId("appearance-system").click();
    await expect(html).toHaveAttribute("data-color-mode", "system");
    await page.emulateMedia({ colorScheme: "light" });
    await expect(html).toHaveAttribute("data-theme", "light");
});

test("preferences and auto-save settings stay usable without a plugin and menus dismiss independently", async ({
    page,
}) => {
    await page.goto("/?lang=en-US");
    await expect(page.getByTestId("open-assets")).toBeDisabled();
    await expect(page.getByTestId("open-translations")).toBeDisabled();
    await page.getByTestId("open-settings").click();
    await expect(page.getByTestId("workspace-page")).toBeVisible();
    await expect(
        page.getByRole("heading", { name: "Settings", exact: true }),
    ).toBeVisible();
    await expect(page.getByTestId("auto-save-toggle")).toBeChecked();
    await page.getByTestId("ui-language").click();
    await page.getByTestId("appearance").click();
    await expect(page.getByTestId("ui-language")).toHaveAttribute(
        "aria-expanded",
        "false",
    );
    await expect(page.getByRole("menu")).toHaveCount(1);
    await page.getByTestId("appearance-system").press("Escape");
    await expect(page.getByTestId("appearance")).toBeFocused();
    await page.getByTestId("connection-trigger").click();
    await page.getByTestId("ui-language").click();
    await expect(page.getByTestId("connection-popup")).toHaveCount(0);
    await page.getByRole("heading", { name: "Settings", exact: true }).click();
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(page.getByTestId("back-to-editor")).toHaveCount(0);
    await expect(page.getByTestId("connection-trigger")).toHaveAttribute(
        "data-state",
        "offline",
    );
});

test("global pages replace the entire right side and preserve the editor state and connection", async ({
    page,
}) => {
    await mockPlugin(page);
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    await page.getByTestId("item-ember-blade").click();
    await page.getByTestId("item-search").fill("ember");
    await setZoom(page, 2);
    for (const id of ["assets", "translations", "settings"]) {
        await page.getByTestId(`open-${id}`).click();
        await expect(page.getByTestId("back-to-editor")).toHaveCount(0);
        await expect(
            page
                .getByTestId("workspace-page")
                .getByRole("button", { name: "Back to editor" }),
        ).toHaveCount(0);
        await expect(page.getByTestId("workspace-page")).toHaveAttribute(
            "data-page",
            id,
        );
        await expect(page.locator(".sidebar")).toBeHidden();
        await expect(page.locator(".stage")).toBeHidden();
        await expect(page.locator(".inspector")).toBeHidden();
        const nav = (await page
            .getByTestId("primary-navigation")
            .boundingBox())!;
        const content = (await page
            .getByTestId("workspace-page")
            .boundingBox())!;
        expect(content.x).toBe(nav.x + nav.width);
        expect(content.x + content.width).toBe(page.viewportSize()!.width);
        await expect(page.getByTestId("connection-trigger")).toHaveAttribute(
            "data-state",
            "connected",
        );
        await expect(page.getByTestId(`open-${id}`)).toHaveAttribute(
            "aria-current",
            "page",
        );
    }
    await page.getByTestId("mode-items").click();
    await expect(page.getByTestId("item-search")).toHaveValue("ember");
    await expect(page.getByTestId("name-input")).toHaveValue("Ember Blade");
    await expect(page.getByTestId("canvas-zoom")).toContainText("200%");
    await page.getByTestId("open-translations").click();
    await page.getByTestId("connection-trigger").click();
    await page.getByTestId("disconnect-plugin").click();
    await expect(page.getByTestId("workspace-page")).toBeHidden();
    await expect(page.getByTestId("locale-table")).toHaveCount(0);
    await expect(page.getByTestId("workspace-status")).toContainText(
        "Not connected",
    );
});

test("light and dark shells, full pages and custom menus fit desktop and narrow viewports", async ({
    page,
}, testInfo) => {
    await mockPlugin(page);
    await page.goto("/?lang=zh-CN");
    await enterWorkspace(page);
    for (const theme of ["light", "dark"] as const) {
        await page.getByTestId("appearance").click();
        await page.getByTestId(`appearance-${theme}`).click();
        for (const viewport of [
            { width: 1440, height: 960 },
            { width: 900, height: 640 },
            { width: 390, height: 844 },
        ]) {
            await page.setViewportSize(viewport);
            await setNavigationExpanded(page, true);
            await page.getByTestId("open-translations").click();
            await page.getByTestId("ui-language").click();
            const layout = await page.evaluate(() => {
                const menu = document
                    .querySelector('[role="menu"]')!
                    .getBoundingClientRect();
                const toggle = document
                    .querySelector('[data-testid="toggle-navigation"]')!
                    .getBoundingClientRect();
                return {
                    width: document.documentElement.scrollWidth,
                    menuLeft: menu.left,
                    menuRight: menu.right,
                    menuBottom: menu.bottom,
                    toggleBottom: toggle.bottom,
                };
            });
            expect(layout.width).toBe(viewport.width);
            expect(layout.menuLeft).toBeGreaterThanOrEqual(0);
            expect(layout.menuRight).toBeLessThanOrEqual(viewport.width);
            expect(layout.menuBottom).toBeLessThanOrEqual(viewport.height);
            expect(layout.toggleBottom).toBeLessThanOrEqual(viewport.height);
            await page.screenshot({
                path: testInfo.outputPath(
                    `pages-${theme}-${viewport.width}.png`,
                ),
                fullPage: true,
            });
            await page.keyboard.press("Escape");
            await page.getByTestId("open-assets").click();
            await expect(page.getByTestId("asset-dropzone")).toBeVisible();
            await page.screenshot({
                path: testInfo.outputPath(
                    `assets-${theme}-${viewport.width}.png`,
                ),
                fullPage: true,
            });
            await page.getByTestId("mode-items").click();
            await setNavigationExpanded(page, false);
            await setZoom(page, 1);
            await page.screenshot({
                path: testInfo.outputPath(
                    `editor-${theme}-${viewport.width}.png`,
                ),
                fullPage: true,
            });
        }
    }
});
