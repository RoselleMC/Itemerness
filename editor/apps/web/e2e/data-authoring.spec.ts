import { expect, test } from "@playwright/test";
import { presentationBlockSchema } from "@itemerness/protocol";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import { chooseValue, enterWorkspace, mockPlugin } from "./fixtures/plugin.js";

test("data labels follow real nested references and defaults are real schema edits", async ({
    page,
}) => {
    const document = structuredClone(baselineDocument);
    const key = document.dataSchemas[0]!.keys.find(
        (entry) => entry.id === "example:charges",
    )!;
    document.items.forEach((item) => {
        item.presentation.blocks = [];
    });
    document.items[0]!.presentation.blocks = [
        presentationBlockSchema.parse({
            uuid: crypto.randomUUID(),
            type: "conditional",
            condition: {
                operator: "EXISTS",
                left: { kind: "data", key: key.id },
            },
            thenBlocks: [],
            otherwiseBlocks: [
                {
                    uuid: crypto.randomUUID(),
                    type: "field",
                    data: key.id,
                    labelMessage: "custom.charges",
                },
            ],
        }),
    ];
    const plugin = await mockPlugin(page, document);
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    await page.getByTestId("mode-data").click();
    await page.getByTestId("datakey-charges").click();
    await page.getByTestId("data-label-input").fill("Available uses");
    await expect
        .poll(
            () =>
                plugin.writes
                    .at(-1)
                    ?.document.locales.find(
                        (locale) => locale.locale === "en_us",
                    )?.messages["custom.charges"],
        )
        .toBe("Available uses");
    expect(
        plugin.writes.at(-1)!.document.locales[0]!.messages[
            "data.charges.label"
        ],
    ).toBe(document.locales[0]!.messages["data.charges.label"]);
    const input = page.getByTestId("data-default-input");
    await input.fill("-");
    await page.getByTestId("datakey-quality").click();
    await expect(input).toHaveValue("-");
    await expect(input).toHaveAttribute("aria-invalid", "true");
    await input.press("Escape");
    await input.fill("42");
    await input.press("Enter");
    await expect
        .poll(
            () =>
                plugin.writes
                    .at(-1)
                    ?.document.dataSchemas[0]!.keys.find(
                        (entry) => entry.uuid === key.uuid,
                    )?.defaultValue,
        )
        .toEqual({ kind: "integer", value: "42" });
    expect(plugin.writes.at(-1)!.document.items).toEqual(document.items);
    await page.getByTestId("undo").click();
    await expect(input).toHaveValue("0");
    await page.getByTestId("data-default-toggle").click();
    await expect(input).toHaveCount(0);
    await expect
        .poll(
            () =>
                plugin.writes
                    .at(-1)
                    ?.document.dataSchemas[0]!.keys.find(
                        (entry) => entry.uuid === key.uuid,
                    )?.defaultValue,
        )
        .toBe(null);
});

test("recursive types, container defaults and constraints remain editable in a narrow inspector", async ({
    page,
}, info) => {
    const plugin = await mockPlugin(page);
    await page.setViewportSize({ width: 900, height: 800 });
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    await page.getByTestId("mode-data").click();
    await page.getByTestId("datakey-custom-label").click();
    await chooseValue(page, page.getByTestId("data-type-kind"), "list");
    await expect(page.getByTestId("data-type-element-kind")).toHaveAttribute(
        "data-field-value",
        "string",
    );
    const obsolete = page.getByTestId("data-constraint-maximumCodePoints");
    await obsolete.fill("");
    await obsolete.press("Enter");
    await expect(obsolete).toHaveCount(0);
    const count = page.getByTestId("data-constraint-maximumElements");
    await count.fill("257");
    await count.press("Enter");
    await expect(count).toHaveAttribute("aria-invalid", "true");
    await count.fill("256");
    await count.press("Enter");
    await page.getByTestId("data-default-toggle").click();
    await page
        .getByTestId("data-default")
        .getByRole("button", { name: "Add entry", exact: true })
        .click();
    const entry = page.getByTestId("data-default-0-input");
    await entry.fill("ordinary:full:text");
    await entry.press("Enter");
    await expect
        .poll(
            () =>
                plugin.writes
                    .at(-1)
                    ?.document.dataSchemas[0]!.keys.find(
                        (key) => key.id === "example:custom-label",
                    )?.defaultValue,
        )
        .toEqual({
            kind: "list",
            values: [{ kind: "string", value: "ordinary:full:text" }],
        });
    expect(
        await page
            .locator(".inspector")
            .evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
    await page.screenshot({
        path: info.outputPath("data-container-narrow.png"),
    });
});
