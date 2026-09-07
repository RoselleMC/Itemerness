import { setZoom } from "./fixtures/plugin.js";
import { chooseValue, setColor } from "./fixtures/plugin.js";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import {
    mockPlugin,
    enterWorkspace,
    connectPlugin,
    HANDSHAKE,
    TEST_TOKEN,
    API_URL,
    selectContent,
} from "./fixtures/plugin.js";
import {
    contentHash,
    type PreviewRequest,
    type ProjectDocument,
} from "@itemerness/protocol";

/**
 * Editor end-to-end coverage, against the redesigned shell.
 *
 * Two things are proven. First, the editing loop the product exists for: pick an item by its name,
 * type a new name and watch the tooltip change, add a row, switch the previewed language, mount a
 * resource pack. Second, that the honesty labelling stays wired to reality: badges change when
 * assets are mounted or a server compiles the draft, and never claim what only the client knows.
 */

const VANILLA_BUNDLE = fileURLToPath(
    new URL("../../../vanilla-cache/vanilla-26.1.2.zip", import.meta.url),
);
const hasVanillaBundle = existsSync(VANILLA_BUNDLE);

async function canvasSize(
    page: Page,
): Promise<{ width: number; height: number }> {
    return page.evaluate(() => {
        const canvas = document.querySelector<HTMLCanvasElement>(
            '[data-testid="tooltip-canvas"]',
        );
        return { width: canvas?.width ?? 0, height: canvas?.height ?? 0 };
    });
}

async function canvasSignature(page: Page): Promise<string> {
    // A cheap content fingerprint: enough to detect that the drawn pixels changed without
    // asserting an exact image, which would make every legitimate metric fix a test failure.
    return page.evaluate(() => {
        const canvas = document.querySelector<HTMLCanvasElement>(
            '[data-testid="tooltip-canvas"]',
        );
        if (!canvas) return "none";
        const context = canvas.getContext("2d");
        if (!context) return "none";
        const data = context.getImageData(
            0,
            0,
            canvas.width,
            canvas.height,
        ).data;
        let hash = 2166136261;
        for (let index = 0; index < data.length; index += 17) {
            hash = Math.imul(hash ^ data[index]!, 16777619) >>> 0;
        }
        return `${canvas.width}x${canvas.height}:${hash.toString(16)}`;
    });
}

async function mountVanilla(page: Page): Promise<void> {
    await page.getByTestId("open-assets").click();
    await page.getByTestId("asset-file-input").setInputFiles(VANILLA_BUNDLE);
    await expect(page.getByTestId("pack-list")).toContainText(
        "vanilla-26.1.2.zip",
    );
    await page.getByTestId("mode-items").click();
}

async function simulateManagedPack(page: Page): Promise<void> {
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

test.beforeEach(async ({ page }) => {
    await mockPlugin(page);
    await page.addInitScript(() =>
        window.localStorage.setItem("itemerness.ui-language", '"en-US"'),
    );
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    await expect(page.getByTestId("item-tree")).toBeVisible();
});

test.describe("narrow workspace", () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test("stacks the editor around a usable preview", async ({ page }) => {
        const layout = await page.evaluate(() => {
            const documentBox = (selector: string) => {
                const element = document.querySelector<HTMLElement>(selector);
                if (!element) throw new Error(`Missing ${selector}`);
                const rect = element.getBoundingClientRect();
                return {
                    top: rect.top + window.scrollY,
                    right: rect.right + window.scrollX,
                    bottom: rect.bottom + window.scrollY,
                    left: rect.left + window.scrollX,
                    width: rect.width,
                    height: rect.height,
                    clientWidth: element.clientWidth,
                    scrollWidth: element.scrollWidth,
                };
            };

            return {
                sidebar: documentBox(".sidebar"),
                stage: documentBox(".stage"),
                canvasArea: documentBox(".stage-canvas-area"),
                inspector: documentBox(".inspector"),
                canvas: documentBox('[data-testid="tooltip-canvas"]'),
                pageWidth: document.documentElement.scrollWidth,
            };
        });

        expect(layout.stage.width).toBeGreaterThan(300);
        expect(layout.canvasArea.clientWidth).toBeGreaterThan(300);
        expect(layout.canvas.width).toBeGreaterThan(0);
        expect(layout.canvas.height).toBeGreaterThan(0);
        expect(layout.sidebar.bottom).toBeLessThanOrEqual(layout.stage.top + 1);
        expect(layout.stage.bottom).toBeLessThanOrEqual(
            layout.inspector.top + 1,
        );
        expect(layout.pageWidth).toBeLessThanOrEqual(390);

        // Pixel-accurate tooltips may be wider than a phone. They scroll inside the stage instead
        // of shrinking, overlapping the inspector, or widening the whole document.
        expect(layout.canvasArea.scrollWidth).toBeGreaterThanOrEqual(
            layout.canvasArea.clientWidth,
        );
    });
});

test("lists plugin-supplied items by localized name and previews the first one", async ({
    page,
}) => {
    const tree = page.getByTestId("item-tree");
    await expect(tree.getByRole("listitem")).toHaveCount(5);
    // Names, not namespaced ids: this is the difference between an editor and a schema browser.
    await expect(tree).toContainText("Ember Blade");
    await expect(tree).not.toContainText("itemerness:ember-blade");
    await expect(page.getByTestId("tooltip-canvas")).toBeVisible();
    const size = await canvasSize(page);
    expect(size.width).toBeGreaterThan(0);
    expect(size.height).toBeGreaterThan(0);
});

test("loads, autosaves, and previews the selected plugin document", async ({
    page,
}) => {
    const remoteDocument = structuredClone(baselineDocument);
    const firstItem = remoteDocument.items[0]!;
    const locale = remoteDocument.locales.find(
        (entry) => entry.locale === remoteDocument.defaultLocale,
    )!;
    locale.messages[firstItem.presentation.nameMessage] =
        "Loaded from the plugin";
    let persistedHash = contentHash(remoteDocument);
    let servedDocument = remoteDocument;
    let revision = 40;
    const saves: {
        document: ProjectDocument;
        expectedHash: string;
    }[] = [];
    const previews: PreviewRequest[] = [];

    await page.route("**/api/handshake", (route) =>
        route.fulfill({ json: HANDSHAKE }),
    );
    await page.route("**/api/v2/document", async (route) => {
        if (route.request().method() === "GET") {
            await route.fulfill({
                json: {
                    document: servedDocument,
                    snapshotHash: persistedHash,
                    revision,
                },
            });
            return;
        }
        const body = route.request().postDataJSON() as {
            document: ProjectDocument;
            expectedHash: string;
        };
        saves.push(body);
        expect(route.request().headers()["authorization"]).toBe(
            `Bearer ${TEST_TOKEN}`,
        );
        expect(route.request().headers()["x-itemerness-protocol"]).toBe("2.0");
        persistedHash = contentHash(body.document);
        servedDocument = body.document;
        revision += 1;
        await route.fulfill({
            json: { snapshotHash: persistedHash, revision, diagnostics: [] },
        });
    });
    await page.route("**/api/v2/preview", async (route) => {
        previews.push(route.request().postDataJSON() as PreviewRequest);
        await route.fulfill({
            status: 503,
            json: { code: "PREVIEW_UNAVAILABLE" },
        });
    });

    await connectPlugin(page, API_URL, TEST_TOKEN);
    await expect(page.getByTestId("preview-name")).toHaveText(
        "Loaded from the plugin",
    );
    await page.getByTestId("name-input").fill("Current unsaved keystroke");

    await expect(page.getByTestId("preview-name")).toHaveText(
        "Current unsaved keystroke",
    );
    await expect
        .poll(() =>
            previews.some((request) => {
                const requestLocale = request.document.locales.find(
                    (entry) => entry.locale === request.document.defaultLocale,
                );
                return (
                    requestLocale?.messages[
                        request.document.items[0]!.presentation.nameMessage
                    ] === "Current unsaved keystroke" &&
                    request.snapshotHash === contentHash(request.document)
                );
            }),
        )
        .toBe(true);
    await expect.poll(() => saves.length).toBe(1);
    expect(saves[0]?.expectedHash).toBe(contentHash(remoteDocument));
    await expect(page.getByTestId("document-sync-status")).toHaveAttribute(
        "data-sync-kind",
        "saved",
    );
});

test("renaming an item in the inspector updates the preview and the list", async ({
    page,
}) => {
    await page.getByTestId("item-travel-token").click();
    await expect(page.getByTestId("preview-name")).toHaveText(
        "Harbor Travel Token",
    );
    // The user types a name; the message key it lands in stays invisible plumbing.
    await page.getByTestId("name-input").fill("Golden Harbor Pass");
    await expect(page.getByTestId("preview-name")).toHaveText(
        "Golden Harbor Pass",
    );
    await expect(page.getByTestId("item-tree")).toContainText(
        "Golden Harbor Pass",
    );
});

test("adding a text row extends the tooltip", async ({ page }) => {
    await page.getByTestId("item-travel-token").click();
    await setZoom(page, 1);
    const sizeBefore = await canvasSize(page);
    await page.getByTestId("line-hit-name").click();
    await page.getByTestId("insert-after").click();
    await page.getByTestId("add-text-row").click();
    await expect(page.locator("[data-block]")).toHaveCount(1);
    // The new line is real content: the tooltip grows.
    await expect
        .poll(async () => (await canvasSize(page)).height)
        .toBeGreaterThan(sizeBefore.height);
});

test("editing a stat label inline redraws the tooltip", async ({ page }) => {
    await page.getByTestId("item-travel-token").click();
    const before = await canvasSignature(page);
    await page.getByTestId("line-hit-1").click();
    const label = page
        .getByTestId("block-list")
        .first()
        .locator("input")
        .first();
    await label.fill("Charges remaining until the token burns out");
    await expect.poll(async () => canvasSignature(page)).not.toBe(before);
});

test("labels an unverified preview honestly and never claims exact structure", async ({
    page,
}) => {
    await expect(page.getByTestId("tooltip-canvas")).toHaveAttribute(
        "data-preview-origin",
        "local",
    );
    await page.getByTestId("fidelity-toggle").click();
    await expect(page.getByTestId("fidelity-content")).toContainText(
        "Metric faithful",
    );
    // Screen positioning is decided by the player's client and is never claimed at any other level.
    await expect(page.getByTestId("fidelity-positioning")).toContainText(
        "Client only",
    );
    await expect(page.getByTestId("fidelity-overall")).toHaveText(
        "Client only",
    );
    await expect(
        page.getByTestId("fidelity-vanilla-extra-lines"),
    ).toContainText("The client adds its own enchantment and attribute lines");

    await page.getByTestId("open-persona").click();
    await page.getByTestId("managed-vanilla-lines-simulation").check();
    await page.getByTestId("open-persona").click();
    await page.getByTestId("fidelity-toggle").click();
    await expect(
        page.getByTestId("fidelity-vanilla-extra-lines"),
    ).toContainText("The theme claims every tooltip line");
});

test("switching the preview language redraws the tooltip", async ({ page }) => {
    await page.getByTestId("item-ember-blade").click();
    const english = await canvasSignature(page);
    await page.getByTestId("locale-chip-zh_cn").click();
    await expect
        .poll(async () => canvasSignature(page), {
            message: "tooltip should redraw for zh_cn",
        })
        .not.toBe(english);
    // The inspector follows: name editing now targets the previewed language.
    await expect(page.getByTestId("name-input")).toHaveValue("余烬之刃");
});

test("switching the interface language leaves the previewed content alone", async ({
    page,
}) => {
    await page.getByTestId("item-ember-blade").click();
    const before = await canvasSignature(page);
    await page.getByTestId("ui-language").click();
    await page.getByTestId("ui-language-zh-CN").click();
    await expect(page.getByTestId("add-item")).toContainText("新建物品");
    // Interface language and previewed content language are separate axes; changing one must not
    // move the other.
    expect(await canvasSignature(page)).toBe(before);
});

test("choosing a theme card edits the item, and fallbacks are explained", async ({
    page,
}) => {
    await page.getByTestId("item-survey-codex").click();
    // aurora-canvas needs a resource pack the viewer does not have, so the item falls back and
    // the inspector says why instead of silently drawing something else.
    await expect(page.getByTestId("fallback-reasons")).toContainText(
        "RESOURCE_PACK_UNAVAILABLE",
    );
    await expect(page.getByTestId("selected-theme")).toContainText(
        "itemerness:vanilla-frame",
    );

    const before = await canvasSignature(page);
    await page.getByTestId("theme-card-default").click();
    await expect.poll(async () => canvasSignature(page)).not.toBe(before);
    await expect(page.getByTestId("selected-theme")).toContainText(
        "itemerness:default",
    );
});

test("percentage zoom changes the rendered pixel grid", async ({ page }) => {
    await setZoom(page, 2);
    const small = await canvasSize(page);
    await setZoom(page, 6);
    await expect
        .poll(async () => (await canvasSize(page)).width)
        .toBeGreaterThan(small.width);
});

test("the geometry overlay is off by default and can be turned on", async ({
    page,
}) => {
    const plain = await canvasSignature(page);
    await page.getByTestId("annotations-toggle").check();
    await expect.poll(async () => canvasSignature(page)).not.toBe(plain);
});

test("side-by-side language comparison renders two tooltips", async ({
    page,
}) => {
    await page.getByTestId("compare-toggle").click();
    await expect(page.getByTestId("comparison-figure")).toBeVisible();
    await expect(page.getByTestId("tooltip-canvas")).toHaveCount(2);
});

test("the translation matrix still edits the same document", async ({
    page,
}) => {
    await page.getByTestId("item-travel-token").click();
    await page.getByTestId("open-translations").click();
    await page
        .getByTestId("message-en_us-item.travel-token.name")
        .fill("Harbor Travel Token Extended Edition");
    await page.getByTestId("mode-items").click();
    await expect(page.getByTestId("preview-name")).toHaveText(
        "Harbor Travel Token Extended Edition",
    );
});

test("an unmounted preview draws faithful geometry rather than fake glyphs", async ({
    page,
}) => {
    // With no resource pack the engine has advances but no pixels, so it blocks out each glyph's
    // ink bounds. The badge has to admit that, otherwise the blocks would read as real text.
    await page.getByTestId("fidelity-toggle").click();
    await expect(page.getByTestId("fidelity-glyph-raster")).toContainText(
        "Client only",
    );
    await expect(page.getByTestId("fidelity-metrics")).toContainText(
        "Metric faithful",
    );
});

test("diagnostics render from message keys, not server prose", async ({
    page,
}) => {
    const document = structuredClone(baselineDocument);
    document.items[0]!.presentation.nameMessage = "item.missing-name";
    await mockPlugin(page, document);
    await page.reload();
    await enterWorkspace(page);
    await page.getByTestId("open-diagnostics-chip").click();
    await expect(
        page.getByRole("heading", { name: "Diagnostics" }),
    ).toBeVisible();
    await expect(page.getByTestId("diagnostics-list")).toContainText(
        '"item.missing-name" is not translated in any language.',
    );
    await expect(page.getByTestId("diagnostics-list")).not.toContainText(
        "diagnostics.locale.missing_message",
    );
    await page.getByTestId("back-to-editor").click();
    await page.getByTestId("ui-language").click();
    await page.getByTestId("ui-language-zh-CN").click();
    await page.getByTestId("open-diagnostics-chip").click();
    await expect(page.getByRole("heading", { name: "诊断" })).toBeVisible();
    await expect(page.getByTestId("diagnostics-list")).toContainText(
        "“item.missing-name”在任何语言中都没有翻译。",
    );
});

test("fetches pinned vanilla assets directly when explicitly enabled", async ({
    page,
}) => {
    test.skip(
        process.env.E2E_ASSET_NETWORK !== "1",
        "live Mojang downloads are opt-in",
    );
    test.setTimeout(180_000);

    await page.getByTestId("open-assets").click();
    await expect(page.getByTestId("assets-empty")).toBeVisible();
    await page.getByTestId("fetch-vanilla").click();
    await expect(page.getByTestId("pack-list")).toContainText(
        "vanilla-26.1.2",
        { timeout: 120_000 },
    );

    await page.getByTestId("run-self-check").click();
    const results = page.getByTestId("self-check-results");
    await expect(results).toBeVisible({ timeout: 30_000 });
    await expect(results.locator("tr.fail")).toHaveCount(0);
});

test("shows a server-verified preview when a target server is connected", async ({
    page,
}, testInfo) => {
    test.skip(
        !process.env.E2E_PLUGIN_URL,
        "requires an authorized craftr runtime API",
    );
    await page.unrouteAll();
    await connectPlugin(
        page,
        process.env.E2E_PLUGIN_URL!,
        process.env.E2E_PLUGIN_TOKEN ?? "",
    );
    await expect(page.getByTestId("connection-status")).toHaveText("Connected");

    await page.getByTestId("item-ember-blade").click();
    // The badge flips only when a real target compiled this exact draft snapshot. A mock result or
    // a stale snapshot must keep it at draft, which is the whole point of the distinction.
    await expect(page.getByTestId("tooltip-canvas")).toHaveAttribute(
        "data-preview-origin",
        "agent",
        { timeout: 30_000 },
    );
    await page.getByTestId("fidelity-toggle").click();
    await expect(page.getByTestId("fidelity-content")).toContainText(
        "Exact structure",
    );
    // Positioning is still the client's decision, no matter who compiled the tooltip.
    await expect(page.getByTestId("fidelity-positioning")).toContainText(
        "Client only",
    );
    await expect(page.getByTestId("preview-name")).toHaveText("Ember Blade");
    await page.getByTestId("fidelity-toggle").click();
    if (hasVanillaBundle) {
        const before = await canvasSignature(page);
        await mountVanilla(page);
        await expect.poll(() => canvasSignature(page)).not.toBe(before);
    }
    const warmPixels = new Map<string, string>();
    for (const item of ["travel-token", "ember-blade", "survey-codex"]) {
        await page.getByTestId(`item-${item}`).click();
        await expect(page.getByTestId("tooltip-canvas")).toHaveAttribute(
            "data-preview-origin",
            "agent",
        );
        warmPixels.set(
            item,
            await page
                .getByTestId("tooltip-canvas")
                .evaluate((canvas) =>
                    (canvas as HTMLCanvasElement).toDataURL(),
                ),
        );
    }
    const switchTimings = [];
    for (const item of [
        "travel-token",
        "ember-blade",
        "survey-codex",
        "ember-blade",
    ]) {
        const measured = await page.evaluate((item) => {
            const start = performance.now();
            const button = document.querySelector<HTMLButtonElement>(
                `[data-testid="item-${item}"]`,
            )!;
            const expectedName =
                button.querySelector(".item-row-name")!.textContent;
            button.click();
            return new Promise<{
                elapsed: number;
                name: string | null;
                expectedName: string | null;
                origin: string | null;
                bitmap: string;
            }>((resolve) =>
                requestAnimationFrame(() =>
                    resolve({
                        elapsed: performance.now() - start,
                        expectedName,
                        name: document.querySelector(
                            '[data-testid="preview-name"]',
                        )!.textContent,
                        origin: document
                            .querySelector('[data-testid="tooltip-canvas"]')!
                            .getAttribute("data-preview-origin"),
                        bitmap: document
                            .querySelector<HTMLCanvasElement>(
                                '[data-testid="tooltip-canvas"]',
                            )!
                            .toDataURL(),
                    }),
                ),
            );
        }, item);
        expect(measured.name).toBe(measured.expectedName);
        expect(measured.origin).toBe("agent");
        expect(measured.elapsed).toBeLessThan(200);
        expect(measured.bitmap).toBe(warmPixels.get(item));
        const { bitmap: _bitmap, ...timing } = measured;
        switchTimings.push({ item, ...timing });
    }
    mkdirSync(testInfo.outputPath(), { recursive: true });
    writeFileSync(
        testInfo.outputPath("live-preview-switches.json"),
        JSON.stringify(switchTimings, null, 2),
    );
    await testInfo.attach("live-preview-switches", {
        body: JSON.stringify(switchTimings),
        contentType: "application/json",
    });
    for (const viewport of [
        { width: 1440, height: 960 },
        { width: 390, height: 844 },
    ]) {
        await page.setViewportSize(viewport);
        if (viewport.width < 900) await setZoom(page, 1);
        await expect(page.getByTestId("tooltip-canvas")).toHaveAttribute(
            "data-preview-origin",
            "agent",
        );
        expect((await canvasSize(page)).width).toBeGreaterThan(0);
        expect(
            await page.evaluate(
                () => document.documentElement.scrollWidth <= innerWidth,
            ),
        ).toBe(true);
        await page.screenshot({
            path: testInfo.outputPath(`direct-plugin-${viewport.width}.png`),
            fullPage: true,
        });
    }
});

test("focused content commands reorder the tooltip content", async ({
    page,
}) => {
    await page.getByTestId("item-travel-token").click();
    await page.getByTestId("line-hit-1").click();
    const before = await canvasSignature(page);
    await expect(page.getByTestId("content-move-up")).toBeDisabled();
    await page.getByTestId("content-move-down").click();
    await expect(page.getByTestId("content-move-up")).toBeEnabled();
    await expect.poll(async () => canvasSignature(page)).not.toBe(before);
});

test("theme colors edit with a color well and repaint instantly", async ({
    page,
}) => {
    await page.getByTestId("mode-themes").click();
    await page.getByTestId("theme-default").click();
    const before = await canvasSignature(page);
    // The library previews the currently selected item in the chosen theme, so recolouring the
    // name role must repaint the stage at once.
    await setColor(page, "color-item-name", "#ff3366");
    await expect.poll(async () => canvasSignature(page)).not.toBe(before);
});

test("posing the previewed player flips a conditional row", async ({
    page,
}) => {
    await page.getByTestId("item-ember-blade").click();
    const before = await canvasSignature(page);
    await page.getByTestId("open-persona").click();
    // ember-blade requires level 12 and the persona starts at 8, so raising it past the
    // requirement recolours the requirement line.
    await page.getByTestId("fact-example-level").fill("15");
    await expect.poll(async () => canvasSignature(page)).not.toBe(before);
});

test("layout sliders re-wrap real content", async ({ page }) => {
    await page.getByTestId("item-ember-blade").click();
    await page.getByTestId("theme-card-default").click();
    await page.getByTestId("mode-layouts").click();
    await page.getByTestId("layout-equipment").click();
    // The stage previews an item that uses this layout.
    await expect(page.getByTestId("preview-name")).toHaveText("Ember Blade");
    const before = await canvasSize(page);
    // Narrowing the maximum width forces the description to wrap onto more lines: the slider is
    // editing real geometry, not a detached number.
    await page.getByTestId("layout-max-width").fill("120");
    await expect
        .poll(async () => (await canvasSize(page)).height)
        .toBeGreaterThan(before.height);
});

test("renaming a data key relabels every row that uses it", async ({
    page,
}) => {
    await page.getByTestId("mode-data").click();
    await page.getByTestId("datakey-charges").click();
    await page.getByTestId("data-label-input").fill("Uses left");
    await page.getByTestId("mode-items").click();
    await page.getByTestId("item-travel-token").click();
    // The travel token's second stat row uses example:charges; its inline label now reads the new text.
    await selectContent(
        page,
        baselineDocument.items[0]!.presentation.blocks[1]!.uuid,
    );
    await expect(
        page.getByTestId("block-list").locator("input").first(),
    ).toHaveValue("Uses left");
});

test("clicking a tooltip line selects its block in the inspector", async ({
    page,
}) => {
    await page.getByTestId("item-travel-token").click();
    // The synthetic top border has no editing target; the first content line follows it.
    await page.getByTestId("line-hit-1").click();
    const selected = page.locator('[data-block][data-selected="true"]');
    await expect(selected).toHaveCount(1);
    await expect(selected.locator("input").first()).toHaveValue("Region");
});

test("double-clicking a line edits the text in place", async ({ page }) => {
    await page.getByTestId("item-travel-token").click();
    await page.getByTestId("line-hit-name").dblclick();
    const editor = page.getByTestId("inline-editor");
    await expect(editor).toBeVisible();
    await editor.fill("Weathered Harbor Pass");
    await editor.press("Enter");
    // The in-place edit is a real message write: preview caption, sidebar, and inspector agree.
    await expect(page.getByTestId("preview-name")).toHaveText(
        "Weathered Harbor Pass",
    );
    await expect(page.getByTestId("item-tree")).toContainText(
        "Weathered Harbor Pass",
    );
});

test("dragging a canvas anchor repositions content on the canvas itself", async ({
    page,
}) => {
    // Pack acceptance, asset profile, and managed vanilla lines are independent viewer facts.
    await simulateManagedPack(page);
    await page.getByTestId("item-survey-codex").click();
    await expect(page.getByTestId("selected-theme")).toContainText(
        "itemerness:aurora-canvas",
    );

    const box = page.getByTestId("anchor-box-region");
    await expect(box).toBeVisible();
    const bounds = (await box.boundingBox())!;
    const before = await canvasSignature(page);
    // Drag the region anchor two tooltip lines down; the composer snaps y to the line grid, so
    // the text lands exactly where the box was dropped.
    await page.mouse.move(
        bounds.x + bounds.width / 2,
        bounds.y + bounds.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
        bounds.x + bounds.width / 2,
        bounds.y + bounds.height / 2 + 60,
        { steps: 6 },
    );
    await page.mouse.up();
    await expect.poll(async () => canvasSignature(page)).not.toBe(before);
});

test.describe("with vanilla assets mounted", () => {
    test.skip(
        !hasVanillaBundle,
        "run packages/mc-assets/scripts/fetch-vanilla-assets.mjs first",
    );

    test("mounting supplies measured pixels and passes the metrics self-check", async ({
        page,
    }) => {
        await page.getByTestId("open-assets").click();
        await expect(page.getByTestId("assets-empty")).toBeVisible();
        await page
            .getByTestId("asset-file-input")
            .setInputFiles(VANILLA_BUNDLE);
        await expect(page.getByTestId("pack-list")).toContainText(
            "vanilla-26.1.2.zip",
        );

        await page.getByTestId("run-self-check").click();
        const results = page.getByTestId("self-check-results");
        await expect(results).toBeVisible({ timeout: 30_000 });
        // The browser font engine and the artifact generated from the real client jar must agree
        // for every code point; anything else means the preview is lying about widths.
        await expect(results.locator("tr.fail")).toHaveCount(0);
        await expect(results).toContainText("minecraft:default");
        await expect(results).toContainText("minecraft:uniform");
        await page.getByTestId("mode-items").click();

        await page.getByTestId("fidelity-toggle").click();
        await expect(page.getByTestId("fidelity-glyph-raster")).toContainText(
            "Approximate raster",
        );
        await expect(page.getByTestId("fidelity-glyph-raster")).toContainText(
            "Drawn from the mounted glyph textures.",
        );
        await expect(page.getByTestId("fidelity-metrics")).toContainText(
            "Metric faithful",
        );
    });

    test("a bitmap canvas theme anchors its own tooltip width", async ({
        page,
    }) => {
        await mountVanilla(page);
        await simulateManagedPack(page);
        await page.getByTestId("item-survey-codex").click();
        await expect(page.getByTestId("selected-theme")).toContainText(
            "itemerness:aurora-canvas",
        );
        // 176 content pixels + 3 padding + 9 sprite margin on each edge. The invisible width
        // anchor still controls content width, independently of the sprite's decorative margin.
        await expect(page.getByTestId("tooltip-canvas")).toHaveAttribute(
            "data-logical-width",
            "200",
        );
    });

    test("renderer golden screenshot", async ({ page }) => {
        // The golden proves the browser renderer stayed stable, so the compile endpoint is blocked
        // for this test: otherwise the pixels would depend on whether a server happens to be
        // paired with the deployment under test.
        await page.route("**/api/v2/preview", (route) => route.abort());
        await mountVanilla(page);
        await simulateManagedPack(page);
        await page.getByTestId("item-ember-blade").click();
        await setZoom(page, 4);
        await expect(page.getByTestId("tooltip-canvas")).toBeVisible();
        await expect(page.getByTestId("tooltip-canvas")).toHaveAttribute(
            "data-preview-origin",
            "local",
        );
        // This golden proves this renderer stayed stable. It is not evidence about the Minecraft
        // client: only a real client screenshot can speak to that, and this project takes those on
        // the craftr runtime matrix rather than pretending a browser canvas substitutes for one.
        // Compare the actual canvas pixels, not a clipped element screenshot that can include
        // adjacent panes when the tooltip is wider than the workspace.
        const png = await page
            .getByTestId("tooltip-canvas")
            .evaluate(
                (canvas) =>
                    (canvas as HTMLCanvasElement)
                        .toDataURL("image/png")
                        .split(",")[1]!,
            );
        expect(Buffer.from(png, "base64")).toMatchSnapshot(
            "ember-blade-mounted.png",
            {
                maxDiffPixelRatio: 0.01,
            },
        );
    });
});
