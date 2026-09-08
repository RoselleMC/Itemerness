import { expect, test } from "@playwright/test";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import { presentationBlockSchema } from "@itemerness/protocol";
import {
    enterWorkspace,
    mockPlugin,
    selectContent,
} from "./fixtures/plugin.js";

test("valid larger libraries and long authored fields remain editable without truncation", async ({
    page,
}) => {
    const document = structuredClone(baselineDocument);
    document.viewerFacts[0]!.providers = Array.from(
        { length: 32 },
        (_, index) => `source-${index}`,
    );
    while (document.formats.length < 512)
        document.formats.push({
            ...structuredClone(document.formats[0]!),
            uuid: crypto.randomUUID(),
            id: `bounds:format-${document.formats.length}`,
        });
    while (document.fonts.length < 128)
        document.fonts.push({
            uuid: crypto.randomUUID(),
            id: `bounds:font-${document.fonts.length}`,
            metrics: "explicit",
            fallback: null,
            fallbackAdvancePixels: null,
            advances: null,
        });
    const plugin = await mockPlugin(page, document);
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    await page.getByTestId("open-assets").click();
    await page.getByTestId("asset-tab-runtime").click();
    await page.getByTestId("asset-create").click();
    await page.getByTestId("asset-id").fill("bounds:new-font");
    await page.getByTestId("asset-id").press("Enter");
    await page.getByTestId("asset-apply").click();
    await page.keyboard.press("ControlOrMeta+s");
    await expect
        .poll(() => plugin.writes.at(-1)?.document.fonts.length)
        .toBe(129);

    await page.getByTestId("asset-section-resourcePackBindings").click();
    await page.getByTestId("asset-bindingEnabled").uncheck();
    await page
        .getByTestId("asset-sha1")
        .fill("Pending hash for disabled binding");
    await page.getByTestId("asset-sha1").press("Enter");
    await page.keyboard.press("ControlOrMeta+s");
    await expect
        .poll(
            () => plugin.writes.at(-1)?.document.resourcePackBindings[0]?.sha1,
        )
        .toBe("Pending hash for disabled binding");

    await page.getByTestId("mode-formats").click();
    await page.getByTestId("add-formats").click();
    await page.keyboard.press("ControlOrMeta+s");
    await expect
        .poll(() => plugin.writes.at(-1)?.document.formats.length)
        .toBe(513);
    await page.getByTestId("formats-itemerness:integer").click();
    await page.getByTestId("format-pattern").fill("'" + "x".repeat(80) + "'0");
    await page.getByTestId("format-pattern").press("Enter");
    await page.keyboard.press("ControlOrMeta+s");
    await expect
        .poll(
            () =>
                plugin.writes
                    .at(-1)
                    ?.document.formats.find((entry) => entry.kind === "integer")
                    ?.pattern,
        )
        .toBe("'" + "x".repeat(80) + "'0");
    await page.getByTestId("format-pattern").fill("");
    await page.getByTestId("format-pattern").press("Enter");
    await page.keyboard.press("ControlOrMeta+s");
    await expect
        .poll(
            () =>
                plugin.writes
                    .at(-1)
                    ?.document.formats.find((entry) => entry.kind === "integer")
                    ?.pattern,
        )
        .toBe("");

    await page.getByTestId("mode-facts").click();
    await page.getByTestId(`facts-${document.viewerFacts[0]!.id}`).click();
    await page.getByTestId("fact-add-provider-input").fill("additional-source");
    await page.getByTestId("fact-add-provider").click();
    await page.keyboard.press("ControlOrMeta+s");
    await expect
        .poll(
            () =>
                plugin.writes.at(-1)?.document.viewerFacts[0]?.providers.length,
        )
        .toBe(33);

    await page.getByTestId("open-translations").click();
    const messageKey = Object.keys(document.locales[0]!.messages)[0]!;
    const input = page.getByRole("textbox", {
        name: `${messageKey} (${document.locales[0]!.locale})`,
        exact: true,
    });
    const text = "x".repeat(8193);
    await input.fill(text);
    await page.keyboard.press("ControlOrMeta+s");
    await expect(input).toHaveValue(text);
    await expect
        .poll(
            () =>
                plugin.writes.at(-1)?.document.locales[0]?.messages[messageKey],
        )
        .toBe(text);
});

test("compound field creation reports the real key limit without truncating typed text", async ({
    page,
}) => {
    const document = structuredClone(baselineDocument);
    const block = presentationBlockSchema.parse({
        uuid: crypto.randomUUID(),
        type: "conditional",
        condition: {
            operator: "EXISTS",
            left: { kind: "literal", value: { kind: "compound", entries: {} } },
            right: null,
        },
        thenBlocks: [],
        otherwiseBlocks: [],
    });
    document.items[0]!.presentation.blocks = [block];
    const plugin = await mockPlugin(page, document);
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    await selectContent(page, block.uuid);
    const editor = page.getByTestId(`condition-${block.uuid}-left-literal`);
    const input = editor.getByRole("textbox", {
        name: "Field name",
        exact: true,
    });
    await input.fill("x".repeat(129));
    await expect(input).toHaveValue("x".repeat(129));
    await expect(input).toHaveAttribute("aria-invalid", "true");
    await expect(
        editor.getByRole("button", { name: "Add field", exact: true }),
    ).toBeDisabled();
    await expect(editor.getByRole("alert")).toContainText("128");
    await input.fill("x".repeat(128));
    await editor
        .getByRole("button", { name: "Add field", exact: true })
        .click();
    await page.keyboard.press("ControlOrMeta+s");
    await expect
        .poll(() => {
            const value =
                plugin.writes.at(-1)?.document.items[0]?.presentation.blocks[0];
            return value?.type === "conditional" &&
                value.condition.left.kind === "literal" &&
                value.condition.left.value.kind === "compound"
                ? Object.keys(value.condition.left.value.entries)
                : [];
        })
        .toEqual(["x".repeat(128)]);
});
