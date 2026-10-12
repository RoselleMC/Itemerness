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

/** The text every visible tooltip row exposes, connectors included. */
const rows = (page: Page) =>
    page
        .locator(".line-hit")
        .evaluateAll((elements) =>
            elements.map((element) => element.getAttribute("aria-label") ?? ""),
        );

test("groups are authored on the canvas and painted locally with connectors", async ({
    page,
}) => {
    const plugin = await mockPlugin(page, baselineDocument);
    // Every production reply is withheld: all connectors below come from the local draft.
    await page.route(`${API_URL}/api/v2/preview`, (route) =>
        route.abort("blockedbyclient"),
    );
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);

    // Insert an empty tree group below the description, from the canvas.
    await page
        .locator(`.line-hit[data-origin="${description.uuid}"]`)
        .first()
        .click();
    await page.getByTestId("insert-after").click();
    await page.getByTestId("add-group-row").click();
    await expect(page.getByTestId("group-marker")).toHaveAttribute(
        "data-field-value",
        "TREE",
    );
    await expect
        .poll(() => blocksOf(plugin.writes.at(-1)?.document).at(-1)?.type)
        .toBe("group");
    const group = blocksOf(plugin.writes.at(-1)?.document).at(-1)!;

    // An empty group has no rows; the outline adds its contents.
    for (const control of ["add-text-row", "add-field-row"]) {
        await page.getByTestId("content-menu").click();
        await page.getByTestId(`add-branch-${group.uuid}-children`).click();
        await page.getByTestId(control).click();
        await expect(page.getByTestId("content-inspector")).toBeVisible();
    }
    await expect
        .poll(async () => (await rows(page)).filter((row) => /[├└]─/.test(row)))
        .toEqual([
            "├─ New line of text.",
            expect.stringMatching(/^└─ created at: /i),
        ]);
    await expect(
        page.getByTestId("item-status-travel-token"),
    ).not.toHaveAttribute("data-state", "verified");

    // Bullets replace the connectors at the same level; the group is reached from its child.
    await page.getByTestId(`select-parent-${group.uuid}`).click();
    await chooseValue(page, page.getByTestId("group-marker"), "BULLET");
    await expect
        .poll(async () =>
            (await rows(page)).filter((row) => row.startsWith("•")),
        )
        .toHaveLength(2);
    await chooseValue(page, page.getByTestId("group-marker"), "TREE");

    // Bind the last child to data this item does not have: it is omitted, and the previous
    // child takes the last connector.
    await page.locator('.line-hit[aria-label^="└─ "]').click();
    await page
        .getByTestId("content-inspector")
        .getByLabel("Data", { exact: true })
        .click();
    await page
        .getByRole("option")
        .and(page.locator('[data-option-value="example:custom-label"]'))
        .click();
    await expect
        .poll(async () => (await rows(page)).filter((row) => /[├└]─/.test(row)))
        .toEqual(["└─ New line of text."]);

    // Wrap an existing row in a new group, then undo and redo it as one step.
    await page
        .locator(`.line-hit[data-origin="${charges.uuid}"]`)
        .first()
        .click({ button: "right" });
    await page.getByTestId("menu-put-in-group").click();
    await expect(page.getByTestId("group-marker")).toBeVisible();
    await expect.poll(() => rows(page)).toContain("└─ Charges: 3");
    await page.getByTestId("undo").click();
    await expect.poll(() => rows(page)).toContain("Charges: 3");
    await expect.poll(() => rows(page)).not.toContain("└─ Charges: 3");
    await page.getByTestId("redo").click();
    await expect.poll(() => rows(page)).toContain("└─ Charges: 3");
    await expect
        .poll(() => blocksOf(plugin.writes.at(-1)?.document)[1]?.type)
        .toBe("group");
    const wrapper = blocksOf(plugin.writes.at(-1)?.document)[1]!;

    // Ungroup from the group's own context menu in the outline.
    await page.getByTestId("content-menu").click();
    await page
        .getByTestId(`select-content-${wrapper.uuid}`)
        .click({ button: "right" });
    await page.getByTestId("menu-ungroup").click();
    await expect.poll(() => rows(page)).toContain("Charges: 3");
    await expect.poll(() => rows(page)).not.toContain("└─ Charges: 3");
    await page.getByTestId("undo").click();
    await expect.poll(() => rows(page)).toContain("└─ Charges: 3");
    await page.getByTestId("redo").click();
    await expect.poll(() => rows(page)).not.toContain("└─ Charges: 3");

    // Saving writes the group with only non-default options and leaves the root implicit.
    await page.getByTestId("toggle-navigation").focus();
    await page.keyboard.press("ControlOrMeta+s");
    await expect
        .poll(() =>
            blocksOf(plugin.writes.at(-1)?.document).map((block) => block.type),
        )
        .toEqual(["field", "field", "description", "group"]);
    const saved = plugin.writes.at(-1)!.document;
    const written = blocksOf(saved).at(-1)!;
    if (written.type !== "group") throw new Error("expected a group");
    expect(Object.keys(written).sort()).toEqual(
        ["anchor", "children", "marker", "style", "type", "uuid"].sort(),
    );
    expect(written.uuid).toBe(group.uuid);
    expect(written.marker).toBe("TREE");
    expect(written.children.map((child) => child.type)).toEqual([
        "description",
        "field",
    ]);
    const omitted = written.children[1]!;
    expect(omitted.type === "field" && omitted.data).toBe(
        "example:custom-label",
    );
    const presentation = saved.items.find(
        (item) => item.uuid === token.uuid,
    )!.presentation;
    expect(Object.hasOwn(presentation, "marker")).toBe(false);
    expect(Object.hasOwn(presentation, "dividers")).toBe(false);
});
