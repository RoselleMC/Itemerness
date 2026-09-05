import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
    expect,
    test,
    type APIRequestContext,
    type Page,
} from "@playwright/test";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import {
    contentHash,
    itemTemplateSchema,
    projectDocumentSchema,
    withItemTemplateRegistry,
    type PreviewRequest,
    type ProjectDocument,
    type RunoRpgCatalog,
    type RunoRpgCatalogItemUpdate,
} from "@itemerness/protocol";

/**
 * Editor end-to-end coverage, against the redesigned shell.
 *
 * Two things are proven. First, the editing loop the product exists for: pick an item by its name,
 * type a new name and watch the tooltip change, add a row, switch the previewed language, mount a
 * resource pack. Second, that the honesty labelling stays wired to reality: badges change when
 * assets are mounted or a server compiles the draft, and never claim what only the client knows.
 */

const VANILLA_BUNDLE = fileURLToPath(
    new URL("../../../vanilla-cache/vanilla-1.21.11.zip", import.meta.url),
);
const hasVanillaBundle = existsSync(VANILLA_BUNDLE);

const RUNORPG_CATALOG_FIXTURE = {
    available: true,
    writable: true,
    attributes: [
        {
            id: "runocraft:attack_damage",
            name: "Attack damage",
            defaultValue: 1,
            percent: false,
            order: 1,
        },
        {
            id: "runocraft:max_health",
            name: "Maximum health",
            defaultValue: 20,
            percent: false,
            order: 2,
        },
    ],
    diagnostics: [],
    items: [
        {
            id: "runocraft:test-sword",
            localId: "test-sword",
            sourceFile: "items/weapons.yml",
            fileHash: `sha256:${"a".repeat(64)}`,
            displayName: "Runo Test Sword",
            description: "A projected sword.",
            enabled: true,
            material: "minecraft:iron_sword",
            layout: "itemerness:equipment",
            theme: "itemerness:ember",
            mode: "unique",
            maxStackSize: 1,
            unbreakable: true,
            vanillaAttributesDisabled: true,
            schemas: ["runorpg:item-stats@1"],
            legacyReference: "SWORD:TEST_SWORD",
            requiredLevel: 1,
            itemLevel: 1,
            itemTier: "COMMON",
            itemPrefix: "",
            modifiers: [
                {
                    attribute: "runocraft:attack_damage",
                    operation: "runorpg:flat",
                    value: 2,
                    valueMode: "runorpg:final",
                    sourceType: "runorpg:item",
                    sourceId: null,
                    priority: 100,
                },
            ],
            skills: [
                {
                    id: "runocraft:test-slash",
                    mythicSkill: "RUNO_TEST_SLASH",
                    trigger: "runorpg:left-click",
                    cooldownGroup: "runocraft:test-slash",
                    cooldownSeconds: 1,
                    manaCost: 0,
                    staminaCost: 2,
                    power: 1,
                    cancelVanilla: true,
                    hidden: false,
                    lore: "Test slash [Left click]",
                },
            ],
            presentationBlocks: [
                {
                    uuid: "3f8c1a20-0000-4000-8000-000000000001",
                    type: "conditional",
                    condition: {
                        operator: "GREATER_THAN_OR_EQUAL",
                        left: { kind: "fact", key: "runorpg:level" },
                        right: {
                            kind: "literal",
                            value: { kind: "integer", value: "12" },
                        },
                    },
                    thenBlocks: [
                        {
                            uuid: "3f8c1a20-0000-4000-8000-000000000002",
                            type: "description",
                            message: "runorpg.item.test-sword.ready",
                            style: null,
                            anchor: null,
                            wrapping: null,
                        },
                    ],
                    otherwiseBlocks: [
                        {
                            uuid: "3f8c1a20-0000-4000-8000-000000000003",
                            type: "description",
                            message: "runorpg.item.test-sword.locked",
                            style: null,
                            anchor: null,
                            wrapping: null,
                        },
                    ],
                    style: null,
                    anchor: null,
                },
                {
                    uuid: "3f8c1a20-0000-4000-8000-000000000004",
                    type: "description",
                    message: "runorpg.item.test-sword.flavour",
                    style: null,
                    anchor: null,
                    wrapping: null,
                },
            ],
            presentationMessages: {
                "runorpg.item.test-sword.ready": "Balanced for your level",
                "runorpg.item.test-sword.locked":
                    "Requires character level 12 before it swings true",
                "runorpg.item.test-sword.flavour": "Forged for the trials",
            },
        },
        {
            id: "runocraft:wolf-fang",
            localId: "wolf-fang",
            sourceFile: "items/materials.yml",
            fileHash: `sha256:${"b".repeat(64)}`,
            displayName: "Wolf Fang",
            description: "A material.",
            enabled: true,
            material: "minecraft:flint",
            layout: "itemerness:plain",
            theme: "itemerness:vanilla-frame",
            mode: "fungible",
            maxStackSize: 64,
            unbreakable: false,
            vanillaAttributesDisabled: true,
            schemas: ["runorpg:item-stats@1"],
            legacyReference: "MOB_DROP:WOLF_FANG",
            requiredLevel: null,
            itemLevel: 0,
            itemTier: "COMMON",
            itemPrefix: "",
            modifiers: [],
            skills: [],
            presentationBlocks: [],
            presentationMessages: {},
        },
        {
            // A canvas-themed item: the bitmap renderer is the only one with draggable anchors,
            // and it is the case where a missing resource pack forces a visible fallback.
            id: "runocraft:survey-lens",
            localId: "survey-lens",
            sourceFile: "items/tools.yml",
            fileHash: `sha256:${"d".repeat(64)}`,
            displayName: "Survey Lens",
            description: "A canvas-rendered tool.",
            enabled: true,
            material: "minecraft:spyglass",
            layout: "itemerness:bitmap-canvas",
            theme: "itemerness:aurora-canvas",
            mode: "unique",
            maxStackSize: 1,
            unbreakable: false,
            vanillaAttributesDisabled: true,
            schemas: ["runorpg:item-stats@1"],
            legacyReference: "TOOL:SURVEY_LENS",
            requiredLevel: null,
            itemLevel: 3,
            itemTier: "COMMON",
            itemPrefix: "",
            modifiers: [],
            skills: [],
            presentationBlocks: [
                // Anchored content is what makes the canvas anchors worth dragging, and a canvas
                // only reserves as many lines as it has content: with one line there is nowhere
                // for a dragged anchor to move to.
                {
                    uuid: "7ab40000-0000-4000-8000-000000000001",
                    type: "description",
                    message: "runorpg.item.survey-lens.region",
                    style: null,
                    anchor: "region",
                    wrapping: null,
                },
                {
                    uuid: "7ab40000-0000-4000-8000-000000000002",
                    type: "description",
                    message: "runorpg.item.survey-lens.depth",
                    style: null,
                    anchor: null,
                    wrapping: null,
                },
                {
                    uuid: "7ab40000-0000-4000-8000-000000000003",
                    type: "description",
                    message: "runorpg.item.survey-lens.bearing",
                    style: null,
                    anchor: null,
                    wrapping: null,
                },
                {
                    uuid: "7ab40000-0000-4000-8000-000000000004",
                    type: "description",
                    message: "runorpg.item.survey-lens.tide",
                    style: null,
                    anchor: null,
                    wrapping: null,
                },
                {
                    uuid: "7ab40000-0000-4000-8000-000000000005",
                    type: "description",
                    message: "runorpg.item.survey-lens.notes",
                    style: null,
                    anchor: null,
                    wrapping: null,
                },
            ],
            presentationMessages: {
                "runorpg.item.survey-lens.region": "Harbor survey",
                "runorpg.item.survey-lens.depth": "Depth 42 fathoms",
                "runorpg.item.survey-lens.bearing": "Bearing north north east",
                "runorpg.item.survey-lens.tide": "Tide running out",
                "runorpg.item.survey-lens.notes": "Charted last winter",
            },
        },
    ],
} as const;

async function canvasSize(
    page: Page,
): Promise<{ width: number; height: number }> {
    return page.evaluate(() => {
        const canvas = document.querySelector<HTMLCanvasElement>(
            '[data-testid="tooltip-canvas"]',
        );
        return { width: canvas?.width ?? 0, height: canvas?.height ?? 0 };
    });
}

async function canvasSignature(page: Page): Promise<string> {
    // A cheap content fingerprint: enough to detect that the drawn pixels changed without
    // asserting an exact image, which would make every legitimate metric fix a test failure.
    return page.evaluate(() => {
        const canvas = document.querySelector<HTMLCanvasElement>(
            '[data-testid="tooltip-canvas"]',
        );
        if (!canvas) return "none";
        const context = canvas.getContext("2d");
        if (!context) return "none";
        const data = context.getImageData(
            0,
            0,
            canvas.width,
            canvas.height,
        ).data;
        let hash = 2166136261;
        for (let index = 0; index < data.length; index += 17) {
            hash = Math.imul(hash ^ data[index]!, 16777619) >>> 0;
        }
        return `${canvas.width}x${canvas.height}:${hash.toString(16)}`;
    });
}

async function mountVanilla(page: Page): Promise<void> {
    await page.getByTestId("open-assets").click();
    await page.getByTestId("asset-file-input").setInputFiles(VANILLA_BUNDLE);
    await expect(page.getByTestId("pack-list")).toContainText(
        "vanilla-1.21.11.zip",
    );
    await page.getByTestId("close-overlay").click();
}

async function resetDocument(request: APIRequestContext): Promise<void> {
    const currentResponse = await request.get("/api/v1/document");
    expect(currentResponse.ok()).toBe(true);
    const current = (await currentResponse.json()) as { snapshotHash: string };
    const resetResponse = await request.put("/api/v1/document", {
        data: {
            document: baselineDocument,
            expectedHash: current.snapshotHash,
        },
    });
    expect(resetResponse.ok()).toBe(true);
}

async function simulateManagedPack(page: Page): Promise<void> {
    await page.getByTestId("open-persona").click();
    await page.getByTestId("pack-sim-loaded").click();
    await page
        .getByTestId("asset-profile-simulation")
        .selectOption("itemerness:example-pack-v1");
    await page.getByTestId("managed-vanilla-lines-simulation").check();
    await page.getByTestId("open-persona").click();
}

/** The item the rail selects on load, and the one most tests edit. */
const SWORD = "runorpg-template-test-sword";
const LENS = "runorpg-template-survey-lens";

test.beforeEach(async ({ page, request }) => {
    await resetDocument(request);
    // The item library is authoritative RunoRPG content, so every test needs a catalogue. Serving
    // the fixture keeps the suite independent of whatever the deployment's live items happen to be,
    // and gives the rail a deterministic first selection.
    await page.route("**/api/v1/runorpg/catalog", async (route) => {
        await route.fulfill({ json: RUNORPG_CATALOG_FIXTURE });
    });
    await page.addInitScript(() =>
        window.localStorage.setItem("itemerness.ui-language", '"en-US"'),
    );
    await page.goto("/?lang=en-US");
    await expect(page.getByTestId("mode-items")).toHaveAttribute(
        "aria-selected",
        "true",
    );
    await expect(page.getByTestId("item-tree")).toBeVisible();
    await expect(page.getByTestId(SWORD)).toBeVisible();
});

test.describe("narrow workspace", () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test("stacks the editor around a usable preview", async ({ page }) => {
        const layout = await page.evaluate(() => {
            const documentBox = (selector: string) => {
                const element = document.querySelector<HTMLElement>(selector);
                if (!element) throw new Error(`Missing ${selector}`);
                const rect = element.getBoundingClientRect();
                return {
                    top: rect.top + window.scrollY,
                    right: rect.right + window.scrollX,
                    bottom: rect.bottom + window.scrollY,
                    left: rect.left + window.scrollX,
                    width: rect.width,
                    height: rect.height,
                    clientWidth: element.clientWidth,
                    scrollWidth: element.scrollWidth,
                };
            };

            return {
                sidebar: documentBox(".sidebar"),
                stage: documentBox(".stage"),
                canvasArea: documentBox(".stage-canvas-area"),
                inspector: documentBox(".inspector"),
                canvas: documentBox('[data-testid="tooltip-canvas"]'),
                pageWidth: document.documentElement.scrollWidth,
            };
        });

        expect(layout.stage.width).toBeGreaterThan(300);
        expect(layout.canvasArea.clientWidth).toBeGreaterThan(300);
        expect(layout.canvas.width).toBeGreaterThan(0);
        expect(layout.canvas.height).toBeGreaterThan(0);
        expect(layout.sidebar.bottom).toBeLessThanOrEqual(layout.stage.top + 1);
        expect(layout.stage.bottom).toBeLessThanOrEqual(
            layout.inspector.top + 1,
        );
        expect(layout.pageWidth).toBeLessThanOrEqual(390);

        // Pixel-accurate tooltips may be wider than a phone. They scroll inside the stage instead
        // of shrinking, overlapping the inspector, or widening the whole document.
        expect(layout.canvasArea.scrollWidth).toBeGreaterThanOrEqual(
            layout.canvasArea.clientWidth,
        );
    });
});

test("lists the live RunoRPG items by name and previews the first one", async ({
    page,
}) => {
    const tree = page.getByTestId("item-tree");
    await expect(
        tree.locator('button[data-testid^="runorpg-template-"]'),
    ).toHaveCount(3);
    // Names, not namespaced ids: this is the difference between an editor and a schema browser.
    await expect(tree).toContainText("Runo Test Sword");
    await expect(tree).not.toContainText("runocraft:test-sword");
    await expect(page.getByTestId("tooltip-canvas")).toBeVisible();
    const size = await canvasSize(page);
    expect(size.width).toBeGreaterThan(0);
    expect(size.height).toBeGreaterThan(0);
    await expect(page.getByTestId("gui-scale-1")).toHaveClass(/chip-on/u);
});

test("filters the item library by template and caches the catalog", async ({
    page,
    request,
}) => {
    // The kind filter lists templates, so the document has to describe one — and say which item
    // came from it — before the filter has anything to offer.
    const current = (await (await request.get("/api/v1/document")).json()) as {
        document: ProjectDocument;
        snapshotHash: string;
    };
    const bound = withItemTemplateRegistry(
        projectDocumentSchema.parse(current.document),
        {
            version: 1,
            templates: [
                itemTemplateSchema.parse({
                    uuid: "6d0a5c11-0000-4000-8000-000000000001",
                    id: "runocraft:template-blade",
                    displayName: "Blade",
                    material: "minecraft:iron_sword",
                }),
            ],
            bindings: [
                {
                    instanceId: "runocraft:test-sword",
                    templateId: "runocraft:template-blade",
                    overriddenFields: [],
                    templateRevisionSeen: 0,
                },
            ],
        },
    );
    expect(
        (
            await request.put("/api/v1/document", {
                data: { document: bound, expectedHash: current.snapshotHash },
            })
        ).ok(),
    ).toBe(true);

    let catalogRequests = 0;
    await page.route("**/api/v1/runorpg/catalog", async (route) => {
        catalogRequests += 1;
        await route.fulfill({ json: RUNORPG_CATALOG_FIXTURE });
    });
    await page.reload();

    await expect(page.getByTestId(SWORD)).toBeVisible();
    await expect(page.getByTestId("runorpg-template-wolf-fang")).toBeVisible();
    expect(catalogRequests).toBe(1);

    await page
        .getByTestId("template-category")
        .selectOption("runocraft:template-blade");
    await expect(page.getByTestId(SWORD)).toBeVisible();
    await expect(page.getByTestId("runorpg-template-wolf-fang")).toHaveCount(0);
    await expect(page.getByTestId(LENS)).toHaveCount(0);

    // Everything the library needs is already in memory, so leaving and returning must not ask the
    // server again.
    await page.getByTestId("template-category").selectOption("unbound");
    await expect(page.getByTestId(SWORD)).toHaveCount(0);
    await expect(page.getByTestId(LENS)).toBeVisible();
    await page.getByTestId("mode-templates").click();
    await page.getByTestId("mode-items").click();
    expect(catalogRequests).toBe(1);
});

test("resizes the inspector and persists complete RunoRPG attribute and skill CRUD", async ({
    page,
}) => {
    let catalog = structuredClone(
        RUNORPG_CATALOG_FIXTURE,
    ) as unknown as RunoRpgCatalog;
    const updates: RunoRpgCatalogItemUpdate[] = [];
    await page.route("**/api/v1/runorpg/catalog", async (route) => {
        await route.fulfill({ json: catalog });
    });
    await page.route("**/api/v1/runorpg/catalog/item", async (route) => {
        const update = route
            .request()
            .postDataJSON() as RunoRpgCatalogItemUpdate;
        updates.push(update);
        catalog = {
            ...catalog,
            items: catalog.items.map((item) =>
                item.id === update.id
                    ? {
                          ...item,
                          ...update,
                          fileHash: `sha256:${"c".repeat(64)}`,
                      }
                    : item,
            ),
        };
        await route.fulfill({ json: { ok: true } });
    });
    await page.reload();

    await expect(page.getByText("Itemerness templates")).toHaveCount(0);
    await expect(page.getByTestId("add-item")).toHaveCount(0);
    await expect(page.getByTestId("runorpg-template-test-sword")).toBeVisible();

    const inspector = page.locator(".inspector");
    const splitter = page.getByTestId("inspector-resizer");
    const before = await inspector.evaluate(
        (element) => element.getBoundingClientRect().width,
    );
    const splitterBox = await splitter.boundingBox();
    expect(splitterBox).not.toBeNull();
    await page.mouse.move(splitterBox!.x + 3, splitterBox!.y + 120);
    await page.mouse.down();
    await page.mouse.move(splitterBox!.x - 140, splitterBox!.y + 120);
    await page.mouse.up();
    const after = await inspector.evaluate(
        (element) => element.getBoundingClientRect().width,
    );
    expect(after).toBeGreaterThan(before + 100);
    await expect
        .poll(() =>
            page.evaluate(() =>
                Number(
                    window.localStorage.getItem("itemerness.inspector-width"),
                ),
            ),
        )
        .toBeGreaterThan(before + 100);

    await page.getByTestId("runorpg-add-attribute").click();
    await expect(
        page.locator('[data-testid^="runorpg-modifier-row-"]'),
    ).toHaveCount(2);
    await page
        .getByTestId("runorpg-attribute-1")
        .selectOption("runocraft:max_health");
    await page.getByTestId("runorpg-value-1").fill("14");
    await page
        .getByTestId("runorpg-modifier-row-1")
        .getByLabel("Move up")
        .click();
    await page
        .getByTestId("runorpg-modifier-row-1")
        .getByLabel("Remove attribute")
        .click();

    await page.getByTestId("runorpg-add-skill").click();
    await expect(
        page.locator('[data-testid^="runorpg-skill-row-"]'),
    ).toHaveCount(2);
    await page
        .getByTestId("runorpg-skill-id-1")
        .fill("runocraft:editor-strike");
    await page.getByTestId("runorpg-mythic-skill-1").fill("EDITOR_STRIKE");
    await page
        .getByTestId("runorpg-skill-lore-1")
        .fill("Editor strike [Right click]");
    await page.getByTestId("runorpg-skill-row-1").getByLabel("Move up").click();
    await page
        .getByTestId("runorpg-skill-row-1")
        .getByLabel("Remove skill")
        .click();

    await page.getByTestId("save-runorpg-template").click();
    await expect.poll(() => updates.length).toBe(1);
    expect(updates[0]!.modifiers).toEqual([
        expect.objectContaining({
            attribute: "runocraft:max_health",
            value: 14,
            valueMode: "runorpg:bonus",
        }),
    ]);
    expect(updates[0]!.skills).toEqual([
        expect.objectContaining({
            id: "runocraft:editor-strike",
            mythicSkill: "EDITOR_STRIKE",
            lore: "Editor strike [Right click]",
        }),
    ]);

    await page.reload();
    await expect(page.getByTestId("runorpg-attribute-0")).toHaveValue(
        "runocraft:max_health",
    );
    await expect(page.getByTestId("runorpg-value-0")).toHaveValue("14");
    await expect(page.getByTestId("runorpg-skill-id-0")).toHaveValue(
        "runocraft:editor-strike",
    );

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(splitter).toBeHidden();
    const narrowLayout = await page.evaluate(() => ({
        pageWidth: document.documentElement.scrollWidth,
        inspectorWidth:
            document
                .querySelector<HTMLElement>(".inspector")
                ?.getBoundingClientRect().width ?? 0,
    }));
    expect(narrowLayout.pageWidth).toBeLessThanOrEqual(390);
    expect(narrowLayout.inspectorWidth).toBeLessThanOrEqual(390);
});

test("loads, autosaves, and previews the control plane document", async ({
    page,
}) => {
    // This one is about the Itemerness document, so the RunoRPG library stays out of the way: with
    // a catalogue present the rail would select a server item and preview the projection instead.
    await page.route("**/api/v1/runorpg/catalog", (route) => route.abort());
    const remoteDocument = structuredClone(baselineDocument);
    const firstItem = remoteDocument.items[0]!;
    const locale = remoteDocument.locales.find(
        (entry) => entry.locale === remoteDocument.defaultLocale,
    )!;
    locale.messages[firstItem.presentation.nameMessage] =
        "Loaded from the control plane";
    let persistedHash = contentHash(remoteDocument);
    let revision = 40;
    const saves: {
        document: ProjectDocument;
        expectedHash: string;
    }[] = [];
    const previews: PreviewRequest[] = [];

    await page.route("**/api/v1/document", async (route) => {
        if (route.request().method() === "GET") {
            await route.fulfill({
                json: {
                    document: remoteDocument,
                    snapshotHash: persistedHash,
                    revision,
                },
            });
            return;
        }
        const body = route.request().postDataJSON() as {
            document: ProjectDocument;
            expectedHash: string;
        };
        saves.push(body);
        persistedHash = contentHash(body.document);
        revision += 1;
        await route.fulfill({
            json: { snapshotHash: persistedHash, revision, diagnostics: [] },
        });
    });
    await page.route("**/api/v1/preview", async (route) => {
        previews.push(route.request().postDataJSON() as PreviewRequest);
        await route.continue();
    });

    await page.reload();
    await expect(page.getByTestId("preview-name")).toHaveText(
        "Loaded from the control plane",
    );
    await page.getByTestId("name-input").fill("Current unsaved keystroke");

    await expect(page.getByTestId("preview-name")).toHaveText(
        "Current unsaved keystroke",
    );
    await expect
        .poll(() =>
            previews.some((request) => {
                const requestLocale = request.document.locales.find(
                    (entry) => entry.locale === request.document.defaultLocale,
                );
                return (
                    requestLocale?.messages[
                        request.document.items[0]!.presentation.nameMessage
                    ] === "Current unsaved keystroke" &&
                    request.snapshotHash === contentHash(request.document)
                );
            }),
        )
        .toBe(true);
    await expect.poll(() => saves.length).toBe(1);
    expect(saves[0]?.expectedHash).toBe(contentHash(remoteDocument));
    await expect(page.getByTestId("document-sync-status")).toHaveAttribute(
        "data-sync-kind",
        "saved",
    );
});

test("renaming an item in the inspector updates the preview and the list", async ({
    page,
}) => {
    await page.getByTestId(SWORD).click();
    await expect(page.getByTestId("preview-name")).toHaveText(
        "Runo Test Sword",
    );
    // The user types a name; which message key the projection lands it in stays plumbing.
    await page.getByTestId("runorpg-template-name").fill("Emberforged Sabre");
    await expect(page.getByTestId("preview-name")).toHaveText(
        "Emberforged Sabre",
    );
    await expect(page.getByTestId("item-tree")).toContainText(
        "Emberforged Sabre",
    );
});

test("adding a text row extends the tooltip", async ({ page }) => {
    await page.getByTestId(SWORD).click();
    const rows = page
        .getByTestId("runorpg-content-blocks")
        .first()
        .locator("> li");
    const before = await rows.count();
    const sizeBefore = await canvasSize(page);
    await page.getByTestId("runorpg-add-text").click();
    await expect(rows).toHaveCount(before + 1);
    // A new row is only real content once it says something, so the text goes in before the
    // tooltip is expected to grow.
    await rows.last().locator("input").first().fill("Forged in the ember pits");
    await expect
        .poll(async () => (await canvasSize(page)).height)
        .toBeGreaterThan(sizeBefore.height);
});

test("editing a lore line inline redraws the tooltip", async ({ page }) => {
    await page.getByTestId(SWORD).click();
    const before = await canvasSignature(page);
    // The sword's flavour row carries the item's own message; editing it in the inspector is the
    // RunoRPG equivalent of retyping a stat label.
    const label = page
        .getByTestId("runorpg-block-description")
        .locator("input")
        .first();
    await label.fill("Requires far more character levels than you have now");
    await expect.poll(async () => canvasSignature(page)).not.toBe(before);
});

test("labels an unverified preview honestly and never claims exact structure", async ({
    page,
}) => {
    await expect(page.getByTestId("preview-origin")).toHaveText(
        "Draft preview",
    );
    await page.getByTestId("fidelity-toggle").click();
    await expect(page.getByTestId("fidelity-content")).toContainText(
        "Metric faithful",
    );
    // Screen positioning is decided by the player's client and is never claimed at any other level.
    await expect(page.getByTestId("fidelity-positioning")).toContainText(
        "Client only",
    );
    await expect(page.getByTestId("fidelity-overall")).toHaveText(
        "Client only",
    );
    await expect(
        page.getByTestId("fidelity-vanilla-extra-lines"),
    ).toContainText("The client adds its own enchantment and attribute lines");

    await page.getByTestId("open-persona").click();
    await page.getByTestId("managed-vanilla-lines-simulation").check();
    await page.getByTestId("open-persona").click();
    await page.getByTestId("fidelity-toggle").click();
    await expect(
        page.getByTestId("fidelity-vanilla-extra-lines"),
    ).toContainText("The theme claims every tooltip line");
});

test("a RunoRPG item's text is owned by the catalog, not by the previewed language", async ({
    page,
}) => {
    await page.getByTestId(SWORD).click();
    const english = await canvasSignature(page);
    await page.getByTestId("locale-chip-zh_cn").click();
    // Itemerness items carry one message per language; a RunoRPG item carries the single string the
    // server wrote. Switching the previewed language must therefore leave it alone rather than
    // silently fall back to a key or an empty line.
    await expect(page.getByTestId("locale-chip-zh_cn")).toHaveClass(/chip-on/u);
    await expect(page.getByTestId("preview-name")).toHaveText(
        "Runo Test Sword",
    );
    expect(await canvasSignature(page)).toBe(english);
    await expect(page.getByTestId("runorpg-template-name")).toHaveValue(
        "Runo Test Sword",
    );
});

test("switching the interface language leaves the previewed content alone", async ({
    page,
}) => {
    await page.getByTestId(SWORD).click();
    const before = await canvasSignature(page);
    await page.getByTestId("ui-language").selectOption("zh-CN");
    await expect(page.getByTestId("mode-templates")).toContainText("模板");
    // Interface language and previewed content language are separate axes; changing one must not
    // move the other.
    expect(await canvasSignature(page)).toBe(before);
});

test("choosing a theme card edits the item, and fallbacks are explained", async ({
    page,
}) => {
    await page.getByTestId(LENS).click();
    // aurora-canvas needs a resource pack the viewer does not have, so the item falls back and the
    // stage says why instead of silently drawing something else.
    await page.getByTestId("fidelity-toggle").click();
    await expect(page.getByTestId("fidelity-content")).toBeVisible();
    await page.getByTestId("fidelity-toggle").click();

    const before = await canvasSignature(page);
    const cards = page.getByTestId("theme-grid").locator(".theme-card");
    await cards.filter({ hasText: "Default" }).first().click();
    await expect(cards.filter({ hasText: "Default" }).first()).toHaveClass(
        /selected/u,
    );
    await expect.poll(async () => canvasSignature(page)).not.toBe(before);
});

test("zoom chips change the rendered pixel grid", async ({ page }) => {
    await page.getByTestId("gui-scale-2").click();
    const small = await canvasSize(page);
    await page.getByTestId("gui-scale-5").click();
    await expect
        .poll(async () => (await canvasSize(page)).width)
        .toBeGreaterThan(small.width);
});

test("the geometry overlay is off by default and can be turned on", async ({
    page,
}) => {
    const plain = await canvasSignature(page);
    await page.getByTestId("annotations-toggle").check();
    await expect.poll(async () => canvasSignature(page)).not.toBe(plain);
});

test("side-by-side language comparison renders two tooltips", async ({
    page,
}) => {
    await page.getByTestId("compare-toggle").click();
    await expect(page.getByTestId("comparison-figure")).toBeVisible();
    await expect(page.getByTestId("tooltip-canvas")).toHaveCount(2);
});

test("the translation matrix still edits the same document", async ({
    page,
    request,
}) => {
    // The matrix edits Itemerness document messages. A RunoRPG item's text comes from the server
    // catalogue instead, so the proof that the edit landed is the saved document, not the stage.
    await page.getByTestId("open-translations").click();
    await page
        .getByTestId("message-en_us-item.travel-token.name")
        .fill("Harbor Travel Token Extended Edition");
    await page.getByTestId("close-overlay").click();
    await expect
        .poll(async () => {
            const body = (await (
                await request.get("/api/v1/document")
            ).json()) as { document: ProjectDocument };
            return body.document.locales.find(
                (locale) => locale.locale === "en_us",
            )?.messages["item.travel-token.name"];
        })
        .toBe("Harbor Travel Token Extended Edition");

    await page.getByTestId("open-translations").click();
    await expect(
        page.getByTestId("message-en_us-item.travel-token.name"),
    ).toHaveValue("Harbor Travel Token Extended Edition");
});

test("an unmounted preview draws faithful geometry rather than fake glyphs", async ({
    page,
}) => {
    // The shell mounts vanilla and the server pack on load, so an honestly unmounted preview has
    // to be arranged: refuse both, then reload.
    await page.route("**/api/v1/vanilla-assets/**", (route) => route.abort());
    await page.route("**/api/v1/server-assets/**", (route) => route.abort());
    await page.reload();
    await expect(page.getByTestId(SWORD)).toBeVisible();

    // With no resource pack the engine has advances but no pixels, so it blocks out each glyph's
    // ink bounds. The badge has to admit that, otherwise the blocks would read as real text.
    await page.getByTestId("fidelity-toggle").click();
    await expect(page.getByTestId("fidelity-glyph-raster")).toContainText(
        "Client only",
    );
    await expect(page.getByTestId("fidelity-metrics")).toContainText(
        "Metric faithful",
    );
});

test("diagnostics render from message keys, not server prose", async ({
    page,
}) => {
    // The previewed item is the one the library lists, so the untranslated message has to be one
    // of its own: a lore line whose key nothing defines.
    const catalog = structuredClone(
        RUNORPG_CATALOG_FIXTURE,
    ) as unknown as RunoRpgCatalog;
    catalog.items = [
        {
            ...catalog.items[0]!,
            presentationBlocks: [
                {
                    uuid: "5c1e0000-0000-4000-8000-000000000001",
                    type: "description",
                    message: "item.missing-name",
                    style: null,
                    anchor: null,
                    wrapping: null,
                },
            ],
            presentationMessages: {},
        },
    ];
    await page.route("**/api/v1/runorpg/catalog", async (route) => {
        await route.fulfill({ json: catalog });
    });
    await page.reload();
    await page.getByTestId("open-diagnostics").click();
    await expect(
        page.getByRole("heading", { name: "Diagnostics" }),
    ).toBeVisible();
    await expect(page.getByTestId("diagnostics-list")).toContainText(
        '"item.missing-name" is not translated in any language.',
    );
    await expect(page.getByTestId("diagnostics-list")).not.toContainText(
        "diagnostics.locale.missing_message",
    );
    await page.getByTestId("close-overlay").click();
    await page.getByTestId("ui-language").selectOption("zh-CN");
    await page.getByTestId("open-diagnostics").click();
    await expect(page.getByRole("heading", { name: "诊断" })).toBeVisible();
    await expect(page.getByTestId("diagnostics-list")).toContainText(
        "“item.missing-name”在任何语言中都没有翻译。",
    );
});

test("fetches vanilla assets through the control plane when the deployment allows it", async ({
    page,
    request,
}) => {
    // The path for an editor who has no client jar to hand. The control plane downloads the files
    // pinned in tools/font-metrics/1.21.11.sources.json from the official Mojang CDN and verifies
    // every SHA-1 before serving them, so a poisoned mirror cannot change a glyph advance.
    const probe = await request.get("/api/v1/vanilla-assets/1.21.11/manifest");
    test.skip(
        !probe.ok(),
        "this deployment does not expose the vanilla asset proxy",
    );

    await page.getByTestId("open-assets").click();
    // The shell already asks for the vanilla bundle on load, so the panel may open with it
    // mounted. Either way the explicit fetch has to end with the pack present.
    await page.getByTestId("fetch-vanilla").click();
    await expect(page.getByTestId("pack-list")).toContainText(
        "vanilla-1.21.11",
        { timeout: 120_000 },
    );

    await page.getByTestId("run-self-check").click();
    const results = page.getByTestId("self-check-results");
    await expect(results).toBeVisible({ timeout: 30_000 });
    await expect(results.locator("tr.fail")).toHaveCount(0);
});

test("shows a server-verified preview when a target server is connected", async ({
    page,
    request,
}) => {
    const status = await request.get("/api/v1/agent/status");
    const connected = status.ok()
        ? ((await status.json()) as { connected: boolean }).connected
        : false;
    test.skip(
        !connected,
        "no Minecraft server is paired with this control plane",
    );

    await page.getByTestId(SWORD).click();
    // The badge flips only when a real target compiled this exact draft snapshot. A mock result or
    // a stale snapshot must keep it at draft, which is the whole point of the distinction.
    await expect(page.getByTestId("preview-origin")).toHaveText(
        "Server verified",
        { timeout: 30_000 },
    );
    await page.getByTestId("fidelity-toggle").click();
    await expect(page.getByTestId("fidelity-content")).toContainText(
        "Exact structure",
    );
    // Positioning is still the client's decision, no matter who compiled the tooltip.
    await expect(page.getByTestId("fidelity-positioning")).toContainText(
        "Client only",
    );
    await expect(page.getByTestId("preview-name")).toHaveText(
        "Runo Test Sword",
    );
});

test("reordering a row moves the tooltip content", async ({ page }) => {
    await page.getByTestId(SWORD).click();
    const rows = page
        .getByTestId("runorpg-content-blocks")
        .first()
        .locator("> li");
    const firstKind = await rows.nth(0).locator(".block-kind").textContent();
    const before = await canvasSignature(page);
    // The RunoRPG inspector reorders with the row's own move controls rather than a drag handle,
    // because its rows are contract-generated and are not free-form document blocks.
    await rows.nth(1).getByRole("button", { name: "上移" }).click();
    await expect(rows.nth(1).locator(".block-kind")).toHaveText(
        firstKind ?? "",
    );
    await expect.poll(async () => canvasSignature(page)).not.toBe(before);
});

test("theme colors edit with a color well and repaint instantly", async ({
    page,
}) => {
    await page.getByTestId("mode-themes").click();
    await page.getByTestId("theme-default").click();
    const before = await canvasSignature(page);
    // The library previews the currently selected item in the chosen theme, so recolouring the
    // name role must repaint the stage at once.
    await page.getByTestId("color-item-name").fill("#ff3366");
    await expect.poll(async () => canvasSignature(page)).not.toBe(before);
});

test("posing the previewed player flips a conditional row", async ({
    page,
}) => {
    await page.getByTestId(SWORD).click();
    const before = await canvasSignature(page);
    await page.getByTestId("open-persona").click();
    // The sword's conditional row asks for character level 12 and the projected persona starts at
    // 1, so raising it past the requirement swaps the line.
    await page.getByTestId("fact-runorpg-level").fill("15");
    await expect.poll(async () => canvasSignature(page)).not.toBe(before);
});

test("layout sliders re-wrap real content", async ({ page }) => {
    await page.getByTestId("mode-layouts").click();
    await page.getByTestId("layout-equipment").click();
    // The stage previews an item that uses this layout.
    await expect(page.getByTestId("preview-name")).toHaveText(
        "Runo Test Sword",
    );
    const before = await canvasSize(page);
    // Narrowing the maximum width forces the description to wrap onto more lines: the slider is
    // editing real geometry, not a detached number.
    await page.getByTestId("layout-max-width").fill("120");
    await expect
        .poll(async () => (await canvasSize(page)).height)
        .toBeGreaterThan(before.height);
});

test("renaming a data key relabels it everywhere it is listed", async ({
    page,
}) => {
    // Data keys belong to the Itemerness document. A RunoRPG item reads the projection's own
    // `runorpg:*` keys instead, so the rename is proven where the key is authored and listed.
    await page.getByTestId("mode-data").click();
    await page.getByTestId("datakey-charges").click();
    await page.getByTestId("data-label-input").fill("Uses left");
    await expect(page.getByTestId("data-list")).toContainText("Uses left");
    await page.getByTestId("mode-items").click();
    await page.getByTestId("mode-data").click();
    await page.getByTestId("datakey-charges").click();
    await expect(page.getByTestId("data-label-input")).toHaveValue("Uses left");
});

test("clicking a tooltip line selects its block in the inspector", async ({
    page,
}) => {
    await page.getByTestId(SWORD).click();
    // Contract-generated lore has no block to select, so the target is the sword's own flavour
    // line: one attribute row, one skill row, then it.
    await page.getByTestId("line-hit-3").click();
    const selected = page.locator(
        '.inspector [data-block][data-selected="true"]',
    );
    await expect(selected).toHaveCount(1);
    await expect(selected).toHaveAttribute("data-testid", /^runorpg-block-/u);
});

test("double-clicking a line opens the in-place editor", async ({ page }) => {
    await page.getByTestId(SWORD).click();
    await page.getByTestId("line-hit-name").dblclick();
    const editor = page.getByTestId("inline-editor");
    await expect(editor).toBeVisible();
    await editor.fill("Weathered Emberblade");
    await editor.press("Enter");
    // The in-place editor writes a document message, and a RunoRPG item's name comes from the
    // server catalogue, so the catalogue keeps winning. Renaming one is the inspector's job.
    await expect(page.getByTestId("preview-name")).toHaveText(
        "Runo Test Sword",
    );
    await page
        .getByTestId("runorpg-template-name")
        .fill("Weathered Emberblade");
    await expect(page.getByTestId("item-tree")).toContainText(
        "Weathered Emberblade",
    );
});

test("dragging a canvas anchor repositions content on the canvas itself", async ({
    page,
}) => {
    // Pack acceptance, asset profile, and managed vanilla lines are independent viewer facts.
    await simulateManagedPack(page);
    await page.getByTestId(LENS).click();

    const box = page.getByTestId("anchor-box-region");
    await expect(box).toBeVisible();
    const bounds = (await box.boundingBox())!;
    const before = await canvasSignature(page);
    // Drag the region anchor three tooltip lines down; the composer snaps y to the line grid, so
    // the text lands exactly where the box was dropped.
    await page.mouse.move(
        bounds.x + bounds.width / 2,
        bounds.y + bounds.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
        bounds.x + bounds.width / 2,
        bounds.y + bounds.height / 2 + 30,
        { steps: 6 },
    );
    await page.mouse.up();
    await expect.poll(async () => canvasSignature(page)).not.toBe(before);
});

test.describe("with vanilla assets mounted", () => {
    test.skip(
        !hasVanillaBundle,
        "run packages/mc-assets/scripts/fetch-vanilla-assets.mjs first",
    );

    test("mounting supplies measured pixels and passes the metrics self-check", async ({
        page,
    }) => {
        await page.getByTestId("open-assets").click();
        await page
            .getByTestId("asset-file-input")
            .setInputFiles(VANILLA_BUNDLE);
        await expect(page.getByTestId("pack-list")).toContainText(
            "vanilla-1.21.11.zip",
        );

        await page.getByTestId("run-self-check").click();
        const results = page.getByTestId("self-check-results");
        await expect(results).toBeVisible({ timeout: 30_000 });
        // The browser font engine and the artifact generated from the real client jar must agree
        // for every code point; anything else means the preview is lying about widths.
        await expect(results.locator("tr.fail")).toHaveCount(0);
        await expect(results).toContainText("minecraft:default");
        await expect(results).toContainText("minecraft:uniform");
        await page.getByTestId("close-overlay").click();

        await page.getByTestId("fidelity-toggle").click();
        // Every glyph in this item has pixels once vanilla is mounted, so the badge claims the
        // strongest thing a browser may claim about rasterisation — and no more, because GPU
        // sampling still is not the client's.
        await expect(page.getByTestId("fidelity-glyph-raster")).toContainText(
            "Approximate raster",
        );
        await expect(page.getByTestId("fidelity-glyph-raster")).toContainText(
            "Drawn from the mounted glyph textures.",
        );
        await expect(page.getByTestId("fidelity-metrics")).toContainText(
            "Metric faithful",
        );
    });

    test("a bitmap canvas theme anchors its own tooltip width", async ({
        page,
    }) => {
        await mountVanilla(page);
        await simulateManagedPack(page);
        await page.getByTestId(LENS).click();
        // 176 content pixels plus the audited 1.21.11 sprite/background outset. Without the width
        // anchor the negative spacing would collapse this to nearly nothing.
        await expect(page.getByTestId("tooltip-size")).toContainText("200 x");
    });

    test("renderer golden screenshot", async ({ page }) => {
        // The golden proves the browser renderer stayed stable, so the compile endpoint is blocked
        // for this test: otherwise the pixels would depend on whether a server happens to be
        // paired with the deployment under test.
        await page.route("**/api/v1/preview", (route) => route.abort());
        await mountVanilla(page);
        await simulateManagedPack(page);
        await page.getByTestId(SWORD).click();
        await page.getByTestId("gui-scale-4").click();
        await expect(page.getByTestId("tooltip-canvas")).toBeVisible();
        await expect(page.getByTestId("preview-origin")).toHaveText(
            "Draft preview",
        );
        // This golden proves this renderer stayed stable. It is not evidence about the Minecraft
        // client: only a real client screenshot can speak to that, and this project takes those on
        // the craftr runtime matrix rather than pretending a browser canvas substitutes for one.
        //
        // The subject moved from a bundled Itemerness item to the RunoRPG item the library now
        // lists, so the baseline has to be re-recorded once per platform:
        //   pnpm --filter @itemerness/web e2e -- --update-snapshots --grep "golden screenshot"
        await expect(page.getByTestId("tooltip-canvas")).toHaveScreenshot(
            "runo-test-sword-mounted.png",
            {
                maxDiffPixelRatio: 0.01,
            },
        );
    });
});
