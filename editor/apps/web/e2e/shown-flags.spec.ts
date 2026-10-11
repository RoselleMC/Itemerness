import { expect, test, type Page } from "@playwright/test";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import type { ProjectDocument } from "@itemerness/protocol";
import {
    API_URL,
    HANDSHAKE,
    enterWorkspace,
    mockPlugin,
} from "./fixtures/plugin.js";
import { applicationMenuAction } from "./fixtures/applicationMenu.js";

const selectedItem = baselineDocument.items[0]!;

const presentationOf = (document: ProjectDocument | undefined) =>
    document?.items.find((item) => item.uuid === selectedItem.uuid)
        ?.presentation;

async function open(page: Page, handshake = HANDSHAKE) {
    const plugin = await mockPlugin(page, baselineDocument, API_URL, handshake);
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    await expect(page.getByTestId("global-inspector")).toBeVisible();
    return plugin;
}

async function save(page: Page) {
    await page.getByTestId("toggle-navigation").focus();
    await page.keyboard.press("ControlOrMeta+s");
}

test("shown vanilla tooltip components are saved, undone, redone and cleared to an absent field", async ({
    page,
}) => {
    const plugin = await open(page);
    const field = page.getByTestId("shown-flags");
    await expect(field).toContainText("Shown vanilla tooltip");
    await expect(field.getByTestId("shown-flags-empty")).toBeVisible();
    await expect(field).toContainText("Empty hides every vanilla tooltip line");
    await page.getByTestId("fidelity-toggle").click();
    await expect(
        page.getByTestId("fidelity-vanilla-extra-lines"),
    ).toContainText("The theme claims every tooltip line");
    await page.getByTestId("fidelity-toggle").click();

    const input = page.getByTestId("shown-flag-input");
    await input.fill("minecraft:lore");
    await input.press("Enter");
    await expect(field.getByRole("alert")).toContainText(
        "Itemerness owns this component",
    );
    await input.fill("enchantments");
    await input.press("Enter");
    await expect(field.getByTestId("shown-flag")).toHaveText([
        "minecraft:enchantments",
    ]);
    await expect(input).toHaveValue("");
    // A shown component may print lines, so the item is previewed without managed-line ownership.
    await page.getByTestId("fidelity-toggle").click();
    await expect(
        page.getByTestId("fidelity-vanilla-extra-lines"),
    ).toContainText("The client adds its own enchantment and attribute lines");
    await page.getByTestId("fidelity-toggle").click();
    await save(page);
    await expect
        .poll(() => presentationOf(plugin.writes.at(-1)?.document)?.shownFlags)
        .toEqual(["minecraft:enchantments"]);

    await applicationMenuAction(page, "edit", "undo");
    await expect(field.getByTestId("shown-flags-empty")).toBeVisible();
    await applicationMenuAction(page, "edit", "redo");
    await expect(field.getByTestId("shown-flag")).toHaveText([
        "minecraft:enchantments",
    ]);

    await page
        .getByTestId("shown-flag-remove-minecraft:enchantments")
        .click();
    await expect(field.getByTestId("shown-flags-empty")).toBeVisible();
    await save(page);
    await expect
        .poll(() => {
            const presentation = presentationOf(
                plugin.writes.at(-1)?.document,
            );
            return presentation && Object.hasOwn(presentation, "shownFlags");
        })
        .toBe(false);
    for (const write of plugin.writes)
        for (const item of write.document.items)
            if (item.uuid !== selectedItem.uuid)
                expect(Object.hasOwn(item.presentation, "shownFlags")).toBe(
                    false,
                );
});

test("server data component ids are offered as application-styled suggestions", async ({
    page,
}) => {
    const handshake = {
        ...HANDSHAKE,
        dataComponentTypes: [
            "minecraft:attribute_modifiers",
            "minecraft:enchantments",
            "minecraft:lore",
        ],
    };
    await open(page, handshake);
    const input = page.getByTestId("shown-flag-input");
    await input.click();
    const popup = page.locator("[data-ui-popup]");
    await expect(
        popup.locator('[data-option-value="minecraft:attribute_modifiers"]'),
    ).toBeVisible();
    // Projection-owned components are never suggested.
    await expect(
        popup.locator('[data-option-value="minecraft:lore"]'),
    ).toHaveCount(0);
    await popup
        .locator('[data-option-value="minecraft:attribute_modifiers"]')
        .click();
    await page.getByTestId("shown-flag-add").click();
    await expect(
        page.getByTestId("shown-flags").getByTestId("shown-flag"),
    ).toHaveText(["minecraft:attribute_modifiers"]);
});
