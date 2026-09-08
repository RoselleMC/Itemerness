import { expect, test, type Page } from "@playwright/test";
import {
    previewArtifactSchema,
    projectDocumentSchema,
    upgradeProjectDocument,
    type PreviewRequest,
    type ProjectDocument,
} from "@itemerness/protocol";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import {
    API_URL,
    HANDSHAKE,
    enterWorkspace,
    mockPlugin,
} from "./fixtures/plugin.js";

function fixture() {
    const document = upgradeProjectDocument(
        baselineDocument,
        (_schema, key) => ({
            readSources: [
                {
                    kind:
                        key.scope === "DEFINITION"
                            ? "catalogDefinition"
                            : "canonicalNbt",
                },
            ],
            access: {
                read: "PUBLIC",
                write: [key.scope === "DEFINITION" ? "definition" : "internal"],
            },
            placeholderApi: { exposed: false, formatter: null },
        }),
    );
    document.items[1]!.id = "equipment:travel-token";
    document.items[2]!.definition.contents = [
        { item: "equipment:travel-token", amount: 2 },
    ];
    return document;
}

async function start(page: Page, document: ProjectDocument) {
    const plugin = await mockPlugin(page, document);
    await page.route(`${API_URL}/api/handshake`, (route) =>
        route.fulfill({ json: { ...HANDSHAKE, documentSchemas: [1, 2] } }),
    );
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    await page.getByTestId("open-settings").click();
    await page.getByTestId("auto-save-toggle").uncheck();
    await page.getByTestId("mode-items").click();
    return plugin;
}

async function stableId(page: Page) {
    const details = page
        .getByTestId("global-inspector")
        .locator("details.advanced");
    if (!(await details.getAttribute("open")))
        await details.locator(":scope > summary").click();
    return page.getByTestId("item-stable-id");
}

test("same paths in different namespaces have separate selected production previews and cache entries", async ({
    page,
}) => {
    const document = fixture();
    await mockPlugin(page, document);
    await page.route(`${API_URL}/api/handshake`, (route) =>
        route.fulfill({ json: { ...HANDSHAKE, documentSchemas: [1, 2] } }),
    );
    const requests: PreviewRequest[] = [];
    await page.route(`${API_URL}/api/v2/preview`, (route) => {
        const input = route.request().postDataJSON() as PreviewRequest;
        requests.push(input);
        const line = {
            runs: [
                {
                    text: input.itemId,
                    kind: "TEXT",
                    style: { font: "minecraft:default" },
                },
            ],
            logicalWidthPixels: 150,
            visualBounds: { left: 0, right: 150, top: -7, bottom: 1 },
        };
        const artifact = previewArtifactSchema.parse({
            schemaVersion: 1,
            origin: "agent",
            itemId: input.itemId,
            viewer: input.viewer,
            display: {
                displayName: line,
                lore: [],
                tooltipStyle: null,
                renderer: "VANILLA_CHARACTER_FRAME",
                selectedTheme: "itemerness:vanilla-frame",
                requestedTheme: "itemerness:vanilla-frame",
                catalogRevision: 1,
            },
            fidelity: [],
            diagnostics: [],
            digests: {
                snapshot: input.snapshotHash,
                compiler: HANDSHAKE.compilerDigest,
            },
            failure: null,
        });
        return route.fulfill({ json: { artifact, stale: false } });
    });
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    await expect
        .poll(() => new Set(requests.map((request) => request.itemId)).size)
        .toBe(5);
    await expect(page.getByTestId("preview-name")).toHaveText(
        "itemerness:travel-token",
    );
    await page.getByTestId("item-equipment:travel-token").click();
    await expect(page.getByTestId("preview-name")).toHaveText(
        "equipment:travel-token",
    );
    const count = requests.length;
    await page.getByTestId("item-travel-token").click();
    await expect(page.getByTestId("preview-name")).toHaveText(
        "itemerness:travel-token",
    );
    await page.getByTestId("item-equipment:travel-token").click();
    await expect(page.getByTestId("preview-name")).toHaveText(
        "equipment:travel-token",
    );
    expect(requests).toHaveLength(count);
    expect(
        requests.some((request) =>
            request.itemId.startsWith("itemerness:equipment:"),
        ),
    ).toBe(false);
});

test("renaming migrates explicit contents atomically and undo keeps the selected object", async ({
    page,
}) => {
    const document = fixture();
    const plugin = await start(page, document);
    await page.getByTestId("item-equipment:travel-token").click();
    const input = await stableId(page);
    await input.fill("equipment:tools/token");
    await input.press("Control+s");
    await expect
        .poll(() => plugin.writes.at(-1)?.document.items[1]!.id)
        .toBe("equipment:tools/token");
    expect(
        plugin.writes.at(-1)!.document.items[2]!.definition.contents,
    ).toEqual([{ item: "equipment:tools/token", amount: 2 }]);
    expect(plugin.writes.at(-1)!.document.items[1]!.previewData).toEqual(
        document.items[1]!.previewData,
    );
    await expect(input).toHaveValue("equipment:tools/token");
    await expect(page.getByTestId("item-equipment:tools/token")).toHaveClass(
        /\bselected\b/,
    );
    await page.getByTestId("undo").click();
    await expect(page.getByTestId("item-equipment:travel-token")).toHaveClass(
        /\bselected\b/,
    );
    await expect(input).toHaveValue("equipment:travel-token");
    await page.keyboard.press("Control+s");
    await expect
        .poll(
            () =>
                plugin.writes.at(-1)?.document.items[2]!.definition.contents[0]!
                    .item,
        )
        .toBe("equipment:travel-token");
    await page.getByTestId("redo").click();
    await expect(input).toHaveValue("equipment:tools/token");
});

test("invalid aliases block save navigation and copy, and namespaced copies keep valid messages", async ({
    page,
}) => {
    const plugin = await start(page, fixture());
    await page.getByTestId("item-equipment:travel-token").click();
    const input = await stableId(page);
    await input.fill("itemerness:travel-token");
    await input.press("Control+s");
    await expect(input).toHaveAttribute("aria-invalid", "true");
    expect(plugin.writes).toHaveLength(0);
    await page.getByTestId("item-travel-token").click();
    await expect(input).toHaveValue("itemerness:travel-token");
    await expect(page.getByTestId("item-equipment:travel-token")).toHaveClass(
        /\bselected\b/,
    );
    await page.getByTestId("duplicate-item").click();
    await expect(
        page.getByTestId("item-equipment:travel-token-copy"),
    ).toHaveCount(0);
    await input.press("Escape");
    await expect(input).toHaveValue("equipment:travel-token");
    await page.getByTestId("duplicate-item").click();
    await page.keyboard.press("Control+s");
    await expect
        .poll(() => plugin.writes.at(-1)?.document.items.at(-1)?.id)
        .toBe("equipment:travel-token-copy");
    expect(
        projectDocumentSchema.safeParse(plugin.writes.at(-1)!.document).success,
    ).toBe(true);
    await expect(
        page.getByTestId("item-equipment:travel-token-copy"),
    ).toHaveClass(/\bselected\b/);
});

test("legacy ID editing does not silently upgrade document format", async ({
    page,
}) => {
    const plugin = await start(page, baselineDocument);
    const input = await stableId(page);
    await input.fill("equipment:token");
    await input.press("Control+s");
    await expect(input).toHaveAttribute("aria-invalid", "true");
    expect(plugin.writes).toHaveLength(0);
    await input.press("Escape");
    await input.fill("renamed-token");
    await input.press("Control+s");
    await expect
        .poll(() => plugin.writes.at(-1)?.document.items[0]!.id)
        .toBe("renamed-token");
    expect(plugin.writes.at(-1)!.document.schemaVersion).toBe(1);
    expect(plugin.writes.at(-1)!.document.measurement).toBeUndefined();
});

test("maximum-length resolved IDs remain contained in a narrow inspector", async ({
    page,
}, info) => {
    await start(page, fixture());
    const input = await stableId(page);
    await input.fill("p".repeat(245));
    await input.press("Enter");
    await page.setViewportSize({ width: 390, height: 844 });
    await input.scrollIntoViewIfNeeded();
    await expect(page.getByTestId("global-inspector")).toBeVisible();
    expect(
        await page
            .getByTestId("global-inspector")
            .evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
    await page.screenshot({
        path: info.outputPath("item-identity-narrow.png"),
    });
});
