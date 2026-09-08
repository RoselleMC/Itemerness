import { expect, test, type Page } from "@playwright/test";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import { enterWorkspace, mockPlugin } from "./fixtures/plugin.js";

async function open(page: Page) {
    const initial = structuredClone(baselineDocument);
    initial.budgets.maximumWidthPixels = 4096;
    initial.budgets.maximumHeightPixels = 4096;
    const plugin = await mockPlugin(page, initial);
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    await page.getByTestId("open-settings").click();
    await page.getByTestId("auto-save-toggle").uncheck();
    return plugin;
}

async function commit(page: Page, id: string, value: number) {
    const input = page.getByTestId(id);
    await input.fill(String(value));
    await input.press("Enter");
    await expect(input).not.toHaveAttribute("aria-invalid", "true");
    await expect(input).toHaveAttribute("data-dirty", "false");
}

test("flow and wrapping fields accept source-valid numbers beyond former UI caps", async ({
    page,
}) => {
    const plugin = await open(page);
    await page.getByTestId("mode-layouts").click();
    await page.getByTestId("layout-equipment").click();
    await commit(page, "layout-maximumWidthPixels", 3000);
    await commit(page, "layout-blockGapAfterPixels", 2000);
    await commit(page, "layout-fieldIconGapPixels", 5000);
    await commit(page, "layout-fieldLeftPaddingPixels", 1500);
    await commit(page, "layout-descriptionLeftPaddingPixels", 1200);
    await commit(page, "layout-descriptionRightPaddingPixels", 1100);
    await commit(page, "layout-descriptionGapBeforePixels", 3000);
    await commit(page, "layout-wrapping-body-continuationIndentPixels", 5000);
    await commit(page, "layout-wrapping-body-lineHeightPixels", 300);
    await page.keyboard.press("ControlOrMeta+s");
    await expect.poll(() => plugin.writes.length).toBe(1);
    expect(
        plugin.writes[0]!.document.layouts.find(
            (layout) => layout.id === "itemerness:equipment",
        ),
    ).toMatchObject({
        maximumWidthPixels: 3000,
        blockGapAfterPixels: 2000,
        fieldIconGapPixels: 5000,
        fieldLeftPaddingPixels: 1500,
        descriptionLeftPaddingPixels: 1200,
        descriptionRightPaddingPixels: 1100,
        descriptionGapBeforePixels: 3000,
        wrapping: {
            body: { continuationIndentPixels: 5000, lineHeightPixels: 300 },
        },
    });
    const input = page.getByTestId("layout-blockGapAfterPixels");
    await input.fill("2001");
    await input.press("Enter");
    await expect(input).toHaveAttribute("aria-invalid", "true");
    await page.keyboard.press("ControlOrMeta+s");
    expect(plugin.writes).toHaveLength(1);
    await input.press("Escape");
    await expect(input).toHaveValue("2000");
    await page.getByTestId("layout-maximumWidthPixels").fill("4097");
    await page.getByTestId("layout-maximumWidthPixels").press("Enter");
    await expect(page.getByTestId("layout-maximumWidthPixels")).toHaveAttribute(
        "aria-invalid",
        "true",
    );
    await page.getByTestId("layout-maximumWidthPixels").press("Escape");
});

test("frame padding and signed canvas coordinates or draw order retain their source range", async ({
    page,
}) => {
    const plugin = await open(page);
    await page.getByTestId("mode-themes").click();
    await page.getByTestId("theme-vanilla-frame").click();
    await commit(page, "theme-leftPaddingPixels", 1500);
    await expect(
        page.getByText("Padding consumes the available width.", {
            exact: true,
        }),
    ).toHaveCount(0);
    await page.getByTestId("theme-ember").click();
    await commit(page, "theme-content-maximumWidthPixels", 3000);
    await commit(page, "theme-content-leftPaddingPixels", 1500);
    await page.getByTestId("theme-segmented").click();
    await commit(page, "theme-rightPaddingPixels", 1600);
    await expect(
        page.getByText("Padding consumes the available width.", {
            exact: true,
        }),
    ).toHaveCount(0);
    await page.getByTestId("theme-aurora-canvas").click();
    await page.getByTestId("theme-rejectOutOfBoundsLayer").uncheck();
    await commit(page, "theme-layer-0-xPixels", -5000);
    await commit(page, "theme-layer-0-drawOrder", -2000);
    await page.keyboard.press("ControlOrMeta+s");
    await expect.poll(() => plugin.writes.length).toBe(1);
    const saved = plugin.writes[0]!.document;
    expect(
        saved.themes.find((theme) => theme.id === "itemerness:vanilla-frame")
            ?.characterFrame?.leftPaddingPixels,
    ).toBe(1500);
    expect(
        saved.themes.find((theme) => theme.id === "itemerness:ember")?.content
            ?.leftPaddingPixels,
    ).toBe(1500);
    expect(
        saved.themes.find((theme) => theme.id === "itemerness:segmented")
            ?.segmentedFrame?.rightPaddingPixels,
    ).toBe(1600);
    expect(
        saved.themes.find((theme) => theme.id === "itemerness:aurora-canvas")
            ?.canvas?.layers[0],
    ).toMatchObject({ xPixels: -5000, drawOrder: -2000 });
    await page.getByTestId("undo").click();
    await expect(page.getByTestId("theme-layer-0-drawOrder")).toHaveValue(
        String(
            baselineDocument.themes.find(
                (theme) => theme.id === "itemerness:aurora-canvas",
            )!.canvas!.layers[0]!.drawOrder,
        ),
    );
    const input = page.getByTestId("theme-layer-0-xPixels");
    await input.fill("-2147483649");
    await input.press("Enter");
    await expect(input).toHaveAttribute("aria-invalid", "true");
    await input.press("Escape");
    await expect(input).toHaveValue("-5000");
});
