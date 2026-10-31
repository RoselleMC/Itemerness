import { expect, test, type Page } from "@playwright/test";
import {
    previewArtifactSchema,
    type PreviewRequest,
} from "@itemerness/protocol";
import {
    API_URL,
    HANDSHAKE,
    enterWorkspace,
    mockPlugin,
} from "./fixtures/plugin.js";

const scale = {
    id: "scale",
    label: "Damage per level",
    type: { kind: "integer" },
    optional: true,
    choices: [],
    minimum: 1,
    maximum: 10,
    defaultValue: { kind: "integer", value: "3" },
};
const listing = (itemId: string) => ({
    itemId,
    providers: [
        {
            plugin: "RunoRPG",
            status: "offered",
            revision: "runo:7",
            scenarios: [
                {
                    id: "base",
                    label: "Base template",
                    description: null,
                    parameters: [],
                },
                {
                    id: "build",
                    label: "Build",
                    description: "Upper-bound rolls with a chosen scale.",
                    parameters: [scale],
                },
            ],
            failure: null,
        },
        {
            plugin: "Broken",
            status: "failed",
            revision: null,
            scenarios: [],
            failure: { code: "TIMEOUT", detail: "No answer within 250 ms" },
        },
    ],
    failure: null,
});

async function start(page: Page, outcome: "applied" | "failed") {
    await mockPlugin(page, undefined, API_URL, {
        ...HANDSHAKE,
        capabilities: [...HANDSHAKE.capabilities, "preview.providers"],
    });
    const previews: PreviewRequest[] = [];
    const listings: { itemId: string; snapshotHash: string }[] = [];
    await page.route(`${API_URL}/api/v2/preview/scenarios`, (route) => {
        const body = route.request().postDataJSON();
        listings.push(body);
        return route.fulfill({ json: listing(body.itemId) });
    });
    await page.route(`${API_URL}/api/v2/preview`, (route) => {
        const input = route.request().postDataJSON() as PreviewRequest;
        previews.push(input);
        const line = (text: string) => ({
            runs: [{ text, kind: "TEXT", style: { font: "minecraft:default" } }],
            logicalWidthPixels: 100,
            visualBounds: { left: 0, right: 100, top: -7, bottom: 1 },
        });
        const scenario = input.scenario;
        const artifact = previewArtifactSchema.parse({
            schemaVersion: 1,
            origin: "agent",
            itemId: input.itemId,
            viewer: input.viewer,
            display: {
                displayName: line(
                    scenario
                        ? `Damage ${scenario.id} ${JSON.stringify(scenario.parameters)}`
                        : `Manual values ${input.itemId}`,
                ),
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
            previewData: scenario
                ? {
                      plugin: scenario.plugin,
                      scenario: scenario.id,
                      revision: "runo:7",
                      status: outcome,
                      providedKeys:
                          outcome === "applied" ? ["example:attack-damage"] : [],
                      overriddenKeys: [],
                      messages:
                          outcome === "applied" ? ["Computed from level 12"] : [],
                      values: [],
                      failure:
                          outcome === "failed"
                              ? { code: "KEY_NOT_WRITABLE", detail: "itemerness:created-at" }
                              : null,
                  }
                : null,
        });
        return route.fulfill({ json: { artifact, stale: false } });
    });
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    await page.getByTestId("item-ember-blade").click();
    return { previews, listings };
}

test("a provider scenario is chosen per item, parameterised and sent with its previews", async ({
    page,
}, info) => {
    const { previews, listings } = await start(page, "applied");
    await page.getByTestId("open-scenario").click();
    const panel = page.getByTestId("scenario-panel");
    await expect(panel.getByTestId("scenario-provider-failure")).toContainText(
        "Broken could not list scenarios (TIMEOUT)",
    );
    expect(listings.at(-1)!.itemId).toBe("itemerness:ember-blade");
    await panel.getByTestId("scenario-select").click();
    await page.getByRole("option", { name: "RunoRPG · Build" }).click();
    await expect(page.getByTestId("open-scenario")).toContainText("build");
    await expect(page.getByTestId("preview-name")).toHaveText(
        "Damage build {}",
    );
    await panel.getByTestId("scenario-parameter-scale-default").click();
    await expect(page.getByTestId("preview-name")).toHaveText(
        'Damage build {"scale":{"kind":"integer","value":"3"}}',
    );
    const sent = previews.filter(
        (request) => request.itemId === "itemerness:ember-blade" && request.scenario,
    );
    expect(sent.at(-1)!.scenario).toEqual({
        plugin: "RunoRPG",
        id: "build",
        revision: "runo:7",
        parameters: { scale: { kind: "integer", value: "3" } },
    });
    await expect(panel.getByTestId("scenario-status")).toContainText(
        "1 value from RunoRPG.",
    );
    await expect(panel.getByTestId("scenario-status")).toContainText(
        "Computed from level 12",
    );
    await page.screenshot({ path: info.outputPath("scenario-panel.png") });

    // The choice belongs to this item; other items keep previewing manual values only.
    await page.keyboard.press("Escape");
    await page.getByTestId("item-travel-token").click();
    await expect(page.getByTestId("preview-name")).toHaveText(
        "Manual values itemerness:travel-token",
    );
    await expect(page.getByTestId("open-scenario")).toContainText("Scenario");
    expect(
        previews.filter(
            (request) =>
                request.itemId === "itemerness:travel-token" && request.scenario,
        ),
    ).toHaveLength(0);

    // Disconnecting clears scenario choices with the session.
    await page.getByTestId("item-ember-blade").click();
    await expect(page.getByTestId("open-scenario")).toContainText("build");
    await page.getByTestId("connection-trigger").click();
    await page.getByTestId("disconnect-plugin").click();
    await enterWorkspace(page);
    await page.getByTestId("item-ember-blade").click();
    await expect(page.getByTestId("open-scenario")).toContainText("Scenario");
});

test("a failed provider is reported and the preview no longer claims verified content", async ({
    page,
}) => {
    await start(page, "failed");
    await page.getByTestId("open-scenario").click();
    await page.getByTestId("scenario-select").click();
    await page.getByRole("option", { name: "RunoRPG · Base template" }).click();
    await expect(page.getByTestId("scenario-status")).toContainText(
        "RunoRPG did not provide data (KEY_NOT_WRITABLE)",
    );
    await page.keyboard.press("Escape");
    await page.getByTestId("fidelity-toggle").click();
    await expect(page.getByTestId("fidelity-content")).toContainText(
        "preview data provider for the selected scenario failed",
    );
});

test("plugins without providers show no scenario control and receive no scenario", async ({
    page,
}) => {
    await mockPlugin(page);
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    await expect(page.getByTestId("tooltip-canvas").first()).toBeVisible();
    await expect(page.getByTestId("open-scenario")).toHaveCount(0);
});
