import { expect, test } from "@playwright/test";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import { enterWorkspace, mockPlugin } from "./fixtures/plugin.js";

const libraries = [
    { mode: "items", add: "add-item", inspector: "name-input" },
    { mode: "themes", add: "add-theme", inspector: "themes-id" },
    { mode: "layouts", add: "add-layout", inspector: "layouts-id" },
    { mode: "data", add: "add-data-schema", inspector: "data-key-id" },
    { mode: "formats", add: "add-formats", inspector: "formats-id" },
    { mode: "facts", add: "add-facts", inspector: "facts-id" },
] as const;

for (const library of libraries) {
    test(`${library.mode} creation lives in the heading; right click does not navigate`, async ({
        page,
    }, info) => {
        const plugin = await mockPlugin(page);
        await page.goto("/?lang=en-US");
        await enterWorkspace(page);
        await page.getByTestId(`mode-${library.mode}`).click();
        const rail = page.locator(".sidebar");
        const add = page.getByTestId(library.add);
        await expect(
            rail.locator(".library-heading").getByTestId(library.add),
        ).toBeVisible();
        await expect(add).toHaveText("");
        await expect(rail.locator(".add-item")).toHaveCount(0);
        await expect(page.getByTestId("library-heading")).toHaveText(
            / \(\d+\)$/,
        );
        const rows = rail.locator(".item-row");
        await rows.nth(0).click();
        const inspector = page.getByTestId(library.inspector);
        const before = await inspector.inputValue();
        await rows.nth(1).click({ button: "right" });
        await expect(page.getByTestId("context-menu")).toBeVisible();
        await expect(rows.nth(0)).toHaveClass(/selected/);
        await expect(rows.nth(1)).not.toHaveClass(/selected/);
        await expect(inspector).toHaveValue(before);
        await page.keyboard.press("Escape");
        await expect(inspector).toHaveValue(before);
        expect(plugin.writes).toHaveLength(0);
        for (const width of [1440, 900, 390]) {
            await page.setViewportSize({ width, height: 844 });
            const heading = (await page
                .getByTestId("library-heading")
                .boundingBox())!;
            const action = (await add.boundingBox())!;
            expect(heading.x + heading.width).toBeLessThanOrEqual(action.x);
            expect(action.width).toBe(28);
            expect(action.height).toBe(28);
            await page.screenshot({
                path: info.outputPath(`library-${library.mode}-${width}.png`),
            });
        }
    });
}

test("layout creation menu closes when a keyboard command leaves the editor", async ({
    page,
}) => {
    await mockPlugin(page);
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    await page.getByTestId("mode-layouts").click();
    await page.getByTestId("add-layout").click();
    await expect(page.getByTestId("menu-add-flow")).toBeVisible();
    await page.keyboard.press("ControlOrMeta+,");
    await expect(page.getByTestId("menu-add-flow")).toHaveCount(0);
    await page.getByTestId("mode-layouts").click();
    await expect(page.getByTestId("menu-add-flow")).toHaveCount(0);
});

test("deleting an unselected schema preserves the current key inspector", async ({
    page,
}) => {
    const document = structuredClone(baselineDocument);
    const unused = {
        uuid: "f1000000-0000-4000-8000-000000000001",
        id: "example:unused",
        version: 1,
        keys: [],
    };
    document.dataSchemas.push(unused);
    await mockPlugin(page, document);
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    await page.getByTestId("mode-data").click();
    await page.getByTestId("datakey-charges").click();
    await page.getByTestId(`schema-${unused.uuid}`).click({ button: "right" });
    await expect(page.getByTestId("data-key-id")).toHaveValue(
        "example:charges",
    );
    await page.getByTestId("menu-delete-schema").click();
    await page.getByTestId("confirm-accept").click();
    await expect(page.getByTestId(`schema-${unused.uuid}`)).toHaveCount(0);
    await expect(page.getByTestId("data-key-id")).toHaveValue(
        "example:charges",
    );
});
