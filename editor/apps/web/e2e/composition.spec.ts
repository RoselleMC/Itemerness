import { expect, test, type Page } from "@playwright/test";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import type { PresentationBlock, ProjectDocument } from "@itemerness/protocol";
import {
    API_URL,
    chooseValue,
    enterWorkspace,
    mockPlugin,
} from "./fixtures/plugin.js";

const token = baselineDocument.items[0]!;
const [, charges, description] = token.presentation.blocks as [
    PresentationBlock,
    PresentationBlock,
    PresentationBlock,
];

const blocksOf = (document: ProjectDocument | undefined) =>
    document?.items.find((item) => item.uuid === token.uuid)?.presentation
        .blocks ?? [];

const rows = (page: Page) =>
    page
        .locator(".line-hit")
        .evaluateAll((elements) =>
            elements.map((element) => element.getAttribute("aria-label") ?? ""),
        );

test("composed rows, rules and hiding settings are authored and painted locally", async ({
    page,
}) => {
    const plugin = await mockPlugin(page, baselineDocument);
    // Every production reply is withheld: the rows below come from the local draft.
    await page.route(`${API_URL}/api/v2/preview`, (route) =>
        route.abort("blockedbyclient"),
    );
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);

    // A row starts with one text part on the left.
    await page
        .locator(`.line-hit[data-origin="${description.uuid}"]`)
        .first()
        .click();
    await page.getByTestId("insert-after").click();
    await page.getByTestId("add-row-row").click();
    await expect
        .poll(() => blocksOf(plugin.writes.at(-1)?.document).at(-1)?.type)
        .toBe("row");
    const row = blocksOf(plugin.writes.at(-1)?.document).at(-1)!;
    const prefix = row.uuid.slice(0, 8);
    await page.getByTestId(`row-left-${prefix}-0-text`).fill("Greatsword");
    await page.getByTestId(`row-right-${prefix}-add`).click();
    await page.getByTestId(`row-right-${prefix}-0-text`).fill("[RMB]");
    await expect
        .poll(async () =>
            (await rows(page)).find((line) => line.includes("Greatsword")),
        )
        .toMatch(/^Greatsword.*\[RMB\]$/);

    // A literal part keeps its characters.
    await page.getByTestId(`row-left-${prefix}-add`).click();
    await chooseValue(
        page,
        page.getByTestId(`row-left-${prefix}-1-kind`),
        "literal",
    );
    await page.getByTestId(`row-left-${prefix}-1-literal`).fill(" »");
    await page.getByTestId(`row-left-${prefix}-1-literal`).press("Enter");
    await expect
        .poll(async () =>
            (await rows(page)).find((line) => line.includes("Greatsword")),
        )
        .toMatch(/^Greatsword ».*\[RMB\]$/);

    // A rule below the row is measured across the tooltip.
    await page.locator(`.line-hit[data-origin="${row.uuid}"]`).first().click();
    await page.getByTestId("insert-after").click();
    await page.getByTestId("add-rule-row").click();
    await expect
        .poll(async () => (await rows(page)).some((line) => /^─+$/.test(line)))
        .toBe(true);

    // The row declares a slot that the charges row can summarize into once hidden.
    await page.locator(`.line-hit[data-origin="${row.uuid}"]`).first().click();
    await page.getByTestId(`row-right-${prefix}-add`).click();
    await chooseValue(
        page,
        page.getByTestId(`row-right-${prefix}-1-kind`),
        "slot",
    );
    await page
        .locator(`.line-hit[data-origin="${charges.uuid}"]`)
        .first()
        .click();
    const hiding = page.getByTestId(`hiding-${charges.uuid.slice(0, 8)}`);
    await hiding.locator("summary").click();
    await chooseValue(
        page,
        hiding.getByTestId(`hiding-${charges.uuid.slice(0, 8)}-mode`),
        "ranked",
    );
    await chooseValue(
        page,
        hiding.getByTestId(`hiding-${charges.uuid.slice(0, 8)}-slot`),
        "more",
    );

    // Undo steps back through the summary as one change.
    await page.getByTestId("undo").click();
    await expect
        .poll(() => blocksOf(plugin.writes.at(-1)?.document)[1]?.summary)
        .toBeUndefined();
    await page.getByTestId("redo").click();

    await page.getByTestId("toggle-navigation").focus();
    await page.keyboard.press("ControlOrMeta+s");
    await expect
        .poll(() =>
            blocksOf(plugin.writes.at(-1)?.document).map((block) => block.type),
        )
        .toEqual(["field", "field", "description", "row", "rule"]);
    const saved = blocksOf(plugin.writes.at(-1)!.document);
    expect(saved[1]!.weight).toBe(0);
    expect(saved[1]!.summary).toEqual({
        slot: "more",
        piece: { kind: "literal", text: "+" },
    });
    const writtenRow = saved[3]!;
    if (writtenRow.type !== "row") throw new Error("expected a row");
    expect(writtenRow.left.map((fragment) => fragment.kind)).toEqual([
        "message",
        "literal",
    ]);
    expect(writtenRow.right.map((fragment) => fragment.kind)).toEqual([
        "message",
        "slot",
    ]);
    const writtenRule = saved[4]!;
    expect(writtenRule.type === "rule" && writtenRule.title).toEqual([]);
    expect(Object.hasOwn(writtenRule, "weight")).toBe(false);
});
