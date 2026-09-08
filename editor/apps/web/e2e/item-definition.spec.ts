import { expect, test, type Page } from "@playwright/test";
import { dataKeyNodeSchema, type ProjectDocument } from "@itemerness/protocol";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import { chooseValue, enterWorkspace, mockPlugin } from "./fixtures/plugin.js";

function fixture() {
    const document = structuredClone(baselineDocument);
    const key = (
        id: string,
        kind: string,
        scope = "INSTANCE",
        nullable = false,
    ) =>
        dataKeyNodeSchema.parse({
            uuid: crypto.randomUUID(),
            id: `test:${id}`,
            scope,
            nullable,
            type: { kind },
            presentationReadable: true,
        });
    const schema = {
        uuid: crypto.randomUUID(),
        id: "test:definition",
        version: 1,
        keys: [
            {
                ...key("label", "string", "DEFINITION", true),
                defaultValue: { kind: "string" as const, value: "12:34:56" },
            },
            {
                ...key("level", "long"),
                defaultValue: { kind: "integer" as const, value: "1" },
            },
            key("created", "long"),
            {
                ...key("power", "decimal"),
                constraints: {
                    ...key("unused", "decimal").constraints,
                    minimum: "0",
                    maximum: "10",
                    scale: 2,
                },
            },
        ],
    };
    document.dataSchemas.push(schema);
    const item = document.items[0]!;
    item.presentation.blocks = [];
    item.previewData = [
        { key: "test:label", value: { kind: "string", value: "Preview only" } },
    ];
    item.definition = {
        material: "minecraft:bundle",
        baseComponents: [],
        definitionData: [],
        contentComponent: null,
        contents: [],
        instance: {
            mode: "FUNGIBLE",
            idGenerator: null,
            schemas: [{ id: schema.id, version: schema.version }],
            defaults: [],
            generators: [],
        },
    };
    return { document, item, schema };
}

async function start(page: Page, document: ProjectDocument) {
    const plugin = await mockPlugin(page, document);
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    await page.getByTestId("open-settings").click();
    await page.getByTestId("auto-save-toggle").uncheck();
    await page.getByTestId("mode-items").click();
    return plugin;
}
async function open(page: Page, id: string) {
    const details = page.getByTestId(id);
    if (!(await details.getAttribute("open")))
        await details.locator(":scope > summary").click();
    return details;
}

test("definition and instance overrides are typed, distinguish null from inheritance, and never overwrite preview samples", async ({
    page,
}) => {
    const { document } = fixture();
    const plugin = await start(page, document);
    await open(page, "definition-data");
    await page.getByTestId("definition-data-override-test:label").click();
    const value = page.getByTestId("definition-data-0-value-input");
    await expect(value).toHaveValue("12:34:56");
    await value.fill("05:06:07");
    await value.press("Control+s");
    await expect
        .poll(
            () =>
                plugin.writes.at(-1)?.document.items[0]?.definition
                    .definitionData,
        )
        .toEqual([
            { key: "test:label", value: { kind: "string", value: "05:06:07" } },
        ]);
    expect(plugin.writes.at(-1)?.document.items[0]?.previewData).toEqual(
        document.items[0]!.previewData,
    );
    await chooseValue(
        page,
        page.getByTestId("definition-data-0-value-type"),
        "null",
    );
    await page.keyboard.press("Control+s");
    await expect
        .poll(
            () =>
                plugin.writes.at(-1)?.document.items[0]?.definition
                    .definitionData[0]?.value,
        )
        .toEqual({ kind: "null" });
    await page.getByTestId("definition-data-0-remove").click();
    await expect(
        page.getByTestId("definition-data-inherited-test:label"),
    ).toContainText("12:34:56");
    await page.keyboard.press("Control+s");
    await expect
        .poll(
            () =>
                plugin.writes.at(-1)?.document.items[0]?.definition
                    .definitionData,
        )
        .toEqual([]);
    await open(page, "instance-defaults");
    await page.getByTestId("instance-defaults-override-test:level").click();
    const level = page.getByTestId("instance-defaults-0-value-input");
    await level.fill("9223372036854775807");
    await level.press("Control+s");
    await expect
        .poll(
            () =>
                plugin.writes.at(-1)?.document.items[0]?.definition.instance
                    .defaults[0]?.value,
        )
        .toEqual({ kind: "integer", value: "9223372036854775807" });
    await level.fill("-");
    await page.getByTestId("mode-themes").click();
    await expect(level).toHaveValue("-");
    await expect(level).toHaveAttribute("aria-invalid", "true");
    await level.press("Escape");
    await page.getByTestId("instance-defaults-0-key").click();
    await expect(page.locator('[data-option-value="test:label"]')).toHaveCount(
        0,
    );
});

test("schema versions and identity are atomic history edits while orphaned data remains repairable", async ({
    page,
}) => {
    const { document, item, schema } = fixture();
    const v2 = {
        ...structuredClone(schema),
        uuid: crypto.randomUUID(),
        version: 2,
        keys: [],
    };
    document.dataSchemas.push(v2);
    item.definition.definitionData = [
        { key: "test:label", value: { kind: "string", value: "kept" } },
    ];
    const plugin = await start(page, document);
    await chooseValue(page, page.getByTestId("instance-mode"), "UNIQUE");
    await page.keyboard.press("Control+s");
    await expect
        .poll(
            () => plugin.writes.at(-1)?.document.items[0]?.definition.instance,
        )
        .toMatchObject({ mode: "UNIQUE", idGenerator: "UUID_V4" });
    await open(page, "item-schema-bindings");
    await chooseValue(page, page.getByTestId("schema-binding-0"), v2.uuid);
    await expect(page.getByTestId("definition-reference-issues")).toContainText(
        "test:label",
    );
    await page.keyboard.press("Control+s");
    await expect
        .poll(
            () =>
                plugin.writes.at(-1)?.document.items[0]?.definition.instance
                    .schemas,
        )
        .toEqual([{ id: schema.id, version: 2 }]);
    expect(
        plugin.writes.at(-1)?.document.items[0]?.definition.definitionData,
    ).toEqual(item.definition.definitionData);
    await page.getByTestId("undo").click();
    await expect(page.getByTestId("schema-binding-0")).toHaveAttribute(
        "data-field-value",
        schema.uuid,
    );
    await expect(page.getByTestId("definition-reference-issues")).toHaveCount(
        0,
    );
});

test("creation generators validate exact bounds and cannot collide with defaults", async ({
    page,
}) => {
    const { document } = fixture();
    const plugin = await start(page, document);
    await open(page, "item-generators");
    await chooseValue(
        page,
        page.getByTestId("generator-add-choice"),
        "test:created",
    );
    await page.getByTestId("generator-add").click();
    await chooseValue(
        page,
        page.getByTestId("generator-add-choice"),
        "test:power",
    );
    await page.getByTestId("generator-add").click();
    const maximum = page.getByTestId("generator-1-maximum");
    await maximum.fill("8.25");
    await maximum.press("Control+s");
    await expect
        .poll(
            () =>
                plugin.writes.at(-1)?.document.items[0]?.definition.instance
                    .generators,
        )
        .toEqual([
            { kind: "unixMillis", key: "test:created" },
            {
                kind: "randomDecimal",
                key: "test:power",
                minimum: "0",
                maximum: "8.25",
                scale: 2,
            },
        ]);
    const before = plugin.writes.length;
    await maximum.fill("11");
    await maximum.press("Control+s");
    await expect(maximum).toHaveAttribute("aria-invalid", "true");
    expect(plugin.writes).toHaveLength(before);
    await maximum.press("Escape");
    await open(page, "instance-defaults");
    await expect(
        page.getByTestId("instance-defaults-override-test:power"),
    ).toBeDisabled();
    await page.getByTestId("generator-1-remove").click();
    await expect(
        page.getByTestId("instance-defaults-override-test:power"),
    ).toBeEnabled();
});

test("all component forms preserve false and unknown data, validate limits, and fit a narrow inspector", async ({
    page,
}, info) => {
    const { document, item } = fixture();
    item.definition.baseComponents = [
        {
            id: "minecraft:unknown",
            value: { kind: "string", value: "keep:me" },
        },
    ];
    const plugin = await start(page, document);
    await open(page, "item-components");
    const add = async (id: string) => {
        await chooseValue(
            page,
            page.getByTestId("component-add-choice"),
            `minecraft:${id}`,
        );
        await page.getByTestId("component-add").click();
    };
    for (const id of [
        "max_stack_size",
        "enchantment_glint_override",
        "food",
        "use_cooldown",
        "consumable",
        "custom_model_data",
        "rarity",
        "unbreakable",
        "item_model",
        "max_damage",
        "damage",
        "repair_cost",
    ])
        await add(id);
    const stack = page.getByTestId(`${item.uuid}-component-max_stack_size-1`);
    await stack.fill("100");
    await stack.press("Control+s");
    await expect(stack).toHaveAttribute("aria-invalid", "true");
    await stack.fill("1");
    await stack.press("Enter");
    await page
        .getByTestId(`${item.uuid}-component-enchantment_glint_override-2`)
        .uncheck();
    await page
        .getByTestId(`${item.uuid}-component-custom_model_data-6-strings-add`)
        .click();
    await page
        .getByTestId(`${item.uuid}-component-custom_model_data-6-strings-add`)
        .click();
    const text = page.getByTestId(
        `${item.uuid}-component-custom_model_data-6-strings-0`,
    );
    await text.fill("12:34:56");
    await text.press("Control+s");
    await expect
        .poll(
            () =>
                plugin.writes.at(-1)?.document.items[0]?.definition
                    .baseComponents.length,
        )
        .toBe(13);
    expect(
        plugin.writes.at(-1)?.document.items[0]?.definition.baseComponents,
    ).toContainEqual({
        id: "minecraft:unknown",
        value: { kind: "string", value: "keep:me" },
    });
    expect(
        plugin.writes.at(-1)?.document.items[0]?.definition.baseComponents,
    ).toContainEqual({
        id: "minecraft:enchantment_glint_override",
        value: { kind: "boolean", value: false },
    });
    await page.screenshot({ path: info.outputPath("components-desktop.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    const inspector = page.getByTestId("global-inspector");
    await text.scrollIntoViewIfNeeded();
    expect(
        await inspector.evaluate(
            (element) => element.scrollWidth <= element.clientWidth,
        ),
    ).toBe(true);
    await page.screenshot({ path: info.outputPath("components-narrow.png") });
});

test("nested contents reject cycles and quantity budgets, infer carrier, and remove entries without deleting items", async ({
    page,
}) => {
    const { document, item } = fixture();
    const target = document.items[1]!;
    target.definition.contents = [];
    target.definition.contentComponent = null;
    const plugin = await start(page, document);
    await open(page, "item-contents");
    await page.getByTestId("content-add-choice").click();
    await expect(
        page.locator(`[data-option-value="${document.namespace}:${item.id}"]`),
    ).toHaveAttribute("aria-disabled", "true");
    await page.keyboard.press("Escape");
    await chooseValue(
        page,
        page.getByTestId("content-add-choice"),
        `${document.namespace}:${target.id}`,
    );
    await page.getByTestId("content-add").click();
    const amount = page.getByTestId("content-entry-0-amount");
    await amount.fill("99");
    await amount.press("Control+s");
    await expect
        .poll(() => plugin.writes.at(-1)?.document.items[0]?.definition)
        .toMatchObject({
            contentComponent: "BUNDLE",
            contents: [
                { item: `${document.namespace}:${target.id}`, amount: 99 },
            ],
        });
    const material = page.getByTestId("material-input");
    await material.fill("paper");
    await material.press("Control+s");
    await expect(material).toHaveAttribute("aria-invalid", "true");
    await material.fill("barrel");
    await material.press("Control+s");
    await expect
        .poll(
            () =>
                plugin.writes.at(-1)?.document.items[0]?.definition
                    .contentComponent,
        )
        .toBe("CONTAINER");
    await page.getByTestId("content-entry-0-remove").click();
    await page.keyboard.press("Control+s");
    await expect
        .poll(() => plugin.writes.at(-1)?.document.items[0]?.definition)
        .toMatchObject({ contentComponent: null, contents: [] });
    expect(plugin.writes.at(-1)?.document.items).toHaveLength(
        document.items.length,
    );
});

test("material autocomplete keeps keyboard acceptance and Escape layered above the validated buffer", async ({
    page,
}) => {
    const { document } = fixture();
    const plugin = await start(page, document);
    const material = page.getByTestId("material-input");
    await material.fill("diamond_sw");
    await material.press("ArrowDown");
    await material.press("Enter");
    await expect(material).toHaveValue("diamond_sword");
    await material.press("Control+s");
    await expect
        .poll(
            () => plugin.writes.at(-1)?.document.items[0]?.definition.material,
        )
        .toBe("minecraft:diamond_sword");
    await material.fill("custom:unknown_material");
    await material.press("Escape");
    await expect(material).toHaveValue("custom:unknown_material");
    await material.press("Escape");
    await expect(material).toHaveValue("diamond_sword");
    await material.fill("custom:unknown_material");
    await material.press("Control+s");
    await expect
        .poll(
            () => plugin.writes.at(-1)?.document.items[0]?.definition.material,
        )
        .toBe("custom:unknown_material");
});
