import { expect, test, type Page } from "@playwright/test";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import {
    contentHash,
    type LayoutNode,
    type PresentationBlock,
} from "@itemerness/protocol";
import {
    API_URL,
    chooseValue,
    enterWorkspace,
    mockPlugin,
} from "./fixtures/plugin.js";

async function enterLayouts(page: Page, id: string, managed = false) {
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    if (managed) {
        await page.getByTestId("open-persona").click();
        await page.getByTestId("pack-sim-loaded").click();
        await chooseValue(
            page,
            page.getByTestId("asset-profile-simulation"),
            "itemerness:example-pack-v1",
        );
        await page.getByTestId("managed-vanilla-lines-simulation").check();
        await page.getByTestId("open-persona").click();
    }
    await page.getByTestId("mode-layouts").click();
    await page.getByTestId(`layout-${id}`).click();
}

async function commit(page: Page, id: string, value: string) {
    await page.getByTestId(id).fill(value);
    await page.getByTestId(id).press("Enter");
}

async function pixels(page: Page) {
    return page.getByTestId("tooltip-canvas").evaluate((node) => {
        const canvas = node as HTMLCanvasElement;
        const data = canvas
            .getContext("2d")!
            .getImageData(0, 0, canvas.width, canvas.height).data;
        let hash = 2166136261;
        for (let index = 0; index < data.length; index += 17)
            hash = Math.imul(hash ^ data[index]!, 16777619) >>> 0;
        return `${canvas.width}x${canvas.height}:${hash}`;
    });
}

function blocks(block: PresentationBlock): PresentationBlock[] {
    return block.type === "conditional"
        ? [
              block,
              ...block.thenBlocks.flatMap(blocks),
              ...block.otherwiseBlocks.flatMap(blocks),
          ]
        : [block];
}

test("cold flow edits validate exact numbers without silently changing paired widths", async ({
    page,
}) => {
    const initial = structuredClone(baselineDocument);
    initial.items.find(
        (item) => item.id === "ember-blade",
    )!.presentation.theme = "itemerness:default";
    const plugin = await mockPlugin(page, initial);
    await page.route(`${API_URL}/api/v2/preview`, (route) =>
        route.abort("blockedbyclient"),
    );
    await enterLayouts(page, "equipment");
    const before = await pixels(page);
    await commit(page, "layout-maximumWidthPixels", "120");
    await expect(page.getByTestId("layout-maximumWidthPixels")).toHaveAttribute(
        "aria-invalid",
        "true",
    );
    await expect(page.getByTestId("layout-minimumWidthPixels")).toHaveValue(
        "140",
    );
    await page.keyboard.press("ControlOrMeta+s");
    expect(plugin.writes).toHaveLength(0);
    await page.getByTestId("layout-maximumWidthPixels").press("Escape");
    await commit(page, "layout-minimumWidthPixels", "100");
    await commit(page, "layout-maximumWidthPixels", "120");
    await expect.poll(() => pixels(page)).not.toBe(before);
    await commit(page, "layout-blockGapAfterPixels", "15");
    await expect(
        page.getByTestId("layout-blockGapAfterPixels"),
    ).toHaveAttribute("aria-invalid", "true");
    await page.getByTestId("layout-blockGapAfterPixels").press("Escape");
    await commit(page, "layout-blockGapAfterPixels", "20");
    await commit(page, "layout-fieldLeftPaddingPixels", "9");
    await commit(page, "layout-fieldIconGapPixels", "5");
    await commit(page, "layout-descriptionLeftPaddingPixels", "10");
    await commit(page, "layout-descriptionRightPaddingPixels", "11");
    await commit(page, "layout-descriptionGapBeforePixels", "20");
    await page.getByTestId("align-LEFT").click();
    await expect(page.getByTestId("align-LEFT")).toHaveAttribute(
        "aria-pressed",
        "true",
    );
    await expect
        .poll(() =>
            plugin.writes
                .at(-1)
                ?.document.layouts.find(
                    (layout) => layout.id === "itemerness:equipment",
                ),
        )
        .toMatchObject({
            minimumWidthPixels: 100,
            maximumWidthPixels: 120,
            blockGapAfterPixels: 20,
            fieldLeftPaddingPixels: 9,
            fieldIconGapPixels: 5,
            fieldValueAlignment: "LEFT",
            descriptionLeftPaddingPixels: 10,
            descriptionRightPaddingPixels: 11,
            descriptionGapBeforePixels: 20,
        });
    let hash = contentHash(initial);
    for (const write of plugin.writes) {
        expect(write.expectedHash).toBe(hash);
        hash = contentHash(write.document);
    }
});

test("frame lore retains the renderer's independent width cap", async ({
    page,
}) => {
    const plugin = await mockPlugin(page);
    await page.route(`${API_URL}/api/v2/preview`, (route) =>
        route.abort("blockedbyclient"),
    );
    await enterLayouts(page, "equipment");
    await expect(page.getByTestId("tooltip-canvas")).toHaveAttribute(
        "data-theme",
        "itemerness:vanilla-frame",
    );
    const before = await pixels(page);
    await commit(page, "layout-maximumWidthPixels", "140");
    await expect
        .poll(
            () =>
                plugin.writes
                    .at(-1)
                    ?.document.layouts.find(
                        (layout) => layout.id === "itemerness:equipment",
                    )?.maximumWidthPixels,
        )
        .toBe(140);
    expect(await pixels(page)).toBe(before);
    await expect(page.getByTestId("tooltip-canvas")).toHaveAttribute(
        "data-preview-origin",
        "local",
    );
});

test("all wrapping policies support scoped rename, complete editing and reference-aware deletion", async ({
    page,
}) => {
    const plugin = await mockPlugin(page);
    await enterLayouts(page, "equipment");
    const source = baselineDocument.layouts.find(
        (layout) => layout.id === "itemerness:equipment",
    )!;
    await expect(
        page.getByTestId("layout-wrapping-body-delete"),
    ).toBeDisabled();
    const before = await pixels(page);
    await commit(page, "layout-wrapping-body-name", "lore");
    await expect(page.getByTestId("layout-wrapping-lore-name")).toBeVisible();
    await expect
        .poll(
            () =>
                plugin.writes
                    .at(-1)
                    ?.document.layouts.find(
                        (layout) => layout.uuid === source.uuid,
                    )?.wrapping.lore,
        )
        .toEqual(source.wrapping.body);
    expect(await pixels(page)).toBe(before);
    const renamed = plugin.writes.at(-1)!.document;
    for (const item of baselineDocument.items) {
        const next = renamed.items.find((entry) => entry.uuid === item.uuid)!;
        if (item.presentation.layout !== source.id) expect(next).toEqual(item);
        else
            expect(
                next.presentation.blocks
                    .flatMap(blocks)
                    .some(
                        (block) =>
                            "wrapping" in block && block.wrapping === "body",
                    ),
            ).toBe(false);
    }
    await page.getByTestId("undo").click();
    await expect(page.getByTestId("layout-wrapping-body-name")).toBeVisible();
    await expect
        .poll(() => plugin.writes.at(-1)?.document)
        .toEqual(baselineDocument);
    await page.getByTestId("layout-add-wrapping-input").fill("details");
    await page.getByTestId("layout-add-wrapping").click();
    const owner = "layout-wrapping-details";
    await chooseValue(page, page.getByTestId(`${owner}-width-mode`), "fixed");
    await commit(page, `${owner}-widthPixels`, "100");
    await commit(page, `${owner}-maximumLines`, "3");
    await commit(page, `${owner}-lineHeightPixels`, "12");
    await commit(page, `${owner}-continuationIndentPixels`, "7");
    await chooseValue(page, page.getByTestId(`${owner}-overflow`), "ERROR");
    await page.getByTestId(`${owner}-preserveExplicitLines`).uncheck();
    await expect
        .poll(
            () =>
                plugin.writes
                    .at(-1)
                    ?.document.layouts.find(
                        (layout) => layout.uuid === source.uuid,
                    )?.wrapping.details,
        )
        .toEqual({
            widthPixels: 100,
            maximumLines: 3,
            lineHeightPixels: 12,
            continuationIndentPixels: 7,
            overflow: "ERROR",
            preserveExplicitLines: false,
        });
    await commit(page, `${owner}-name`, "body");
    await expect(page.getByTestId(`${owner}-name`)).toHaveAttribute(
        "aria-invalid",
        "true",
    );
    await page.getByTestId(`${owner}-name`).press("Escape");
    await page.getByTestId(`${owner}-delete`).click();
    await expect(page.getByTestId(owner)).toHaveCount(0);
});

test("canvas geometry and anchors edit exactly, migrate references atomically and fit narrow windows", async ({
    page,
}, info) => {
    const plugin = await mockPlugin(page);
    await page.route(`${API_URL}/api/v2/preview`, (route) =>
        route.abort("blockedbyclient"),
    );
    await enterLayouts(page, "bitmap-canvas", true);
    await expect(page.getByTestId("tooltip-canvas")).toHaveAttribute(
        "data-renderer",
        "BITMAP_CANVAS",
    );
    const currentLayout = () =>
        plugin.writes
            .at(-1)
            ?.document.layouts.find((layout) => layout.kind === "canvas") as
            Extract<LayoutNode, { kind: "canvas" }> | undefined;
    await expect(page.getByTestId("layout-anchor-body-delete")).toBeDisabled();
    await commit(page, "layout-anchor-body-x", "-1");
    await expect(page.getByTestId("layout-anchor-body-x")).toHaveAttribute(
        "aria-invalid",
        "true",
    );
    expect(plugin.writes).toHaveLength(0);
    await page.getByTestId("layout-anchor-body-x").press("Escape");
    const before = await pixels(page);
    await commit(page, "layout-anchor-body-x", "22");
    await expect.poll(() => pixels(page)).not.toBe(before);
    await expect.poll(currentLayout).toMatchObject({
        anchors: { body: { x: 22 } },
    });
    const positioned = await pixels(page);
    await commit(page, "layout-anchor-body-name", "details");
    await expect(page.getByTestId("layout-anchor-details-x")).toHaveValue("22");
    await expect.poll(() => currentLayout()?.anchors.details?.x).toBe(22);
    expect(await pixels(page)).toBe(positioned);
    const migrated = plugin.writes
        .at(-1)!
        .document.items.find((item) => item.id === "survey-codex")!.presentation
        .blocks;
    expect(
        migrated.flatMap(blocks).some((block) => block.anchor === "details"),
    ).toBe(true);
    expect(
        migrated.flatMap(blocks).some((block) => block.anchor === "body"),
    ).toBe(false);
    await page.getByTestId("undo").click();
    await expect(page.getByTestId("layout-anchor-body-x")).toHaveValue("22");
    await commit(page, "layout-widthPixels", "190");
    await commit(page, "layout-heightPixels", "110");
    await commit(page, "layout-maximumWidthPixels", "210");
    await commit(page, "layout-maximumHeightPixels", "160");
    await commit(page, "layout-reserveTooltipLines", "12");
    await expect(
        page.getByTestId("layout-canvas-theme-mismatch"),
    ).toContainText("itemerness:aurora-canvas");
    await expect
        .poll(currentLayout)
        .toMatchObject({
            widthPixels: 190,
            heightPixels: 110,
            maximumWidthPixels: 210,
            maximumHeightPixels: 160,
            reserveTooltipLines: 12,
        });
    expect(plugin.writes.at(-1)!.document.themes).toEqual(
        baselineDocument.themes,
    );
    await page.getByTestId("layout-add-anchor-input").fill("extra");
    await page.getByTestId("layout-add-anchor").click();
    await commit(page, "layout-anchor-extra-width", "30");
    await commit(page, "layout-anchor-extra-height", "20");
    await commit(page, "layout-anchor-extra-x", "5");
    await commit(page, "layout-anchor-extra-y", "6");
    await chooseValue(
        page,
        page.getByTestId("layout-anchor-extra-overflow"),
        "ALLOW_OVERFLOW",
    );
    await expect
        .poll(() => currentLayout()?.anchors.extra)
        .toEqual({
            x: 5,
            y: 6,
            width: 30,
            height: 20,
            overflow: "ALLOW_OVERFLOW",
        });
    for (const width of [900, 390]) {
        await page.setViewportSize({ width, height: 844 });
        await page
            .getByTestId("layout-anchor-extra-overflow")
            .scrollIntoViewIfNeeded();
        expect(
            await page.evaluate(
                () => document.documentElement.scrollWidth <= innerWidth,
            ),
        ).toBe(true);
        await page.screenshot({
            path: info.outputPath(`canvas-layout-${width}.png`),
            fullPage: width !== 390,
        });
    }
    await page.getByTestId("layout-anchor-extra-delete").click();
    await expect(page.getByTestId("layout-anchor-extra")).toHaveCount(0);
});
