import { expect, test } from "@playwright/test";
import { enterWorkspace, mockPlugin } from "./fixtures/plugin.js";

test("footer controls remain available during content selection and open upward without inspector duplication", async ({
    page,
}, testInfo) => {
    const plugin = await mockPlugin(page);
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    const footer = page.getByTestId("preview-footer");
    await expect(footer).toBeVisible();
    await expect(
        page.locator(".inspector").getByTestId("open-persona"),
    ).toHaveCount(0);
    await page.getByTestId("preview-language").click();
    const box = await page.getByTestId("preview-language").boundingBox();
    const options = await page.getByRole("listbox").boundingBox();
    expect(options!.y + options!.height).toBeLessThanOrEqual(box!.y);
    await page.getByRole("option", { name: "zh_cn", exact: true }).click();
    await page.getByTestId("compare-toggle").click();
    await expect(page.getByTestId("compare-toggle")).toHaveAttribute(
        "aria-pressed",
        "true",
    );
    await expect(page.getByTestId("comparison-figure")).toBeVisible();
    await page.getByTestId("annotations-toggle").click();
    await expect(page.getByTestId("annotations-toggle")).toHaveAttribute(
        "aria-pressed",
        "true",
    );
    await page.getByTestId("open-persona").click();
    await expect(page.getByTestId("persona")).toBeVisible();
    const persona = await page
        .getByRole("dialog", { name: "Previewed player" })
        .boundingBox();
    const button = await page.getByTestId("open-persona").boundingBox();
    expect(persona!.y + persona!.height).toBeLessThanOrEqual(button!.y);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("open-persona")).toBeFocused();
    await page.getByTestId("fidelity-toggle").click();
    await expect(page.getByTestId("fidelity-summary")).toHaveText(/^\d+\/\d+$/);
    await expect(page.getByTestId("fidelity-positioning")).toBeVisible();
    const fidelity = await page
        .getByRole("dialog", { name: /^Accuracy/ })
        .boundingBox();
    const fidelityButton = await page
        .getByTestId("fidelity-toggle")
        .boundingBox();
    expect(fidelity!.x + fidelity!.width).toBeLessThanOrEqual(
        fidelityButton!.x + fidelityButton!.width + 1,
    );
    expect(fidelity!.y + fidelity!.height).toBeLessThanOrEqual(
        fidelityButton!.y,
    );
    await page.keyboard.press("Escape");
    for (const width of [1600, 1024, 760, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        const bounds = await footer.boundingBox();
        const controls = await footer.locator("button").evaluateAll((buttons) =>
            buttons.map((button) => {
                const rect = button.getBoundingClientRect();
                return { left: rect.left, right: rect.right };
            }),
        );
        for (const control of controls) {
            expect(control.left).toBeGreaterThanOrEqual(bounds!.x);
            expect(control.right).toBeLessThanOrEqual(
                bounds!.x + bounds!.width + 1,
            );
        }
        await page.screenshot({
            path: testInfo.outputPath(`footer-${width}.png`),
        });
    }
    expect(plugin.writes).toHaveLength(0);
});

test("selected hover keeps accent borders and context menus can cover the titlebar", async ({
    page,
}, testInfo) => {
    await mockPlugin(page);
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    for (const theme of ["light", "dark"]) {
        await page.getByTestId("appearance").click();
        await page.getByTestId(`appearance-${theme}`).click();
        const selected = page.locator(".theme-card.selected").first();
        const border = await selected.evaluate(
            (element) => getComputedStyle(element).borderColor,
        );
        await selected.hover();
        await expect(selected).toHaveCSS("border-color", border);
        const unselected = page.locator(".theme-card:not(.selected)").first();
        await page.mouse.move(500, 52);
        const background = await unselected.evaluate(
            (element) => getComputedStyle(element).backgroundColor,
        );
        await unselected.hover();
        await expect
            .poll(() =>
                unselected.evaluate(
                    (element) => getComputedStyle(element).backgroundColor,
                ),
            )
            .not.toBe(background);
        const titlebar = page.getByTestId("titlebar");
        await titlebar.click({ button: "right", position: { x: 280, y: 12 } });
        const menu = page.getByTestId("context-menu");
        const bounds = await menu.boundingBox();
        expect(bounds!.y).toBeLessThan(52);
        expect(
            await menu.evaluate((element) => {
                const rect = element.getBoundingClientRect();
                return element.contains(
                    document.elementFromPoint(rect.left + 10, rect.top + 10),
                );
            }),
        ).toBe(true);
        await page.screenshot({
            path: testInfo.outputPath(`titlebar-menu-${theme}.png`),
        });
        await page.keyboard.press("Escape");
    }
});
