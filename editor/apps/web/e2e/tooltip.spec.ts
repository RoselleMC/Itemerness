import { setZoom } from "./fixtures/plugin.js";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { enterWorkspace, mockPlugin } from "./fixtures/plugin.js";

const bundle = fileURLToPath(
    new URL("../../../vanilla-cache/vanilla-26.1.2.zip", import.meta.url),
);

test("vanilla tooltip sprites enclose visible text and align with the editing hitboxes", async ({
    page,
}, testInfo) => {
    test.skip(
        !existsSync(bundle),
        "requires the pinned vanilla 26.1.2 asset bundle",
    );
    await mockPlugin(page);
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    await page.getByTestId("open-assets").click();
    await page.getByTestId("asset-file-input").setInputFiles(bundle);
    await expect(page.getByTestId("pack-list")).toContainText(
        "vanilla-26.1.2.zip",
    );
    await page.getByTestId("mode-items").click();

    for (const viewport of [
        { width: 1440, height: 960 },
        { width: 390, height: 844 },
    ]) {
        await page.setViewportSize(viewport);
        for (const scale of viewport.width > 720 ? [1, 3] : [1]) {
            await setZoom(page, scale);
            for (const locale of ["en_us", "zh_cn"]) {
                await page.getByTestId(`locale-chip-${locale}`).click();
                for (const item of [
                    "travel-token",
                    "ember-blade",
                    "survey-codex",
                ]) {
                    await page.getByTestId(`item-${item}`).click();
                    const sample = await page
                        .getByTestId("tooltip-canvas")
                        .evaluate((element) => {
                            const canvas = element as HTMLCanvasElement;
                            const context = canvas.getContext("2d")!;
                            const pixels = context.getImageData(
                                0,
                                0,
                                canvas.width,
                                canvas.height,
                            ).data;
                            let left = canvas.width,
                                top = canvas.height,
                                right = -1,
                                bottom = -1,
                                count = 0;
                            for (let y = 0; y < canvas.height; y++)
                                for (let x = 0; x < canvas.width; x++) {
                                    const index = (y * canvas.width + x) * 4;
                                    // Bright neutral text, excluding the purple frame and dark glyph shadows.
                                    if (
                                        pixels[index + 3]! < 200 ||
                                        Math.min(
                                            pixels[index]!,
                                            pixels[index + 1]!,
                                            pixels[index + 2]!,
                                        ) < 140
                                    )
                                        continue;
                                    left = Math.min(left, x);
                                    top = Math.min(top, y);
                                    right = Math.max(right, x);
                                    bottom = Math.max(bottom, y);
                                    count++;
                                }
                            const bounds = canvas.getBoundingClientRect();
                            const hit = document
                                .querySelector('[data-testid="line-hit-name"]')!
                                .getBoundingClientRect();
                            return {
                                left,
                                top,
                                right,
                                bottom,
                                count,
                                width: canvas.width,
                                logicalWidth: Number(
                                    canvas.dataset.logicalWidth,
                                ),
                                height: canvas.height,
                                pixelRatio: canvas.width / bounds.width,
                                hitX: hit.x - bounds.x,
                                hitY: hit.y - bounds.y,
                            };
                        });
                    const unit = sample.width / sample.logicalWidth;
                    expect(sample.count).toBeGreaterThan(0);
                    expect(sample.left).toBeGreaterThanOrEqual(12 * unit);
                    expect(sample.top).toBeGreaterThanOrEqual(12 * unit);
                    expect(sample.right).toBeLessThan(sample.width - 11 * unit);
                    expect(sample.bottom).toBeLessThan(
                        sample.height - 10 * unit,
                    );
                    expect(sample.hitX).toBeCloseTo(12 * scale, 4);
                    expect(sample.hitY).toBeCloseTo(12 * scale, 4);
                    await page.getByTestId("tooltip-canvas").screenshot({
                        path: testInfo.outputPath(
                            `tooltip-${item}-${locale}-${viewport.width}-${scale}.png`,
                        ),
                    });
                }
            }
        }
    }
});
