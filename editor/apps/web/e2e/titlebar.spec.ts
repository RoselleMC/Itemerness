import { expect, test, type Page } from "@playwright/test";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import { contentHash } from "@itemerness/protocol";
import { mockPlugin, enterWorkspace, HANDSHAKE } from "./fixtures/plugin.js";

test.beforeEach(async ({ page }) => {
    await mockPlugin(page);
});

async function nativeWindow(page: Page, platform: "macos" | "windows") {
    await page.addInitScript(
        ({ platform, document, hash, handshake }) => {
            Object.defineProperty(navigator, "userAgent", {
                value:
                    platform === "macos"
                        ? "Macintosh Mac OS X"
                        : "Windows NT 10.0",
            });
            const callbacks = new Map<number, (event: unknown) => void>();
            const listeners = new Map<
                number,
                { event: string; handler: number }
            >();
            let next = 0;
            let maximized = false;
            const calls: string[] = [];
            const themes: unknown[] = [];
            const runtime = window as unknown as Record<string, unknown>;
            runtime.isTauri = true;
            runtime.captionCalls = calls;
            runtime.themeRequests = themes;
            runtime.setWindowFocused = (focused: boolean) => {
                for (const [id, listener] of listeners)
                    if (
                        listener.event ===
                        (focused ? "tauri://focus" : "tauri://blur")
                    )
                        callbacks.get(listener.handler)?.({
                            event: listener.event,
                            id,
                            payload: focused,
                        });
            };
            runtime.__TAURI_INTERNALS__ = {
                metadata: { currentWindow: { label: "main" } },
                transformCallback: (callback: (event: unknown) => void) => {
                    callbacks.set(++next, callback);
                    return next;
                },
                unregisterCallback: (id: number) => callbacks.delete(id),
                invoke: async (
                    command: string,
                    args: {
                        event: string;
                        handler: number;
                        eventId: number;
                        path?: string;
                        method?: string;
                        value?: unknown;
                    },
                ) => {
                    calls.push(command);
                    if (command === "plugin:window|set_theme")
                        themes.push(args.value);
                    if (command === "plugin_request") {
                        if (args.path === "/api/handshake")
                            return {
                                status: 200,
                                body: JSON.stringify(handshake),
                            };
                        if (
                            args.path === "/api/v2/document" &&
                            args.method === "GET"
                        )
                            return {
                                status: 200,
                                body: JSON.stringify({
                                    document,
                                    snapshotHash: hash,
                                    revision: 1,
                                }),
                            };
                        return {
                            status: 503,
                            body: JSON.stringify({ code: "UNAVAILABLE" }),
                        };
                    }
                    if (command === "plugin:event|listen") {
                        listeners.set(++next, args);
                        return next;
                    }
                    if (command === "plugin:event|unlisten") {
                        listeners.delete(args.eventId);
                        return;
                    }
                    if (command === "plugin:window|is_maximized")
                        return maximized;
                    if (command === "plugin:window|is_focused") return true;
                    if (command === "plugin:window|toggle_maximize") {
                        maximized = !maximized;
                        for (const [id, listener] of listeners)
                            if (listener.event === "tauri://resize")
                                callbacks.get(listener.handler)?.({
                                    event: listener.event,
                                    id,
                                    payload: { width: 1440, height: 960 },
                                });
                    }
                },
            };
            runtime.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
                unregisterListener: (id: number) => listeners.delete(id),
            };
        },
        {
            platform,
            document: baselineDocument,
            hash: contentHash(baselineDocument),
            handshake: HANDSHAKE,
        },
    );
    await page.goto("/?lang=en-US");
    await expect(page.getByTestId("titlebar")).toHaveAttribute(
        "data-platform",
        platform,
    );
    await enterWorkspace(page);
}

const calls = (page: Page) =>
    page.evaluate(
        () => (window as unknown as { captionCalls: string[] }).captionCalls,
    );

for (const platform of ["macos", "windows"] as const) {
    test(`${platform} appearance requests light, dark, and system themes without triggering a drag`, async ({
        page,
    }) => {
        await nativeWindow(page, platform);
        for (const mode of ["light", "dark", "system"]) {
            await page.getByTestId("appearance").click();
            await page.getByTestId(`appearance-${mode}`).click();
            await expect
                .poll(() =>
                    page.evaluate(() =>
                        (
                            window as unknown as { themeRequests: unknown[] }
                        ).themeRequests.at(-1),
                    ),
                )
                .toBe(mode === "system" ? null : mode);
        }
        expect(await calls(page)).not.toContain("plugin:window|start_dragging");
    });
}

test("browser preview shares the titlebar without fake native controls", async ({
    page,
}) => {
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    await expect(
        page.getByRole("heading", { name: "Itemerness", exact: true }),
    ).toHaveCount(0);
    await expect(page.getByTestId("window-controls")).toHaveCount(0);
    await page.getByTestId("mode-themes").click();
    await expect(page.getByTestId("mode-themes")).toHaveAttribute(
        "aria-current",
        "page",
    );
    await expect(page.getByTestId("connection-trigger")).toContainText("test");
});

for (const platform of ["browser", "macos", "windows"] as const) {
    test(`${platform} keeps save status at the free outer edge with distinct language controls`, async ({
        page,
    }, testInfo) => {
        if (platform === "browser") {
            await page.goto("/?lang=en-US");
            await enterWorkspace(page);
        } else await nativeWindow(page, platform);
        await expect(page.getByTestId("ui-language")).toHaveAccessibleName(
            "Interface language",
        );
        await expect(
            page.getByTestId("open-translations"),
        ).toHaveAccessibleName("Content translations");
        expect(
            await page
                .getByTestId("ui-language")
                .locator("svg")
                .first()
                .innerHTML(),
        ).not.toBe(
            await page
                .getByTestId("open-translations")
                .locator("svg")
                .first()
                .innerHTML(),
        );
        for (const width of platform === "browser"
            ? [1440, 900, 390]
            : [1440, 900]) {
            await page.setViewportSize({ width, height: 800 });
            const ids =
                platform === "windows"
                    ? ["document-sync-status", "ui-language", "appearance"]
                    : ["appearance", "ui-language", "document-sync-status"];
            const boxes = [];
            for (const id of ids)
                boxes.push((await page.getByTestId(id).boundingBox())!);
            for (let index = 1; index < boxes.length; index++)
                expect(
                    boxes[index - 1]!.x + boxes[index - 1]!.width,
                ).toBeLessThanOrEqual(boxes[index]!.x);
            const status = (await page
                .getByTestId("document-sync-status")
                .boundingBox())!;
            if (platform === "windows") expect(status.x).toBeLessThanOrEqual(8);
            else expect(width - status.x - status.width).toBeLessThanOrEqual(8);
            await page.getByTestId(ids[0]!).focus();
            await page.keyboard.press("Tab");
            await expect(page.getByTestId(ids[1]!)).toBeFocused();
            await page.keyboard.press("Tab");
            await expect(page.getByTestId(ids[2]!)).toBeFocused();
            for (const menu of ["ui-language", "appearance"]) {
                await page.getByTestId(menu).click();
                const bounds = (await page.getByRole("menu").boundingBox())!;
                expect(bounds.x).toBeGreaterThanOrEqual(0);
                expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
                await page.screenshot({
                    path: testInfo.outputPath(
                        `edge-${platform}-${width}-${menu}.png`,
                    ),
                    fullPage: true,
                });
                await page.keyboard.press("Escape");
            }
            await page.getByTestId("document-sync-status").click();
            await expect(page.getByTestId("connection-popup")).toBeVisible();
            await page.getByTestId("close-connection").click();
            if (platform === "windows") {
                const controls = (await page
                    .getByTestId("window-controls")
                    .boundingBox())!;
                expect(controls.x + controls.width).toBe(width);
                expect(controls.x).toBeGreaterThan(
                    (await page
                        .getByTestId("connection-trigger")
                        .boundingBox())!.x +
                        (await page
                            .getByTestId("connection-trigger")
                            .boundingBox())!.width,
                );
                expect(await calls(page)).not.toContain(
                    "plugin:window|start_dragging",
                );
            }
        }
    });
}

test("macOS reserves native traffic lights and keeps dragging after editing", async ({
    page,
}) => {
    await nativeWindow(page, "macos");
    await expect(page.getByTestId("window-controls")).toHaveCount(0);
    await expect(page.locator(".titlebar h1")).toHaveCount(0);
    await expect(page.getByRole("menubar")).toHaveCount(0);
    expect(
        await page
            .locator(".titlebar-lead")
            .evaluate((element) => getComputedStyle(element).paddingLeft),
    ).toBe("100px");
    await page.getByTestId("name-input").fill("Selected text");
    await page
        .getByTestId("titlebar-drag-area")
        .click({ position: { x: 120, y: 8 } });
    await expect
        .poll(() => calls(page))
        .toContain("plugin:window|start_dragging");
    await page
        .getByTestId("titlebar-drag-area")
        .dblclick({ position: { x: 120, y: 8 } });
    await expect
        .poll(() => calls(page))
        .toContain("plugin:window|toggle_maximize");
});

test("Windows caption buttons invoke controls without dragging and remain usable above dialogs", async ({
    page,
}) => {
    await nativeWindow(page, "windows");
    await page.getByTestId("window-minimize").click();
    await expect.poll(() => calls(page)).toContain("plugin:window|minimize");
    await page.getByTestId("window-maximize").click();
    await expect(page.getByTestId("window-maximize")).toHaveAccessibleName(
        "Restore",
    );
    await page.getByTestId("window-maximize").click();
    await expect(page.getByTestId("window-maximize")).toHaveAccessibleName(
        "Maximize",
    );
    expect(await calls(page)).not.toContain("plugin:window|start_dragging");
    await page.getByTestId("connection-trigger").click();
    await page.getByTestId("disconnect-plugin").click();
    await page.getByTestId("plugin-api-url").fill("https://server.example.com");
    expect(
        await page.getByTestId("plugin-api-url").evaluate((element) =>
            element.dispatchEvent(
                new MouseEvent("contextmenu", {
                    bubbles: true,
                    cancelable: true,
                }),
            ),
        ),
    ).toBe(false);
    await expect(page.getByTestId("context-menu")).toBeVisible();
    await page.keyboard.press("Escape");
    expect(
        await page.getByTestId("titlebar-drag-area").evaluate((element) =>
            element.dispatchEvent(
                new MouseEvent("contextmenu", {
                    bubbles: true,
                    cancelable: true,
                }),
            ),
        ),
    ).toBe(false);
    expect(await calls(page)).not.toContain("plugin:window|start_dragging");
    await enterWorkspace(page);
    await page.getByTestId("open-assets").click();
    await expect(page.getByTestId("connection-popup")).toHaveCount(0);
    const toolsPage = await page.getByTestId("workspace-page").boundingBox();
    expect(toolsPage!.y).toBe(32);
    await expect(page.locator(".overlay-backdrop")).toHaveCount(0);
    await page.getByTestId("window-close").click();
    await expect.poll(() => calls(page)).toContain("plugin:window|close");
    await expect(page.getByTestId("titlebar").getByRole("alert")).toHaveCount(
        0,
    );
});

test("window controls and text fit at the minimum desktop size", async ({
    page,
}, testInfo) => {
    await page.setViewportSize({ width: 900, height: 640 });
    await nativeWindow(page, "windows");
    const layout = await page.evaluate(() => {
        const titlebar = document
            .querySelector(".titlebar")!
            .getBoundingClientRect();
        const app = document.querySelector(".app")!.getBoundingClientRect();
        const controls = document
            .querySelector(".window-controls")!
            .getBoundingClientRect();
        return {
            titlebarBottom: titlebar.bottom,
            appTop: app.top,
            appBottom: app.bottom,
            controlsRight: controls.right,
            connectionRight: document
                .querySelector(".connection-center")!
                .getBoundingClientRect().right,
            connectionLeft: document
                .querySelector(".connection-center")!
                .getBoundingClientRect().left,
            toolsRight: document
                .querySelector(".titlebar-tools")!
                .getBoundingClientRect().right,
            menuRight: document
                .querySelector(".application-menubar")!
                .getBoundingClientRect().right,
            pageWidth: document.documentElement.scrollWidth,
            canvasLeft: document
                .querySelector('[data-testid="tooltip-canvas"]')!
                .getBoundingClientRect().left,
            stageLeft: document
                .querySelector(".stage-canvas-area")!
                .getBoundingClientRect().left,
        };
    });
    expect(layout.titlebarBottom).toBe(layout.appTop);
    expect(layout.appBottom).toBe(640);
    expect(layout.controlsRight).toBe(900);
    expect(layout.menuRight).toBeLessThanOrEqual(layout.connectionLeft);
    expect(layout.toolsRight).toBeLessThanOrEqual(layout.connectionLeft);
    expect(layout.pageWidth).toBe(900);
    expect(layout.canvasLeft).toBeGreaterThanOrEqual(layout.stageLeft);
    await page.screenshot({
        path: testInfo.outputPath("windows-titlebar-minimum.png"),
        fullPage: true,
    });
});

for (const theme of ["light", "dark"] as const) {
    test(`Windows ${theme} caption matches the header in active and inactive windows`, async ({
        page,
    }, testInfo) => {
        await nativeWindow(page, "windows");
        await page.getByTestId("appearance").click();
        await page.getByTestId(`appearance-${theme}`).click();
        const header = page.getByTestId("titlebar");
        const captions = page.getByTestId("window-controls");
        for (const width of [900, 1440]) {
            await page.setViewportSize({ width, height: 800 });
            await expect(header).toHaveCSS("height", "32px");
            await expect(captions).toHaveCSS(
                "background-color",
                await header.evaluate(
                    (element) => getComputedStyle(element).backgroundColor,
                ),
            );
            for (const id of [
                "window-minimize",
                "window-maximize",
                "window-close",
            ]) {
                const button = page.getByTestId(id);
                await expect(button).toHaveCSS("width", "46px");
                await expect(button).toHaveCSS("height", "32px");
                await expect(button).toHaveCSS(
                    "background-color",
                    "rgba(0, 0, 0, 0)",
                );
                const stroke = await button
                    .locator("svg")
                    .evaluate(
                        (element) =>
                            (Number.parseFloat(
                                getComputedStyle(element).strokeWidth,
                            ) *
                                element.getBoundingClientRect().width) /
                            24,
                    );
                expect(stroke).toBeCloseTo(1);
            }
            for (const id of [
                "connection-trigger",
                "document-sync-status",
                "ui-language",
                "appearance",
            ]) {
                const bounds = (await page.getByTestId(id).boundingBox())!;
                expect(bounds.y).toBe(2);
                expect(bounds.height).toBe(28);
            }
            for (const focused of [true, false]) {
                await page.evaluate(
                    (value) =>
                        (
                            window as unknown as {
                                setWindowFocused(value: boolean): void;
                            }
                        ).setWindowFocused(value),
                    focused,
                );
                await expect(header).toHaveAttribute(
                    "data-focused",
                    String(focused),
                );
                await expect(captions).toHaveCSS("opacity", "1");
                await expect(captions).toHaveCSS(
                    "background-color",
                    await header.evaluate(
                        (element) => getComputedStyle(element).backgroundColor,
                    ),
                );
                await page.screenshot({
                    path: testInfo.outputPath(
                        `caption-${theme}-${width}-${focused}.png`,
                    ),
                });
            }
        }
        const minimize = page.getByTestId("window-minimize");
        await minimize.hover();
        await expect(minimize).toHaveCSS(
            "background-color",
            theme === "light"
                ? "rgba(0, 0, 0, 0.1)"
                : "rgba(255, 255, 255, 0.1)",
        );
        const close = page.getByTestId("window-close");
        await close.hover();
        await expect(close).toHaveCSS("background-color", "rgb(196, 43, 28)");
        await expect(close).toHaveCSS("color", "rgb(255, 255, 255)");
        await page.mouse.down();
        await expect(close).toHaveCSS("background-color", "rgb(169, 37, 25)");
        await page.mouse.move(500, 200);
        await page.mouse.up();
        expect(await calls(page)).not.toContain("plugin:window|close");
    });
}

for (const platform of ["macos", "windows"] as const) {
    test(`${platform} navigation density preserves targets and expanded labels`, async ({
        page,
    }, testInfo) => {
        await nativeWindow(page, platform);
        for (const width of [900, 1440]) {
            await page.setViewportSize({ width, height: 800 });
            const nav = page.getByTestId("primary-navigation");
            await expect(nav).toHaveCSS(
                "width",
                platform === "windows" ? "48px" : "56px",
            );
            const item = page.getByTestId("mode-items");
            const before = (await item.locator("svg").boundingBox())!;
            expect((await item.boundingBox())!.width).toBe(41);
            expect((await item.boundingBox())!.height).toBe(40);
            const indicator = await item.evaluate(
                (element) =>
                    element.getBoundingClientRect().x +
                    Number.parseFloat(
                        getComputedStyle(element, "::before").left,
                    ),
            );
            expect(indicator).toBe(0);
            await item.hover();
            const tooltip = page.getByRole("tooltip", {
                name: "Items",
                exact: true,
            });
            await expect(tooltip).toBeVisible();
            expect((await tooltip.boundingBox())!.x).toBeGreaterThan(
                (await nav.boundingBox())!.width,
            );
            await page.getByTestId("toggle-navigation").click();
            await expect(nav).toHaveCSS(
                "width",
                platform === "windows" ? "152px" : "160px",
            );
            expect((await item.boundingBox())!.width).toBe(145);
            expect(
                Math.abs(
                    (await item.locator("svg").boundingBox())!.x - before.x,
                ),
            ).toBeLessThanOrEqual(0.5);
            for (const label of await nav
                .locator(".primary-navigation-label")
                .all()) {
                const bounds = (await label.boundingBox())!;
                expect(bounds.x + bounds.width).toBeLessThan(
                    (await nav.boundingBox())!.width,
                );
                expect(
                    await label.evaluate(
                        (element) => element.scrollWidth <= element.clientWidth,
                    ),
                ).toBe(true);
            }
            await page.getByTestId("open-settings").click();
            expect(
                (await page.getByTestId("workspace-page").boundingBox())!.x,
            ).toBe((await nav.boundingBox())!.width);
            await page.screenshot({
                path: testInfo.outputPath(
                    `navigation-density-${platform}-${width}.png`,
                ),
            });
            await page.getByTestId("mode-items").click();
            await page.getByTestId("toggle-navigation").focus();
            await page.keyboard.press("Space");
        }
    });
}

test("Windows caption buttons remain clickable over field and context popups", async ({
    page,
}) => {
    await nativeWindow(page, "windows");
    await page.getByTestId("form-layout").click();
    await expect(page.locator(".ui-select-popup")).toBeVisible();
    await page.getByTestId("window-minimize").click();
    await expect.poll(() => calls(page)).toContain("plugin:window|minimize");
    await page.getByTestId("item-travel-token").click({ button: "right" });
    await expect(page.getByTestId("context-menu")).toBeVisible();
    await page.getByTestId("window-maximize").click();
    await expect
        .poll(() => calls(page))
        .toContain("plugin:window|toggle_maximize");
    expect(await calls(page)).not.toContain("plugin:window|start_dragging");
});

test("integrated header stays clear of the preview on desktop and mobile", async ({
    page,
}, testInfo) => {
    await page.goto("/?lang=zh-CN");
    await enterWorkspace(page);
    for (const viewport of [
        { width: 1440, height: 960 },
        { width: 390, height: 844 },
    ]) {
        await page.setViewportSize(viewport);
        await expect(page.getByTestId("tooltip-canvas")).toBeVisible();
        const layout = await page.evaluate(() => {
            const canvas = document.querySelector<HTMLCanvasElement>(
                '[data-testid="tooltip-canvas"]',
            )!;
            const pixels = canvas
                .getContext("2d")!
                .getImageData(0, 0, canvas.width, canvas.height).data;
            return {
                width: document.documentElement.scrollWidth,
                titlebar: document
                    .querySelector(".titlebar")!
                    .getBoundingClientRect().bottom,
                contentTop: document
                    .querySelector(".sidebar")!
                    .getBoundingClientRect().top,
                painted: pixels.some(
                    (value, index) => index % 4 === 3 && value > 0,
                ),
            };
        });
        expect(layout.width).toBe(viewport.width);
        expect(layout.contentTop).toBeGreaterThanOrEqual(layout.titlebar);
        expect(layout.painted).toBe(true);
        await page.screenshot({
            path: testInfo.outputPath(`titlebar-${viewport.width}.png`),
            fullPage: true,
        });
    }
});

test("diagnostics remain in the preview and settings opens a full page", async ({
    page,
}) => {
    await page.goto("/?lang=en-US");
    const document = structuredClone(baselineDocument);
    document.items[0]!.presentation.nameMessage = "item.missing-name";
    await mockPlugin(page, document);
    await enterWorkspace(page);
    await expect(page.getByTestId("open-diagnostics")).toHaveCount(0);
    const diagnostics = page.getByTestId("open-diagnostics-chip");
    await diagnostics.click();
    await expect(
        page.getByTestId("diagnostics-list").locator(":scope > li"),
    ).not.toHaveCount(0);
    await page.getByTestId("open-settings").click();
    await expect(page.getByTestId("workspace-page")).toHaveAttribute(
        "data-page",
        "settings",
    );
    await expect(
        page.getByRole("heading", { name: "Settings", exact: true }),
    ).toBeVisible();
    await expect(page.getByTestId("auto-save-toggle")).toBeChecked();
    await expect(page.getByTestId("project-settings")).toBeVisible();
    await expect(page.getByTestId("project-default-locale")).toBeVisible();
    await expect(page.getByTestId("catalog-read")).toBeVisible();
    await page.getByTestId("open-translations").click();
    await expect(page.getByTestId("diagnostics-list")).toHaveCount(0);
    await expect(
        page.getByRole("heading", { name: "Locale matrix" }),
    ).toBeVisible();
    await page.getByTestId("connection-trigger").click();
    await expect(page.getByTestId("workspace-page")).toHaveAttribute(
        "data-page",
        "translations",
    );
    await expect(page.getByTestId("connection-popup")).toBeVisible();
});
