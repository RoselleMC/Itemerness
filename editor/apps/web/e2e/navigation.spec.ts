import { expect, test } from "@playwright/test";
import {
    mockPlugin,
    enterWorkspace,
    setNavigationExpanded,
} from "./fixtures/plugin.js";

test.beforeEach(async ({ page }) => {
    await mockPlugin(page);
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    await expect(page.getByTestId("primary-navigation")).toBeVisible();
});

test("primary navigation switches the secondary library and supports independent expansion", async ({
    page,
}, testInfo) => {
    const navigation = page.getByTestId("primary-navigation");
    const toggle = page.getByTestId("toggle-navigation");
    await expect(page.getByTestId("navigation-resizer")).toHaveCount(0);
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(navigation.locator(".primary-navigation-label")).toHaveCount(
        0,
    );
    await page.getByTestId("mode-items").hover();
    await expect(
        page.getByRole("tooltip", { name: "Items", exact: true }),
    ).toBeVisible();
    const collapsed = (await navigation.boundingBox())!.width;
    await setNavigationExpanded(page, true);
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(navigation.locator(".primary-navigation-label")).toHaveCount(
        8,
    );
    expect((await navigation.boundingBox())!.width).toBeGreaterThan(collapsed);
    await expect(page.getByTestId("library-heading")).toHaveText("Items");
    await page.getByTestId("mode-themes").click();
    await expect(page.getByTestId("library-heading")).toHaveText("Themes");
    await expect(page.getByTestId("theme-list")).toBeVisible();
    await expect(page.getByTestId("item-tree")).toHaveCount(0);
    await page.getByTestId("item-search").fill("ember");
    await page.getByTestId("mode-items").click();
    await expect(page.getByTestId("item-search")).toHaveValue("");
    await page.getByTestId("mode-themes").click();
    await expect(page.getByTestId("item-search")).toHaveValue("ember");
    await expect(
        page.getByTestId("theme-list").locator(":scope > li"),
    ).toHaveCount(1);
    await page.screenshot({
        path: testInfo.outputPath("navigation-expanded.png"),
        fullPage: true,
    });
    await page.reload();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await setNavigationExpanded(page, false);
    await page.reload();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
});

test("keyboard navigation preserves the current mode until activation", async ({
    page,
}) => {
    await page.getByTestId("mode-items").focus();
    await page.getByTestId("mode-items").press("ArrowDown");
    await expect(page.getByTestId("mode-themes")).toBeFocused();
    await expect(page.getByTestId("library-heading")).toHaveText("Items");
    await page.getByTestId("mode-themes").press("Enter");
    await expect(page.getByTestId("library-heading")).toHaveText("Themes");
    await page.getByTestId("mode-themes").press("End");
    await expect(page.getByTestId("mode-data")).toBeFocused();
    await page.getByTestId("mode-data").press("Space");
    await expect(page.getByTestId("data-list")).toBeVisible();
    await page.getByTestId("mode-data").press("Home");
    await expect(page.getByTestId("mode-items")).toBeFocused();
});

test("both navigation columns remain separate at desktop and mobile sizes", async ({
    page,
}, testInfo) => {
    for (const viewport of [
        { width: 1440, height: 960 },
        { width: 900, height: 640 },
        { width: 390, height: 844 },
    ]) {
        await page.setViewportSize(viewport);
        for (const expanded of [false, true]) {
            await setNavigationExpanded(page, expanded);
            const bounds = await page.evaluate(() => {
                const box = (selector: string) =>
                    document.querySelector(selector)!.getBoundingClientRect();
                const nav = box(".primary-navigation");
                const sidebar = box(".sidebar");
                const stage = box(".stage");
                return {
                    navRight: nav.right,
                    sidebarLeft: sidebar.left,
                    sidebarRight: sidebar.right,
                    stageLeft: stage.left,
                    pageWidth: document.documentElement.scrollWidth,
                };
            });
            expect(bounds.navRight).toBeLessThanOrEqual(bounds.sidebarLeft);
            if (viewport.width > 720)
                expect(bounds.sidebarRight).toBeLessThanOrEqual(
                    bounds.stageLeft,
                );
            expect(bounds.pageWidth).toBe(viewport.width);
            await expect(page.getByTestId("mode-layouts")).toBeVisible();
            await page.getByTestId("mode-layouts").click();
            await expect(page.getByTestId("layout-list")).toBeVisible();
            await page.screenshot({
                path: testInfo.outputPath(
                    `navigation-${viewport.width}-${expanded}.png`,
                ),
                fullPage: true,
            });
        }
    }
});

test("the bottom button toggles with the keyboard and sits below the global pages", async ({
    page,
}) => {
    const navigation = page.getByTestId("primary-navigation");
    const toggle = page.getByTestId("toggle-navigation");
    const initial = (await navigation.boundingBox())!.width;
    const box = (await toggle.boundingBox())!;
    const settings = (await page.getByTestId("open-settings").boundingBox())!;
    expect(settings.y + settings.height).toBeLessThan(box.y);
    expect(box.y + box.height).toBeGreaterThan(
        page.viewportSize()!.height - 20,
    );
    await toggle.focus();
    await toggle.press("Enter");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect((await navigation.boundingBox())!.width).toBe(160);
    await toggle.press("Space");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect((await navigation.boundingBox())!.width).toBe(initial);
});
