import { expect, test, type Page } from "@playwright/test";
import { contentHash, type FormatNode } from "@itemerness/protocol";
import {
    API_URL,
    chooseValue,
    enterWorkspace,
    mockPlugin,
} from "./fixtures/plugin.js";

async function enter(page: Page, mode: "formats" | "facts", id: string) {
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    await page.getByTestId(`mode-${mode}`).click();
    await page.getByTestId(`${mode}-${id}`).click();
}
async function commit(page: Page, id: string, value: string) {
    await page.getByTestId(id).fill(value);
    await page.getByTestId(id).press("Enter");
}
async function pixels(page: Page) {
    return page.getByTestId("tooltip-canvas").evaluate((node) => {
        const canvas = node as HTMLCanvasElement;
        const data = canvas
            .getContext("2d")!
            .getImageData(0, 0, canvas.width, canvas.height).data;
        let hash = 2166136261;
        for (let index = 0; index < data.length; index += 17)
            hash = Math.imul(hash ^ data[index]!, 16777619) >>> 0;
        return `${canvas.width}x${canvas.height}:${hash}`;
    });
}

test("formatters choose an actual user and paint cold pattern edits with atomic rename and CAS", async ({
    page,
}) => {
    const plugin = await mockPlugin(page);
    await page.route(`${API_URL}/api/v2/preview`, (route) =>
        route.abort("blockedbyclient"),
    );
    await enter(page, "formats", "itemerness:integer");
    await expect(page.getByTestId("tooltip-canvas")).toBeVisible();
    const before = await pixels(page);
    await commit(page, "format-pattern", "00000");
    await expect.poll(() => pixels(page)).not.toBe(before);
    await commit(page, "formats-id", "example:whole-number");
    await page.keyboard.press("ControlOrMeta+s");
    await expect
        .poll(() => plugin.writes.at(-1)?.document.formats[0]?.id)
        .toBe("example:whole-number");
    expect(JSON.stringify(plugin.writes.at(-1)!.document.items)).not.toContain(
        '"format":"itemerness:integer"',
    );
    await expect(page.getByTestId("delete-formats")).toBeDisabled();
    for (let index = 1; index < plugin.writes.length; index++)
        expect(plugin.writes[index]!.expectedHash).toBe(
            contentHash(plugin.writes[index - 1]!.document),
        );
    await page.getByTestId("undo").click();
    await expect(page.getByTestId("formats-id")).toHaveValue(
        "itemerness:integer",
    );
});

test("format type changes stage complete settings and keep invalid buffers out of saves", async ({
    page,
}) => {
    const plugin = await mockPlugin(page);
    await enter(page, "formats", "itemerness:integer");
    await chooseValue(page, page.getByTestId("format-kind"), "boolean");
    await page.getByTestId("format-apply").click();
    await expect(page.getByRole("alert")).toContainText(
        "Complete all required",
    );
    await commit(page, "format-trueMessage", "format.boolean.true");
    await commit(page, "format-falseMessage", "format.boolean.false");
    await page.keyboard.press("ControlOrMeta+s");
    await expect(page.getByRole("alert")).toContainText("Apply or cancel");
    expect(plugin.writes).toHaveLength(0);
    await page.getByTestId("format-apply").click();
    await page.keyboard.press("ControlOrMeta+s");
    await expect
        .poll(() => plugin.writes.at(-1)?.document.formats[0]?.kind)
        .toBe("boolean");
    await chooseValue(page, page.getByTestId("format-kind"), "decimal");
    await page.getByTestId("format-multiply").fill("1e-");
    await page.getByTestId("format-apply").click();
    await expect(page.getByTestId("format-multiply")).toHaveAttribute(
        "aria-invalid",
        "true",
    );
    const count = plugin.writes.length;
    await page.keyboard.press("ControlOrMeta+s");
    expect(plugin.writes.length).toBe(count);
    await page.getByTestId("format-cancel").click();
    await expect(page.getByTestId("format-kind")).toHaveAttribute(
        "data-field-value",
        "boolean",
    );
    await chooseValue(page, page.getByTestId("format-kind"), "integer");
    await expect(page.getByTestId("format-pattern")).toHaveValue("0");
    await page.getByTestId("format-apply").click();
    await page.keyboard.press("ControlOrMeta+s");
    await expect
        .poll(() => plugin.writes.at(-1)?.document.formats[0]?.kind)
        .toBe("integer");
});

test("format list creation requires explicit resources and preserves key modes", async ({
    page,
}) => {
    const plugin = await mockPlugin(page);
    await enter(page, "formats", "itemerness:key-path");
    await chooseValue(page, page.getByTestId("format-keyMode"), "MESSAGE");
    await commit(page, "format-messagePattern", "values.{namespace}.{path}");
    await chooseValue(page, page.getByTestId("format-missingValue"), "ERROR");
    await expect(page.getByTestId("format-apply")).toHaveCount(0);
    await page.getByTestId("add-formats").click();
    await chooseValue(page, page.getByTestId("format-kind"), "list");
    await chooseValue(
        page,
        page.getByTestId("format-elementFormat"),
        "itemerness:key-path",
    );
    await commit(page, "format-separatorMessage", "format.list-separator");
    await page.getByTestId("format-apply").click();
    await page.keyboard.press("ControlOrMeta+s");
    await expect
        .poll(() => plugin.writes.at(-1)?.document.formats.at(-1)?.kind)
        .toBe("list");
    const format = plugin.writes.at(-1)!.document.formats.at(-1) as Extract<
        FormatNode,
        { kind: "list" }
    >;
    expect(format.elementFormat).toBe("itemerness:key-path");
    await page.getByTestId("delete-formats").click();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page.getByTestId(`formats-${format.id}`)).toHaveCount(0);
    await page.getByTestId("undo").click();
    await expect(page.getByTestId(`formats-${format.id}`)).toBeVisible();
});

test("viewer facts distinguish defaults from cold preview overrides and preserve typed values", async ({
    page,
}) => {
    const plugin = await mockPlugin(page);
    await page.route(`${API_URL}/api/v2/preview`, (route) =>
        route.abort("blockedbyclient"),
    );
    await enter(page, "facts", "example:level");
    const before = await pixels(page);
    await commit(page, "fact-defaultValue-input", "99");
    expect(await pixels(page)).toBe(before);
    await commit(page, "fact-previewValue-input", "99");
    await expect.poll(() => pixels(page)).not.toBe(before);
    await chooseValue(page, page.getByTestId("fact-type"), "LONG");
    await commit(page, "fact-defaultValue-input", "9223372036854775807");
    await commit(page, "fact-previewValue-input", "9223372036854775808");
    await expect(page.getByTestId("fact-previewValue-input")).toHaveAttribute(
        "aria-invalid",
        "true",
    );
    await page.getByTestId("fact-previewValue-input").press("Escape");
    await commit(page, "facts-id", "example:viewer-level");
    await page.keyboard.press("ControlOrMeta+s");
    await expect
        .poll(
            () =>
                plugin.writes
                    .at(-1)
                    ?.document.viewerFacts.find(
                        (fact) => fact.id === "example:viewer-level",
                    )?.defaultValue,
        )
        .toEqual({ kind: "integer", value: "9223372036854775807" });
    expect(JSON.stringify(plugin.writes.at(-1)!.document.items)).not.toContain(
        '"key":"example:level"',
    );
    await expect(page.getByTestId("delete-facts")).toBeDisabled();
    await chooseValue(page, page.getByTestId("fact-type"), "BOOLEAN");
    await chooseValue(page, page.getByTestId("fact-type"), "LONG");
    await expect(page.getByTestId("fact-defaultValue-input")).toHaveValue(
        "9223372036854775807",
    );
});

test("fact providers and nullable defaults are complete CRUD with narrow-window controls", async ({
    page,
}, testInfo) => {
    const plugin = await mockPlugin(page);
    await enter(page, "facts", "itemerness:locale");
    await expect(page.getByTestId("delete-facts")).toBeEnabled();
    await expect(page.getByTestId("facts-id")).toHaveValue("itemerness:locale");
    await commit(page, "fact-defaultValue-input", "xx_missing");
    await expect(page.getByTestId("fact-defaultValue-input")).toHaveAttribute(
        "aria-invalid",
        "true",
    );
    await page.getByTestId("fact-defaultValue-input").press("Escape");
    await page.getByTestId("add-facts").click();
    await commit(page, "facts-id", "itemerness:custom-fact");
    await page.getByTestId("fact-nullable").uncheck();
    await expect(page.getByTestId("fact-defaultValue-input")).toHaveValue("");
    await page.getByTestId("fact-cacheKey").uncheck();
    await page.getByTestId("fact-add-provider-input").fill("custom-provider");
    await page.getByTestId("fact-add-provider").click();
    await page.getByTestId("fact-provider-1-up").click();
    await expect(page.getByTestId("fact-provider-0")).toHaveValue(
        "custom-provider",
    );
    await page.getByTestId("fact-provider-1-delete").click();
    await expect(page.getByTestId("fact-provider-0-delete")).toBeDisabled();
    await page.keyboard.press("ControlOrMeta+s");
    await expect
        .poll(
            () => plugin.writes.at(-1)?.document.viewerFacts.at(-1)?.providers,
        )
        .toEqual(["custom-provider"]);
    expect(plugin.writes.at(-1)!.document.viewerFacts.at(-1)).toMatchObject({
        nullable: false,
        cacheKey: false,
        previewValue: null,
        defaultValue: { kind: "string", value: "" },
    });
    for (const width of [390, 900]) {
        await page.setViewportSize({ width, height: 900 });
        await page.getByTestId("fact-type").scrollIntoViewIfNeeded();
        await expect(page.getByTestId("fact-defaultValue-input")).toBeVisible();
        const escaped = await page
            .locator(
                ".presentation-inspector input, .presentation-inspector button",
            )
            .evaluateAll((nodes) =>
                nodes
                    .filter((node) => {
                        const rect = node.getBoundingClientRect();
                        const parent = node
                            .closest(".inspector")!
                            .getBoundingClientRect();
                        return (
                            rect.width > 0 &&
                            node.getAttribute("aria-hidden") !== "true" &&
                            (rect.left < parent.left - 1 ||
                                rect.right > parent.right + 1)
                        );
                    })
                    .map((node) => ({
                        id: node.getAttribute("data-testid"),
                        html: node.outerHTML,
                        bounds: node.getBoundingClientRect().toJSON(),
                    })),
            );
        await page.screenshot({
            path: testInfo.outputPath(`viewer-facts-${width}.png`),
        });
        expect(escaped).toEqual([]);
    }
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.getByTestId("delete-facts").scrollIntoViewIfNeeded();
    await page.getByTestId("delete-facts").click();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page.getByTestId("facts-itemerness:custom-fact")).toHaveCount(
        0,
    );
});

test("built-in fact role changes require confirmation and cancel without document changes", async ({
    page,
}) => {
    const plugin = await mockPlugin(page);
    await enter(page, "facts", "itemerness:locale");
    await page.getByTestId("facts-id").fill("example:locale");
    await page.keyboard.press("ControlOrMeta+s");
    await expect(page.getByRole("alertdialog")).toContainText(
        "no longer serve this system role",
    );
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("facts-id")).toHaveValue("itemerness:locale");
    expect(plugin.writes).toHaveLength(0);
    await page.getByTestId("delete-facts").click();
    await expect(page.getByRole("alertdialog")).toContainText("system role");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(plugin.writes).toHaveLength(0);
    await chooseValue(page, page.getByTestId("fact-type"), "INTEGER");
    await expect(
        page.getByText("The system role reads Locale values.", {
            exact: false,
        }),
    ).toBeVisible();
    await page.keyboard.press("ControlOrMeta+s");
    await expect
        .poll(() => plugin.writes.at(-1)?.document.viewerFacts[0]?.type)
        .toBe("INTEGER");
    await commit(page, "facts-id", "example:locale");
    await page.getByRole("button", { name: "Rename", exact: true }).click();
    await expect(page.getByTestId("facts-example:locale")).toBeVisible();
    await page.getByTestId("undo").click();
    await expect(page.getByTestId("facts-id")).toHaveValue("itemerness:locale");
});
