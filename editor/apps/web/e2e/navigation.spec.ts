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
        10,
    );
    expect((await navigation.boundingBox())!.width).toBeGreaterThan(collapsed);
    await expect(page.getByTestId("library-heading")).toHaveText(
        /^Items \(\d+\)$/,
    );
    await page.getByTestId("mode-themes").click();
    await expect(page.getByTestId("library-heading")).toHaveText(
        /^Themes \(\d+\)$/,
    );
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
    await expect(page.getByTestId("library-heading")).toHaveText(
        /^Items \(\d+\)$/,
    );
    await page.getByTestId("mode-themes").press("Enter");
    await expect(page.getByTestId("library-heading")).toHaveText(
        /^Themes \(\d+\)$/,
    );
    await page.getByTestId("mode-themes").press("End");
    await expect(page.getByTestId("mode-facts")).toBeFocused();
    await page.getByTestId("mode-facts").press("Space");
    await expect(page.getByTestId("facts-tree")).toBeVisible();
    await page.getByTestId("mode-facts").press("ArrowUp");
    await expect(page.getByTestId("mode-formats")).toBeFocused();
    await page.getByTestId("mode-formats").press("ArrowUp");
    await expect(page.getByTestId("mode-data")).toBeFocused();
    await page.getByTestId("mode-data").press("Enter");
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

test("resizing the library keeps the selected row visible without scrolling the page", async ({
    page,
}) => {
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.getByTestId("item-survey-codex").click();
    const selectionIsVisible = () =>
        page.getByTestId("item-tree").evaluate((list) => {
            const selected = list.querySelector(".item-row.selected")!;
            const row = selected.getBoundingClientRect();
            const viewport = list.getBoundingClientRect();
            return row.top >= viewport.top && row.bottom <= viewport.bottom + 1;
        });
    for (const viewport of [
        { width: 640, height: 360 },
        { width: 390, height: 844 },
    ]) {
        await page.setViewportSize(viewport);
        await expect.poll(selectionIsVisible).toBe(true);
        expect(await page.evaluate(() => window.scrollY)).toBe(0);
        await expect(page.getByTestId("preview-name")).toHaveText(
            "Survey Codex",
        );
    }
    const list = page.getByTestId("item-tree");
    await list.evaluate((element) => {
        element.scrollTop = 0;
    });
    await page.getByTestId("appearance").click();
    await page.getByTestId("appearance-dark").click();
    expect(await list.evaluate((element) => element.scrollTop)).toBe(0);
    await page.setViewportSize({ width: 640, height: 360 });
    await expect.poll(selectionIsVisible).toBe(true);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
});

test("narrow item lists scroll without pushing fitted preview out of the first screen", async ({
    page,
}, testInfo) => {
    for (const viewport of [
        { width: 320, height: 568 },
        { width: 390, height: 844 },
        { width: 720, height: 960 },
        { width: 640, height: 360 },
        { width: 720, height: 390 },
    ]) {
        await page.setViewportSize(viewport);
        for (const expanded of [false, true]) {
            await setNavigationExpanded(page, expanded);
            await page.getByTestId("item-survey-codex").click();
            await expect(page.getByTestId("preview-name")).toHaveText(
                "Survey Codex",
            );
            await page.getByTestId("zoom-fit").click();
            await page.evaluate(() => window.scrollTo(0, 0));
            const bounds = () =>
                page.evaluate(() => {
                    const box = (selector: string) => {
                        const rect = document
                            .querySelector(selector)!
                            .getBoundingClientRect();
                        return {
                            top: rect.top,
                            bottom: rect.bottom,
                            left: rect.left,
                            right: rect.right,
                            height: rect.height,
                        };
                    };
                    const canvas = document.querySelector<HTMLCanvasElement>(
                        '[data-testid="tooltip-canvas"]',
                    )!;
                    const pixels = canvas
                        .getContext("2d")!
                        .getImageData(0, 0, canvas.width, canvas.height).data;
                    return {
                        sidebar: box(".sidebar"),
                        search: box('[data-testid="item-search"]'),
                        stage: box(".stage"),
                        area: box('[data-testid="canvas-viewport"]'),
                        canvas: box('[data-testid="tooltip-canvas"]'),
                        inspector: box(".inspector"),
                        width: document.documentElement.scrollWidth,
                        painted: pixels.some(
                            (value, index) => index % 4 === 3 && value > 0,
                        ),
                    };
                });
            await expect
                .poll(async () => {
                    const result = await bounds();
                    return (
                        result.canvas.top >= result.area.top &&
                        result.canvas.bottom <= result.area.bottom + 1 &&
                        result.canvas.left >= result.area.left &&
                        result.canvas.right <= result.area.right + 1
                    );
                })
                .toBe(true);
            const result = await bounds();
            expect(
                result.width,
                JSON.stringify(
                    await page.evaluate(() =>
                        [...document.querySelectorAll(".app *, .titlebar *")]
                            .filter((element) => {
                                const rect = element.getBoundingClientRect();
                                return (
                                    rect.width > 0 && rect.right > innerWidth
                                );
                            })
                            .map((element) => ({
                                tag: element.tagName,
                                className: element.className,
                                right: element.getBoundingClientRect().right,
                            }))
                            .slice(0, 12),
                    ),
                ),
            ).toBe(viewport.width);
            expect(result.search.top).toBeGreaterThanOrEqual(
                result.sidebar.top,
            );
            expect(result.search.bottom).toBeLessThan(result.sidebar.bottom);
            expect(result.sidebar.bottom).toBeLessThanOrEqual(
                result.stage.top + 1,
            );
            expect(result.stage.bottom).toBeLessThanOrEqual(
                viewport.height + 1,
            );
            expect(result.inspector.top).toBeGreaterThanOrEqual(
                result.stage.bottom - 1,
            );
            expect(result.canvas.height).toBeGreaterThan(40);
            expect(result.painted).toBe(true);
            const originalTop = result.stage.top;
            const list = page.getByTestId("item-tree");
            await list.evaluate((element) => {
                element.scrollTop = element.scrollHeight;
            });
            if (viewport.height <= 568)
                expect(
                    await list.evaluate((element) => element.scrollTop),
                ).toBeGreaterThan(0);
            expect((await bounds()).stage.top).toBe(originalTop);
            await page.getByTestId("item-search").fill("Ember");
            await expect(list.getByRole("listitem")).toHaveCount(1);
            await expect(page.getByTestId("preview-name")).toHaveText(
                "Survey Codex",
            );
            expect((await bounds()).stage.top).toBe(originalTop);
            await page.getByTestId("item-search").clear();
            await expect(list.getByRole("listitem")).toHaveCount(5);
            await expect(page.getByTestId("preview-name")).toHaveText(
                "Survey Codex",
            );
            await page.screenshot({
                path: testInfo.outputPath(
                    `first-screen-${viewport.width}x${viewport.height}-${expanded}.png`,
                ),
            });
        }
    }
});
