import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { zipSync } from "fflate";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import { contentHash } from "@itemerness/protocol";
import { enterWorkspace, mockPlugin } from "./fixtures/plugin.js";

const bytes = Buffer.from(
    zipSync({
        "assets/example/font/frame.json": new TextEncoder().encode(
            JSON.stringify({
                providers: [
                    {
                        type: "bitmap",
                        file: "example:font/icon.png",
                        ascent: 7,
                        height: 8,
                        chars: ["\ue000"],
                    },
                    { type: "space", advances: { "\ue001": -1 } },
                ],
            }),
        ),
        "assets/example/textures/font/icon.png": readFileSync(
            new URL("../src-tauri/icons/32x32.png", import.meta.url),
        ),
    }),
);

test("pack mounting is local; explicit font import is one undoable draft change", async ({
    page,
}) => {
    const plugin = await mockPlugin(page);
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    await page.getByTestId("open-assets").click();
    await page
        .getByTestId("asset-file-input")
        .setInputFiles({
            name: "generic-frame.zip",
            mimeType: "application/zip",
            buffer: bytes,
        });
    await page.getByTestId("import-pack-font-0").click();
    await expect(page.getByTestId("pack-font-count")).toContainText(
        "2 new glyphs",
    );
    await expect(page.getByTestId("asset-texture-canvas")).toBeVisible();
    expect(plugin.writes).toHaveLength(0);
    await page.getByTestId("pack-font-apply").click();
    await page.keyboard.press("ControlOrMeta+s");
    await expect
        .poll(() => plugin.writes.at(-1)?.document.glyphs.length)
        .toBe(baselineDocument.glyphs.length + 2);
    expect(plugin.writes.at(-1)!.document.items).toEqual(
        baselineDocument.items,
    );
    expect(plugin.writes.at(-1)!.document.resourcePackBindings).toEqual(
        baselineDocument.resourcePackBindings,
    );
    await applicationMenuAction(page, "edit", "undo");
    await page.keyboard.press("ControlOrMeta+s");
    await expect
        .poll(() => contentHash(plugin.writes.at(-1)!.document))
        .toBe(contentHash(baselineDocument));
    await applicationMenuAction(page, "edit", "redo");
    await page.getByTestId("import-pack-font-0").click();
    await expect(page.getByTestId("pack-font-count")).toContainText(
        "0 new glyphs",
    );
    await expect(page.getByTestId("pack-font-apply")).toBeDisabled();
    for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 960 });
        await expect(page.getByTestId("pack-font-apply")).toBeVisible();
        expect(
            await page.evaluate(
                () => document.documentElement.scrollWidth <= innerWidth,
            ),
        ).toBe(true);
    }
});

test("closing the import or removing its pack never writes declarations", async ({
    page,
}) => {
    const plugin = await mockPlugin(page);
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    await page.getByTestId("open-assets").click();
    await page
        .getByTestId("asset-file-input")
        .setInputFiles({
            name: "generic-frame.zip",
            mimeType: "application/zip",
            buffer: bytes,
        });
    await page.getByTestId("import-pack-font-0").click();
    await page
        .getByTestId("pack-font-import")
        .getByRole("button", { name: "Close", exact: true })
        .click();
    await expect(page.getByTestId("pack-font-import")).toHaveCount(0);
    await page.getByTestId("import-pack-font-0").click();
    await page
        .getByTestId("pack-0")
        .getByRole("button", { name: "Remove", exact: true })
        .click();
    await expect(page.getByTestId("pack-font-import")).toHaveCount(0);
    expect(plugin.writes).toHaveLength(0);
});
import { applicationMenuAction } from "./fixtures/applicationMenu.js";
