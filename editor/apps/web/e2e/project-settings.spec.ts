import { expect, test, type Page } from "@playwright/test";
import {
    upgradeProjectDocument,
    type ProjectDocument,
} from "@itemerness/protocol";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import {
    API_URL,
    HANDSHAKE,
    chooseValue,
    enterWorkspace,
    mockPlugin,
} from "./fixtures/plugin.js";

function fixture() {
    const document = upgradeProjectDocument(
        baselineDocument,
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
    document.defaultTheme = "itemerness:default";
    document.defaultLayout = "itemerness:plain";
    document.items[0]!.presentation.theme = null;
    document.items[0]!.presentation.layout = null;
    const layout = structuredClone(
        document.layouts.find((entry) => entry.id === "itemerness:plain")!,
    );
    document.layouts.push({
        ...layout,
        id: "custom:plain",
        uuid: crypto.randomUUID(),
    });
    return document;
}
async function start(page: Page, document: ProjectDocument) {
    const plugin = await mockPlugin(page, document);
    await page.route(`${API_URL}/api/handshake`, (route) =>
        route.fulfill({ json: { ...HANDSHAKE, documentSchemas: [1, 2] } }),
    );
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    await page.getByTestId("open-settings").click();
    await page.getByTestId("auto-save-toggle").uncheck();
    return plugin;
}

test("project defaults remain live inheritance, while selecting an explicit theme pins only that item", async ({
    page,
}, info) => {
    const document = fixture();
    const plugin = await start(page, document);
    await chooseValue(
        page,
        page.getByTestId("project-default-theme"),
        "itemerness:vanilla-frame",
    );
    await chooseValue(
        page,
        page.getByTestId("project-default-layout"),
        "custom:plain",
    );
    await page.keyboard.press("Control+s");
    await expect
        .poll(() => plugin.writes.at(-1)?.document.defaultLayout)
        .toBe("custom:plain");
    expect(plugin.writes.at(-1)!.document.items[0]!.presentation).toMatchObject(
        { theme: null, layout: null },
    );
    expect(plugin.writes.at(-1)!.document.items[1]!.presentation).toEqual(
        document.items[1]!.presentation,
    );
    await page.getByTestId("project-default-theme").click();
    await expect(
        page.getByRole("option").and(page.locator('[data-option-value=""]')),
    ).toHaveAttribute("aria-disabled", "true");
    await page.keyboard.press("Escape");
    await page.getByTestId("mode-items").click();
    await expect(page.getByTestId("item-theme-inherit")).toBeChecked();
    await expect(page.getByTestId("selected-theme")).toContainText(
        "itemerness:vanilla-frame",
    );
    await expect(page.getByTestId("form-layout")).toHaveAttribute(
        "data-field-value",
        "",
    );
    await expect(page.getByTestId("form-layout")).toContainText("custom:plain");
    await page.getByTestId("theme-card-default").click();
    await expect(page.getByTestId("item-theme-inherit")).not.toBeChecked();
    await page.getByTestId("open-settings").click();
    await chooseValue(
        page,
        page.getByTestId("project-default-theme"),
        "itemerness:ember",
    );
    await page.keyboard.press("Control+s");
    await expect
        .poll(() => plugin.writes.at(-1)?.document.defaultTheme)
        .toBe("itemerness:ember");
    expect(plugin.writes.at(-1)!.document.items[0]!.presentation.theme).toBe(
        "itemerness:default",
    );
    await page.getByTestId("mode-items").click();
    await expect(page.getByTestId("selected-theme")).toContainText(
        "itemerness:default",
    );
    await page.getByTestId("item-theme-inherit").check();
    await page.keyboard.press("Control+s");
    await expect
        .poll(() => plugin.writes.at(-1)?.document.items[0]!.presentation.theme)
        .toBeNull();
    await page.getByTestId("open-settings").click();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.getByTestId("project-settings").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath("project-settings-v2-narrow.png") });
});

test("namespace changes validate collisions and atomically move references without changing qualified items", async ({
    page,
}) => {
    const document = fixture();
    document.items[1]!.id = "equipment:travel-token";
    document.items[2]!.definition.contents = [
        { item: "itemerness:travel-token", amount: 1 },
        { item: "equipment:travel-token", amount: 2 },
    ];
    const plugin = await start(page, document);
    const input = page.getByTestId("project-namespace");
    await input.fill("equipment");
    await input.press("Control+s");
    await expect(input).toHaveAttribute("aria-invalid", "true");
    await page.getByTestId("mode-items").click();
    await expect(page.getByTestId("project-settings")).toBeVisible();
    expect(plugin.writes).toHaveLength(0);
    await input.press("Escape");
    await input.fill("migrated");
    await input.press("Control+s");
    await expect
        .poll(() => plugin.writes.at(-1)?.document.namespace)
        .toBe("migrated");
    expect(plugin.writes.at(-1)!.document.items[1]!.id).toBe(
        "equipment:travel-token",
    );
    expect(
        plugin.writes
            .at(-1)!
            .document.items[2]!.definition.contents.map((entry) => entry.item),
    ).toEqual(["migrated:travel-token", "equipment:travel-token"]);
    expect(plugin.writes.at(-1)!.document.items[0]!.previewData).toEqual(
        document.items[0]!.previewData,
    );
    await applicationMenuAction(page, "edit", "undo");
    await expect(input).toHaveValue("itemerness");
    await page.getByTestId("mode-items").click();
    await expect(page.getByTestId("item-travel-token")).toHaveClass(
        /\bselected\b/,
    );
});

test("document settings are separate from local autosave, remain contained, and legacy inheritance has an explicit upgrade entry", async ({
    page,
}, info) => {
    const plugin = await start(page, baselineDocument);
    await expect(page.getByTestId("project-default-theme")).toHaveCount(0);
    await expect(page.getByTestId("integration-review-upgrade")).toBeVisible();
    await chooseValue(
        page,
        page.getByTestId("project-default-locale"),
        "zh_cn",
    );
    await page.keyboard.press("Control+s");
    await expect
        .poll(() => plugin.writes.at(-1)?.document.defaultLocale)
        .toBe("zh_cn");
    expect(plugin.writes.at(-1)!.document.schemaVersion).toBe(1);
    expect(plugin.writes.at(-1)!.document).not.toHaveProperty("defaultTheme");
    expect(plugin.writes.at(-1)!.document).not.toHaveProperty("autoSave");
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
        await page
            .getByTestId("project-settings")
            .evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
    await page.screenshot({
        path: info.outputPath("project-settings-legacy-narrow.png"),
    });
});
import { applicationMenuAction } from "./fixtures/applicationMenu.js";
