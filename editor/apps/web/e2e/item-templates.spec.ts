import { expect, test, type APIRequestContext } from "@playwright/test";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import {
    itemTemplateRegistryOf,
    projectDocumentSchema,
    type RunoRpgCatalog,
} from "@itemerness/protocol";

/**
 * Item type templates, end to end through the browser.
 *
 * The catalogue is mocked because this suite is about the editor's own behaviour: that a template
 * is created, persisted into the authoring document, previewed like a real item, and offered as the
 * starting point for a new instance. What the server writes to `items/*.yml` is proven separately
 * by `apps/control-plane/scripts/verify-item-templates.mts`, which reads the YAML back.
 */

const CATALOG: RunoRpgCatalog = {
    available: true,
    writable: true,
    diagnostics: [],
    attributes: [
        {
            id: "runocraft:attack_damage",
            name: "Attack damage",
            defaultValue: 1,
            percent: false,
            order: 1,
        },
    ],
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
            legacyReference: null,
            requiredLevel: null,
            itemLevel: 12,
            itemTier: "rare",
            itemPrefix: "",
            modifiers: [
                {
                    attribute: "runocraft:attack_damage",
                    operation: "runorpg:flat",
                    value: 9,
                    valueMode: "runorpg:bonus",
                    sourceType: "runorpg:item",
                    sourceId: null,
                    priority: 100,
                },
            ],
            skills: [],
            presentationBlocks: [],
            presentationMessages: {},
        },
    ],
};

async function resetDocument(request: APIRequestContext): Promise<void> {
    const current = (await (await request.get("/api/v1/document")).json()) as {
        snapshotHash: string;
    };
    const response = await request.put("/api/v1/document", {
        data: {
            document: baselineDocument,
            expectedHash: current.snapshotHash,
        },
    });
    expect(response.ok()).toBe(true);
}

test.beforeEach(async ({ page, request }) => {
    await resetDocument(request);
    await page.route("**/api/v1/runorpg/catalog", async (route) => {
        await route.fulfill({ json: CATALOG });
    });
    await page.addInitScript(() =>
        window.localStorage.setItem("itemerness.ui-language", '"en-US"'),
    );
    await page.goto("/?lang=en-US");
});

test("creates a template, previews it, and quality picks the frame", async ({
    page,
    request,
}) => {
    await page.getByTestId("mode-templates").click();
    await expect(page.getByTestId("template-list")).toBeVisible();

    // The button below is the one that used to throw: `crypto.randomUUID` does not exist over
    // plain HTTP, which is how this editor is actually reached.
    await page.getByTestId("add-template").click();
    await expect(page.getByTestId("item-template-inspector")).toBeVisible();

    await page.getByTestId("template-display-name").fill("Sword");
    await page.getByTestId("template-material").fill("minecraft:diamond_sword");
    await page.getByTestId("template-item-tier").selectOption("rare");

    // The prefab renders through the same projection a live item does, so the stage proves the
    // template is a real tooltip rather than a form that only claims to describe one.
    await expect(page.getByTestId("tooltip-canvas")).toBeVisible();
    await expect(page.getByTestId("template-list")).toContainText("Sword");

    // The registry is authoring state: it has to survive the autosave round trip, because a
    // template that vanishes on reload cannot be the thing every item is derived from. The theme
    // is asserted alongside the tier because choosing a quality is what chooses the frame.
    await expect
        .poll(async () => {
            const body = (await (
                await request.get("/api/v1/document")
            ).json()) as { document: unknown };
            const parsed = projectDocumentSchema.safeParse(body.document);
            if (!parsed.success) return null;
            const template = itemTemplateRegistryOf(parsed.data).templates[0];
            return template ? `${template.itemTier}/${template.theme}` : null;
        })
        .toBe("rare/itemerness:quality-rare");
});

test("makes an item from a template and hands it to the item library", async ({
    page,
}) => {
    const created: Record<string, unknown>[] = [];
    await page.route("**/api/v1/runorpg/catalog/item", async (route) => {
        created.push(route.request().postDataJSON() as Record<string, unknown>);
        await route.fulfill({ json: { created: "runocraft:sword-1" } });
    });

    await page.getByTestId("mode-templates").click();
    await page.getByTestId("add-template").click();
    await page.getByTestId("template-display-name").fill("Sword");
    await page.getByTestId("template-material").fill("minecraft:diamond_sword");
    await page.getByTestId("template-item-tier").selectOption("corruption");

    await page.getByTestId("template-create-item").click();
    await page.getByTestId("template-new-item-name").fill("Ashen Sabre");
    await page.getByTestId("template-create-item-confirm").click();

    // What the server is asked to write is the template's values, flat: no template key, because
    // the plugin's loader rejects anything it does not declare.
    await expect.poll(() => created.length).toBe(1);
    expect(created[0]).toMatchObject({
        displayName: "Ashen Sabre",
        material: "minecraft:diamond_sword",
        theme: "itemerness:quality-corruption",
        itemTier: "corruption",
    });
    expect(JSON.stringify(created[0])).not.toContain("templateId");

    // And the author lands on the item itself, which is where quality, conditions and attributes
    // are tuned before saving again.
    await expect(page.getByTestId("mode-items")).toHaveAttribute(
        "aria-selected",
        "true",
    );
});
