import { expect, test } from "@playwright/test";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import { enterWorkspace, mockPlugin } from "./fixtures/plugin.js";

test("imported items keep and reassign their catalog source files", async ({
    page,
}) => {
    const document = structuredClone(baselineDocument);
    const [first, second] = document.items;
    document.sourceLayout = {
        sourceHash: "sha256:" + "a".repeat(64),
        files: { [first!.uuid]: "items/armory/weapons.yml" },
    };
    const plugin = await mockPlugin(page, document);
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    await page.getByTestId("open-settings").click();
    await page.getByTestId("auto-save-toggle").uncheck();
    await page.getByTestId("mode-items").click();

    await page.getByTestId(`item-${first!.id}`).click();
    await page.locator("details.advanced > summary").click();
    const field = page.getByTestId("item-source-file");
    await expect(field).toHaveValue("items/armory/weapons.yml");

    await page.getByTestId(`item-${second!.id}`).click();
    await expect(field).toHaveValue("");
    await field.fill("themes/stolen.yml");
    await field.press("Enter");
    await expect(field).toHaveAttribute("aria-invalid", "true");
    await field.fill("items/consumables.yml");
    await field.press("Enter");
    await expect(field).not.toHaveAttribute("aria-invalid", "true");

    await page.keyboard.press("Control+s");
    await expect
        .poll(() => plugin.writes.at(-1)?.document.sourceLayout?.files)
        .toEqual({
            [first!.uuid]: "items/armory/weapons.yml",
            [second!.uuid]: "items/consumables.yml",
        });
});
