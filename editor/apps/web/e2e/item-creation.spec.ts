import { expect, test, type Page } from "@playwright/test";
import { contentHash } from "@itemerness/protocol";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import { chooseValue, enterWorkspace, mockPlugin } from "./fixtures/plugin.js";

async function start(page: Page) {
    const plugin = await mockPlugin(page);
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    await page.getByTestId("open-settings").click();
    await page.getByTestId("auto-save-toggle").uncheck();
    await page.getByTestId("mode-items").click();
    return plugin;
}
async function appearance(page: Page) {
    await chooseValue(
        page,
        page.getByTestId("new-item-layout"),
        "itemerness:plain",
    );
    await chooseValue(
        page,
        page.getByTestId("new-item-theme"),
        "itemerness:default",
    );
}

test("blank creation requires explicit appearance, never borrows schemas, and saves as one reversible CAS edit", async ({
    page,
}) => {
    const plugin = await start(page);
    await page.getByTestId("add-item").click();
    await expect(page.getByTestId("new-item-create")).toBeDisabled();
    await expect(page.getByTestId("new-item-layout")).toHaveAttribute(
        "data-field-value",
        "",
    );
    const id = page.getByTestId("new-item-id");
    const initialId = await id.inputValue();
    await id.press("ControlOrMeta+a");
    await id.pressSequentially("temporary");
    await expect(id).toHaveValue("temporary");
    await id.press("ControlOrMeta+z");
    await expect(id).toHaveValue(initialId);
    await expect(page.getByTestId("new-item-dialog")).toBeVisible();
    expect(plugin.writes).toHaveLength(0);
    await id.fill("blank-item");
    await page.getByTestId("new-item-name").fill("Blank Item");
    await appearance(page);
    await page.getByTestId("new-item-create").click();
    await expect(page.getByTestId("new-item-dialog")).toHaveCount(0);
    await expect(page.getByTestId("item-blank-item")).toHaveClass(/selected/);
    await expect(page.getByTestId("name-input")).toHaveValue("Blank Item");
    expect(plugin.writes).toHaveLength(0);
    await page.keyboard.press("ControlOrMeta+s");
    await expect.poll(() => plugin.writes.length).toBe(1);
    const created = plugin.writes[0]!.document.items.at(-1)!;
    expect(created.enabled).toBe(false);
    expect(created.definition.instance.schemas).toEqual([]);
    expect(created.definition.instance.defaults).toEqual([]);
    expect(created.presentation.blocks).toEqual([]);
    expect(plugin.writes[0]!.expectedHash).toBe(contentHash(baselineDocument));
    await page.getByTestId("undo").click();
    await expect(page.getByTestId("item-blank-item")).toHaveCount(0);
    await page.keyboard.press("ControlOrMeta+s");
    await expect.poll(() => plugin.writes.length).toBe(2);
    expect(plugin.writes[1]!.document).toEqual(baselineDocument);
    expect(plugin.writes[1]!.expectedHash).toBe(
        contentHash(plugin.writes[0]!.document),
    );
});

test("existing definitions are copied once with independent messages and quality-neutral appearance changes", async ({
    page,
}) => {
    const plugin = await start(page);
    const source = baselineDocument.items.find(
        (item) => item.id === "ember-blade",
    )!;
    await page.getByTestId("add-item").click();
    await chooseValue(page, page.getByTestId("new-item-source"), source.uuid);
    await expect(page.getByTestId("new-item-source-summary")).toContainText(
        "Enabled",
    );
    await expect(page.getByTestId("new-item-id")).toHaveValue(
        "ember-blade-copy",
    );
    await expect(page.getByTestId("new-item-layout")).toHaveAttribute(
        "data-field-value",
        "__source__",
    );
    await page.getByTestId("new-item-name").fill("Frost Blade");
    await chooseValue(
        page,
        page.getByTestId("new-item-theme"),
        "itemerness:default",
    );
    await page.getByTestId("new-item-create").click();
    await expect(page.getByTestId("name-input")).toHaveValue("Frost Blade");
    await page.keyboard.press("ControlOrMeta+s");
    await expect.poll(() => plugin.writes.length).toBe(1);
    const created = plugin.writes[0]!.document.items.at(-1)!;
    expect(created.definition).toEqual(source.definition);
    expect(created.previewData).toEqual(source.previewData);
    expect(created.presentation.theme).toBe("itemerness:default");
    expect(created.presentation.layout).toBe(source.presentation.layout);
    expect(created.presentation.nameMessage).not.toBe(
        source.presentation.nameMessage,
    );
    expect(created.enabled).toBe(false);
    await page.getByTestId("item-ember-blade").click();
    await page.getByTestId("name-input").fill("Original changed later");
    await page.getByTestId("item-ember-blade-copy").click();
    await expect(page.getByTestId("name-input")).toHaveValue("Frost Blade");
    await expect(page.getByTestId("new-item-source")).toHaveCount(0);
});

test("cancelling or incomplete new-item buffers do not write or escape through Save and navigation", async ({
    page,
}) => {
    const plugin = await start(page);
    await page
        .getByTestId("item-tree")
        .click({ button: "right", position: { x: 2, y: 2 } });
    await page.getByTestId("menu-new-item").click();
    await page.getByTestId("new-item-id").fill("travel-token");
    await expect(page.getByTestId("new-item-create")).toBeDisabled();
    await expect(page.getByTestId("new-item-error")).toContainText(
        "already in use",
    );
    await page.keyboard.press("ControlOrMeta+s");
    await expect(page.getByTestId("new-item-error")).toContainText(
        "Create or cancel",
    );
    expect(plugin.writes).toHaveLength(0);
    await page.getByTestId("open-settings").click({ force: true });
    await expect(page.getByTestId("new-item-dialog")).toBeVisible();
    await page.getByTestId("new-item-cancel").click();
    await expect(page.getByTestId("new-item-dialog")).toHaveCount(0);
    await expect(page.getByTestId("undo")).toBeDisabled();
    await page.getByTestId("open-settings").click();
    await expect(page.getByTestId("auto-save-toggle")).toBeVisible();
    expect(plugin.writes).toHaveLength(0);
});

test("disconnect discards only the explicitly cancelled creation and never resurrects its source", async ({
    page,
}) => {
    const plugin = await start(page);
    await page.getByTestId("add-item").click();
    await page.getByTestId("new-item-name").fill("Not created");
    await page.getByTestId("connection-trigger").click();
    await page.getByTestId("disconnect-plugin").click();
    await expect(page.getByTestId("unsaved-dialog")).toBeVisible();
    for (const direction of ["Tab", "Shift+Tab"]) {
        for (let index = 0; index < 6; index += 1) {
            await page.keyboard.press(direction);
            expect(
                await page.evaluate(() =>
                    Boolean(
                        document.activeElement?.closest(
                            '[data-testid="unsaved-dialog"], .window-controls',
                        ),
                    ),
                ),
            ).toBe(true);
        }
    }
    await page.getByTestId("leave-cancel").click();
    await expect(page.getByTestId("new-item-name")).toHaveValue("Not created");
    if (!(await page.getByTestId("connection-popup").isVisible()))
        await page.getByTestId("connection-trigger").click();
    await page.getByTestId("disconnect-plugin").click();
    await page.getByTestId("leave-discard").click();
    await expect(page.getByTestId("new-item-dialog")).toHaveCount(0);
    await expect(page.getByTestId("workspace")).toHaveAttribute(
        "data-ready",
        "false",
    );
    await enterWorkspace(page);
    await page.getByTestId("add-item").click();
    await expect(page.getByTestId("new-item-name")).not.toHaveValue(
        "Not created",
    );
    await page.getByTestId("new-item-cancel").click();
    expect(plugin.writes).toHaveLength(0);
});

test("creation fields and source menus fit narrow and short viewports with layered Escape", async ({
    page,
}, testInfo) => {
    await start(page);
    for (const viewport of [
        { width: 320, height: 568 },
        { width: 640, height: 360 },
    ]) {
        await page.setViewportSize(viewport);
        await page.getByTestId("add-item").click();
        await page.getByTestId("new-item-source").click();
        await expect(
            page
                .locator('[data-ui-popup][aria-label="Starting point"]')
                .getByRole("listbox"),
        ).toBeVisible();
        await page.screenshot({
            path: testInfo.outputPath(`new-item-source-${viewport.width}.png`),
        });
        await page.keyboard.press("Escape");
        await expect(page.getByTestId("new-item-dialog")).toBeVisible();
        const bounds = await page.getByTestId("new-item-dialog").boundingBox();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
        expect(bounds!.y).toBeGreaterThanOrEqual(52);
        expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height);
        await expect(page.getByTestId("new-item-cancel")).toBeInViewport();
        expect(
            await page.evaluate(
                () => document.documentElement.scrollWidth <= innerWidth,
            ),
        ).toBe(true);
        await page.screenshot({
            path: testInfo.outputPath(`new-item-dialog-${viewport.width}.png`),
        });
        await page.keyboard.press("Escape");
        await expect(page.getByTestId("new-item-dialog")).toHaveCount(0);
    }
});
