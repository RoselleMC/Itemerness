import { expect, test, type Page } from "@playwright/test";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import { contentHash } from "@itemerness/protocol";
import {
    API_URL,
    chooseValue,
    enterWorkspace,
    mockPlugin,
} from "./fixtures/plugin.js";

async function enterThemes(page: Page, id: string) {
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    await page.getByTestId("mode-themes").click();
    await page.getByTestId(`theme-${id}`).click();
}

test("cold character-frame edits preserve input drafts, paint locally and serialize saves", async ({
    page,
}) => {
    const plugin = await mockPlugin(page);
    await page.route(`${API_URL}/api/v2/preview`, (route) =>
        route.abort("blockedbyclient"),
    );
    await enterThemes(page, "vanilla-frame");
    const source = baselineDocument.themes.find(
        (theme) => theme.id === "itemerness:vanilla-frame",
    )!;
    const field = page.getByTestId("theme-leftPaddingPixels");
    const before = await page
        .getByTestId("tooltip-canvas")
        .evaluate((canvas) => (canvas as HTMLCanvasElement).toDataURL());
    await field.fill("-");
    expect(plugin.writes).toHaveLength(0);
    await field.press("Escape");
    await expect(field).toHaveValue(
        String(source.characterFrame!.leftPaddingPixels),
    );
    await field.fill("9");
    await field.press("Enter");
    await expect
        .poll(
            () =>
                plugin.writes
                    .at(-1)
                    ?.document.themes.find(
                        (theme) => theme.uuid === source.uuid,
                    )?.characterFrame?.leftPaddingPixels,
        )
        .toBe(9);
    await expect
        .poll(() =>
            page
                .getByTestId("tooltip-canvas")
                .evaluate((canvas) =>
                    (canvas as HTMLCanvasElement).toDataURL(),
                ),
        )
        .not.toBe(before);
    await page.getByTestId("undo").click();
    await expect
        .poll(
            () =>
                plugin.writes
                    .at(-1)
                    ?.document.themes.find(
                        (theme) => theme.uuid === source.uuid,
                    )?.characterFrame?.leftPaddingPixels,
        )
        .toBe(source.characterFrame!.leftPaddingPixels);
    await page.getByTestId("mode-items").click();
    await expect(
        page.getByTestId("item-status-travel-token"),
    ).not.toHaveAttribute("data-state", "verified");
    let hash = contentHash(baselineDocument);
    for (const write of plugin.writes) {
        expect(write.expectedHash).toBe(hash);
        hash = contentHash(write.document);
    }
});

test("renderer transitions retain native geometry and expose only current settings", async ({
    page,
}) => {
    const plugin = await mockPlugin(page);
    await enterThemes(page, "ember");
    const original = baselineDocument.themes.find(
        (theme) => theme.id === "itemerness:ember",
    )!;
    await chooseValue(page, page.getByTestId("theme-renderer"), "PLAIN");
    await expect(
        page.getByTestId("theme-content-leftPaddingPixels"),
    ).toHaveCount(0);
    await expect
        .poll(
            () =>
                plugin.writes
                    .at(-1)
                    ?.document.themes.find(
                        (theme) => theme.uuid === original.uuid,
                    )?.renderer,
        )
        .toBe("PLAIN");
    const plain = plugin.writes
        .at(-1)!
        .document.themes.find((theme) => theme.uuid === original.uuid)!;
    expect(plain.fallback).toBeNull();
    expect(plain.tooltipStyle).toBeNull();
    expect(plain.content).toBeNull();
    expect(plain.extensions?.editorRendererState).toMatchObject({
        fallback: original.fallback,
        tooltipStyle: original.tooltipStyle,
        content: original.content,
    });
    await chooseValue(
        page,
        page.getByTestId("theme-renderer"),
        "NATIVE_TOOLTIP_STYLE",
    );
    await expect(page.getByTestId("theme-tooltip-style")).toHaveAttribute(
        "data-field-value",
        original.tooltipStyle!,
    );
    await chooseValue(
        page,
        page.getByTestId("theme-renderer"),
        "VANILLA_CHARACTER_FRAME",
    );
    await expect(page.getByTestId("theme-initialize-geometry")).toBeVisible();
    await expect(page.getByTestId("theme-tooltip-style")).toHaveCount(0);
    await page.getByTestId("theme-initialize-geometry").click();
    await expect(page.getByTestId("frame-preset")).toBeVisible();
    await chooseValue(page, page.getByTestId("frame-preset"), "UNICODE_DOUBLE");
    await chooseValue(
        page,
        page.getByTestId("theme-renderer"),
        "NATIVE_TOOLTIP_STYLE",
    );
    await expect(page.getByTestId("frame-preset")).toHaveCount(0);
    await expect(page.getByTestId("theme-tooltip-style")).toHaveAttribute(
        "data-field-value",
        original.tooltipStyle!,
    );
    await expect
        .poll(() => {
            const theme = plugin.writes
                .at(-1)
                ?.document.themes.find((entry) => entry.uuid === original.uuid);
            return {
                renderer: theme?.renderer,
                preset: theme?.characterFrame?.preset,
            };
        })
        .toEqual({
            renderer: "NATIVE_TOOLTIP_STYLE",
            preset: "UNICODE_DOUBLE",
        });
    const saved = plugin.writes
        .at(-1)!
        .document.themes.find((theme) => theme.uuid === original.uuid)!;
    expect(saved.content).toEqual(original.content);
    expect(saved.characterFrame?.preset).toBe("UNICODE_DOUBLE");
    expect(saved.fallback).toBe(original.fallback);
    expect(saved.requiresResourcePack).toBe(true);
    await page.getByTestId("undo").click();
    await expect(page.getByTestId("frame-preset")).toHaveAttribute(
        "data-field-value",
        "UNICODE_DOUBLE",
    );
});

test("theme roles and segmented rows are editable without native form popups", async ({
    page,
}, info) => {
    const plugin = await mockPlugin(page);
    await enterThemes(page, "segmented");
    const source = baselineDocument.themes.find(
        (theme) => theme.id === "itemerness:segmented",
    )!;
    await chooseValue(
        page,
        page.getByTestId("theme-frame-top-left"),
        "frame.segment.bottom-left",
    );
    await page.getByTestId("theme-connector").uncheck();
    await expect(page.getByTestId("theme-frame-connector-left")).toHaveCount(0);
    await page.getByTestId("theme-connector").check();
    await expect(page.getByTestId("theme-frame-connector-left")).toBeVisible();
    await page.getByTestId("theme-add-font-role-input").fill("custom-font");
    await page.getByTestId("theme-add-font-role").click();
    await page.getByTestId("theme-add-style-role-input").fill("custom-style");
    await page.getByTestId("theme-add-style-role").click();
    for (const style of ["bold", "italic", "underlined", "strikethrough"])
        await page.getByTestId(`theme-style-custom-style-${style}`).click();
    await expect
        .poll(
            () =>
                plugin.writes
                    .at(-1)
                    ?.document.themes.find(
                        (theme) => theme.uuid === source.uuid,
                    )?.styles["custom-style"]?.strikethrough,
        )
        .toBe(true);
    const saved = plugin.writes
        .at(-1)!
        .document.themes.find((theme) => theme.uuid === source.uuid)!;
    expect(saved.styles["custom-style"]).toEqual({
        color: null,
        bold: true,
        italic: true,
        underlined: true,
        strikethrough: true,
    });
    expect(saved.fonts["custom-font"]).toBe(baselineDocument.fonts[0]!.id);
    expect(saved.segmentedFrame?.top.left).toBe("frame.segment.bottom-left");
    expect(saved.segmentedFrame?.connector).toEqual(saved.segmentedFrame?.body);
    await page.setViewportSize({ width: 900, height: 800 });
    await page
        .getByTestId("theme-style-custom-style-underlined")
        .scrollIntoViewIfNeeded();
    expect(
        await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
        ),
    ).toBe(true);
    await page.screenshot({
        path: info.outputPath("theme-roles-900.png"),
        fullPage: true,
    });
    await page
        .getByRole("button", {
            name: "Remove style role custom-style",
            exact: true,
        })
        .click();
    await expect(
        page.getByTestId("theme-style-custom-style-underlined"),
    ).toHaveCount(0);
    await page.getByTestId("undo").click();
    await expect(
        page.getByTestId("theme-style-custom-style-underlined"),
    ).toHaveAttribute("aria-pressed", "true");
});

test("bitmap canvas edits signed offsets, baselines, widths, layer lifecycle and safety", async ({
    page,
}, info) => {
    const plugin = await mockPlugin(page);
    await enterThemes(page, "aurora-canvas");
    const source = baselineDocument.themes.find(
        (theme) => theme.id === "itemerness:aurora-canvas",
    )!;
    await expect(page.getByTestId("theme-tooltip-style")).toBeVisible();
    await chooseValue(
        page,
        page.getByTestId("theme-tooltip-style"),
        baselineDocument.tooltipStyles[0]!.id,
    );
    await page.getByTestId("theme-rejectOutOfBoundsLayer").uncheck();
    await page.getByTestId("theme-layer-0-xPixels").fill("-");
    await page.getByTestId("theme-layer-0-xPixels").fill("-8");
    await page.getByTestId("theme-layer-0-xPixels").press("Enter");
    await page.getByTestId("theme-measuredAdvancePixels").fill("210");
    await page.getByTestId("theme-measuredAdvancePixels").press("Enter");
    await expect(page.getByTestId("theme-finalTooltipWidthPixels")).toHaveValue(
        "210",
    );
    await page.getByTestId("theme-add-layer").click();
    const added = source.canvas!.layers.length;
    await expect(page.getByTestId(`theme-layer-${added}-asset`)).toBeVisible();
    await chooseValue(
        page,
        page.getByTestId(`theme-layer-${added}-anchor`),
        "TOP_RIGHT",
    );
    await expect
        .poll(
            () =>
                plugin.writes
                    .at(-1)
                    ?.document.themes.find(
                        (theme) => theme.uuid === source.uuid,
                    )?.canvas?.layers.length,
        )
        .toBe(added + 1);
    const saved = plugin.writes
        .at(-1)!
        .document.themes.find((theme) => theme.uuid === source.uuid)!.canvas!;
    expect(saved.layers[0]!.xPixels).toBe(-8);
    expect(saved.measuredAdvancePixels).toBe(210);
    expect(saved.finalTooltipWidthPixels).toBe(210);
    expect(saved.rejectOutOfBoundsLayer).toBe(false);
    expect(saved.layers[added]!.anchor).toBe("TOP_RIGHT");
    expect(
        plugin.writes
            .at(-1)!
            .document.themes.find((theme) => theme.uuid === source.uuid)!
            .tooltipStyle,
    ).toBe(baselineDocument.tooltipStyles[0]!.id);
    for (const width of [900, 390]) {
        await page.setViewportSize({ width, height: 844 });
        await page
            .getByTestId(`theme-layer-${added}-anchor`)
            .scrollIntoViewIfNeeded();
        expect(
            await page.evaluate(
                () => document.documentElement.scrollWidth <= innerWidth,
            ),
        ).toBe(true);
        await page.screenshot({
            path: info.outputPath(`canvas-theme-${width}.png`),
            fullPage: width !== 390,
        });
    }
    await page.getByTestId(`theme-remove-layer-${added}`).click();
    await expect(page.getByTestId(`theme-layer-${added}-asset`)).toHaveCount(0);
});

test("content and exact metrics have YAML-supported active modes and retained transitions", async ({
    page,
}) => {
    const plugin = await mockPlugin(page);
    await enterThemes(page, "ember");
    const field = page.getByTestId("theme-content-leftPaddingPixels");
    await field.fill("7");
    await field.press("Enter");
    for (const renderer of [
        "PLAIN",
        "VANILLA_CHARACTER_FRAME",
        "SEGMENTED_FRAME",
        "BITMAP_CANVAS",
    ]) {
        await chooseValue(page, page.getByTestId("theme-renderer"), renderer);
        await expect(field).toHaveCount(0);
        await expect(
            page.getByTestId("theme-requireExactFontMetrics"),
        ).toHaveCount(renderer === "BITMAP_CANVAS" ? 1 : 0);
        await expect
            .poll(
                () =>
                    plugin.writes
                        .at(-1)
                        ?.document.themes.find(
                            (theme) => theme.id === "itemerness:ember",
                        )?.content,
            )
            .toBeNull();
    }
    await chooseValue(
        page,
        page.getByTestId("theme-renderer"),
        "NATIVE_TOOLTIP_STYLE",
    );
    await expect(field).toHaveValue("7");
});

test("legacy renderer-only values remain visible until explicit reversible normalization", async ({
    page,
}) => {
    const initial = structuredClone(baselineDocument);
    const source = initial.themes.find(
        (theme) => theme.renderer === "VANILLA_CHARACTER_FRAME",
    )!;
    source.content = structuredClone(
        initial.themes.find((theme) => theme.content)!.content,
    );
    source.requireExactFontMetrics = true;
    source.characterFrame!.fallbackBidirectionalText = false;
    const plugin = await mockPlugin(page, initial);
    await enterThemes(page, "vanilla-frame");
    await expect(page.getByTestId("theme-incompatible-settings")).toBeVisible();
    expect(plugin.writes).toHaveLength(0);
    await page.getByTestId("theme-normalize-settings").click();
    await page.keyboard.press("ControlOrMeta+s");
    await expect
        .poll(
            () =>
                plugin.writes
                    .at(-1)
                    ?.document.themes.find(
                        (theme) => theme.uuid === source.uuid,
                    )?.content,
        )
        .toBeNull();
    const normalized = plugin.writes
        .at(-1)!
        .document.themes.find((theme) => theme.uuid === source.uuid)!;
    expect(normalized.requireExactFontMetrics).toBe(false);
    expect(normalized.characterFrame?.fallbackBidirectionalText).toBe(true);
    expect(normalized.extensions?.editorRendererState).toMatchObject({
        content: source.content,
        requireExactFontMetrics: true,
        characterFallbackBidirectionalText: false,
    });
    await expect(page.getByTestId("theme-incompatible-settings")).toHaveCount(
        0,
    );
    await page.getByTestId("undo").click();
    await expect(page.getByTestId("theme-incompatible-settings")).toBeVisible();
});
