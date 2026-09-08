import { expect, test } from "@playwright/test";
import { zipSync } from "fflate";
import { enterWorkspace, mockPlugin } from "./fixtures/plugin.js";

test("mounted pack declarations are visible, nonblocking, and fit narrow resource lists", async ({
    page,
}, testInfo) => {
    const plugin = await mockPlugin(page);
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    await page.getByTestId("open-assets").click();
    const cases = [
        {
            name: "old-format-75.zip",
            metadata: { pack_format: 75 },
            status: "outside",
        },
        {
            name: "declared-format-84.zip",
            metadata: { min_format: [84, 0], max_format: 84 },
            status: "included",
        },
        {
            name: "unknown-format.zip",
            metadata: { min_format: 84 },
            status: "unknown",
        },
    ];
    for (const entry of cases) {
        await page.getByTestId("asset-file-input").setInputFiles({
            name: entry.name,
            mimeType: "application/zip",
            buffer: Buffer.from(
                zipSync({
                    "pack.mcmeta": new TextEncoder().encode(
                        JSON.stringify({ pack: entry.metadata }),
                    ),
                    "assets/example/font/default.json":
                        new TextEncoder().encode(
                            JSON.stringify({
                                providers: [
                                    { type: "space", advances: { " ": 4 } },
                                ],
                            }),
                        ),
                }),
            ),
        });
        const row = page
            .getByTestId("pack-list")
            .locator("li")
            .filter({ hasText: entry.name });
        await expect(row.getByTestId("pack-metadata-status")).toHaveAttribute(
            "data-pack-format-status",
            entry.status,
        );
        await expect(row).toContainText("Minecraft 26.1.2 (84.0)");
        await expect(row).toContainText(
            "not client compatibility verification",
        );
        await expect(
            row.getByRole("button", {
                name: "Import font declarations",
                exact: true,
            }),
        ).toBeEnabled();
    }
    expect(plugin.writes).toHaveLength(0);
    await expect(page.getByTestId("undo")).toBeDisabled();
    for (const width of [1440, 390, 320]) {
        await page.setViewportSize({ width, height: 844 });
        expect(
            await page.evaluate(
                () => document.documentElement.scrollWidth <= innerWidth,
            ),
        ).toBe(true);
        const ranges = await page
            .getByTestId("pack-metadata-status")
            .evaluateAll((elements) =>
                elements.map((element) => {
                    const rect = element.getBoundingClientRect();
                    return {
                        left: rect.left,
                        right: rect.right,
                        width: innerWidth,
                    };
                }),
            );
        expect(
            ranges.every((rect) => rect.left >= 0 && rect.right <= rect.width),
        ).toBe(true);
        await page.screenshot({
            path: testInfo.outputPath(`pack-declarations-${width}.png`),
            fullPage: true,
        });
    }
});
