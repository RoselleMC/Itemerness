import { expect, test } from "@playwright/test";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import { chooseValue, enterWorkspace, mockPlugin } from "./fixtures/plugin.js";

test("language creation, fallback cycle protection, atomic rename, duplication and deletion share history", async ({
    page,
}, info) => {
    const plugin = await mockPlugin(page);
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    await page.getByTestId("open-translations").click();
    await page.getByTestId("add-locale").click();
    await page.getByTestId("locale-create-value").fill("BAD");
    await page.getByTestId("locale-create-value").press("Enter");
    await expect(page.getByTestId("locale-create-value")).toHaveAttribute(
        "aria-invalid",
        "true",
    );
    expect(plugin.writes).toHaveLength(0);
    await page.getByTestId("locale-create-value").fill("fr_fr");
    await page.getByTestId("locale-create-value").press("Enter");
    await expect(page.getByTestId("locale-fallback-fr_fr")).toHaveAttribute(
        "data-field-value",
        "en_us",
    );
    await page.getByTestId("locale-fallback-en_us").click();
    await expect(
        page.getByRole("option", { name: "fr_fr", exact: true }),
    ).toHaveAttribute("aria-disabled", "true");
    await page.keyboard.press("Escape");
    const en = baselineDocument.locales.find(
        (entry) => entry.locale === "en_us",
    )!;
    await page.getByTestId(`locale-code-${en.uuid}`).fill("en_gb");
    await page.getByTestId(`locale-code-${en.uuid}`).press("Enter");
    await expect(page.getByTestId("locale-fallback-fr_fr")).toHaveAttribute(
        "data-field-value",
        "en_gb",
    );
    await expect
        .poll(() => plugin.writes.at(-1)?.document.defaultLocale)
        .toBe("en_gb");
    await applicationMenuAction(page, "edit", "undo");
    await expect(page.getByTestId("locale-fallback-fr_fr")).toHaveAttribute(
        "data-field-value",
        "en_us",
    );
    await page.getByTestId("duplicate-locale-fr_fr").click();
    await page.getByTestId("locale-create-value").fill("de_de");
    await page.getByTestId("locale-create-value").press("Enter");
    await chooseValue(page, page.getByTestId("locale-fallback-de_de"), "fr_fr");
    await expect(page.getByTestId("delete-locale-fr_fr")).toBeDisabled();
    await page.getByTestId("delete-locale-de_de").click();
    await page.getByTestId("confirm-cancel").click();
    await expect(page.getByTestId("locale-fallback-de_de")).toBeVisible();
    await page.getByTestId("delete-locale-de_de").click();
    await page.getByTestId("confirm-accept").click();
    await expect(page.getByTestId("locale-fallback-de_de")).toHaveCount(0);
    await applicationMenuAction(page, "edit", "undo");
    await expect(page.getByTestId("locale-fallback-de_de")).toBeVisible();
    for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 844 });
        if (width === 390) {
            const firstKey = Object.keys(
                baselineDocument.locales[0]!.messages,
            ).sort()[0]!;
            await expect(
                page.getByTestId("locale-narrow-language"),
            ).toBeVisible();
            await expect(
                page.getByTestId(`message-de_de-${firstKey}`),
            ).toBeVisible();
            await expect(
                page.getByTestId(`message-en_us-${firstKey}`),
            ).toBeHidden();
            const bounds = (await page
                .getByTestId(`message-de_de-${firstKey}`)
                .boundingBox())!;
            expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
        }
        expect(
            await page.evaluate(
                () => document.documentElement.scrollWidth <= innerWidth,
            ),
        ).toBe(true);
        await page.screenshot({
            path: info.outputPath(`translations-${width}.png`),
        });
    }
});

test("message CRUD preserves empty and multiline translations and migrates references without deleting used keys", async ({
    page,
}) => {
    const plugin = await mockPlugin(page);
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    await page.getByTestId("open-translations").click();
    await page.getByTestId("add-message").click();
    await page.getByTestId("locale-create-value").fill("new.message");
    await page.getByTestId("locale-create-value").press("Enter");
    const cell = page.getByTestId("message-en_us-new.message");
    await expect(cell.locator("..")).toHaveAttribute(
        "data-message-source",
        "own",
    );
    await cell.fill("First line\nSecond line");
    await expect
        .poll(
            () =>
                plugin.writes
                    .at(-1)
                    ?.document.locales.find((entry) => entry.locale === "en_us")
                    ?.messages["new.message"],
        )
        .toBe("First line\nSecond line");
    await page.getByTestId("message-key-new.message").fill("new.renamed");
    await page.getByTestId("message-key-new.message").press("Enter");
    await page.getByTestId("locale-filter").fill("new.renamed");
    await expect(page.getByTestId("message-en_us-new.renamed")).toHaveValue(
        "First line\nSecond line",
    );
    await page.getByTestId("delete-message-new.renamed").click();
    await page.getByTestId("confirm-accept").click();
    await expect(page.getByTestId("message-en_us-new.renamed")).toHaveCount(0);
    await applicationMenuAction(page, "edit", "undo");
    await expect(page.getByTestId("message-en_us-new.renamed")).toHaveValue(
        "First line\nSecond line",
    );
    const key = baselineDocument.items[0]!.presentation.nameMessage;
    await page.getByTestId("locale-filter").fill(key);
    await expect(page.getByTestId(`delete-message-${key}`)).toBeDisabled();
    await page.getByTestId(`message-key-${key}`).fill("item.renamed.name");
    await page.getByTestId(`message-key-${key}`).press("Enter");
    await expect
        .poll(
            () =>
                plugin.writes.at(-1)?.document.items[0]?.presentation
                    .nameMessage,
        )
        .toBe("item.renamed.name");
});
import { applicationMenuAction } from "./fixtures/applicationMenu.js";
