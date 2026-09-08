import { expect, test } from "@playwright/test";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import { contentHash, type PresentationBlock } from "@itemerness/protocol";
import {
    API_URL,
    enterWorkspace,
    mockPlugin,
    selectContent,
} from "./fixtures/plugin.js";

test("all six content kinds can be inserted with production preview replies blocked", async ({
    page,
}) => {
    const document = structuredClone(baselineDocument);
    const satchel = document.items.find(
        (item) => item.id === "nested-satchel",
    )!;
    document.items = [
        satchel,
        ...document.items.filter((item) => item !== satchel),
    ];
    satchel.presentation.blocks = [];
    const plugin = await mockPlugin(page, document);
    await page.route(`${API_URL}/api/v2/preview`, (route) =>
        route.abort("blockedbyclient"),
    );
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    const kinds = [
        ["add-field-row", "field"],
        ["add-text-row", "description"],
        ["add-value-row", "text"],
        ["add-conditional-row", "conditional"],
        ["add-repeat-row", "repeat"],
        ["add-nested-row", "nestedItemList"],
    ] as const;
    for (const [control, kind] of kinds) {
        await selectContent(page, "name");
        await page.getByTestId("insert-after").click();
        await expect(page.getByTestId(control)).toBeEnabled();
        await page.getByTestId(control).click();
        await expect(page.getByTestId("content-inspector")).toBeVisible();
        await expect
            .poll(
                () =>
                    plugin.writes.at(-1)?.document.items[0]?.presentation
                        .blocks[0]?.type,
            )
            .toBe(kind);
        await expect(
            page.getByTestId("item-status-nested-satchel"),
        ).not.toHaveAttribute("data-state", "verified");
    }
    expect(
        plugin.writes
            .at(-1)!
            .document.items[0]!.presentation.blocks.map((block) => block.type),
    ).toEqual([...kinds].reverse().map(([, kind]) => kind));
    let expectedHash = contentHash(document);
    for (const write of plugin.writes) {
        expect(write.expectedHash).toBe(expectedHash);
        expectedHash = contentHash(write.document);
    }
    await page.getByTestId("undo").click();
    await expect
        .poll(
            () =>
                plugin.writes.at(-1)?.document.items[0]?.presentation.blocks[0]
                    ?.type,
        )
        .toBe("repeat");
    await page.getByTestId("redo").click();
    await expect
        .poll(
            () =>
                plugin.writes.at(-1)?.document.items[0]?.presentation.blocks[0]
                    ?.type,
        )
        .toBe("nestedItemList");
});

test("outline reaches empty condition branches by keyboard and preserves branch ownership", async ({
    page,
}, info) => {
    const document = structuredClone(baselineDocument);
    const ember = document.items.find((item) => item.id === "ember-blade")!;
    document.items = [
        ember,
        ...document.items.filter((item) => item !== ember),
    ];
    const parent = ember.presentation.blocks.find(
        (block) => block.type === "conditional",
    )!;
    if (parent.type !== "conditional")
        throw new Error("Missing conditional fixture");
    parent.thenBlocks = [];
    parent.otherwiseBlocks = [];
    ember.presentation.blocks = [parent];
    const plugin = await mockPlugin(page, document);
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);

    for (const branch of ["thenBlocks", "otherwiseBlocks"] as const) {
        await page.getByTestId("content-menu").click();
        const target = page.getByTestId(`add-branch-${parent.uuid}-${branch}`);
        await expect(target).toBeVisible();
        await target.focus();
        await page.keyboard.press("Enter");
        await expect(page.getByTestId("back-to-outline")).toBeFocused();
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("ArrowDown");
        await expect(page.getByTestId("add-text-row")).toBeFocused();
        await page.keyboard.press("Enter");
        await expect
            .poll(() => {
                const saved =
                    plugin.writes.at(-1)?.document.items[0]?.presentation
                        .blocks[0];
                return saved?.type === "conditional" ? saved[branch].length : 0;
            })
            .toBe(1);
    }
    const saved = plugin.writes.at(-1)!.document.items[0]!.presentation
        .blocks[0] as Extract<PresentationBlock, { type: "conditional" }>;
    expect(
        plugin.writes.at(-1)!.document.items[0]!.presentation.blocks,
    ).toHaveLength(1);
    expect(saved.thenBlocks[0]!.uuid).not.toBe(saved.otherwiseBlocks[0]!.uuid);
    await page.setViewportSize({ width: 900, height: 800 });
    await page.getByTestId("content-menu").click();
    await page.getByTestId(`add-branch-${parent.uuid}-otherwiseBlocks`).click();
    await expect(page.getByTestId("add-repeat-row")).toBeVisible();
    const popup = page.getByRole("menu", { name: "Content", exact: true });
    await page.screenshot({
        path: info.outputPath("empty-branch-add-menu.png"),
        fullPage: true,
    });
    await page.keyboard.press("Escape");
    await expect(
        page.getByTestId(`add-branch-${parent.uuid}-thenBlocks`),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("content-menu")).toBeFocused();
    await expect(popup).toHaveCount(0);
});
