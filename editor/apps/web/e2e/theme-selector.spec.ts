import { expect, test, type Page } from "@playwright/test";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import type { ProjectDocument, ThemeSelectorNode } from "@itemerness/protocol";
import {
    API_URL,
    chooseValue,
    enterWorkspace,
    mockPlugin,
    selectContent,
} from "./fixtures/plugin.js";

const SELECTOR_ID = `${baselineDocument.namespace}:charge-frame`;
const chargesBlock = baselineDocument.items[0]!.presentation.blocks.find(
    (block) => block.type === "field" && block.data === "example:charges",
)!;

const selectorOf = (document: ProjectDocument | undefined) =>
    document?.themeSelectors?.find((entry) => entry.id === SELECTOR_ID);

async function coldWorkspace(page: Page, document = baselineDocument) {
    const plugin = await mockPlugin(page, document);
    // Every server preview reply is blocked, so the canvas must paint the local draft alone.
    await page.route(`${API_URL}/api/v2/preview`, (route) =>
        route.abort("blockedbyclient"),
    );
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    return plugin;
}

test("a theme selector is authored, bound to an item and switches local frames from preview data", async ({
    page,
}, info) => {
    const plugin = await coldWorkspace(page);
    await page.getByTestId("mode-themes").click();
    await page.getByTestId("add-theme-menu").click();
    await page.getByTestId("menu-add-theme-selector").click();
    const inspector = page.getByTestId("theme-selector-inspector");
    await expect(inspector).toBeVisible();
    await expect(page.getByTestId("theme-selector-id")).toHaveValue(
        `${baselineDocument.namespace}:new-theme-selector`,
    );
    await page.getByTestId("theme-selector-id").fill(SELECTOR_ID);
    await page.getByTestId("theme-selector-id").press("Enter");
    await expect(page.getByTestId("theme-selector-charge-frame")).toHaveClass(
        /selected/,
    );
    await chooseValue(
        page,
        page.getByTestId("theme-selector-default"),
        "itemerness:vanilla-frame",
    );
    await expect(page.getByTestId("theme-selector-empty")).toBeVisible();
    await page.getByTestId("theme-selector-add-case").click();
    const prefix = "theme-selector-case-0-condition";
    await chooseValue(
        page,
        page.getByTestId(`${prefix}-left-reference`),
        "data:example:charges",
    );
    await chooseValue(
        page,
        page.getByTestId(`${prefix}-operator`),
        "GREATER_THAN_OR_EQUAL",
    );
    const right = page.getByTestId(`${prefix}-right-literal-input`);
    await right.fill("3");
    await right.press("Enter");
    await chooseValue(
        page,
        page.getByTestId("theme-selector-case-0-theme"),
        "itemerness:default",
    );
    await expect
        .poll(() => selectorOf(plugin.writes.at(-1)?.document))
        .toMatchObject({
            id: SELECTOR_ID,
            defaultTheme: "itemerness:vanilla-frame",
            cases: [
                {
                    condition: {
                        operator: "GREATER_THAN_OR_EQUAL",
                        left: { kind: "data", key: "example:charges" },
                        right: {
                            kind: "literal",
                            value: { kind: "integer", value: "3" },
                        },
                    },
                    theme: "itemerness:default",
                },
            ],
        });
    await page.screenshot({ path: info.outputPath("selector-inspector.png") });

    await page.getByTestId("mode-items").click();
    await page.getByTestId("item-travel-token").click();
    await page.getByTestId("theme-selector-card-charge-frame").click();
    await expect
        .poll(() => plugin.writes.at(-1)?.document.items[0]?.presentation.theme)
        .toBe(SELECTOR_ID);
    const canvas = page.getByTestId("tooltip-canvas").first();
    // The fixture previews three charges, which satisfies the first case.
    await expect(canvas).toHaveAttribute("data-preview-origin", "local");
    await expect(canvas).toHaveAttribute("data-theme", "itemerness:default");
    await expect(canvas).toHaveAttribute("data-renderer", "PLAIN");
    await expect(canvas).toHaveAttribute("data-frame-runs", "0");

    await selectContent(page, chargesBlock.uuid);
    const sample = page.getByTestId(`sample-${chargesBlock.uuid}-input`);
    await sample.fill("2");
    await sample.press("Enter");
    await expect(canvas).toHaveAttribute(
        "data-theme",
        "itemerness:vanilla-frame",
    );
    await expect(canvas).toHaveAttribute(
        "data-renderer",
        "VANILLA_CHARACTER_FRAME",
    );
    await expect(canvas).not.toHaveAttribute("data-frame-runs", "0");
    await page.screenshot({ path: info.outputPath("selector-frame.png") });
    await expect
        .poll(() =>
            plugin.writes
                .at(-1)
                ?.document.items[0]?.previewData.find(
                    (entry) => entry.key === "example:charges",
                ),
        )
        .toEqual({
            key: "example:charges",
            value: { kind: "integer", value: "2" },
        });

    // Undo restores the matching sample and with it the selected case's theme.
    await page.getByTestId("undo").click();
    await expect(canvas).toHaveAttribute("data-theme", "itemerness:default");
});

test("selector library actions protect references and keep the field absent once empty", async ({
    page,
}) => {
    const selector: ThemeSelectorNode = {
        uuid: "8c7c4b1e-6a7e-4a55-9b8e-2f3c0b6d5a10",
        id: SELECTOR_ID,
        cases: [],
        defaultTheme: "itemerness:vanilla-frame",
    };
    const document = structuredClone(baselineDocument);
    document.themeSelectors = [selector];
    document.items[0]!.presentation.theme = SELECTOR_ID;
    const plugin = await coldWorkspace(page, document);
    await page.getByTestId("mode-themes").click();
    await page.getByTestId("theme-default").click();
    const row = page.getByTestId("theme-selector-charge-frame");
    await row.click({ button: "right" });
    // A right click targets the row without selecting it.
    await expect(page.getByTestId("themes-id")).toHaveValue(
        "itemerness:default",
    );
    await expect(page.getByTestId("menu-delete-theme-selector")).toBeDisabled();
    await page.getByTestId("menu-duplicate-theme-selector").click();
    await expect(page.getByTestId("theme-selector-id")).toHaveValue(
        `${SELECTOR_ID}-copy`,
    );
    await expect
        .poll(() => plugin.writes.at(-1)?.document.themeSelectors?.length)
        .toBe(2);
    // The vanilla frame is the selectors' default, so it cannot be deleted.
    await page.getByTestId("theme-vanilla-frame").click();
    await expect(page.getByTestId("delete-themes")).toBeDisabled();

    await page.getByTestId("theme-selector-charge-frame-copy").click();
    await page.getByTestId("delete-theme-selector").click();
    await page.getByTestId("confirm-accept").click();
    await expect(
        page.getByTestId("theme-selector-charge-frame-copy"),
    ).toHaveCount(0);

    // Unbind the item, then the remaining selector can go and the field disappears.
    await page.getByTestId("mode-items").click();
    await page.getByTestId("item-travel-token").click();
    await page.getByTestId("theme-card-vanilla-frame").click();
    await page.getByTestId("mode-themes").click();
    await row.click();
    await expect(page.getByTestId("delete-theme-selector")).toBeEnabled();
    await page.getByTestId("delete-theme-selector").click();
    await page.getByTestId("confirm-accept").click();
    await expect(row).toHaveCount(0);
    await expect
        .poll(() =>
            Object.hasOwn(plugin.writes.at(-1)!.document, "themeSelectors"),
        )
        .toBe(false);
    await page.getByTestId("undo").click();
    await expect(row).toBeVisible();
});
