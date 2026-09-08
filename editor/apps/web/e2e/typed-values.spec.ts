import { expect, test, type Page } from "@playwright/test";
import {
    dataKeyNodeSchema,
    presentationBlockSchema,
    type PresentationBlock,
    type ProjectDocument,
} from "@itemerness/protocol";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import {
    chooseValue,
    enterWorkspace,
    mockPlugin,
    selectContent,
} from "./fixtures/plugin.js";

function fixture() {
    const document = structuredClone(baselineDocument);
    const condition = presentationBlockSchema.parse({
        uuid: crypto.randomUUID(),
        type: "conditional",
        condition: {
            operator: "EQUALS",
            left: {
                kind: "literal",
                value: { kind: "string", value: "12:34:56" },
            },
            right: {
                kind: "literal",
                value: { kind: "decimal", value: "-1.5" },
            },
        },
        thenBlocks: [],
        otherwiseBlocks: [],
    }) as Extract<PresentationBlock, { type: "conditional" }>;
    document.items[0]!.presentation.blocks = [condition];
    return { document, condition, prefix: `condition-${condition.uuid}` };
}
async function manual(page: Page) {
    await page.getByTestId("open-settings").click();
    await page.getByTestId("auto-save-toggle").uncheck();
    await page.getByTestId("mode-items").click();
}
const conditionOf = (document: ProjectDocument | undefined) => {
    const block = document?.items[0]?.presentation.blocks[0];
    return block?.type === "conditional" ? block.condition : null;
};

test("both operands retain literal types, complete numeric drafts on Save, and remember values across references and EXISTS", async ({
    page,
}, info) => {
    const { document, condition, prefix } = fixture();
    const plugin = await mockPlugin(page, document);
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    await manual(page);
    await selectContent(page, condition.uuid);
    const left = page.getByTestId(`${prefix}-left-literal-input`);
    const right = page.getByTestId(`${prefix}-right-literal-input`);
    await expect(left).toHaveValue("12:34:56");
    await left.fill("05:06:07");
    await left.press("Enter");
    await right.fill("-");
    await expect(right).toHaveValue("-");
    await right.fill("-2.");
    await expect(right).toHaveValue("-2.");
    await right.fill("-2.750");
    expect(plugin.writes).toHaveLength(0);
    await right.press("Control+s");
    await expect
        .poll(() => conditionOf(plugin.writes.at(-1)?.document))
        .toMatchObject({
            left: {
                kind: "literal",
                value: { kind: "string", value: "05:06:07" },
            },
            right: {
                kind: "literal",
                value: { kind: "decimal", value: "-2.750" },
            },
        });
    const dataReference = `fact:${document.viewerFacts[0]!.id}`;
    await chooseValue(
        page,
        page.getByTestId(`${prefix}-left-reference`),
        dataReference,
    );
    await chooseValue(
        page,
        page.getByTestId(`${prefix}-left-reference`),
        "literal",
    );
    await expect(left).toHaveValue("05:06:07");
    await chooseValue(page, page.getByTestId(`${prefix}-operator`), "EXISTS");
    await expect(page.getByTestId(`${prefix}-right-reference`)).toBeDisabled();
    await expect(right).toHaveCount(0);
    await page.keyboard.press("Meta+s");
    await expect
        .poll(() => conditionOf(plugin.writes.at(-1)?.document)?.right)
        .toBeNull();
    await chooseValue(page, page.getByTestId(`${prefix}-operator`), "EQUALS");
    await expect(right).toHaveValue("-2.750");
    await chooseValue(
        page,
        page.getByTestId(`${prefix}-left-literal-type`),
        "boolean",
    );
    await page.getByTestId(`${prefix}-left-literal-input`).check();
    await page.getByTestId(`${prefix}-left-literal-type`).click();
    await expect(page.locator('[data-option-value="null"]')).toHaveCount(0);
    await page.keyboard.press("Escape");
    await chooseValue(
        page,
        page.getByTestId(`${prefix}-left-literal-type`),
        "string",
    );
    await chooseValue(
        page,
        page.getByTestId(`${prefix}-left-literal-type`),
        "boolean",
    );
    await expect(
        page.getByTestId(`${prefix}-left-literal-input`),
    ).toBeChecked();
    await page.screenshot({ path: info.outputPath("typed-condition.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    const inspector = page.getByTestId("content-inspector");
    await inspector.scrollIntoViewIfNeeded();
    expect(
        await inspector.evaluate(
            (element) => element.scrollWidth <= element.clientWidth,
        ),
    ).toBe(true);
    await page.screenshot({
        path: info.outputPath("typed-condition-narrow.png"),
        fullPage: true,
    });
});

test("invalid drafts block explicit save and exit, remain visible, and never leak into a reconnected document", async ({
    page,
}) => {
    const { document, condition, prefix } = fixture();
    const plugin = await mockPlugin(page, document);
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    await manual(page);
    await selectContent(page, condition.uuid);
    const input = page.getByTestId(`${prefix}-right-literal-input`);
    await input.fill("-");
    await input.press("Control+s");
    await expect(input).toHaveAttribute("aria-invalid", "true");
    await expect(input).toHaveValue("-");
    await expect(page.getByTestId("document-sync-status")).toHaveAttribute(
        "data-sync-kind",
        "unsaved",
    );
    expect(plugin.writes).toHaveLength(0);
    await page.getByTestId("mode-themes").click();
    await expect(page.getByTestId("content-inspector")).toBeVisible();
    await expect(input).toHaveValue("-");
    await page.getByTestId("open-settings").click();
    await expect(page.getByTestId("workspace")).toHaveAttribute(
        "data-page",
        "editor",
    );
    await page.getByTestId(`item-${document.items[1]!.id}`).click();
    await expect(input).toHaveValue("-");
    await page.getByTestId("line-hit-name").click();
    await expect(page.getByTestId("content-inspector")).toBeVisible();
    await page.getByTestId("connection-trigger").click();
    await page.getByTestId("disconnect-plugin").click();
    await expect(page.getByTestId("unsaved-dialog")).toBeVisible();
    await page.getByTestId("leave-save").click();
    await expect(
        page.getByTestId("unsaved-dialog").getByRole("alert"),
    ).toBeVisible();
    await expect(page.getByTestId("workspace")).toHaveAttribute(
        "data-ready",
        "true",
    );
    expect(plugin.writes).toHaveLength(0);
    await page.getByTestId("leave-cancel").click();
    await expect(page.getByTestId("workspace")).toHaveAttribute(
        "data-ready",
        "true",
    );
    await expect(page.getByTestId("connection-popup")).toHaveCount(0);
    await expect(input).toHaveValue("-");
    await input.press("Escape");
    await expect(input).toHaveValue("-1.5");
    await expect(input).not.toHaveAttribute("aria-invalid", "true");
    await page.getByTestId("open-settings").click();
    await expect(page.getByTestId("workspace")).toHaveAttribute(
        "data-page",
        "settings",
    );
    await page.getByTestId("mode-items").click();
    await selectContent(page, condition.uuid);
    await input.fill("-");
    await page.getByTestId("connection-trigger").click();
    await page.getByTestId("disconnect-plugin").click();
    await page.getByTestId("leave-discard").click();
    await expect(page.getByTestId("workspace")).toHaveAttribute(
        "data-ready",
        "false",
    );
    const replacement = structuredClone(document);
    const replacementCondition = replacement.items[0]!.presentation.blocks[0]!;
    if (replacementCondition.type !== "conditional")
        throw new Error("Expected condition");
    replacementCondition.condition.right = {
        kind: "literal",
        value: { kind: "decimal", value: "7.25" },
    };
    plugin.replace(replacement);
    await enterWorkspace(page);
    await selectContent(page, condition.uuid);
    await expect(input).toHaveValue("7.25");
    await input.fill("8.5");
    await input.press("Control+s");
    await expect
        .poll(() => conditionOf(plugin.writes.at(-1)?.document)?.right)
        .toEqual({ kind: "literal", value: { kind: "decimal", value: "8.5" } });
});

test("preview values retain ordinary colons, resolve the bound schema's scope, and do not rewrite real defaults", async ({
    page,
}) => {
    const document = structuredClone(baselineDocument);
    const item = document.items[0]!;
    const clock = dataKeyNodeSchema.parse({
        uuid: crypto.randomUUID(),
        id: "test:clock",
        type: { kind: "string" },
        scope: "DEFINITION",
        presentationReadable: true,
    });
    const gem = dataKeyNodeSchema.parse({
        uuid: crypto.randomUUID(),
        id: "test:gem",
        type: { kind: "namespacedKey" },
        scope: "INSTANCE",
        presentationReadable: true,
    });
    document.dataSchemas = [
        {
            uuid: crypto.randomUUID(),
            id: "test:bound",
            version: 2,
            keys: [clock, gem],
        },
        {
            uuid: crypto.randomUUID(),
            id: "test:unbound",
            version: 1,
            keys: [
                {
                    ...clock,
                    uuid: crypto.randomUUID(),
                    type: { kind: "namespacedKey" },
                },
            ],
        },
    ];
    item.definition.instance.schemas = [{ id: "test:bound", version: 2 }];
    item.definition.definitionData = [
        { key: clock.id, value: { kind: "string", value: "12:34:56" } },
    ];
    item.definition.instance.defaults = [
        { key: clock.id, value: { kind: "string", value: "wrong:scope" } },
        { key: gem.id, value: { kind: "string", value: "custom:quartz" } },
    ];
    item.previewData = [];
    item.presentation.blocks = [clock, gem].map((key) =>
        presentationBlockSchema.parse({
            uuid: crypto.randomUUID(),
            type: "text",
            data: key.id,
        }),
    );
    const clockBlock = item.presentation.blocks[0]!,
        gemBlock = item.presentation.blocks[1]!;
    const plugin = await mockPlugin(page, document);
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    await manual(page);
    await selectContent(page, clockBlock.uuid);
    const clockInput = page.getByTestId(`sample-${clockBlock.uuid}-input`);
    await expect(clockInput).toHaveValue("12:34:56");
    await expect(
        page.getByTestId(`sample-${clockBlock.uuid}-type`),
    ).toHaveCount(0);
    await expect(page.getByTestId("content-inspector")).toContainText(
        "Item definition",
    );
    await clockInput.fill("05:06:07");
    await clockInput.press("Control+s");
    await expect
        .poll(() => plugin.writes.at(-1)?.document.items[0]?.previewData)
        .toEqual([
            { key: clock.id, value: { kind: "string", value: "05:06:07" } },
        ]);
    expect(plugin.writes.at(-1)?.document.items[0]?.definition).toEqual(
        item.definition,
    );
    await page.getByTestId(`sample-${clockBlock.uuid}-reset`).click();
    await expect(clockInput).toHaveValue("12:34:56");
    await selectContent(page, gemBlock.uuid);
    const gemInput = page.getByTestId(`sample-${gemBlock.uuid}-input`);
    await expect(gemInput).toHaveValue("custom:quartz");
    await gemInput.fill("other:gem");
    await gemInput.press("Enter");
    await page.keyboard.press("Meta+s");
    await expect
        .poll(() => plugin.writes.at(-1)?.document.items[0]?.previewData)
        .toEqual([
            { key: gem.id, value: { kind: "string", value: "other:gem" } },
        ]);
    expect(plugin.writes.at(-1)?.document.items[0]?.definition).toEqual(
        item.definition,
    );
});

test("recursive literal fields retain list order and member types", async ({
    page,
}) => {
    const { document, condition, prefix } = fixture();
    condition.condition.right = {
        kind: "literal",
        value: {
            kind: "compound",
            entries: {
                threshold: { kind: "decimal", value: "1.5" },
                labels: {
                    kind: "list",
                    values: [
                        { kind: "string", value: "first:value" },
                        { kind: "boolean", value: true },
                    ],
                },
            },
        },
    };
    const plugin = await mockPlugin(page, document);
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    await manual(page);
    await selectContent(page, condition.uuid);
    const root = `${prefix}-right-literal`;
    await page.getByTestId(`${root}-threshold-input`).fill("2.75");
    await page.getByTestId(`${root}-threshold-input`).press("Enter");
    await page
        .getByTestId(`${root}-labels-0-input`)
        .fill("edited:value\nsecond:line");
    await page.getByTestId(`${root}-labels-0-input`).press("Enter");
    await page
        .getByTestId(`${root}-labels`)
        .getByRole("button", { name: "Move down", exact: true })
        .first()
        .click();
    await page.keyboard.press("Control+s");
    await expect
        .poll(() => conditionOf(plugin.writes.at(-1)?.document)?.right)
        .toEqual({
            kind: "literal",
            value: {
                kind: "compound",
                entries: {
                    threshold: { kind: "decimal", value: "2.75" },
                    labels: {
                        kind: "list",
                        values: [
                            { kind: "boolean", value: true },
                            {
                                kind: "string",
                                value: "edited:value\nsecond:line",
                            },
                        ],
                    },
                },
            },
        });
});

test("automatic saving continues for committed edits while incomplete input stays local", async ({
    page,
}) => {
    const { document, condition, prefix } = fixture();
    const plugin = await mockPlugin(page, document);
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    await selectContent(page, condition.uuid);
    const left = page.getByTestId(`${prefix}-left-literal-input`);
    const right = page.getByTestId(`${prefix}-right-literal-input`);
    await left.fill("Committed text");
    await left.press("Enter");
    await right.fill("-");
    await expect
        .poll(() => conditionOf(plugin.writes.at(-1)?.document)?.left)
        .toEqual({
            kind: "literal",
            value: { kind: "string", value: "Committed text" },
        });
    expect(conditionOf(plugin.writes.at(-1)?.document)?.right).toEqual({
        kind: "literal",
        value: { kind: "decimal", value: "-1.5" },
    });
    await right.press("Control+s");
    await expect(right).toHaveAttribute("aria-invalid", "true");
    await expect(right).toHaveValue("-");
    await expect(page.getByTestId("document-sync-status")).toHaveAttribute(
        "data-sync-kind",
        "unsaved",
    );
});

test("polled remote replacement conflicts with unfinished text instead of discarding it", async ({
    page,
}) => {
    const { document, condition, prefix } = fixture();
    const plugin = await mockPlugin(page, document);
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    await selectContent(page, condition.uuid);
    const input = page.getByTestId(`${prefix}-right-literal-input`);
    await input.fill("-");
    const replacement = structuredClone(document);
    replacement.items[0]!.definition.material = "minecraft:stone";
    plugin.replace(replacement);
    await expect(page.getByTestId("document-sync-status")).toHaveAttribute(
        "data-sync-kind",
        "conflict",
    );
    await expect(input).toHaveValue("-");
    expect(plugin.writes).toHaveLength(0);
    await input.press("Escape");
    await page.getByTestId("document-sync-status").click();
    await expect(page.getByTestId("global-inspector")).toBeVisible();
    await selectContent(page, condition.uuid);
    await expect(input).toHaveValue("-1.5");
    expect(plugin.writes).toHaveLength(0);
});
