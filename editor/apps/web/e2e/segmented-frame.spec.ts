import { expect, test, type Page } from "@playwright/test";
import { contentHash } from "@itemerness/protocol";
import { segmentedFrameDocument } from "../../../packages/protocol/fixtures/segmented-frame.js";
import {
    API_URL,
    HANDSHAKE,
    chooseValue,
    enterWorkspace,
    mockPlugin,
} from "./fixtures/plugin.js";

async function enterFrame(page: Page) {
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    await page.getByTestId("open-persona").click();
    await page.getByTestId("pack-sim-loaded").click();
    await chooseValue(
        page,
        page.getByTestId("asset-profile-simulation"),
        "itemerness:example-pack-v1",
    );
    await page.getByTestId("managed-vanilla-lines-simulation").check();
    await page.getByTestId("open-persona").click();
    await page.getByTestId("mode-themes").click();
    await page.getByTestId("theme-segmented").click();
}

async function pixels(page: Page) {
    return page
        .getByTestId("tooltip-canvas")
        .evaluate((node) => (node as HTMLCanvasElement).toDataURL());
}

test("cold decorated-frame edits paint, undo and save optional fields without changing block identities", async ({
    page,
}, info) => {
    const document = segmentedFrameDocument();
    const plugin = await mockPlugin(page, document);
    await page.route(`${API_URL}/api/v2/preview`, (route) =>
        route.abort("blockedbyclient"),
    );
    await enterFrame(page);
    await expect(page.getByTestId("theme-includeName")).toBeChecked();
    const before = await pixels(page);
    await page.getByTestId("theme-includeName").uncheck();
    await expect.poll(() => pixels(page)).not.toBe(before);
    await expect
        .poll(
            () =>
                plugin.writes
                    .at(-1)
                    ?.document.themes.find(
                        (theme) => theme.renderer === "SEGMENTED_FRAME",
                    )?.segmentedFrame?.includeName,
        )
        .toBe(false);
    await page.getByTestId("undo").click();
    await expect(page.getByTestId("theme-includeName")).toBeChecked();
    await expect.poll(() => pixels(page)).toBe(before);
    await chooseValue(page, page.getByTestId("theme-frame-top-center"), "");
    await expect
        .poll(
            () =>
                plugin.writes
                    .at(-1)
                    ?.document.themes.find(
                        (theme) => theme.renderer === "SEGMENTED_FRAME",
                    )?.segmentedFrame?.top.center,
        )
        .toBeNull();
    await chooseValue(
        page,
        page.getByTestId("theme-frame-top-center"),
        "test.frame.center",
    );
    await chooseValue(page, page.getByTestId("theme-tooltip-style"), "");
    await expect
        .poll(
            () =>
                plugin.writes
                    .at(-1)
                    ?.document.themes.find(
                        (theme) => theme.renderer === "SEGMENTED_FRAME",
                    )?.tooltipStyle,
        )
        .toBeNull();
    let hash = contentHash(document);
    for (const write of plugin.writes) {
        expect(write.expectedHash).toBe(hash);
        expect(write.document.items).toEqual(document.items);
        hash = contentHash(write.document);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByTestId("theme-frame-top-center")).toBeVisible();
    await page.screenshot({
        path: info.outputPath("segmented-frame-narrow.png"),
        fullPage: true,
    });
});

test("older plugins show retained decorations read-only without writing or stripping fields", async ({
    page,
}) => {
    const document = segmentedFrameDocument();
    const plugin = await mockPlugin(page, document);
    await page.route(`${API_URL}/api/handshake`, (route) =>
        route.fulfill({
            json: {
                ...HANDSHAKE,
                capabilities: HANDSHAKE.capabilities.filter(
                    (capability) =>
                        capability !==
                        "presentation.segmented-frame.decorations",
                ),
            },
        }),
    );
    await enterFrame(page);
    await expect(page.getByTestId("theme-includeName")).toBeChecked();
    await expect(page.getByTestId("theme-includeName")).toBeDisabled();
    for (const id of [
        "theme-frame-top-center",
        "theme-frame-top-kern",
        "theme-tooltip-style",
    ])
        await expect(page.getByTestId(id)).toBeDisabled();
    await expect(page.getByTestId("theme-frame-top-center")).toHaveAttribute(
        "data-field-value",
        "test.frame.center",
    );
    await expect(
        page.getByTestId("theme-decorations-unsupported"),
    ).toBeVisible();
    expect(plugin.writes).toHaveLength(0);
});
