import { expect, test } from "@playwright/test";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import {
    mockPlugin,
    enterWorkspace,
    chooseValue,
    setColor,
    selectContent,
} from "./fixtures/plugin.js";

test("item actions are icon commands in the global header, with styled confirmation and undo", async ({
    page,
}) => {
    const plugin = await mockPlugin(page);
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    await expect(page.getByTestId("delete-item")).toHaveText("");
    await expect(
        page.locator(".advanced").getByTestId("delete-item"),
    ).toHaveCount(0);
    await page.getByTestId("delete-item").click();
    await expect(page.getByTestId("confirm-dialog")).toBeVisible();
    await page.getByTestId("confirm-cancel").click();
    expect(plugin.writes).toHaveLength(0);
    await page.getByTestId("item-ember-blade").click({ button: "right" });
    await expect(page.getByTestId("context-menu")).toBeVisible();
    await expect(page.getByTestId("name-input")).toHaveValue(
        "Harbor Travel Token",
    );
    await page.getByTestId("menu-delete-item").click();
    await expect(page.getByTestId("confirm-dialog")).toContainText(
        "Ember Blade",
    );
    await page.getByTestId("confirm-accept").click();
    await expect(page.getByTestId("item-ember-blade")).toHaveCount(0);
    await page.getByTestId("undo").click();
    await expect(page.getByTestId("item-ember-blade")).toBeVisible();
});

test("all inspector choice controls, color wells and material suggestions use application popups", async ({
    page,
}, info) => {
    await mockPlugin(page);
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    await chooseValue(
        page,
        page.getByTestId("form-layout"),
        "itemerness:equipment",
    );
    await page.getByTestId("material-input").fill("diamond");
    await page.locator('[data-option-value="diamond_sword"]').click();
    await expect(page.getByTestId("material-input")).toHaveValue(
        "diamond_sword",
    );
    await selectContent(
        page,
        baselineDocument.items[0]!.presentation.blocks[0]!.uuid,
    );
    await chooseValue(
        page,
        page.getByRole("combobox", { name: "Data", exact: true }),
        "example:charges",
    );
    await page.getByRole("combobox", { name: "Style", exact: true }).click();
    await page.screenshot({ path: info.outputPath("content-select.png") });
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await page.getByTestId("mode-themes").click();
    await page.getByTestId("theme-vanilla-frame").click();
    await chooseValue(page, page.getByTestId("frame-preset"), "UNICODE_DOUBLE");
    await setColor(page, "color-frame", "#ff5500");
    await expect(
        page.locator('select,datalist,input[type="color"]'),
    ).toHaveCount(0);
    await page.getByTestId("color-frame").click();
    await page.screenshot({ path: info.outputPath("color-popup.png") });
});

test("canvas context commands insert, move, duplicate and remove the actual selected block", async ({
    page,
}) => {
    await mockPlugin(page);
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    await page.getByTestId("line-hit-name").click({ button: "right" });
    await expect(page.getByTestId("menu-insert-before")).toHaveCount(0);
    await page.getByTestId("menu-insert-after").hover();
    await page.getByTestId("menu-add-text").click();
    await expect(page.getByTestId("content-inspector")).toBeVisible();
    const uuid = await page.locator("[data-block]").getAttribute("data-block");
    await page
        .locator(`.line-hit[data-origin="${uuid}"]`)
        .first()
        .click({ button: "right" });
    await page.getByTestId("menu-move-down").click();
    await page.locator(`.line-hit[data-origin="${uuid}"]`).first().focus();
    await page.keyboard.press("Shift+F10");
    await expect(page.getByTestId("context-menu")).toBeVisible();
    await page.getByTestId("menu-delete-content").click();
    await expect(page.locator(`.line-hit[data-origin="${uuid}"]`)).toHaveCount(
        0,
    );
    await page.getByTestId("undo").click();
    await expect(
        page.locator(`.line-hit[data-origin="${uuid}"]`).first(),
    ).toBeVisible();
});

test("text context menus preserve selection and support clipboard commands without reading on open", async ({
    page,
    context,
}) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await mockPlugin(page);
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    const name = page.getByTestId("name-input");
    await name.selectText();
    await name.click({ button: "right" });
    await page.getByTestId("menu-copy").click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
        "Harbor Travel Token",
    );
    await page.evaluate(() => navigator.clipboard.writeText("Clipboard name"));
    await name.selectText();
    await name.click({ button: "right" });
    await page.getByTestId("menu-paste").click();
    await expect(name).toHaveValue("Clipboard name");
    await page.getByTestId("undo").click();
    await expect(name).toHaveValue("Harbor Travel Token");
});

test("outline context menus target the clicked block without changing the inspector", async ({
    page,
}) => {
    const plugin = await mockPlugin(page);
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    await page.getByTestId("line-hit-1").click();
    const selected = await page
        .locator("[data-block]")
        .getAttribute("data-block");
    await page.getByTestId("content-menu").click();
    const target = baselineDocument.items[0]!.presentation.blocks.find(
        (block) => block.uuid !== selected,
    )!.uuid;
    await page
        .getByTestId(`select-content-${target}`)
        .click({ button: "right" });
    await expect(page.getByTestId("menu-edit-content")).toBeVisible();
    await expect(page.locator("[data-block]")).toHaveAttribute(
        "data-block",
        selected!,
    );
    await page.getByTestId("menu-edit-content").click();
    await expect(page.locator("[data-block]")).toHaveAttribute(
        "data-block",
        target,
    );
    expect(plugin.writes).toHaveLength(0);
});

test("navigation, library, translations, assets and diagnostics have contextual operations", async ({
    page,
}) => {
    await mockPlugin(page);
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    await page
        .getByTestId("primary-navigation")
        .click({ button: "right", position: { x: 10, y: 300 } });
    await page.getByTestId("menu-toggle-navigation").click();
    await expect(page.getByTestId("toggle-navigation")).toHaveAttribute(
        "aria-expanded",
        "true",
    );
    await page.getByTestId("mode-themes").click();
    await page.getByTestId("theme-vanilla-frame").click({ button: "right" });
    await expect(page.getByTestId("menu-copy-id")).toBeVisible();
    await expect(page.getByTestId("menu-related-items")).toBeEnabled();
    await page.keyboard.press("Escape");
    await page.getByTestId("open-assets").click();
    await page.getByTestId("asset-dropzone").click({ button: "right" });
    await expect(page.getByTestId("menu-import-assets")).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByTestId("open-translations").click();
    const key = baselineDocument.items[0]!.presentation.nameMessage;
    await page.getByTestId(`message-zh_cn-${key}`).click({ button: "right" });
    await expect(page.getByTestId("menu-copy-key")).toBeVisible();
    await page.getByTestId("menu-clear-translation").click();
    await expect(page.getByTestId(`message-zh_cn-${key}`)).toHaveValue("");
    await applicationMenuAction(page, "edit", "undo");
    await expect(page.getByTestId(`message-zh_cn-${key}`)).not.toHaveValue("");
});

test("inline text right click preserves the draft and Escape cancels it", async ({
    page,
    context,
}) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const plugin = await mockPlugin(page);
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    await page.getByTestId("line-hit-name").dblclick();
    const input = page.getByTestId("inline-editor");
    await input.fill("Uncommitted text");
    await input.selectText();
    await input.click({ button: "right" });
    await page.getByTestId("menu-copy").click();
    await expect(input).toHaveValue("Uncommitted text");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
        "Uncommitted text",
    );
    expect(plugin.writes).toHaveLength(0);
    await input.press("Escape");
    await expect(page.getByTestId("name-input")).toHaveValue(
        "Harbor Travel Token",
    );
});

test("a delayed paste cannot edit a different item and password menus never expose copy", async ({
    page,
}) => {
    await page.addInitScript(() => {
        Object.defineProperty(navigator, "clipboard", {
            configurable: true,
            value: {
                readText: () =>
                    new Promise<string>((resolve) => {
                        (
                            window as unknown as {
                                finishPaste(value: string): void;
                            }
                        ).finishPaste = resolve;
                    }),
                writeText: async () => {},
            },
        });
    });
    await mockPlugin(page);
    await page.goto("/?lang=en-US");
    await page.getByTestId("connection-trigger").click();
    await page.getByTestId("plugin-api-token").fill("secret-" + "a".repeat(40));
    await page.getByTestId("plugin-api-token").selectText();
    await page.getByTestId("plugin-api-token").click({ button: "right" });
    await expect(page.getByTestId("menu-copy")).toBeDisabled();
    await expect(page.getByTestId("menu-cut")).toBeDisabled();
    await page.keyboard.press("Escape");
    await enterWorkspace(page);
    const name = page.getByTestId("name-input");
    await name.selectText();
    await name.click({ button: "right" });
    await page.getByTestId("menu-paste").click();
    await page.getByTestId("item-ember-blade").click();
    await page.evaluate(() =>
        (window as unknown as { finishPaste(value: string): void }).finishPaste(
            "Wrong item",
        ),
    );
    await expect(name).toHaveValue("Ember Blade");
});

test("popups fit light/dark desktop and narrow screens, with keyboard field selection", async ({
    page,
}, info) => {
    await mockPlugin(page);
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    for (const colorScheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme });
        for (const size of [
            { width: 1440, height: 900 },
            { width: 390, height: 844 },
        ]) {
            await page.setViewportSize(size);
            await page.getByTestId("form-layout").click();
            const list = page.locator(".ui-select-popup");
            await expect(list).toBeVisible();
            const box = (await list.boundingBox())!;
            expect(box.x).toBeGreaterThanOrEqual(0);
            expect(box.x + box.width).toBeLessThanOrEqual(size.width + 1);
            expect(box.y).toBeGreaterThanOrEqual(50);
            expect(box.y + box.height).toBeLessThanOrEqual(size.height + 1);
            await page.screenshot({
                path: info.outputPath(
                    `select-${colorScheme}-${size.width}.png`,
                ),
            });
            await page.keyboard.press("Escape");
            await page
                .getByTestId("item-travel-token")
                .click({ button: "right" });
            const menu = (await page
                .getByTestId("context-menu")
                .boundingBox())!;
            expect(menu.x + menu.width).toBeLessThanOrEqual(size.width + 1);
            expect(menu.y + menu.height).toBeLessThanOrEqual(size.height + 1);
            await page.keyboard.press("Escape");
        }
    }
});
import { applicationMenuAction } from "./fixtures/applicationMenu.js";
