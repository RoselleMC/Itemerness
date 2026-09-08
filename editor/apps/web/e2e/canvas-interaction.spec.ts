import { expect, test } from "@playwright/test";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import {
    mockPlugin,
    enterWorkspace,
    setZoom,
    selectContent,
    API_URL,
    HANDSHAKE,
} from "./fixtures/plugin.js";

const vanillaBundle = fileURLToPath(
    new URL("../../../vanilla-cache/vanilla-26.1.2.zip", import.meta.url),
);

test("selection switches the complete inspector without editing or repainting content", async ({
    page,
}, info) => {
    const plugin = await mockPlugin(page);
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    await expect(page.getByTestId("global-inspector")).toBeVisible();
    await expect(page.getByTestId("block-list")).toHaveCount(0);
    const pixels = await page
        .getByTestId("tooltip-canvas")
        .evaluate((canvas) => (canvas as HTMLCanvasElement).toDataURL());
    const zoom = await page.getByTestId("canvas-zoom").textContent();
    await page.getByTestId("line-hit-1").click();
    await expect(page.getByTestId("content-inspector")).toBeVisible();
    await expect(page.getByTestId("name-input")).toHaveCount(0);
    await expect(page.getByTestId("preview-settings")).toHaveCount(0);
    await expect(page.locator("[data-block]")).toHaveCount(1);
    await expect(page.getByTestId("insert-before")).toHaveCount(1);
    await expect(page.getByTestId("insert-after")).toHaveCount(1);
    await page.screenshot({ path: info.outputPath("selected-content.png") });
    await page
        .getByTestId("canvas-viewport")
        .click({ position: { x: 8, y: 8 } });
    await expect(page.getByTestId("global-inspector")).toBeVisible();
    await expect(page.getByTestId("insert-after")).toHaveCount(0);
    await page.getByTestId("line-hit-name").click();
    await expect(page.getByTestId("global-inspector")).toBeVisible();
    await expect(page.getByTestId("insert-before")).toHaveCount(0);
    await expect(page.getByTestId("insert-after")).toBeVisible();
    await expect(page.getByTestId("name-input")).not.toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("insert-after")).toHaveCount(0);
    expect(await page.getByTestId("canvas-zoom").textContent()).toBe(zoom);
    expect(
        await page
            .getByTestId("tooltip-canvas")
            .evaluate((canvas) => (canvas as HTMLCanvasElement).toDataURL()),
    ).toBe(pixels);
    expect(plugin.writes).toHaveLength(0);
});

test("name inserts first and selected rows insert above or below in order", async ({
    page,
}) => {
    const plugin = await mockPlugin(page);
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    await page.getByTestId("line-hit-name").click();
    await page.getByTestId("insert-after").click();
    await page.getByTestId("add-text-row").click();
    await expect(page.getByTestId("content-inspector")).toBeVisible();
    const first = await page.locator("[data-block]").getAttribute("data-block");
    await setZoom(page, 0.25);
    const bounds = (await page.getByTestId("canvas-viewport").boundingBox())!;
    expect(
        (await page.getByTestId("insert-before").boundingBox())!.x,
    ).toBeGreaterThanOrEqual(bounds.x);
    await page.getByTestId("insert-before").click();
    await page.getByTestId("add-text-row").click();
    const second = await page
        .locator("[data-block]")
        .getAttribute("data-block");
    await page.getByTestId("insert-after").click();
    await page.getByTestId("add-text-row").click();
    const third = await page.locator("[data-block]").getAttribute("data-block");
    await expect
        .poll(() =>
            plugin.writes
                .at(-1)
                ?.document.items[0]?.presentation.blocks.slice(0, 3)
                .map((block) => block.uuid),
        )
        .toEqual([second, third, first]);
});

test("nested insertion stays inside its branch and hidden content remains reachable", async ({
    page,
}) => {
    const doc = structuredClone(baselineDocument);
    const parent = doc.items
        .flatMap((item) => item.presentation.blocks)
        .find((block) => block.type === "conditional")!;
    if (parent.type !== "conditional")
        throw new Error("Missing conditional fixture");
    doc.items[0]!.presentation.blocks = [parent];
    doc.items[0]!.previewData = structuredClone(doc.items[1]!.previewData);
    doc.items[0]!.definition.definitionData = structuredClone(
        doc.items[1]!.definition.definitionData,
    );
    const child = parent.thenBlocks[0]!;
    const plugin = await mockPlugin(page, doc);
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    await selectContent(page, child.uuid);
    await expect(page.getByTestId("content-inspector")).toBeVisible();
    await page.getByTestId(`select-parent-${parent.uuid}`).click();
    await expect(page.locator("[data-block]")).toHaveAttribute(
        "data-block",
        parent.uuid,
    );
    await expect(page.getByTestId(`select-child-${child.uuid}`)).toBeVisible();
    // The selected parent remains editable even when its previewed branch is omitted.
    await page.keyboard.press("Escape");
    await page.getByTestId("open-persona").click();
    await page.getByTestId("fact-example-level").fill("0");
    await page.getByTestId("open-persona").click();
    await selectContent(page, child.uuid);
    await page.getByTestId("insert-after").click();
    await page.getByTestId("add-text-row").click();
    const added = await page.locator("[data-block]").getAttribute("data-block");
    await expect
        .poll(() => {
            const saved =
                plugin.writes.at(-1)?.document.items[0]?.presentation.blocks[0];
            return saved?.type === "conditional"
                ? saved.thenBlocks.map((block) => block.uuid)
                : [];
        })
        .toContain(added);
    expect(
        plugin.writes.at(-1)!.document.items[0]!.presentation.blocks,
    ).toHaveLength(1);
});

test("wheel zoom is fractional, fit contains both previews, and narrow layouts do not overflow", async ({
    page,
}, info) => {
    const plugin = await mockPlugin(page);
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    await setZoom(page, 2);
    const viewport = page.getByTestId("canvas-viewport");
    await viewport.hover();
    await page.mouse.wheel(0, -53);
    await expect(page.getByTestId("canvas-zoom")).not.toContainText("200%");
    await page.getByTestId("zoom-reset").click();
    await expect(page.getByTestId("canvas-zoom")).toContainText("100%");
    await page.getByTestId("compare-toggle").click();
    await page.getByTestId("zoom-fit").click();
    for (const size of [
        { width: 1440, height: 960 },
        { width: 900, height: 800 },
        { width: 390, height: 844 },
    ]) {
        await page.setViewportSize(size);
        await expect
            .poll(async () =>
                viewport.evaluate((element) => {
                    const outer = element.getBoundingClientRect();
                    return [...element.querySelectorAll("canvas")].every(
                        (canvas) => {
                            const inner = canvas.getBoundingClientRect();
                            return (
                                inner.left >= outer.left &&
                                inner.right <= outer.right + 1 &&
                                inner.top >= outer.top &&
                                inner.bottom <= outer.bottom + 1
                            );
                        },
                    );
                }),
            )
            .toBe(true);
        expect(
            await page.evaluate(
                () => document.documentElement.scrollWidth <= innerWidth,
            ),
        ).toBe(true);
        await page.screenshot({
            path: info.outputPath(`fit-${size.width}.png`),
            fullPage: true,
        });
    }
    expect(plugin.writes).toHaveLength(0);
});

test("Escape cancels inline editing and returns to global settings", async ({
    page,
}) => {
    const plugin = await mockPlugin(page);
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    await page.getByTestId("line-hit-name").dblclick();
    await page.getByTestId("inline-editor").fill("Cancelled draft");
    await page.getByTestId("inline-editor").press("Escape");
    await expect(page.getByTestId("inline-editor")).toHaveCount(0);
    await expect(page.getByTestId("insert-after")).toHaveCount(0);
    await expect(page.getByTestId("name-input")).toHaveValue(
        "Harbor Travel Token",
    );
    expect(plugin.writes).toHaveLength(0);
});

test("wrapped content shares edge controls and the insertion popup stays inside the window", async ({
    page,
}, info) => {
    const doc = structuredClone(baselineDocument);
    const item = doc.items[0]!;
    const block = item.presentation.blocks.find(
        (entry) => entry.type === "description",
    )!;
    if (block.type !== "description")
        throw new Error("Missing description fixture");
    item.presentation.blocks = [block];
    doc.locales[0]!.messages[block.message] =
        "A long description with several words repeated to wrap across the entire available content area. ".repeat(
            8,
        );
    await mockPlugin(page, doc);
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    if (existsSync(vanillaBundle)) {
        await page.getByTestId("open-assets").click();
        await page.getByTestId("asset-file-input").setInputFiles(vanillaBundle);
        await expect(page.getByTestId("pack-list")).toBeVisible();
        await page.getByTestId("mode-items").click();
    }
    await selectContent(page, block.uuid);
    const lines = page.locator(`.line-hit[data-origin="${block.uuid}"]`);
    expect(await lines.count()).toBeGreaterThan(1);
    await expect(page.getByTestId("insert-before")).toHaveCount(1);
    await expect(page.getByTestId("insert-after")).toHaveCount(1);
    for (const size of [
        { width: 1440, height: 900 },
        { width: 390, height: 844 },
    ]) {
        await page.setViewportSize(size);
        await page.getByTestId("zoom-fit").click();
        await page.getByTestId("insert-after").click();
        const menu = page.getByRole("menu");
        const rect = (await menu.boundingBox())!;
        expect(rect.x).toBeGreaterThanOrEqual(0);
        expect(rect.y).toBeGreaterThanOrEqual(0);
        expect(rect.x + rect.width).toBeLessThanOrEqual(size.width);
        expect(rect.y + rect.height).toBeLessThanOrEqual(size.height);
        const zoom = await page.getByTestId("canvas-zoom").textContent();
        await menu.hover();
        await page.mouse.wheel(0, 120);
        expect(await page.getByTestId("canvas-zoom").textContent()).toBe(zoom);
        await page.screenshot({
            path: info.outputPath(`wrapped-insert-${size.width}.png`),
            fullPage: true,
        });
        await page.keyboard.press("Escape");
    }
});

test("high zoom preserves the cursor anchor and supports hand and Space panning", async ({
    page,
}) => {
    const plugin = await mockPlugin(page);
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    await setZoom(page, 8);
    const viewport = page.getByTestId("canvas-viewport");
    const rect = (await viewport.boundingBox())!;
    const x = rect.x + rect.width / 2,
        y = rect.y + rect.height / 2;
    const anchor = () =>
        page.getByTestId("tooltip-canvas").evaluate(
            (element, point) => {
                const rect = element.getBoundingClientRect();
                return {
                    x: (point.x - rect.x) / rect.width,
                    y: (point.y - rect.y) / rect.height,
                };
            },
            { x, y },
        );
    const before = await anchor();
    await page.mouse.move(x, y);
    await page.mouse.wheel(0, -180);
    await expect(page.getByTestId("canvas-zoom")).not.toContainText("800%");
    const after = await anchor();
    expect(after.x).toBeCloseTo(before.x, 2);
    expect(after.y).toBeCloseTo(before.y, 2);
    for (const mode of ["hand", "space"]) {
        if (mode === "hand") await page.getByTestId("canvas-pan").click();
        else await page.keyboard.down("Space");
        const left = (await page.getByTestId("tooltip-canvas").boundingBox())!
            .x;
        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.mouse.move(x - 80, y - 30, { steps: 5 });
        await page.mouse.up();
        expect(
            (await page.getByTestId("tooltip-canvas").boundingBox())!.x,
        ).toBeLessThan(left - 60);
        if (mode === "hand") await page.getByTestId("canvas-pan").click();
        else await page.keyboard.up("Space");
    }
    expect(plugin.writes).toHaveLength(0);
});

test("item validation distinguishes pending, errors and unavailable capability", async ({
    page,
}) => {
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
    try {
        await page.goto("/?lang=en-US");
        await enterWorkspace(page);
        const status = page.getByTestId("item-status-travel-token");
        await expect(status).toHaveAttribute("data-state", "pending");
        const pendingColor = await status.evaluate(
            (element) => getComputedStyle(element).color,
        );
        release();
        await expect(status).toHaveAttribute("data-state", "error");
        expect(
            await status.evaluate((element) => getComputedStyle(element).color),
        ).not.toBe(pendingColor);
        await page.route(`${API_URL}/api/handshake`, (route) =>
            route.fulfill({
                json: {
                    ...HANDSHAKE,
                    capabilities: ["draft.read", "draft.write"],
                },
            }),
        );
        await enterWorkspace(page);
        await expect(status).toHaveAttribute("data-state", "unavailable");
    } finally {
        release();
    }
});

test("real plugin artifacts remain selectable without draft writes", async ({
    page,
}, info) => {
    test.skip(
        !process.env.E2E_PLUGIN_URL,
        "requires the authorized Craft Runner plugin endpoint",
    );
    let writes = 0;
    await page.route("**/api/v2/document", (route) => {
        if (route.request().method() === "PUT") {
            writes++;
            return route.abort();
        }
        return route.continue();
    });
    await page.goto("/?lang=en-US");
    await enterWorkspace(page, process.env.E2E_PLUGIN_URL!);
    if (existsSync(vanillaBundle)) {
        await page.getByTestId("open-assets").click();
        await page.getByTestId("asset-file-input").setInputFiles(vanillaBundle);
        await expect(page.getByTestId("pack-list")).toBeVisible();
        await page.getByTestId("mode-items").click();
    }
    for (const item of ["travel-token", "ember-blade", "survey-codex"]) {
        await page.getByTestId(`item-${item}`).click();
        await expect(page.getByTestId(`item-status-${item}`)).toHaveAttribute(
            "data-state",
            "verified",
        );
        const lines = page.locator('.line-hit:not([data-origin="__name"])');
        expect(await lines.count()).toBeGreaterThan(0);
        const canvas = page.getByTestId("tooltip-canvas");
        const before = (await canvas.boundingBox())!;
        const row = (await lines.first().boundingBox())!;
        await page.mouse.move(row.x + 20, row.y + row.height / 2);
        await page.mouse.down({ button: "right" });
        await page.mouse.move(row.x + 60, row.y + row.height / 2 + 24, {
            steps: 5,
        });
        await page.mouse.up({ button: "right" });
        const after = (await canvas.boundingBox())!;
        expect(after.x - before.x).toBeCloseTo(40, 0);
        expect(after.y - before.y).toBeCloseTo(24, 0);
        await expect(page.getByTestId("context-menu")).toHaveCount(0);
        await expect(page.getByTestId("global-inspector")).toBeVisible();
        await lines.first().click();
        await expect(page.getByTestId("content-inspector")).toBeVisible();
        await page.getByTestId("insert-after").click();
        await expect(page.getByTestId("add-text-row")).toBeVisible();
        await page.screenshot({
            path: info.outputPath(`live-${item}.png`),
            fullPage: true,
        });
        await page.keyboard.press("Escape");
        await page.keyboard.press("Escape");
        await expect(page.getByTestId("global-inspector")).toBeVisible();
    }
    expect(writes).toBe(0);
});
