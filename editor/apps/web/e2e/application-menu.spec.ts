import { expect, test, type Page } from "@playwright/test";
import { enterWorkspace, mockPlugin } from "./fixtures/plugin.js";

async function menu(page: Page, group: string) {
    const trigger = page.getByTestId(`app-menu-${group}`);
    if (await trigger.isVisible()) await trigger.click();
    else {
        await page.getByTestId("app-menu-compact").click();
        await page.getByTestId(`menu-application-${group}`).hover();
    }
}

test("settings shortcut and menu work before connecting; unavailable document commands stay disabled", async ({
    page,
}) => {
    await page.goto("/?lang=en-US");
    await expect(page.locator(".titlebar h1")).toHaveCount(0);
    await menu(page, "file");
    await expect(page.getByTestId("menu-new-item")).toHaveAttribute(
        "aria-disabled",
        "true",
    );
    await expect(page.getByTestId("menu-save-document")).toHaveAttribute(
        "aria-disabled",
        "true",
    );
    await expect(page.getByTestId("menu-settings")).toContainText(
        /(?:Cmd|Ctrl)\+,/,
    );
    await page.getByTestId("menu-settings").click();
    await expect(page.getByTestId("auto-save-toggle")).toBeVisible();
    await page.keyboard.press("Control+,");
    await expect(page.getByTestId("auto-save-toggle")).toBeVisible();
    await page.keyboard.press("Control+Shift+K");
    await expect(page.getByTestId("connection-popup")).toBeVisible();
});

test("shared document commands save and undo across pages, and create through the existing dialog", async ({
    page,
}) => {
    const plugin = await mockPlugin(page);
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    await menu(page, "file");
    await page.getByTestId("menu-auto-save").click();
    const original = await page.getByTestId("name-input").inputValue();
    await page.getByTestId("name-input").fill("Menu history");
    await page.keyboard.press("Control+,");
    await menu(page, "edit");
    await page.getByTestId("menu-undo").click();
    await menu(page, "file");
    await page.getByTestId("menu-save-document").click();
    await page.getByTestId("mode-items").click();
    await expect(page.getByTestId("name-input")).toHaveValue(original);
    await page.getByTestId("redo").click();
    await page.keyboard.press("Control+s");
    await expect
        .poll(() =>
            Object.values(
                plugin.writes.at(-1)?.document.locales[0]?.messages ?? {},
            ),
        )
        .toContain("Menu history");
    await page.keyboard.press("Control+n");
    await expect(page.getByTestId("new-item-dialog")).toBeVisible();
    await page.keyboard.press("Control+,");
    await expect(page.getByTestId("new-item-dialog")).toBeVisible();
    await page.getByTestId("new-item-cancel").click();
});

test("canvas history stays centered and menus fit desktop and narrow windows", async ({
    page,
}, info) => {
    await mockPlugin(page);
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    for (const width of [2400, 1440, 1024, 900, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        const toolbar = (await page.locator(".canvas-toolbar").boundingBox())!;
        const history = (await page
            .getByRole("group", { name: "Document history" })
            .boundingBox())!;
        expect(
            Math.abs(
                history.x + history.width / 2 - toolbar.x - toolbar.width / 2,
            ),
        ).toBeLessThan(2);
        const zoom = (await page.locator(".zoom-tools").boundingBox())!;
        expect(
            zoom.x + zoom.width <= history.x + 1 ||
                zoom.y + zoom.height <= history.y + 1,
        ).toBeTruthy();
        await menu(page, "file");
        const popup = (await page.getByTestId("menu-settings").boundingBox())!;
        expect(popup.x).toBeGreaterThanOrEqual(0);
        expect(popup.x + popup.width).toBeLessThanOrEqual(width);
        await page.screenshot({ path: info.outputPath(`menu-${width}.png`) });
        await page.keyboard.press("Escape");
        await page.keyboard.press("Escape");
    }
});

test("menu keyboard access, canvas zoom and about do not disturb titlebar controls", async ({
    page,
}) => {
    await mockPlugin(page);
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    await page.keyboard.press("F10");
    await expect(page.getByTestId("app-menu-file")).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByTestId("menu-settings")).toBeVisible();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Alt+v");
    await expect(page.getByTestId("menu-zoom-in")).toBeVisible();
    await page.getByTestId("menu-zoom-reset").click();
    await expect(page.getByTestId("canvas-viewport")).toHaveAttribute(
        "data-zoom",
        "1",
    );
    await page.keyboard.press("Control+=");
    await expect(page.getByTestId("canvas-viewport")).toHaveAttribute(
        "data-zoom",
        "1.2",
    );
    await menu(page, "help");
    await page.getByTestId("menu-about").click();
    await expect(
        page.getByRole("dialog", { name: "Itemerness Editor", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(
        page.getByRole("dialog", { name: "Itemerness Editor", exact: true }),
    ).toHaveCount(0);
});

test("Edit respects selected text, password protection and input undo", async ({
    page,
}) => {
    await page.goto("/?lang=en-US");
    await page.getByTestId("connection-trigger").click();
    const address = page.getByTestId("plugin-api-url");
    await address.fill("");
    await address.pressSequentially("http://example.test:18087");
    await menu(page, "edit");
    await expect(page.getByTestId("menu-copy")).toHaveAttribute(
        "aria-disabled",
        "true",
    );
    await page.getByTestId("menu-undo").click();
    await expect(address).toHaveValue("");
    await address.fill("http://example.test:18087");
    await address.press("ControlOrMeta+a");
    await menu(page, "edit");
    await expect(page.getByTestId("menu-copy")).not.toHaveAttribute(
        "aria-disabled",
        "true",
    );
    await page.keyboard.press("Escape");
    const password = page.getByTestId("plugin-api-token");
    await password.fill("private-token");
    await password.press("ControlOrMeta+a");
    await menu(page, "edit");
    await expect(page.getByTestId("menu-copy")).toHaveAttribute(
        "aria-disabled",
        "true",
    );
    await expect(page.getByTestId("menu-cut")).toHaveAttribute(
        "aria-disabled",
        "true",
    );
});
