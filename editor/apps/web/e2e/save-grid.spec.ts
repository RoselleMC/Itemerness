import { expect, test, type Page } from "@playwright/test";
import {
    API_URL,
    enterWorkspace,
    mockPlugin,
    setZoom,
} from "./fixtures/plugin.js";

async function automatic(page: Page, enabled: boolean) {
    await page.getByTestId("open-settings").click();
    await page.getByTestId("auto-save-toggle").setChecked(enabled);
    await page.getByTestId("mode-items").click();
}

test("manual mode persists, never saves on its own, and supports Ctrl/Cmd+S and the status light", async ({
    page,
}) => {
    const plugin = await mockPlugin(page);
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    await automatic(page, false);
    await page.getByTestId("name-input").fill("Manual draft");
    await expect(page.getByTestId("document-sync-status")).toHaveAttribute(
        "data-sync-kind",
        "unsaved",
    );
    await page.waitForTimeout(650);
    expect(plugin.writes).toHaveLength(0);
    await page.getByTestId("name-input").press("Control+s");
    await expect.poll(() => plugin.writes.length).toBe(1);
    await expect(page.getByTestId("document-sync-status")).toHaveAttribute(
        "data-sync-kind",
        "saved",
    );
    await page.getByTestId("name-input").fill("Second draft");
    await page.getByTestId("document-sync-status").click();
    await expect.poll(() => plugin.writes.length).toBe(2);
    await page.getByTestId("name-input").fill("Third draft");
    await page.getByTestId("name-input").press("Meta+s");
    await expect.poll(() => plugin.writes.length).toBe(3);
    await expect(page.getByTestId("document-sync-status")).toHaveAttribute(
        "data-sync-kind",
        "saved",
    );
    await page.reload();
    await page.getByTestId("open-settings").click();
    await expect(page.getByTestId("auto-save-toggle")).not.toBeChecked();
});

test("turning automatic saving back on flushes the dirty draft without changing history", async ({
    page,
}, info) => {
    const plugin = await mockPlugin(page);
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    await automatic(page, false);
    await page.getByTestId("name-input").fill("Enable automatic");
    await page.getByTestId("open-settings").click();
    await page.screenshot({
        path: info.outputPath("auto-save-setting.png"),
        fullPage: true,
    });
    await page.getByTestId("auto-save-toggle").check();
    await expect.poll(() => plugin.writes.length).toBe(1);
    await applicationMenuAction(page, "edit", "undo");
    await expect.poll(() => plugin.writes.length).toBe(2);
    await page.getByTestId("mode-items").click();
    await expect(page.getByTestId("name-input")).toHaveValue(
        "Harbor Travel Token",
    );
    await expect(page.getByTestId("undo")).toBeDisabled();
});

test("Save commits in-place text and manual disconnect offers save, discard or cancel", async ({
    page,
}) => {
    const plugin = await mockPlugin(page);
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    await automatic(page, false);
    await page.getByTestId("line-hit-name").dblclick();
    await page.getByTestId("inline-editor").fill("Saved inline");
    await page.getByTestId("inline-editor").press("Control+s");
    await expect(page.getByTestId("inline-editor")).toHaveCount(0);
    await expect.poll(() => plugin.writes.length).toBe(1);
    await expect(page.getByTestId("name-input")).toHaveValue("Saved inline");
    await page.getByTestId("name-input").fill("Save before disconnect");
    await page.getByTestId("connection-trigger").click();
    await page.getByTestId("disconnect-plugin").click();
    await expect(page.getByTestId("unsaved-dialog")).toBeVisible();
    await page.getByTestId("leave-cancel").click();
    await expect(page.getByTestId("workspace")).toHaveAttribute(
        "data-ready",
        "true",
    );
    await page.getByTestId("connection-trigger").click();
    await page.getByTestId("disconnect-plugin").click();
    await page.getByTestId("leave-save").click();
    await expect(page.getByTestId("workspace")).toHaveAttribute(
        "data-ready",
        "false",
    );
    expect(plugin.writes).toHaveLength(2);
    await enterWorkspace(page);
    await page.getByTestId("name-input").fill("Discard this edit");
    await page.getByTestId("connection-trigger").click();
    await page.getByTestId("disconnect-plugin").click();
    await page.getByTestId("leave-discard").click();
    await expect(page.getByTestId("workspace")).toHaveAttribute(
        "data-ready",
        "false",
    );
    expect(plugin.writes).toHaveLength(2);
});

test("manual save failures retain the draft and block leaving until resolved", async ({
    page,
}) => {
    await mockPlugin(page);
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    await automatic(page, false);
    await page.route(`${API_URL}/api/v2/document`, (route) =>
        route.request().method() === "PUT"
            ? route.fulfill({ status: 409, json: { actualHash: "remote" } })
            : route.fallback(),
    );
    await page.getByTestId("name-input").fill("Local conflict");
    await page.getByTestId("connection-trigger").click();
    await page.getByTestId("disconnect-plugin").click();
    await page.getByTestId("leave-save").click();
    await expect(
        page.getByTestId("unsaved-dialog").getByRole("alert"),
    ).toBeVisible();
    await expect(page.getByTestId("workspace")).toHaveAttribute(
        "data-ready",
        "true",
    );
    await page.getByTestId("leave-cancel").click();
    await expect(page.getByTestId("name-input")).toHaveValue("Local conflict");
});

async function nativeBridge(page: Page, platform = "macos") {
    await page.addInitScript(
        ({ url, platform }) => {
            const runtime = window as unknown as Record<string, unknown>;
            const callbacks = new Map<number, (event: unknown) => void>();
            const listeners = new Map<
                number,
                { event: string; handler: number }
            >();
            let next = 0;
            runtime.isTauri = true;
            Object.defineProperty(navigator, "userAgent", {
                value:
                    platform === "macos"
                        ? "Macintosh Mac OS X"
                        : "Windows NT 10.0",
            });
            runtime.menuStates = [];
            runtime.exitConfirmed = 0;
            runtime.captionCommands = [];
            runtime.emitNative = (name: string) => {
                for (const [id, listener] of listeners)
                    if (listener.event === name)
                        callbacks.get(listener.handler)?.({
                            event: name,
                            id,
                            payload: null,
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
                    args: Record<string, unknown>,
                ) => {
                    if (command.startsWith("plugin:window|"))
                        (runtime.captionCommands as string[]).push(command);
                    if (command === "plugin_request") {
                        const response = await fetch(url + String(args.path), {
                            method: String(args.method),
                            body: args.body as string | undefined,
                            headers: { "Content-Type": "application/json" },
                        });
                        return {
                            status: response.status,
                            body: await response.text(),
                        };
                    }
                    if (command === "plugin:event|listen") {
                        listeners.set(
                            ++next,
                            args as { event: string; handler: number },
                        );
                        return next;
                    }
                    if (command === "plugin:event|unlisten") {
                        listeners.delete(Number(args.eventId));
                        return;
                    }
                    if (command === "update_editor_menu")
                        (runtime.menuStates as unknown[]).push(args);
                    if (command === "confirm_editor_exit")
                        runtime.exitConfirmed =
                            Number(runtime.exitConfirmed) + 1;
                    if (command === "plugin:window|is_maximized") return false;
                    if (command === "plugin:window|is_focused") return true;
                },
            };
            runtime.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
                unregisterListener: (id: number) => listeners.delete(id),
            };
        },
        { url: API_URL, platform },
    );
}

test("native File Save events use the same queue, menu state and unsaved exit confirmation", async ({
    page,
}) => {
    const plugin = await mockPlugin(page);
    await nativeBridge(page);
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    await automatic(page, false);
    await page.getByTestId("line-hit-name").dblclick();
    await page.getByTestId("inline-editor").fill("Native menu save");
    await page.evaluate(() =>
        (window as unknown as { emitNative(event: string): void }).emitNative(
            "editor-save",
        ),
    );
    await expect.poll(() => plugin.writes.length).toBe(1);
    await expect
        .poll(() =>
            page.evaluate(() =>
                (
                    window as unknown as {
                        menuStates: {
                            groups: {
                                id: string;
                                items: {
                                    id: string;
                                    enabled: boolean;
                                    label: string;
                                }[];
                            }[];
                        }[];
                    }
                ).menuStates
                    .at(-1)
                    ?.groups.find((group) => group.id === "file")
                    ?.items.find((item) => item.id === "save-document"),
            ),
        )
        .toMatchObject({ enabled: true, label: "Save" });
    await page.getByTestId("name-input").fill("Native exit save");
    await page.evaluate(() =>
        (window as unknown as { emitNative(event: string): void }).emitNative(
            "editor-exit-requested",
        ),
    );
    await expect(page.getByTestId("unsaved-dialog")).toBeVisible();
    await page.getByTestId("leave-cancel").click();
    expect(
        await page.evaluate(
            () =>
                (window as unknown as { exitConfirmed: number }).exitConfirmed,
        ),
    ).toBe(0);
    await page.evaluate(() =>
        (window as unknown as { emitNative(event: string): void }).emitNative(
            "tauri://close-requested",
        ),
    );
    await page.getByTestId("leave-save").click();
    await expect
        .poll(() =>
            page.evaluate(
                () =>
                    (window as unknown as { exitConfirmed: number })
                        .exitConfirmed,
            ),
        )
        .toBe(1);
    expect(plugin.writes).toHaveLength(2);
});

test("Windows caption controls stay usable above the unsaved confirmation", async ({
    page,
}) => {
    await mockPlugin(page);
    await nativeBridge(page, "windows");
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    await automatic(page, false);
    await page.getByTestId("name-input").fill("Unsaved window");
    await page.evaluate(() =>
        (window as unknown as { emitNative(event: string): void }).emitNative(
            "editor-exit-requested",
        ),
    );
    await expect(page.getByTestId("unsaved-dialog")).toBeVisible();
    await page.getByTestId("window-minimize").click();
    await expect(page.getByTestId("unsaved-dialog")).toBeVisible();
    expect(
        await page.evaluate(
            () =>
                (window as unknown as { captionCommands: string[] })
                    .captionCommands,
        ),
    ).toContain("plugin:window|minimize");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("unsaved-dialog")).toHaveCount(0);
    await expect(page.getByTestId("name-input")).toHaveValue("Unsaved window");
});

test("checkerboard coordinates and tile size follow pan, zoom and scrolling", async ({
    page,
}) => {
    await mockPlugin(page);
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    await setZoom(page, 2);
    const area = page.getByTestId("canvas-viewport");
    const sample = () =>
        area.evaluate((element) => {
            const outer = element.getBoundingClientRect(),
                canvas = element
                    .querySelector(".canvas-wrap")!
                    .getBoundingClientRect();
            const css = getComputedStyle(element),
                [x, y] = css.backgroundPosition.split(" ").map(parseFloat);
            return {
                x,
                y,
                tile: parseFloat(css.backgroundSize),
                zoom: Number((element as HTMLElement).dataset.zoom),
                canvasX: canvas.left - outer.left,
                canvasY: canvas.top - outer.top,
            };
        });
    const before = await sample();
    const rect = (await area.boundingBox())!;
    await page.mouse.move(rect.x + 10, rect.y + 10);
    await page.mouse.down();
    await page.mouse.move(rect.x + 80, rect.y + 60, { steps: 8 });
    await page.mouse.up();
    const moved = await sample();
    expect(moved.x! - before.x!).toBeCloseTo(70, 1);
    expect(moved.y! - before.y!).toBeCloseTo(50, 1);
    await setZoom(page, 8);
    await area.evaluate((element) => {
        element.scrollTop = 100;
        element.scrollLeft = 80;
    });
    await expect
        .poll(async () => {
            const current = await sample();
            return (
                Math.abs(current.x! - current.canvasX) +
                Math.abs(current.y! - current.canvasY)
            );
        })
        .toBeLessThan(0.05);
    const zoomed = await sample();
    expect(zoomed.tile).toBeCloseTo(zoomed.zoom * 6, 3);
    expect(zoomed.tile).toBe(before.tile * 4);
});
import { applicationMenuAction } from "./fixtures/applicationMenu.js";
