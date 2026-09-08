import { expect, test, type Page } from "@playwright/test";
import { contentHash, type ProjectDocument } from "@itemerness/protocol";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import {
    API_URL,
    HANDSHAKE,
    chooseValue,
    enterWorkspace,
    mockPlugin,
} from "./fixtures/plugin.js";

async function start(page: Page, document: ProjectDocument, legacy = false) {
    const plugin = await mockPlugin(page, document);
    if (legacy)
        await page.route(`${API_URL}/api/handshake`, (route) =>
            route.fulfill({
                json: {
                    ...HANDSHAKE,
                    capabilities: HANDSHAKE.capabilities.filter(
                        (capability) =>
                            capability !==
                            "catalog.base-components.attributes-enchantments",
                    ),
                },
            }),
        );
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    await page.getByTestId("open-settings").click();
    await page.getByTestId("auto-save-toggle").uncheck();
    await page.getByTestId("mode-items").click();
    await page
        .getByTestId("item-components")
        .locator(":scope > summary")
        .click();
    return plugin;
}

test("old plugins expose unsupported component values read-only without silently clearing them", async ({
    page,
}) => {
    const document = structuredClone(baselineDocument);
    const item = document.items[0]!;
    item.definition.baseComponents = [
        {
            id: "minecraft:enchantments",
            value: {
                kind: "compound",
                entries: {
                    "custom:retained": { kind: "integer", value: "255" },
                },
            },
        },
    ];
    const plugin = await start(page, document, true);
    const owner = `${item.uuid}-component-enchantments-0`;
    await expect(page.getByTestId("item-components")).toContainText(
        "The plugin does not support attribute and enchantment components.",
    );
    await expect(page.getByTestId(`${owner}-0-key`)).toHaveValue(
        "custom:retained",
    );
    await expect(page.getByTestId(`${owner}-0-key`)).toBeDisabled();
    await page.getByTestId("component-add-choice").click();
    await expect(
        page.locator('[data-option-value="minecraft:attribute_modifiers"]'),
    ).toHaveAttribute("aria-disabled", "true");
    await page.keyboard.press("Escape");
    expect(plugin.writes).toEqual([]);
    await page.getByTestId(`${owner}-remove`).click();
    await page.keyboard.press("Control+s");
    await expect
        .poll(
            () =>
                plugin.writes.at(-1)?.document.items[0]?.definition
                    .baseComponents,
        )
        .toEqual([]);
});

test("explicit component clears and enchantment entries preserve history and serialized saves", async ({
    page,
}, info) => {
    const document = structuredClone(baselineDocument);
    const item = document.items[0]!;
    item.definition.baseComponents = [];
    const plugin = await start(page, document);
    for (const id of [
        "attribute_modifiers",
        "enchantments",
        "stored_enchantments",
    ]) {
        await chooseValue(
            page,
            page.getByTestId("component-add-choice"),
            `minecraft:${id}`,
        );
        await page.getByTestId("component-add").click();
    }
    await expect(
        page.getByTestId("component-minecraft:attribute_modifiers"),
    ).toContainText("Explicitly cleared");
    await page.keyboard.press("Control+s");
    const components = () =>
        plugin.writes.at(-1)?.document.items[0]?.definition.baseComponents;
    await expect.poll(components).toEqual([
        {
            id: "minecraft:attribute_modifiers",
            value: { kind: "list", values: [] },
        },
        {
            id: "minecraft:enchantments",
            value: { kind: "compound", entries: {} },
        },
        {
            id: "minecraft:stored_enchantments",
            value: { kind: "compound", entries: {} },
        },
    ]);
    const owner = `${item.uuid}-component-enchantments-1`;
    await page.getByTestId(`${owner}-new-key`).fill("custom:skill/one");
    await page.getByTestId(`${owner}-add`).click();
    const level = page.getByTestId(`${owner}-0-level`);
    await level.fill("255");
    await level.press("Control+s");
    await expect.poll(components).toContainEqual({
        id: "minecraft:enchantments",
        value: {
            kind: "compound",
            entries: {
                "custom:skill/one": { kind: "integer", value: "255" },
            },
        },
    });
    const before = plugin.writes.length;
    for (const invalid of ["-", "0", "256", "1.5"]) {
        await level.fill(invalid);
        await level.press("Control+s");
        await expect(level).toHaveAttribute("aria-invalid", "true");
        expect(plugin.writes).toHaveLength(before);
    }
    await level.press("Escape");
    await expect(level).toHaveValue("255");
    await page.getByTestId(`${owner}-new-key`).fill("minecraft:sharpness");
    await page.getByTestId(`${owner}-new-key`).press("Enter");
    const key = page.getByTestId(`${owner}-0-key`);
    await key.fill("minecraft:sharpness");
    await key.press("Enter");
    await expect(key).toHaveAttribute("aria-invalid", "true");
    await key.press("Escape");
    await key.fill("custom:renamed");
    await key.press("Enter");
    await page.getByTestId("undo").click();
    await expect(page.getByTestId(`${owner}-0-key`)).toHaveValue(
        "custom:skill/one",
    );
    await page.getByTestId("redo").click();
    await expect(page.getByTestId(`${owner}-0-key`)).toHaveValue(
        "custom:renamed",
    );
    const stored = `${item.uuid}-component-stored_enchantments-2`;
    await page.getByTestId(`${stored}-new-key`).fill("minecraft:efficiency");
    await page.getByTestId(`${stored}-add`).click();
    await page.getByTestId(`${stored}-0-level`).fill("255");
    await page.getByTestId(`${stored}-0-level`).press("Control+s");
    await expect.poll(components).toContainEqual({
        id: "minecraft:stored_enchantments",
        value: {
            kind: "compound",
            entries: {
                "minecraft:efficiency": { kind: "integer", value: "255" },
            },
        },
    });
    await page.screenshot({
        path: info.outputPath("enchantments-desktop.png"),
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByTestId(`${owner}-0-key`).scrollIntoViewIfNeeded();
    expect(
        await page
            .getByTestId("global-inspector")
            .evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
    await page.screenshot({ path: info.outputPath("enchantments-narrow.png") });
    await page.getByTestId(`${owner}-1-remove`).click();
    await page.getByTestId(`${owner}-0-remove`).click();
    await page.keyboard.press("Control+s");
    await expect.poll(components).toContainEqual({
        id: "minecraft:enchantments",
        value: { kind: "compound", entries: {} },
    });
    await page
        .getByTestId(`${item.uuid}-component-attribute_modifiers-0-remove`)
        .click();
    await page.keyboard.press("Control+s");
    await expect
        .poll(() =>
            components()?.some(
                (component) => component.id === "minecraft:attribute_modifiers",
            ),
        )
        .toBe(false);
    expect(plugin.writes.at(-1)?.document.items.slice(1)).toEqual(
        document.items.slice(1),
    );
    for (let index = 0; index < plugin.writes.length; index++) {
        expect(plugin.writes[index]!.expectedHash).toBe(
            contentHash(
                index === 0 ? document : plugin.writes[index - 1]!.document,
            ),
        );
    }
});

test("loaded enchantments retain unknown registry keys and enforce the 64 entry budget without overwrites", async ({
    page,
}) => {
    const document = structuredClone(baselineDocument);
    const item = document.items[0]!;
    item.definition.baseComponents = [
        {
            id: "minecraft:stored_enchantments",
            value: {
                kind: "compound",
                entries: Object.fromEntries(
                    Array.from({ length: 64 }, (_, index) => [
                        `custom:unknown/${index}`,
                        { kind: "integer", value: "255" },
                    ]),
                ),
            },
        },
    ];
    await start(page, document);
    const owner = `${item.uuid}-component-stored_enchantments-0`;
    await page.getByTestId(`${owner}-new-key`).fill("custom:new");
    await expect(page.getByTestId(`${owner}-add`)).toBeDisabled();
    await expect(page.getByTestId(`${owner}-0-key`)).toHaveValue(
        "custom:unknown/0",
    );
    await page.getByTestId(`${owner}-0-remove`).click();
    await expect(page.getByTestId(`${owner}-add`)).toBeEnabled();
    await page.getByTestId(`${owner}-add`).click();
    await expect(page.getByTestId(`${owner}-63-key`)).toHaveValue("custom:new");
    await expect(page.getByTestId(`${owner}-add`)).toBeDisabled();
});

test("malformed loaded enchantment values have an explicit repair without dropping adjacent entries", async ({
    page,
}) => {
    const document = structuredClone(baselineDocument);
    const item = document.items[0]!;
    item.definition.baseComponents = [
        {
            id: "minecraft:enchantments",
            value: {
                kind: "compound",
                entries: {
                    "custom:broken": {
                        kind: "string",
                        value: "keep-until-repaired",
                    },
                    "custom:valid": { kind: "integer", value: "255" },
                },
            },
        },
    ];
    const plugin = await start(page, document);
    const owner = `${item.uuid}-component-enchantments-0`;
    expect(plugin.writes).toEqual([]);
    await page.getByTestId(`${owner}-0-repair`).click();
    await page.keyboard.press("Control+s");
    await expect
        .poll(
            () =>
                plugin.writes.at(-1)?.document.items[0]?.definition
                    .baseComponents[0]?.value,
        )
        .toEqual({
            kind: "compound",
            entries: {
                "custom:broken": { kind: "integer", value: "1" },
                "custom:valid": { kind: "integer", value: "255" },
            },
        });
    await page.getByTestId("undo").click();
    await expect(page.getByTestId(`${owner}-0-repair`)).toBeVisible();
});

test("maximum length enchantment IDs fit the minimum desktop window without losing their value", async ({
    page,
}, info) => {
    const document = structuredClone(baselineDocument);
    const item = document.items[0]!;
    const longId = `${"n".repeat(64)}:${"p".repeat(191)}`;
    item.definition.baseComponents = [
        {
            id: "minecraft:enchantments",
            value: {
                kind: "compound",
                entries: { [longId]: { kind: "integer", value: "255" } },
            },
        },
    ];
    await page.setViewportSize({ width: 900, height: 640 });
    const plugin = await start(page, document);
    const owner = `${item.uuid}-component-enchantments-0`;
    const key = page.getByTestId(`${owner}-0-key`);
    await key.scrollIntoViewIfNeeded();
    await expect(key).toHaveValue(longId);
    const inspector = page.getByTestId("global-inspector");
    expect(
        await inspector.evaluate(
            (element) => element.scrollWidth <= element.clientWidth,
        ),
    ).toBe(true);
    const outer = (await inspector.boundingBox())!;
    const input = (await key.boundingBox())!;
    expect(input.x).toBeGreaterThanOrEqual(outer.x);
    expect(input.x + input.width).toBeLessThanOrEqual(outer.x + outer.width);
    await page.screenshot({
        path: info.outputPath("enchantments-minimum-desktop.png"),
    });
    const level = page.getByTestId(`${owner}-0-level`);
    await level.fill("1");
    await level.press("Control+s");
    await expect
        .poll(
            () =>
                plugin.writes.at(-1)?.document.items[0]?.definition
                    .baseComponents[0]?.value,
        )
        .toEqual({
            kind: "compound",
            entries: { [longId]: { kind: "integer", value: "1" } },
        });
    await level.fill("-");
    await level.press("Control+s");
    await expect(level).toHaveValue("-");
    await expect(level).toHaveAttribute("aria-invalid", "true");
    expect(
        await inspector.evaluate(
            (element) => element.scrollWidth <= element.clientWidth,
        ),
    ).toBe(true);
    await page.screenshot({
        path: info.outputPath("enchantments-minimum-desktop-invalid.png"),
    });
    await level.press("Escape");
});
