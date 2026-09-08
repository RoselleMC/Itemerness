import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { zipSync } from "fflate";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import {
    contentHash,
    upgradeProjectDocument,
    type ProjectDocument,
} from "@itemerness/protocol";
import {
    API_URL,
    HANDSHAKE,
    chooseValue,
    enterWorkspace,
    mockPlugin,
} from "./fixtures/plugin.js";

async function enter(page: Page, section = "fonts") {
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    await page.getByTestId("open-assets").click();
    await page.getByTestId("asset-tab-runtime").click();
    await page.getByTestId(`asset-section-${section}`).click();
}
async function commit(page: Page, id: string, value: string) {
    await page.getByTestId(id).fill(value);
    await page.getByTestId(id).press("Enter");
}
async function save(page: Page) {
    await page.keyboard.press("ControlOrMeta+s");
}
function upgraded(): ProjectDocument {
    return upgradeProjectDocument(
        structuredClone(baselineDocument),
        (_schema, key) => ({
            readSources: [
                {
                    kind:
                        key.scope === "DEFINITION"
                            ? "catalogDefinition"
                            : "canonicalNbt",
                },
            ],
            access: {
                read: "PUBLIC",
                write: [key.scope === "DEFINITION" ? "definition" : "internal"],
            },
            placeholderApi: { exposed: false, formatter: null },
        }),
    );
}

test("right-clicking another declaration preserves the current asset inspector", async ({
    page,
}) => {
    const plugin = await mockPlugin(page);
    await enter(page);
    await page.getByTestId("asset-entry-itemerness:icons").click();
    const selected = await page.getByTestId("asset-id").inputValue();
    await page
        .locator('[data-testid^="asset-entry-"]')
        .filter({ hasNotText: "itemerness:icons" })
        .first()
        .click({ button: "right" });
    await expect(page.getByTestId("context-menu")).toBeVisible();
    await expect(page.getByTestId("asset-id")).toHaveValue(selected);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("asset-id")).toHaveValue(selected);
    expect(plugin.writes).toHaveLength(0);
});

test("new declarations stage required fields, block saving and cancel without writes", async ({
    page,
}) => {
    const plugin = await mockPlugin(page);
    await enter(page, "bitmaps");
    await page.getByTestId("asset-create").click();
    await expect(page.getByTestId("asset-sourceWidthPixels")).toHaveValue("");
    await save(page);
    await expect(page.getByTestId("asset-validation-error")).toContainText(
        "Apply or cancel",
    );
    await page.getByTestId("asset-section-fonts").click();
    await expect(page.getByTestId("asset-section-bitmaps")).toHaveAttribute(
        "aria-selected",
        "true",
    );
    expect(plugin.writes).toHaveLength(0);
    await page.getByTestId("asset-cancel").click();
    await page.getByTestId("asset-create").click();
    await commit(page, "asset-id", "created-bitmap");
    await commit(page, "asset-texture", "example:font/real.png");
    await commit(page, "asset-sourceWidthPixels", "8192");
    await commit(page, "asset-sourceHeightPixels", "16");
    await page.getByTestId("asset-apply").click();
    await save(page);
    await expect
        .poll(() => plugin.writes.at(-1)?.document.bitmaps.at(-1)?.id)
        .toBe("created-bitmap");
    expect(
        plugin.writes.at(-1)!.document.bitmaps.at(-1)!.sourceWidthPixels,
    ).toBe(8192);
    await applicationMenuAction(page, "edit", "undo");
    await expect(page.getByTestId("asset-entry-created-bitmap")).toHaveCount(0);
    await applicationMenuAction(page, "edit", "redo");
    await expect(page.getByTestId("asset-entry-created-bitmap")).toBeVisible();
    for (let index = 1; index < plugin.writes.length; index++)
        expect(plugin.writes[index]!.expectedHash).toBe(
            contentHash(plugin.writes[index - 1]!.document),
        );
});

test("font edits preserve exact numeric buffers and migrate references with a single undo", async ({
    page,
}) => {
    const plugin = await mockPlugin(page);
    await enter(page);
    await page.getByTestId("asset-entry-itemerness:icons").click();
    await commit(page, "asset-metrics", "example:metrics/icons-v2");
    await page.getByTestId("asset-fallbackAdvancePixels").fill("-");
    await save(page);
    await expect(
        page.getByTestId("asset-fallbackAdvancePixels"),
    ).toHaveAttribute("aria-invalid", "true");
    expect(
        plugin.writes
            .at(-1)
            ?.document.fonts.find((font) => font.id === "itemerness:icons")
            ?.fallbackAdvancePixels ?? null,
    ).toBeNull();
    await page.getByTestId("asset-fallbackAdvancePixels").press("Escape");
    await commit(page, "asset-fallbackAdvancePixels", "4.125");
    await commit(page, "asset-id", "example:custom/icons");
    await save(page);
    await expect
        .poll(() =>
            plugin.writes
                .at(-1)
                ?.document.fonts.some(
                    (font) => font.id === "example:custom/icons",
                ),
        )
        .toBe(true);
    const doc = plugin.writes.at(-1)!.document;
    expect(doc.glyphs.some((glyph) => glyph.font === "itemerness:icons")).toBe(
        false,
    );
    expect(
        doc.fonts.find((font) => font.id === "example:custom/icons")!
            .fallbackAdvancePixels,
    ).toBe(4.125);
    await expect(page.getByTestId("delete-asset")).toBeDisabled();
    await applicationMenuAction(page, "edit", "undo");
    await expect(page.getByTestId("asset-id")).toHaveValue("itemerness:icons");
    await page.getByTestId("asset-entry-minecraft:default").click();
    await commit(page, "asset-id", "example:wrong-font");
    await expect(page.getByTestId("asset-id")).toHaveAttribute(
        "aria-invalid",
        "true",
    );
    await page.getByTestId("asset-id").press("Escape");
    await expect(page.getByTestId("asset-id")).toHaveValue("minecraft:default");
});

test("bitmap metadata repairs use mounted source pixels explicitly and preserve layer references", async ({
    page,
}, testInfo) => {
    const initial = structuredClone(baselineDocument);
    const bitmap = initial.bitmaps[0]!;
    bitmap.texture = "example:font/source.png";
    bitmap.sourceWidthPixels = null;
    bitmap.sourceHeightPixels = null;
    const plugin = await mockPlugin(page, initial);
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    await page.getByTestId("open-assets").click();
    const bytes = readFileSync(
        new URL("../src-tauri/icons/32x32.png", import.meta.url),
    );
    const archive = zipSync({
        "pack.mcmeta": new TextEncoder().encode(
            JSON.stringify({
                pack: { pack_format: 0, description: "Asset authoring test" },
            }),
        ),
        "assets/example/textures/font/source.png": bytes,
    });
    await page.getByTestId("asset-file-input").setInputFiles({
        name: "authoring.zip",
        mimeType: "application/zip",
        buffer: Buffer.from(archive),
    });
    await expect(page.getByTestId("pack-list")).toContainText("authoring.zip");
    await page.getByTestId("asset-tab-runtime").click();
    await page.getByTestId("asset-section-bitmaps").click();
    await page.getByTestId(`asset-entry-${bitmap.id}`).click();
    await expect(page.getByTestId("asset-validation-error")).toContainText(
        "actual source image",
    );
    await expect(page.getByTestId("asset-sourceWidthPixels")).toHaveValue("");
    const image = await page
        .getByTestId("asset-texture-canvas")
        .evaluate((node) => {
            const canvas = node as HTMLCanvasElement;
            return {
                width: canvas.width,
                height: canvas.height,
                nonzero: canvas
                    .getContext("2d")!
                    .getImageData(0, 0, canvas.width, canvas.height)
                    .data.some((value) => value !== 0),
            };
        });
    expect(image).toEqual({ width: 32, height: 32, nonzero: true });
    await page.getByTestId("asset-use-source-size").click();
    await expect(page.getByTestId("asset-sourceWidthPixels")).toHaveValue("32");
    await commit(page, "asset-baselineVariant", "renamed-baseline");
    await commit(page, "asset-id", "renamed-bitmap");
    await save(page);
    await expect
        .poll(() => plugin.writes.at(-1)?.document.bitmaps[0]?.id)
        .toBe("renamed-bitmap");
    const doc = plugin.writes.at(-1)!.document;
    expect(
        doc.themes.find((theme) => theme.canvas)!.canvas!.layers[0]!
            .baselineVariant,
    ).toBe("renamed-baseline");
    expect(doc.glyphs.some((glyph) => glyph.bitmap === bitmap.id)).toBe(false);
    for (const width of [900, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.getByTestId("asset-texture-canvas").scrollIntoViewIfNeeded();
        const viewport = await page.evaluate(() => ({
            width: innerWidth,
            scroll: document.documentElement.scrollWidth,
        }));
        expect(viewport.scroll).toBeLessThanOrEqual(viewport.width);
        await page.screenshot({
            path: testInfo.outputPath(`asset-bitmap-${width}.png`),
        });
    }
});

test("profiles, pack bindings and tooltip styles expose all runtime fields with reference protection", async ({
    page,
}) => {
    const plugin = await mockPlugin(page);
    await enter(page, "assetProfiles");
    await page.getByTestId("asset-entry-itemerness:example-pack-v1").click();
    await page
        .getByTestId("asset-capability-input")
        .fill("example:new-capability");
    await page.getByTestId("asset-add-capability").click();
    await commit(page, "asset-metricsRevision", "example:metrics/revision-2");
    await commit(page, "asset-id", "example:profile");
    await expect(page.getByTestId("delete-asset")).toBeDisabled();
    await page.getByTestId("asset-section-resourcePackBindings").click();
    await expect(page.getByTestId("asset-assetProfile")).toHaveAttribute(
        "data-field-value",
        "example:profile",
    );
    await page.getByTestId("asset-bindingEnabled").check();
    await commit(page, "asset-packId", "10000000-0000-4000-8000-000000000001");
    await commit(page, "asset-sha1", "A".repeat(40));
    await save(page);
    await expect
        .poll(
            () => plugin.writes.at(-1)?.document.resourcePackBindings[0]?.sha1,
        )
        .toBe("A".repeat(40));
    await page.getByTestId("asset-section-tooltipStyles").click();
    await chooseValue(page, page.getByTestId("asset-scaling"), "stretch");
    await commit(
        page,
        "asset-expectedBackgroundSprite",
        "example:tooltip/background",
    );
    await commit(page, "asset-expectedFrameSprite", "example:tooltip/frame");
    await commit(page, "asset-id", "example:tooltip");
    await save(page);
    await expect
        .poll(() => plugin.writes.at(-1)?.document.tooltipStyles[0]?.id)
        .toBe("example:tooltip");
    expect(
        plugin.writes
            .at(-1)!
            .document.themes.some(
                (theme) => theme.tooltipStyle === "itemerness:ember",
            ),
    ).toBe(false);
    await page.getByTestId("asset-section-resourcePackBindings").click();
    await page.getByTestId("delete-asset").click();
    await page.getByTestId("confirm-cancel").click();
    await expect(page.getByTestId("asset-packId")).toHaveValue(
        "10000000-0000-4000-8000-000000000001",
    );
});

test("spacing creation is explicit and validates signed ranges without saving a pending policy", async ({
    page,
}) => {
    const initial = structuredClone(baselineDocument);
    initial.spacing = null;
    const plugin = await mockPlugin(page, initial);
    await enter(page, "spacing");
    await page.getByTestId("asset-create-spacing").click();
    await commit(page, "asset-negative-lastCodePoint", "U+F801");
    await page.getByTestId("asset-apply-spacing").click();
    await expect(
        page.locator(".workspace-page-content").getByRole("alert"),
    ).toContainText("number of code points");
    await save(page);
    expect(plugin.writes).toHaveLength(0);
    await commit(page, "asset-negative-minimumAdvancePixels", "-2");
    await page.getByTestId("asset-apply-spacing").click();
    await save(page);
    await expect
        .poll(
            () =>
                plugin.writes.at(-1)?.document.spacing?.negative
                    .minimumAdvancePixels,
        )
        .toBe(-2);
    await expect(page.getByTestId("asset-remove-spacing")).toBeDisabled();
    await applicationMenuAction(page, "edit", "undo");
    await expect(page.getByTestId("asset-create-spacing")).toBeVisible();
    await page.getByTestId("asset-section-measurement").click();
    await expect(page.getByTestId("asset-boldExtraAdvancePixels")).toHaveCount(
        0,
    );
    expect(plugin.writes.at(-1)!.document.schemaVersion).toBe(1);
});

test("glyph and measurement edits paint a complete cold local document", async ({
    page,
}) => {
    const initial = upgraded();
    const font = {
        uuid: crypto.randomUUID(),
        id: "example:font",
        metrics: "explicit",
        fallback: null,
        fallbackAdvancePixels: 28.5,
        advances: null,
    };
    initial.fonts.push(font);
    initial.glyphs.push({
        uuid: crypto.randomUUID(),
        id: "example-letter",
        font: font.id,
        codePoint: 65,
        advancePixels: 10,
        bitmap: null,
        visualBounds: { left: 0, right: 8, top: -8, bottom: 0 },
    });
    initial.themes[0]!.fonts.text = font.id;
    initial.themes[0]!.styles["item-name"]!.bold = true;
    initial.items[0]!.presentation.theme = initial.themes[0]!.id;
    initial.items[0]!.presentation.blocks = [];
    initial.locales.forEach(
        (locale) =>
            (locale.messages[initial.items[0]!.presentation.nameMessage] =
                "AAAA"),
    );
    const plugin = await mockPlugin(page, initial);
    await page.route(`${API_URL}/api/handshake`, (route) =>
        route.fulfill({ json: { ...HANDSHAKE, documentSchemas: [1, 2] } }),
    );
    await page.route(`${API_URL}/api/v2/preview`, (route) =>
        route.abort("blockedbyclient"),
    );
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    await page.getByTestId(`item-${initial.items[0]!.id}`).click();
    const width = () =>
        page
            .getByTestId("tooltip-canvas")
            .evaluate((node) =>
                Number((node as HTMLCanvasElement).dataset.logicalWidth),
            );
    const before = await width();
    await page.getByTestId("open-assets").click();
    await page.getByTestId("asset-tab-runtime").click();
    await page.getByTestId("asset-section-glyphs").click();
    await page.getByTestId("asset-entry-example-letter").click();
    await commit(page, "asset-advancePixels", "28.5");
    await page.getByTestId("mode-items").click();
    await expect.poll(width).toBeGreaterThan(before);
    await commit(page, "name-input", "BBBB");
    const beforeMeasurement = await width();
    await page.getByTestId("open-assets").click();
    await expect(page.getByTestId("asset-section-glyphs")).toHaveAttribute(
        "aria-selected",
        "true",
    );
    await page.getByTestId("asset-section-measurement").click();
    await commit(page, "asset-boldExtraAdvancePixels", "3.5");
    await chooseValue(page, page.getByTestId("asset-clientVersion"), "26.1.2");
    await page.getByTestId("mode-items").click();
    await expect.poll(width).toBeGreaterThan(beforeMeasurement);
    await save(page);
    await expect
        .poll(() => plugin.writes.at(-1)?.document.measurement?.clientVersion)
        .toBe("26.1.2");
    expect(
        plugin.writes.at(-1)!.document.measurement?.boldExtraAdvancePixels,
    ).toBe(3.5);
});

test("resource library CRUD, keyboard tabs and form controls remain usable in narrow windows", async ({
    page,
}, testInfo) => {
    const plugin = await mockPlugin(page);
    await enter(page);
    await expect(page.getByTestId("asset-fontFallback")).toBeDisabled();
    await expect(
        page.getByTestId("asset-fallbackAdvancePixels"),
    ).toBeDisabled();
    await page.getByTestId("asset-create").click();
    await commit(page, "asset-id", "example:font-library");
    await page.getByTestId("asset-apply").click();
    await page.getByTestId("asset-advanceRangeEnabled").check();
    await commit(page, "asset-maximumAdvance", "40");
    await commit(page, "asset-minimumAdvance", "12");
    await page.getByTestId("duplicate-asset").click();
    await expect(page.getByTestId("asset-id")).toHaveValue(
        "example:font-library-copy",
    );
    await page.getByTestId("asset-apply").click();
    await page.getByTestId("delete-asset").click();
    await page.getByTestId("confirm-cancel").click();
    await expect(
        page.getByTestId("asset-entry-example:font-library-copy"),
    ).toBeVisible();
    await page.getByTestId("delete-asset").click();
    await page.getByTestId("confirm-accept").click();
    await expect(
        page.getByTestId("asset-entry-example:font-library-copy"),
    ).toHaveCount(0);
    await applicationMenuAction(page, "edit", "undo");
    await expect(page.getByTestId("asset-id")).toHaveValue(
        "example:font-library-copy",
    );
    await page.getByTestId("asset-section-fonts").focus();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("asset-section-glyphs")).toHaveAttribute(
        "aria-selected",
        "true",
    );
    await commit(page, "asset-codePoint", "U+D800");
    await expect(page.getByTestId("asset-codePoint")).toHaveAttribute(
        "aria-invalid",
        "true",
    );
    await page.getByTestId("asset-codePoint").press("Escape");
    await page.getByTestId("asset-section-assetProfiles").click();
    await page.getByTestId("asset-entry-itemerness:example-pack-v1").click();
    await commit(
        page,
        "asset-capability-itemerness:native-tooltip-style-v1",
        "example:renamed-capability",
    );
    for (const width of [900, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        await page
            .getByTestId("asset-capability-example:renamed-capability")
            .scrollIntoViewIfNeeded();
        const bounds = await page
            .getByTestId("asset-capability-example:renamed-capability")
            .boundingBox();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
        const tab = await page
            .getByTestId("asset-section-assetProfiles")
            .boundingBox();
        expect(tab!.x).toBeGreaterThanOrEqual(0);
        expect(tab!.x + tab!.width).toBeLessThanOrEqual(width);
        await page.screenshot({
            path: testInfo.outputPath(`asset-profile-${width}.png`),
        });
    }
    await save(page);
    await expect
        .poll(
            () =>
                plugin.writes.at(-1)?.document.assetProfiles[1]
                    ?.capabilities[0],
        )
        .toBe("example:renamed-capability");
    expect(
        plugin.writes
            .at(-1)!
            .document.fonts.find(
                (font) => font.id === "example:font-library-copy",
            )!.advances,
    ).toEqual({ minimum: 12, maximum: 40 });
});
import { applicationMenuAction } from "./fixtures/applicationMenu.js";
