import { expect, test } from "@playwright/test";
import {
    formatNodeSchema,
    presentationBlockSchema,
} from "@itemerness/protocol";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import { enterWorkspace, mockPlugin } from "./fixtures/plugin.js";

test("missing referenced translations can be edited, saved, cleared and undone without disappearing", async ({
    page,
}, info) => {
    const document = structuredClone(baselineDocument);
    const item = document.items[0]!;
    item.presentation.nameMessage = "required.name";
    item.presentation.blocks = [
        presentationBlockSchema.parse({
            uuid: crypto.randomUUID(),
            type: "conditional",
            condition: {
                operator: "EXISTS",
                left: { kind: "data", key: "example:flag" },
            },
            thenBlocks: [
                {
                    uuid: crypto.randomUUID(),
                    type: "field",
                    labelMessage: "required.field",
                    data: "example:value",
                },
            ],
            otherwiseBlocks: [
                {
                    uuid: crypto.randomUUID(),
                    type: "description",
                    message: "required.description",
                },
                {
                    uuid: crypto.randomUUID(),
                    type: "repeat",
                    data: "example:compound",
                    maximumElements: 5,
                    template: {
                        labelMessage: "required.repeat.label",
                        missingMessage: "required.repeat.empty",
                        valuePath: "value",
                    },
                },
            ],
        }),
    ];
    document.formats.push(
        ...[
            {
                kind: "decimal",
                pattern: "0.0",
                suffixMessage: "required.suffix",
            },
            {
                kind: "boolean",
                trueMessage: "required.true",
                falseMessage: "required.false",
            },
            {
                kind: "list",
                elementFormat: "example:integer",
                separatorMessage: "required.separator",
            },
        ].map((format, index) =>
            formatNodeSchema.parse({
                uuid: crypto.randomUUID(),
                id: `example:missing-format-${index}`,
                ...format,
            }),
        ),
    );
    const plugin = await mockPlugin(page, document);
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    await page.getByTestId("open-translations").click();
    await page.getByTestId("locale-filter").fill("required.");
    const expectedKeys = [
        "name",
        "field",
        "description",
        "repeat.label",
        "repeat.empty",
        "suffix",
        "true",
        "false",
        "separator",
    ];
    for (const key of expectedKeys) {
        const cell = page.getByTestId(`message-en_us-required.${key}`);
        await expect(cell).toBeVisible();
        await expect(cell).toHaveValue("");
        await expect(cell).toHaveAttribute("placeholder", "Missing");
        await expect(cell.locator("..")).toHaveAttribute(
            "data-message-source",
            "missing",
        );
    }
    await page.mouse.move(1100, 100);
    await page.screenshot({ path: info.outputPath("missing-references.png") });
    const name = page.getByTestId("message-en_us-required.name");
    await name.fill("Recovered name");
    await expect
        .poll(
            () =>
                plugin.writes
                    .at(-1)
                    ?.document.locales.find((entry) => entry.locale === "en_us")
                    ?.messages["required.name"],
        )
        .toBe("Recovered name");
    await expect(name.locator("..")).toHaveAttribute(
        "data-message-source",
        "own",
    );
    await page.getByTestId("open-settings").click();
    await page.getByTestId("open-translations").click();
    await expect(page.getByTestId("locale-filter")).toHaveValue("required.");
    await expect(name).toHaveValue("Recovered name");
    await applicationMenuAction(page, "edit", "undo");
    await expect(name).toHaveValue("");
    await expect(name.locator("..")).toHaveAttribute(
        "data-message-source",
        "missing",
    );
    await applicationMenuAction(page, "edit", "redo");
    await name.click({ button: "right" });
    await page.getByTestId("menu-clear-translation").click();
    await expect(name).toBeVisible();
    await expect(name.locator("..")).toHaveAttribute(
        "data-message-source",
        "missing",
    );
    await applicationMenuAction(page, "edit", "undo");
    await expect(name).toHaveValue("Recovered name");
});

test("translation cells expose the resolved fallback text, actual locale and intentionally empty overrides", async ({
    page,
}, info) => {
    const document = structuredClone(baselineDocument);
    document.locales = [
        {
            uuid: crypto.randomUUID(),
            locale: "en_us",
            fallback: null,
            messages: {
                "test.inherited": "Default language",
                "test.empty": "",
            },
        },
        {
            uuid: crypto.randomUUID(),
            locale: "fr_fr",
            fallback: "en_us",
            messages: { "test.inherited": "French language" },
        },
        {
            uuid: crypto.randomUUID(),
            locale: "fr_ca",
            fallback: "fr_fr",
            messages: {},
        },
        {
            uuid: crypto.randomUUID(),
            locale: "de_de",
            fallback: null,
            messages: {},
        },
    ];
    await mockPlugin(page, document);
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    await page.getByTestId("open-translations").click();
    await page.getByTestId("locale-filter").fill("test.");
    const fallback = page.getByTestId("message-fr_ca-test.inherited");
    const defaulted = page.getByTestId("message-de_de-test.inherited");
    await expect(fallback).toHaveAttribute("placeholder", "French language");
    await expect(fallback).toHaveAccessibleDescription("Inherited from fr_fr");
    await expect(fallback.locator("..")).toHaveAttribute(
        "data-message-source",
        "fallback",
    );
    await expect(defaulted).toHaveValue("");
    await expect(defaulted).toHaveAttribute("placeholder", "Default language");
    await expect(defaulted).toHaveAccessibleDescription("Inherited from en_us");
    await expect(defaulted.locator("..")).toHaveClass("cell-fallback");
    await expect(defaulted.locator("..")).toHaveAttribute(
        "data-message-source",
        "default",
    );
    const inheritedEmpty = page.getByTestId("message-de_de-test.empty");
    await expect(inheritedEmpty).toHaveAttribute(
        "placeholder",
        "Empty translation",
    );
    await expect(inheritedEmpty).toHaveAccessibleDescription(
        "Inherited from en_us",
    );
    await expect(
        page.getByTestId("message-en_us-test.empty"),
    ).toHaveAccessibleDescription("Empty translation");
    await defaulted.fill("Own text");
    await defaulted.fill("");
    await expect(defaulted.locator("..")).toHaveAttribute(
        "data-message-source",
        "own",
    );
    await expect(defaulted).toHaveAccessibleDescription("Empty translation");
    await defaulted.click({ button: "right" });
    await page.getByTestId("menu-clear-translation").click();
    await expect(defaulted).toHaveAttribute("placeholder", "Default language");
    await expect(defaulted).toHaveAccessibleDescription("Inherited from en_us");
    await page.mouse.move(1100, 100);
    await page.screenshot({ path: info.outputPath("translation-sources.png") });
});
import { applicationMenuAction } from "./fixtures/applicationMenu.js";
