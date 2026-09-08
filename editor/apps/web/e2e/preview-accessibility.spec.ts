import { expect, test } from "@playwright/test";
import { segmentedFrameDocument } from "../../../packages/protocol/fixtures/segmented-frame.js";
import {
    API_URL,
    chooseValue,
    enterWorkspace,
    mockPlugin,
} from "./fixtures/plugin.js";

test("decorated frame accessibility names contain content instead of frame and positioning glyphs", async ({
    page,
}) => {
    const document = segmentedFrameDocument();
    const plugin = await mockPlugin(page, document);
    await page.route(`${API_URL}/api/v2/preview`, (route) =>
        route.abort("blockedbyclient"),
    );
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
    await expect(page.getByTestId("tooltip-canvas")).toHaveAttribute(
        "data-renderer",
        "SEGMENTED_FRAME",
    );
    await expect(page.getByTestId("preview-name")).toHaveText("Name");
    const description = document.items[0]!.presentation.blocks.find(
        (block) => block.type === "description",
    )!;
    await expect(
        page.locator(`.line-hit[data-origin="${description.uuid}"]`),
    ).toHaveAccessibleName("Body");
    await expect(page.getByTestId("line-hit-name")).toHaveAccessibleName(
        "Name",
    );
    expect(plugin.writes).toHaveLength(0);
    await expect(page.getByTestId("undo")).toBeDisabled();
});
