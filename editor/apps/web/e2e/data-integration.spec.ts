import { expect, test, type Page } from "@playwright/test";
import {
    dataKeyNodeSchema,
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

function fixture(version: 1 | 2 = 1) {
    const document = structuredClone(baselineDocument);
    const count = dataKeyNodeSchema.parse({
        uuid: crypto.randomUUID(),
        id: "test:count",
        type: { kind: "long" },
        scope: "INSTANCE",
        defaultValue: { kind: "integer", value: "1" },
    });
    const title = dataKeyNodeSchema.parse({
        uuid: crypto.randomUUID(),
        id: "test:title",
        type: { kind: "string" },
        scope: "DEFINITION",
        defaultValue: { kind: "string", value: "keep:me" },
    });
    document.dataSchemas = [
        {
            uuid: crypto.randomUUID(),
            id: "test:integration",
            version: 1,
            keys: [count, title],
        },
    ];
    document.items.forEach((item) => {
        item.definition.instance.schemas = [
            { id: "test:integration", version: 1 },
        ];
        item.definition.instance.defaults = [];
        item.definition.instance.generators = [];
        item.definition.definitionData = [];
        item.previewData = [];
        item.presentation.blocks = [];
    });
    return {
        document:
            version === 1
                ? document
                : upgradeProjectDocument(document, (_schema, key) => ({
                      readSources: [
                          {
                              kind:
                                  key.scope === "DEFINITION"
                                      ? "catalogDefinition"
                                      : "canonicalNbt",
                          },
                      ],
                      access: {
                          read: "INTERNAL",
                          write: [
                              key.scope === "DEFINITION"
                                  ? "definition"
                                  : "internal",
                          ],
                      },
                      placeholderApi: { exposed: false, formatter: null },
                  })),
        count,
        title,
    };
}
async function start(
    page: Page,
    document: ProjectDocument,
    modernServer = true,
) {
    const plugin = await mockPlugin(page, document);
    await page.route(`${API_URL}/api/handshake`, (route) =>
        route.fulfill({
            json: {
                ...HANDSHAKE,
                documentSchemas: modernServer ? [1, 2] : [1],
            },
        }),
    );
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    await page.getByTestId("open-settings").click();
    await page.getByTestId("auto-save-toggle").uncheck();
    await page.getByTestId("mode-data").click();
    if (document.dataSchemas.length)
        await page.getByTestId("datakey-count").click();
    return plugin;
}

test("format 2 integration edits ordered read-only PDC, case-insensitive writers and type-compatible public placeholders", async ({
    page,
}, info) => {
    const { document } = fixture(2);
    const plugin = await start(page, document);
    await expect(page.getByTestId("integration-fields")).toBeVisible();
    for (const key of ["legacy:first", "legacy:second"]) {
        await page.getByTestId("integration-new-pdc").fill(key);
        await page.getByTestId("integration-add-pdc").click();
    }
    await page.getByTestId("integration-source-2-up").click();
    await page.getByTestId("integration-new-plugin").fill("Example");
    await page.getByTestId("integration-add-plugin").click();
    await page.getByTestId("integration-new-plugin").fill("example");
    await expect(page.getByTestId("integration-add-plugin")).toBeDisabled();
    await page.getByTestId("integration-new-plugin").fill("");
    const writer = page.getByTestId("integration-writer-1");
    await writer.fill("plugin:Edited");
    await chooseValue(page, page.getByTestId("integration-read"), "PUBLIC");
    await expect(writer).toHaveValue("plugin:Edited");
    await page.getByTestId("integration-placeholder-exposed").check();
    await chooseValue(
        page,
        page.getByTestId("integration-formatter"),
        "itemerness:integer",
    );
    await page.getByTestId("integration-read").click();
    await expect(
        page.locator('[data-option-value="OWNER_ONLY"]'),
    ).toHaveAttribute("aria-disabled", "true");
    await expect(
        page.locator('[data-option-value="INTERNAL"]'),
    ).toHaveAttribute("aria-disabled", "true");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+s");
    await expect
        .poll(
            () =>
                plugin.writes.at(-1)?.document.dataSchemas[0]?.keys[0]
                    ?.integration,
        )
        .toEqual({
            readSources: [
                { kind: "canonicalNbt" },
                {
                    kind: "pdc",
                    key: "legacy:second",
                    mode: "FALLBACK_READ_ONLY",
                },
                {
                    kind: "pdc",
                    key: "legacy:first",
                    mode: "FALLBACK_READ_ONLY",
                },
            ],
            access: { read: "PUBLIC", write: ["internal", "plugin:Edited"] },
            placeholderApi: { exposed: true, formatter: "itemerness:integer" },
        });
    await page.getByTestId("integration-pdc-1").fill("bad:key:extra");
    await page.keyboard.press("Control+s");
    await expect(page.getByTestId("integration-pdc-1")).toHaveAttribute(
        "aria-invalid",
        "true",
    );
    await page.getByTestId("integration-pdc-1").press("Escape");
    await page.screenshot({ path: info.outputPath("integration-desktop.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    const inspector = page.getByTestId("data-integration");
    await inspector.scrollIntoViewIfNeeded();
    expect(
        await inspector.evaluate(
            (element) => element.scrollWidth <= element.clientWidth,
        ),
    ).toBe(true);
    await page.screenshot({ path: info.outputPath("integration-narrow.png") });
});

test("legacy upgrade requires every explicit policy, retains review navigation and commits one undoable document change", async ({
    page,
}, info) => {
    const { document, count, title } = fixture();
    const plugin = await start(page, document);
    await expect(page.getByTestId("data-integration")).toHaveCount(0);
    await page.getByTestId("integration-review-upgrade").click();
    const dialog = page.getByTestId("integration-upgrade-dialog");
    await expect(dialog).toContainText("Key 1 of 2");
    await expect(dialog).toContainText("1 pixel");
    await expect(page.getByTestId("integration-read")).toHaveAttribute(
        "data-field-value",
        "",
    );
    await expect(page.getByTestId("integration-confirm-policy")).toBeDisabled();
    await chooseValue(page, page.getByTestId("integration-read"), "INTERNAL");
    await expect(page.getByTestId("integration-confirm-policy")).toBeDisabled();
    await page.getByTestId("integration-add-internal").click();
    await page.getByTestId("integration-new-pdc").fill("legacy:pending");
    await page.getByTestId("integration-review-next").click();
    await expect(dialog).toContainText("Key 1 of 2");
    await expect(page.getByTestId("integration-new-pdc")).toHaveValue(
        "legacy:pending",
    );
    await expect(dialog.getByRole("alert")).toContainText("Add or clear");
    await page.getByTestId("integration-new-pdc").press("Escape");
    await page.getByTestId("integration-confirm-policy").click();
    await expect(dialog).toContainText("Key 2 of 2");
    await chooseValue(page, page.getByTestId("integration-read"), "PUBLIC");
    await page.getByTestId("integration-confirm-policy").click();
    await chooseValue(
        page,
        page.getByTestId("integration-review-key"),
        count.uuid,
    );
    await expect(page.getByTestId("integration-read")).toHaveAttribute(
        "data-field-value",
        "INTERNAL",
    );
    await page.keyboard.press("Control+s");
    expect(plugin.writes).toHaveLength(0);
    await chooseValue(
        page,
        page.getByTestId("integration-review-key"),
        title.uuid,
    );
    await page.screenshot({
        path: info.outputPath("upgrade-review-desktop.png"),
    });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
        await dialog.evaluate(
            (element) =>
                element.scrollWidth <= element.clientWidth &&
                element.scrollHeight <= element.clientHeight + 1,
        ),
    ).toBe(true);
    await page.screenshot({
        path: info.outputPath("upgrade-review-narrow.png"),
    });
    await page.getByTestId("integration-upgrade-apply").click();
    await expect(dialog).toHaveCount(0);
    await page.keyboard.press("Control+s");
    await expect
        .poll(() => plugin.writes.at(-1)?.document.schemaVersion)
        .toBe(2);
    const upgraded = plugin.writes.at(-1)!.document;
    expect(upgraded.measurement).toEqual({ boldExtraAdvancePixels: 1 });
    expect(
        upgraded.dataSchemas[0]!.keys.map((key) => key.integration?.access),
    ).toEqual([
        { read: "INTERNAL", write: ["internal"] },
        { read: "PUBLIC", write: ["definition"] },
    ]);
    expect(upgraded.items).toEqual(document.items);
    await page.getByTestId("undo").click();
    await page.keyboard.press("Control+s");
    await expect
        .poll(() => plugin.writes.at(-1)?.document.schemaVersion)
        .toBe(1);
    expect(plugin.writes.at(-1)?.document.measurement).toBeUndefined();
    expect(
        plugin.writes.at(-1)?.document.dataSchemas[0]?.keys[0]?.integration,
    ).toBeUndefined();
});

test("cancelling review keeps the legacy document intact and requires fresh choices next time", async ({
    page,
}) => {
    const { document } = fixture();
    const plugin = await start(page, document);
    await page.getByTestId("integration-review-upgrade").click();
    await chooseValue(page, page.getByTestId("integration-read"), "PUBLIC");
    await page.getByTestId("integration-new-plugin").fill("ChosenPlugin");
    await page.getByTestId("integration-add-plugin").click();
    await page.getByTestId("integration-upgrade-cancel").click();
    await expect(page.getByTestId("integration-upgrade-dialog")).toHaveCount(0);
    expect(plugin.writes).toHaveLength(0);
    await page.getByTestId("integration-review-upgrade").click();
    await expect(page.getByTestId("integration-read")).toHaveAttribute(
        "data-field-value",
        "",
    );
    await expect(page.getByTestId("integration-writer-0")).toHaveCount(0);
    await page.getByTestId("integration-upgrade-cancel").click();
});

test("server schema support gates upgrades and empty legacy documents can reach the explicit flow", async ({
    page,
}) => {
    const { document } = fixture();
    await start(page, document, false);
    await expect(page.getByTestId("integration-review-upgrade")).toBeDisabled();
    await page.reload();
    const empty = structuredClone(document);
    empty.dataSchemas = [];
    const plugin = await start(page, empty);
    await page.getByTestId("integration-review-upgrade").click();
    await expect(page.getByTestId("integration-upgrade-dialog")).toContainText(
        "Key 0 of 0",
    );
    await page.getByTestId("integration-upgrade-apply").click();
    await page.keyboard.press("Control+s");
    await expect
        .poll(() => plugin.writes.at(-1)?.document.schemaVersion)
        .toBe(2);
});
