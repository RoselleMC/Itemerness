import { expect, test } from "@playwright/test";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import { enterWorkspace, mockPlugin } from "./fixtures/plugin.js";

const MESSAGES = 5_000;

test("a production-sized translation table keeps the editor responsive", async ({
    page,
}) => {
    const document = structuredClone(baselineDocument);
    for (const locale of document.locales)
        for (let index = 0; index < MESSAGES; index++)
            locale.messages[`item.scale-${String(index).padStart(4, "0")}.lore`] =
                `${locale.locale} flavor text ${index}`;
    await mockPlugin(page, document);
    await page.goto("/?lang=en-US");
    const started = Date.now();
    await enterWorkspace(page);
    await expect(page.getByTestId("tooltip-canvas").first()).toBeVisible();
    // The hidden matrix used to render every row on load and block the tab for tens of seconds.
    expect(Date.now() - started).toBeLessThan(15_000);

    await page.getByTestId("open-translations").click();
    const rows = page.locator('[data-testid="locale-table"] tbody tr:not([data-testid="locale-more"])');
    await expect(rows).toHaveCount(100);
    await expect(page.getByTestId("locale-more")).toContainText("Showing 100 of");
    await page.getByTestId("locale-more").getByRole("button").click();
    await expect(rows).toHaveCount(200);

    await page.getByTestId("locale-filter").fill("item.scale-4321");
    await expect(rows).toHaveCount(1);
    await expect(page.getByTestId("message-key-item.scale-4321.lore")).toBeVisible();
    const cell = page.getByRole("textbox", { name: "item.scale-4321.lore (en_us)" });
    const typed = Date.now();
    await cell.fill("Edited text");
    await expect(cell).toHaveValue("Edited text");
    expect(Date.now() - typed).toBeLessThan(5_000);

    // Navigating away and back keeps the search.
    await page.getByTestId("mode-items").click();
    await page.getByTestId("open-translations").click();
    await expect(page.getByTestId("locale-filter")).toHaveValue("item.scale-4321");
    await expect(rows).toHaveCount(1);
});
