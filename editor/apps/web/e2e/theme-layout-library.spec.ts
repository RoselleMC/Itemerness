import { expect, test } from "@playwright/test";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import { API_URL, enterWorkspace, mockPlugin } from "./fixtures/plugin.js";

test("themes can be created, duplicated, renamed with references, and safely deleted with undo", async ({
    page,
}) => {
    const plugin = await mockPlugin(page);
    await page.route(`${API_URL}/api/v2/preview`, (route) =>
        route.abort("blockedbyclient"),
    );
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    await page.getByTestId("mode-themes").click();
    await page.getByTestId("theme-default").click();
    await expect(page.getByTestId("delete-themes")).toBeDisabled();
    await page.getByTestId("themes-id").fill("example:renamed-theme");
    await page.getByTestId("themes-id").press("Enter");
    await expect(page.getByTestId("theme-renamed-theme")).toBeVisible();
    await expect
        .poll(() =>
            plugin.writes
                .at(-1)
                ?.document.themes.some(
                    (entry) => entry.fallback === "itemerness:default",
                ),
        )
        .toBe(false);
    await page.getByTestId("undo").click();
    await expect(page.getByTestId("themes-id")).toHaveValue(
        "itemerness:default",
    );
    await page.getByTestId("theme-default").click({ button: "right" });
    await page.getByTestId("menu-duplicate-themes").click();
    await expect(page.getByTestId("themes-id")).toHaveValue(
        "itemerness:default-copy",
    );
    await page.getByTestId("delete-themes").click();
    await page.getByTestId("confirm-cancel").click();
    await expect(page.getByTestId("theme-default-copy")).toBeVisible();
    await page.getByTestId("delete-themes").click();
    await page.getByTestId("confirm-accept").click();
    await expect(page.getByTestId("theme-default-copy")).toHaveCount(0);
    await page.getByTestId("undo").click();
    await expect(page.getByTestId("themes-id")).toHaveValue(
        "itemerness:default-copy",
    );
    await page.getByTestId("add-theme").click();
    await expect(page.getByTestId("themes-id")).toHaveValue(
        `${baselineDocument.namespace}:new-theme`,
    );
    await expect(page.getByTestId("theme-renderer")).toHaveAttribute(
        "data-field-value",
        "PLAIN",
    );
    await expect
        .poll(() => plugin.writes.at(-1)?.document.themes.length)
        .toBe(baselineDocument.themes.length + 2);
});

test("flow and canvas layouts are created without cloning another layout and their IDs migrate bindings atomically", async ({
    page,
}, info) => {
    const plugin = await mockPlugin(page);
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    await page.getByTestId("mode-layouts").click();
    await page.getByTestId("layout-equipment").click();
    await expect(page.getByTestId("delete-layouts")).toBeDisabled();
    await page.getByTestId("layouts-id").fill("example:equipment");
    await page.getByTestId("layouts-id").press("Enter");
    await expect
        .poll(
            () =>
                plugin.writes
                    .at(-1)
                    ?.document.items.filter(
                        (item) =>
                            item.presentation.layout === "example:equipment",
                    ).length,
        )
        .toBeGreaterThan(0);
    await page.getByTestId("duplicate-layouts").click();
    await expect(page.getByTestId("layouts-id")).toHaveValue(
        "example:equipment-copy",
    );
    await page.getByTestId("add-layout").click();
    await page.getByTestId("menu-add-canvas").click();
    await expect(page.getByTestId("layouts-id")).toHaveValue(
        `${baselineDocument.namespace}:new-canvas-layout`,
    );
    await expect(page.getByTestId("layout-widthPixels")).toHaveValue("160");
    await page.getByTestId("add-layout").click();
    await page.getByTestId("menu-add-flow").click();
    await expect(page.getByTestId("layouts-id")).toHaveValue(
        `${baselineDocument.namespace}:new-flow-layout`,
    );
    await expect(page.getByTestId("layout-minimumWidthPixels")).toHaveValue(
        "1",
    );
    await expect
        .poll(() => plugin.writes.at(-1)?.document.layouts.length)
        .toBe(baselineDocument.layouts.length + 3);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByTestId("layouts-id").scrollIntoViewIfNeeded();
    expect(
        await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
        ),
    ).toBe(true);
    await page.screenshot({ path: info.outputPath("layout-library-390.png") });
});
