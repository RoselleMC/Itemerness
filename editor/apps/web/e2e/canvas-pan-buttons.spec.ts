import { expect, test, type Page } from "@playwright/test";
import { chooseValue, enterWorkspace, mockPlugin } from "./fixtures/plugin.js";

async function position(page: Page) {
    return (await page.getByTestId("tooltip-canvas").boundingBox())!;
}
async function dragContent(
    page: Page,
    button: "right" | "middle",
    cancel = false,
) {
    const line = (await page.getByTestId("line-hit-name").boundingBox())!;
    await page.mouse.move(line.x + line.width / 2, line.y + line.height / 2);
    await page.mouse.down({ button });
    await page.mouse.move(
        line.x + line.width / 2 + 56,
        line.y + line.height / 2 + 31,
        { steps: 8 },
    );
    if (cancel) await page.keyboard.press("Escape");
    await page.mouse.up({ button });
}

test("right and middle buttons pan over content without edits or a stray menu", async ({
    page,
}) => {
    const plugin = await mockPlugin(page);
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    for (const button of ["right", "middle"] as const) {
        const before = await position(page);
        await dragContent(page, button);
        const after = await position(page);
        expect(after.x - before.x).toBeCloseTo(56, 0);
        expect(after.y - before.y).toBeCloseTo(31, 0);
        await expect(page.getByTestId("context-menu")).toHaveCount(0);
        await expect(page.getByTestId("global-inspector")).toBeVisible();
    }
    const before = await position(page);
    await dragContent(page, "right", true);
    expect((await position(page)).x).toBeCloseTo(before.x, 0);
    expect((await position(page)).y).toBeCloseTo(before.y, 0);
    await expect(page.getByTestId("context-menu")).toHaveCount(0);
    expect(plugin.writes).toHaveLength(0);
    await page
        .locator('.line-hit:not([data-origin="__name"])')
        .first()
        .click({ button: "right" });
    await expect(page.getByTestId("menu-edit-content")).toBeVisible();
    await expect(page.getByTestId("global-inspector")).toBeVisible();
    await page.getByTestId("menu-edit-content").click();
    await expect(page.getByTestId("content-inspector")).toBeVisible();
});

test("a right click with minor movement keeps its object menu and fit state", async ({
    page,
}) => {
    await mockPlugin(page);
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    const before = await position(page);
    const line = (await page.getByTestId("line-hit-name").boundingBox())!;
    await page.mouse.move(line.x + 20, line.y + 4);
    await page.mouse.down({ button: "right" });
    await expect(page.getByTestId("context-menu")).toHaveCount(0);
    await page.mouse.move(line.x + 22, line.y + 5);
    await page.mouse.up({ button: "right" });
    await expect(page.getByTestId("menu-edit-content")).toBeVisible();
    await expect(page.getByTestId("menu-insert-before")).toHaveCount(0);
    await expect(page.getByTestId("zoom-fit")).toHaveAttribute(
        "aria-pressed",
        "true",
    );
    expect((await position(page)).x).toBeCloseTo(before.x, 0);
    await page.keyboard.press("Escape");
    await page.locator('.line-hit:not([data-origin="__name"])').first().focus();
    await page.keyboard.press("Shift+F10");
    await expect(page.getByTestId("menu-insert-before")).toBeVisible();
});

test("pan button preference is local, immediate, and survives reopening the editor", async ({
    page,
}) => {
    const plugin = await mockPlugin(page);
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    await page.getByTestId("open-settings").click();
    const field = page.getByTestId("canvas-pan-buttons");
    await expect(field).toHaveAttribute("data-field-value", "middle-right");
    await chooseValue(page, field, "middle");
    await page.getByTestId("mode-items").click();
    const before = await position(page);
    await dragContent(page, "right");
    expect((await position(page)).x).toBeCloseTo(before.x, 0);
    await expect(page.getByTestId("context-menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await dragContent(page, "middle");
    expect((await position(page)).x - before.x).toBeCloseTo(56, 0);
    expect(plugin.writes).toHaveLength(0);
    await page.reload();
    await page.getByTestId("open-settings").click();
    await expect(field).toHaveAttribute("data-field-value", "middle");
});

test("cancelling a right drag preserves the selected content and never opens a menu", async ({
    page,
}) => {
    const plugin = await mockPlugin(page);
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    await page.locator('.line-hit:not([data-origin="__name"])').first().click();
    const selected = await page
        .locator("[data-block]")
        .getAttribute("data-block");
    const before = await position(page);
    await dragContent(page, "right", true);
    await expect(page.locator("[data-block]")).toHaveAttribute(
        "data-block",
        selected!,
    );
    expect((await position(page)).x).toBeCloseTo(before.x, 0);
    await expect(page.getByTestId("context-menu")).toHaveCount(0);
    expect(plugin.writes).toHaveLength(0);
});

for (const interruption of ["blur", "pointercancel", "page"] as const) {
    test(`a right pan interrupted by ${interruption} does not leak its gesture`, async ({
        page,
    }) => {
        const plugin = await mockPlugin(page);
        await page.goto("/?lang=en-US");
        await enterWorkspace(page);
        const line = (await page.getByTestId("line-hit-name").boundingBox())!;
        await page.mouse.move(line.x + 20, line.y + 4);
        await page.mouse.down({ button: "right" });
        await page.mouse.move(line.x + 50, line.y + 24, { steps: 4 });
        if (interruption === "blur") {
            await page.evaluate(() => window.dispatchEvent(new Event("blur")));
        } else if (interruption === "pointercancel") {
            await page
                .getByTestId("canvas-viewport")
                .dispatchEvent("pointercancel", { pointerId: 1 });
        } else {
            await page.keyboard.press("ControlOrMeta+,");
            await expect(page.getByTestId("canvas-pan-buttons")).toBeVisible();
        }
        await page.mouse.up({ button: "right" });
        if (interruption === "page")
            await page.getByTestId("mode-items").click();
        await expect(page.getByTestId("context-menu")).toHaveCount(0);
        const stopped = await position(page);
        await page.mouse.move(line.x + 90, line.y + 64);
        expect((await position(page)).x).toBeCloseTo(stopped.x, 0);
        await page.getByTestId("line-hit-name").click({ button: "right" });
        await expect(page.getByTestId("menu-edit-content")).toBeVisible();
        expect(plugin.writes).toHaveLength(0);
    });
}
