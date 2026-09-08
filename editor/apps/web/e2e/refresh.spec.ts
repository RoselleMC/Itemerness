import { setZoom } from "./fixtures/plugin.js";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { API_URL, enterWorkspace, mockPlugin } from "./fixtures/plugin.js";

const bundle = fileURLToPath(
    new URL("../../../vanilla-cache/vanilla-26.1.2.zip", import.meta.url),
);

async function changeAtFrame(page: Page, id: string, value?: string) {
    let selection = false;
    if (
        value !== undefined &&
        (await page
            .getByTestId(id)
            .evaluate((element) => element.classList.contains("ui-select")))
    ) {
        selection = true;
        await page.getByTestId(id).click();
        await page
            .locator(`[data-option-value=${JSON.stringify(value)}]`)
            .waitFor({ state: "visible" });
    } else if (value !== undefined && id.startsWith("color-")) {
        await page.getByTestId(id).click();
        id = `${id}-hex`;
    }
    return page.evaluate(
        ({ id, value, selection }) => {
            const canvas = () =>
                document.querySelector<HTMLCanvasElement>(
                    '[data-testid="tooltip-canvas"]',
                )!;
            const before = canvas().toDataURL();
            const target = document.querySelector<HTMLElement>(
                `[data-testid="${id}"]`,
            )!;
            const start = performance.now();
            if (selection)
                document
                    .querySelector<HTMLElement>(
                        `[data-option-value=${JSON.stringify(value)}]`,
                    )!
                    .click();
            else if (value === undefined) target.click();
            else {
                const prototype =
                    target instanceof HTMLSelectElement
                        ? HTMLSelectElement.prototype
                        : HTMLInputElement.prototype;
                Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(
                    target,
                    value,
                );
                target.dispatchEvent(
                    new Event(
                        target instanceof HTMLSelectElement
                            ? "change"
                            : "input",
                        { bubbles: true },
                    ),
                );
            }
            return new Promise<{
                elapsed: number;
                changed: boolean;
                renderer: string;
                frames: number;
                width: number;
                height: number;
                origin: string | null;
            }>((resolve) =>
                requestAnimationFrame(() => {
                    const surface = canvas();
                    resolve({
                        elapsed: performance.now() - start,
                        changed: before !== surface.toDataURL(),
                        renderer: surface.dataset.renderer!,
                        frames: Number(surface.dataset.frameRuns),
                        width: surface.width,
                        height: surface.height,
                        origin: document
                            .querySelector('[data-testid="tooltip-canvas"]')!
                            .getAttribute("data-preview-origin"),
                    });
                }),
            );
        },
        { id, value, selection },
    );
}

test("cold theme and canvas edits paint next frame even while every server preview is blocked", async ({
    page,
}, testInfo) => {
    test.skip(!existsSync(bundle), "requires pinned vanilla assets");
    await mockPlugin(page);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    await page.route(`${API_URL}/api/v2/preview`, async (route) => {
        await gate;
        await route
            .fulfill({ status: 503, json: { code: "PREVIEW_UNAVAILABLE" } })
            .catch(() => {});
    });
    const samples: Array<
        Awaited<ReturnType<typeof changeAtFrame>> & {
            id: string;
            value?: string;
        }
    > = [];
    try {
        await page.goto("/?lang=en-US");
        await enterWorkspace(page);
        await page.getByTestId("open-assets").click();
        await page.getByTestId("asset-file-input").setInputFiles(bundle);
        await expect(page.getByTestId("pack-list")).toBeVisible();
        await page.getByTestId("mode-items").click();
        await setZoom(page, 1);
        const action = async (
            id: string,
            value?: string,
            renderer?: string,
        ) => {
            const sample = await changeAtFrame(page, id, value);
            expect(sample.elapsed, id).toBeLessThan(200);
            expect(sample.changed, id).toBe(true);
            expect(sample.origin).toBe("local");
            if (renderer) expect(sample.renderer, id).toBe(renderer);
            if (sample.renderer === "VANILLA_CHARACTER_FRAME")
                expect(sample.frames).toBeGreaterThan(0);
            samples.push({ id, value, ...sample });
            return sample;
        };
        await action("theme-card-default", undefined, "PLAIN");
        await action(
            "theme-card-vanilla-frame",
            undefined,
            "VANILLA_CHARACTER_FRAME",
        );
        await page.getByTestId("preview-language").click();
        await action("preview-language-option-zh_cn");
        await page.getByTestId("preview-language").click();
        await action("preview-language-option-en_us");
        await action("name-input", "Immediate unsaved name");
        await page.getByTestId("canvas-zoom").click();
        await action("canvas-zoom-2");
        await action("annotations-toggle");
        await action("annotations-toggle");
        await page.getByTestId("mode-themes").click();
        await page.getByTestId("theme-vanilla-frame").click();
        await action("color-frame", "#ff5555");
        await action("frame-preset", "UNICODE_DOUBLE");
        await action("max-width-slider", "130");
        await action("max-width-slider", "220");
        await page.getByTestId("mode-items").click();
        await page.getByTestId("item-ember-blade").click();
        await page.getByTestId("open-persona").click();
        await action("fact-example-level", "20");
        await page.getByTestId("open-persona").click();
        await action("theme-card-default", undefined, "PLAIN");
        await page.getByTestId("mode-layouts").click();
        await page.getByTestId("layout-equipment").click();
        await action("layout-max-width", "140");
        await action("align-LEFT");
        await page.getByTestId("mode-items").click();
        await action("form-layout", "itemerness:plain");
        await page.getByTestId("compare-toggle").click();
        await expect(page.getByTestId("tooltip-canvas")).toHaveCount(2);
        await page.screenshot({
            path: testInfo.outputPath("cold-refresh.png"),
            fullPage: true,
        });
        mkdirSync(testInfo.outputPath(), { recursive: true });
        writeFileSync(
            testInfo.outputPath("cold-refresh.json"),
            JSON.stringify(samples, null, 2),
        );
    } finally {
        release();
    }
});
