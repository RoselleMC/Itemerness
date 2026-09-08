import { expect, test } from "@playwright/test";
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

test("retains configuration error detail and location without verifying partial output", async ({
    page,
}) => {
    const remote = await mockPlugin(page);
    await page.route(`${API_URL}/api/v2/preview`, async (route) => {
        const request = route.request().postDataJSON() as PreviewRequest;
        const artifact = previewArtifactSchema.parse({
            schemaVersion: 1,
            origin: "agent",
            itemId: request.itemId,
            viewer: request.viewer,
            display: {
                displayName: {
                    runs: [
                        {
                            text: "Invalid partial output",
                            kind: "TEXT",
                            style: { font: "minecraft:default" },
                        },
                    ],
                    logicalWidthPixels: 100,
                    visualBounds: { left: 0, right: 100, top: -7, bottom: 1 },
                },
                lore: [],
                tooltipStyle: null,
                renderer: "PLAIN",
                selectedTheme: "itemerness:default",
                requestedTheme: "itemerness:default",
                catalogRevision: 1,
            },
            diagnostics: [
                {
                    code: "CATALOG.INVALID_SCOPE",
                    messageKey: "diagnostics.catalog.invalid_scope",
                    params: {
                        detail: "Data key example:charges is not presentation-readable",
                        path: "presentation.items.itemerness:travel-token.blocks[1].data",
                    },
                    severity: "ERROR",
                    origin: "agent",
                },
            ],
            fidelity: [],
            failure: null,
            digests: {
                snapshot: request.snapshotHash,
                compiler: HANDSHAKE.compilerDigest,
            },
        });
        await route.fulfill({ json: { artifact, stale: false } });
    });
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    await expect(page.getByTestId("item-status-travel-token")).toHaveAttribute(
        "data-state",
        "error",
    );
    await expect(page.getByTestId("preview-name")).not.toHaveText(
        "Invalid partial output",
    );
    await page.getByTestId("open-diagnostics-chip").click();
    const diagnostics = page.getByTestId("diagnostics-list");
    await expect(diagnostics).toContainText(
        "Data key example:charges is not presentation-readable",
    );
    await expect(diagnostics).toContainText(
        "presentation.items.itemerness:travel-token.blocks[1].data",
    );
    await expect(diagnostics).not.toContainText("catalog.invalid_scope");
    await diagnostics.getByTestId("diagnostic-locate").click();
    await expect(page.getByTestId("content-inspector")).toBeVisible();
    await expect(page.getByTestId("block-list")).toHaveCount(1);
    await expect(page.getByTestId("undo")).toBeDisabled();
    expect(remote.writes).toHaveLength(0);
});
