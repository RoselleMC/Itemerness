import { expect, test, type Page } from "@playwright/test";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import {
    enterWorkspace,
    mockPlugin,
    selectContent,
    setZoom,
    namedDocument,
} from "./fixtures/plugin.js";

const original = baselineDocument.items[0]!.presentation.blocks.map(
    (block) => block.uuid,
);
const line = (page: Page, uuid: string) =>
    page.locator(`.line-hit[data-origin="${uuid}"]`).first();
const order = (page: Page) =>
    page
        .locator('.line-hit:not([data-origin="__name"])')
        .evaluateAll((elements) => [
            ...new Set(
                elements.map(
                    (element) => (element as HTMLElement).dataset.origin,
                ),
            ),
        ]);
const bitmap = (page: Page) =>
    page
        .getByTestId("tooltip-canvas")
        .evaluate((element) => (element as HTMLCanvasElement).toDataURL());

test("smooth zoom paints intermediate frames, respects reduced motion, and does not create history", async ({
    page,
}, info) => {
    await mockPlugin(page);
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    await setZoom(page, 1);
    await page.getByTestId("canvas-zoom").click();
    const samples = await page.evaluate(async () => {
        document
            .querySelector<HTMLButtonElement>('[data-testid="canvas-zoom-4"]')!
            .click();
        const samples: number[] = [];
        const deadline = performance.now() + 1200;
        while (performance.now() < deadline) {
            await new Promise(requestAnimationFrame);
            samples.push(
                Number(
                    document.querySelector<HTMLElement>(
                        '[data-testid="canvas-viewport"]',
                    )!.dataset.zoom,
                ),
            );
            if (samples.at(-1) === 4) break;
        }
        return samples;
    });
    expect(
        new Set(samples.filter((scale) => scale > 1 && scale < 4)).size,
    ).toBeGreaterThan(4);
    expect(samples.at(-1)).toBe(4);
    expect(
        samples.every(
            (value, index) => index === 0 || value >= samples[index - 1]!,
        ),
    ).toBe(true);
    await expect(page.getByTestId("undo")).toBeDisabled();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await setZoom(page, 1);
    await expect(page.getByTestId("canvas-viewport")).toHaveAttribute(
        "data-zoom",
        "1",
    );
    await info.attach("smooth-zoom-frames", {
        body: JSON.stringify(samples),
        contentType: "application/json",
    });
});

test("blank dragging pans even a fitted canvas, while a blank click only deselects", async ({
    page,
}) => {
    const plugin = await mockPlugin(page);
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    await line(page, original[0]!).click();
    const area = (await page.getByTestId("canvas-viewport").boundingBox())!;
    const before = (await page.getByTestId("tooltip-canvas").boundingBox())!;
    const targetZoom = await page
        .getByTestId("canvas-viewport")
        .getAttribute("data-target-zoom");
    await page.mouse.move(area.x + 30, area.y + 30);
    await page.mouse.down();
    await page.mouse.move(area.x + 120, area.y + 95, { steps: 8 });
    await page.mouse.up();
    const after = (await page.getByTestId("tooltip-canvas").boundingBox())!;
    expect(after.x - before.x).toBeCloseTo(90, 0);
    expect(after.y - before.y).toBeCloseTo(65, 0);
    await expect(page.getByTestId("content-inspector")).toBeVisible();
    await expect(page.getByTestId("canvas-viewport")).toHaveAttribute(
        "data-target-zoom",
        targetZoom!,
    );
    await page
        .getByTestId("canvas-viewport")
        .click({ position: { x: 5, y: 5 } });
    await expect(page.getByTestId("global-inspector")).toBeVisible();
    await page.getByTestId("zoom-fit").click();
    await expect
        .poll(
            async () =>
                (await page.getByTestId("tooltip-canvas").boundingBox())!.x,
        )
        .toBeCloseTo(before.x, 0);
    expect(plugin.writes).toHaveLength(0);
});

test("canvas move buttons and one-step undo restore the saved document through CAS", async ({
    page,
}) => {
    const plugin = await mockPlugin(page);
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    await line(page, original[0]!).click();
    await expect(
        page.getByTestId("content-inspector").getByTestId("content-move-down"),
    ).toHaveCount(0);
    await page.getByTestId("content-move-down").click();
    await expect
        .poll(() => order(page))
        .toEqual([original[1], original[0], original[2]]);
    await expect(page.getByTestId("document-sync-status")).toHaveAttribute(
        "data-sync-kind",
        "saved",
    );
    await page.getByTestId("undo").click();
    await expect.poll(() => order(page)).toEqual(original);
    await expect
        .poll(() =>
            plugin.writes
                .at(-1)
                ?.document.items[0]?.presentation.blocks.map(
                    (block) => block.uuid,
                ),
        )
        .toEqual(original);
    await page.getByTestId("redo").click();
    await expect
        .poll(() => order(page))
        .toEqual([original[1], original[0], original[2]]);
});

test("dragging reorders pixels before release and records one undo step", async ({
    page,
}, info) => {
    const plugin = await mockPlugin(page);
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    await setZoom(page, 2);
    const before = await bitmap(page);
    const first = (await line(page, original[0]!).boundingBox())!,
        second = (await line(page, original[1]!).boundingBox())!;
    await page.mouse.move(first.x + 40, first.y + first.height / 2);
    await page.mouse.down();
    await page.mouse.move(first.x + 40, second.y + second.height / 2 + 6, {
        steps: 8,
    });
    await expect(page.getByTestId("canvas-drag-ghost")).toBeVisible();
    await expect
        .poll(() => order(page))
        .toEqual([original[1], original[0], original[2]]);
    expect(await bitmap(page)).not.toBe(before);
    expect(plugin.writes).toHaveLength(0);
    const last = (await line(page, original[2]!).boundingBox())!;
    await page.mouse.move(first.x + 40, last.y + last.height / 2 + 8, {
        steps: 8,
    });
    await expect
        .poll(() => order(page))
        .toEqual([original[1], original[2], original[0]]);
    await page.screenshot({ path: info.outputPath("live-drag.png") });
    await page.mouse.up();
    await expect(page.getByTestId("canvas-drag-ghost")).toHaveCount(0);
    await expect.poll(() => plugin.writes.length).toBe(1);
    await page.getByTestId("undo").click();
    await expect.poll(() => order(page)).toEqual(original);
    await expect(page.getByTestId("undo")).toBeDisabled();
    await page.getByTestId("redo").click();
    await expect
        .poll(() => order(page))
        .toEqual([original[1], original[2], original[0]]);
});

test("Escape cancels live reordering without saving or creating a history entry", async ({
    page,
}) => {
    const plugin = await mockPlugin(page);
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    await setZoom(page, 2);
    const first = (await line(page, original[0]!).boundingBox())!,
        second = (await line(page, original[1]!).boundingBox())!;
    await page.mouse.move(first.x + 40, first.y + first.height / 2);
    await page.mouse.down();
    await page.mouse.move(first.x + 40, second.y + second.height, { steps: 8 });
    await expect
        .poll(() => order(page))
        .toEqual([original[1], original[0], original[2]]);
    await page.keyboard.press("Escape");
    await page.mouse.up();
    await expect.poll(() => order(page)).toEqual(original);
    await expect(page.getByTestId("undo")).toBeDisabled();
    await expect(page.getByTestId("document-sync-status")).toHaveAttribute(
        "data-sync-kind",
        "saved",
    );
    expect(plugin.writes).toHaveLength(0);
});

test("nested dragging stays in its branch and a selected conditional moves as one block", async ({
    page,
}) => {
    const document = structuredClone(baselineDocument);
    const token = document.items[0]!,
        blade = document.items[1]!;
    const parent = blade.presentation.blocks.find(
        (block) => block.type === "conditional",
    )!;
    if (parent.type !== "conditional") throw new Error("conditional fixture");
    parent.thenBlocks = token.presentation.blocks.slice(0, 2);
    const next = token.presentation.blocks[2]!;
    blade.previewData.push(...token.previewData);
    blade.presentation.blocks = [parent, next];
    document.items = [blade];
    const plugin = await mockPlugin(page, document);
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    await setZoom(page, 2);
    const first = (await line(page, original[0]!).boundingBox())!,
        second = (await line(page, original[1]!).boundingBox())!;
    await page.mouse.move(first.x + 30, first.y + first.height / 2);
    await page.mouse.down();
    await page.mouse.move(first.x + 30, second.y + second.height, { steps: 6 });
    await page.mouse.up();
    await expect
        .poll(() => {
            const saved =
                plugin.writes.at(-1)?.document.items[0]?.presentation.blocks[0];
            return saved?.type === "conditional"
                ? saved.thenBlocks.map((block) => block.uuid)
                : [];
        })
        .toEqual([original[1], original[0]]);
    expect(
        plugin.writes
            .at(-1)!
            .document.items[0]!.presentation.blocks.map((block) => block.uuid),
    ).toEqual([parent.uuid, next.uuid]);
    await page.getByTestId("undo").click();
    await expect.poll(() => order(page)).toEqual(original);
    await selectContent(page, parent.uuid);
    const source = (await line(page, original[0]!).boundingBox())!,
        destination = (await line(page, next.uuid).boundingBox())!;
    await page.mouse.move(source.x + 30, source.y + source.height / 2);
    await page.mouse.down();
    await page.mouse.move(source.x + 30, destination.y + destination.height, {
        steps: 8,
    });
    await page.mouse.up();
    await expect
        .poll(() =>
            plugin.writes
                .at(-1)
                ?.document.items[0]?.presentation.blocks.map(
                    (block) => block.uuid,
                ),
        )
        .toEqual([next.uuid, parent.uuid]);
    const saved =
        plugin.writes.at(-1)!.document.items[0]!.presentation.blocks[1]!;
    expect(
        saved.type === "conditional" &&
            saved.thenBlocks.map((block) => block.uuid),
    ).toEqual(original.slice(0, 2));
    await page.getByTestId("undo").click();
    await expect.poll(() => order(page)).toEqual(original);
});

test("text bursts, duplicate, delete and redo shortcuts share document history", async ({
    page,
}) => {
    await mockPlugin(page);
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    const name = page.getByTestId("name-input");
    await name.fill("New");
    await name.pressSequentially(" name");
    await name.press("Control+z");
    await expect(name).toHaveValue("Harbor Travel Token");
    await name.press("Control+Shift+z");
    await expect(name).toHaveValue("New name");
    await name.press("Meta+z");
    await name.pressSequentially(" continued");
    await name.press("Meta+z");
    await expect(name).toHaveValue("Harbor Travel Token");
    await name.fill("Different");
    await expect(page.getByTestId("redo")).toBeDisabled();
    await line(page, original[0]!).click();
    await page.keyboard.press("Control+d");
    await expect.poll(async () => (await order(page)).length).toBe(4);
    const duplicate = await page
        .locator("[data-block]")
        .getAttribute("data-block");
    await selectContent(page, duplicate!);
    await line(page, duplicate!).click();
    await page.keyboard.press("Delete");
    await expect.poll(async () => (await order(page)).length).toBe(3);
    await page.getByTestId("undo").click();
    await expect.poll(async () => (await order(page)).length).toBe(4);
    await expect(page.locator("[data-block]")).toHaveAttribute(
        "data-block",
        duplicate!,
    );
});

test("remote reload and disconnect clear history, and dark canvas contrasts with tooltip pixels", async ({
    page,
}, info) => {
    const plugin = await mockPlugin(page);
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    await page.getByTestId("name-input").fill("Saved local edit");
    await expect(page.getByTestId("undo")).toBeEnabled();
    await expect(page.getByTestId("document-sync-status")).toHaveAttribute(
        "data-sync-kind",
        "saved",
    );
    plugin.replace(namedDocument("Remote draft"));
    await expect(page.getByTestId("name-input")).toHaveValue("Remote draft");
    await expect(page.getByTestId("undo")).toBeDisabled();
    const colors = await page.evaluate(() => {
        const css = getComputedStyle(document.documentElement);
        return [
            css.getPropertyValue("--checker-a").trim(),
            css.getPropertyValue("--bg").trim(),
        ];
    });
    expect(colors[0]).toBe("#303735");
    expect(colors[0]).not.toBe(colors[1]);
    await page.screenshot({ path: info.outputPath("dark-canvas.png") });
    await page.getByTestId("name-input").fill("Unsaved");
    await page.getByTestId("connection-trigger").click();
    await page.getByTestId("disconnect-plugin").click();
    await expect(page.getByTestId("undo")).toBeDisabled();
    await expect(page.getByTestId("redo")).toBeDisabled();
});
