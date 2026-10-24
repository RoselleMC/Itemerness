import { expect, test, type Page } from "@playwright/test";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import type { ProjectDocument } from "@itemerness/protocol";
import { API_URL, enterWorkspace, mockPlugin } from "./fixtures/plugin.js";

/** The first item with enough extra rows to exceed 180 pixels but not 320. */
function tallDocument(maximumHeightPixels: number): ProjectDocument {
    const [first, ...rest] = baselineDocument.items;
    const charges = first!.presentation.blocks[1]!;
    return {
        ...baselineDocument,
        budgets: { ...baselineDocument.budgets, maximumHeightPixels },
        items: [
            {
                ...first!,
                presentation: {
                    ...first!.presentation,
                    blocks: [
                        ...first!.presentation.blocks,
                        ...Array.from({ length: 18 }, (_, index) => ({
                            ...charges,
                            uuid: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
                        })),
                    ],
                },
            },
            ...rest,
        ],
    };
}

async function open(page: Page, document: ProjectDocument) {
    await mockPlugin(page, document);
    // Withhold production replies: the rows below come from the local draft under its limits.
    await page.route(`${API_URL}/api/v2/preview`, (route) =>
        route.abort("blockedbyclient"),
    );
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
}

test("a server's raised height limit is announced and applied to the local preview", async ({
    page,
}) => {
    await open(page, tallDocument(320));
    const notice = page.getByTestId("height-limit");
    await expect(notice).toBeVisible();
    await expect(notice).toHaveAttribute(
        "aria-label",
        "Tooltip height limit: 320px",
    );
    await notice.click();
    await expect(page.getByTestId("height-limit-notice")).toContainText(
        "instead of the usual 180px",
    );
    await expect(page.getByTestId("height-limit-notice")).toContainText(
        "presentation.maximum-height-pixels",
    );
    await page.keyboard.press("Escape");
    await expect(notice).toBeFocused();
    await expect
        .poll(() => page.locator(".line-hit").count())
        .toBeGreaterThan(18);
});

test("the default height limit shows no notice", async ({ page }) => {
    await open(page, tallDocument(180));
    await expect(page.getByTestId("preview-footer")).toBeVisible();
    await expect(page.getByTestId("height-limit")).toHaveCount(0);
    // The same item does not fit under 180 pixels, so its rows are not painted as fitted.
    await expect(page.getByTestId("open-diagnostics-chip")).toBeVisible();
    expect(await page.locator(".line-hit").count()).toBeLessThan(19);
});
