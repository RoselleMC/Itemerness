import { expect, test, type Page } from "@playwright/test";
import {
    upgradeProjectDocument,
    type ProjectDocument,
} from "@itemerness/protocol";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import {
    API_URL,
    HANDSHAKE,
    enterWorkspace,
    mockPlugin,
} from "./fixtures/plugin.js";

const MiB = 1024 * 1024;
const hash = (digit: string) => "sha256:" + digit.repeat(64);
const handshake = {
    ...HANDSHAKE,
    documentSchemas: [1, 2],
    capabilities: [
        ...HANDSHAKE.capabilities,
        "catalog.read",
        "catalog.export",
        "catalog.status",
        "transfer.limits",
    ],
    limits: {
        documentBytes: 16 * MiB,
        requestBytes: 17 * MiB,
        responseBytes: 17 * MiB,
    },
};

function imported(sourceHash: string | null, namespace = "imported") {
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
    document.namespace = namespace;
    document.defaultTheme = "itemerness:default";
    document.defaultLayout = "itemerness:plain";
    if (sourceHash) document.sourceLayout = { sourceHash, files: {} };
    return document;
}

async function start(
    page: Page,
    draft: ProjectDocument,
    status: () => string,
    candidate: ProjectDocument | null = null,
) {
    const plugin = await mockPlugin(page, draft, API_URL, handshake);
    const checks: string[] = [];
    await page.route(`${API_URL}/api/v2/catalog/status`, (route) => {
        checks.push(route.request().method());
        return route.fulfill({
            json: { serverId: "test", sourceHash: status() },
        });
    });
    if (candidate)
        await page.route(`${API_URL}/api/v2/catalog`, (route) =>
            route.fulfill({
                json: {
                    document: candidate,
                    sourceHash: candidate.sourceLayout!.sourceHash,
                    diagnostics: [],
                },
            }),
        );
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    return { ...plugin, checks };
}

test("a draft whose server YAML changed says so and leads to a reviewed import", async ({
    page,
}, info) => {
    let live = hash("2");
    const plugin = await start(
        page,
        imported(hash("1"), "stale"),
        () => live,
        imported(hash("2")),
    );
    const chip = page.getByTestId("catalog-baseline");
    await expect(chip).toBeVisible();
    await expect(chip).toContainText("YAML changed");
    await chip.click();
    await expect(page.getByTestId("catalog-baseline-notice")).toContainText(
        "not the live configuration",
    );
    await page.screenshot({ path: info.outputPath("baseline-notice.png") });
    // Checking is read-only: the draft is untouched until the author confirms the review.
    expect(plugin.writes).toHaveLength(0);
    await page.getByTestId("catalog-baseline-review").click();
    await expect(page.getByTestId("workspace-page")).toHaveAttribute(
        "data-page",
        "settings",
    );
    await expect(page.getByTestId("catalog-review")).toBeVisible();
    await expect(page.getByTestId("catalog-baseline-status")).toHaveAttribute(
        "data-status",
        "changed",
    );
    expect(plugin.writes).toHaveLength(0);
    await page.getByTestId("catalog-replace").click();
    await expect(page.getByTestId("catalog-review")).toHaveCount(0);
    await expect(page.getByTestId("project-namespace")).toHaveValue("imported");
    expect(plugin.writes).toHaveLength(1);
    await expect(page.getByTestId("catalog-baseline-status")).toHaveAttribute(
        "data-status",
        "current",
    );
    await page.getByTestId("mode-items").click();
    await expect(chip).toHaveCount(0);
    expect(plugin.checks.every((method) => method === "GET")).toBe(true);

    // Someone edits the YAML while the editor stays open; focusing the window rechecks.
    live = hash("3");
    await page.clock.install();
    await page.clock.fastForward(16_000);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(chip).toBeVisible();
});

test("drafts without an import fingerprint or plugins without status show no stale notice", async ({
    page,
}) => {
    const plugin = await start(page, imported(null), () => hash("9"));
    await expect(page.getByTestId("tooltip-canvas").first()).toBeVisible();
    await expect(page.getByTestId("catalog-baseline")).toHaveCount(0);
    expect(plugin.checks).toHaveLength(0);
    await page.getByTestId("open-settings").click();
    await expect(page.getByTestId("catalog-baseline-status")).toHaveAttribute(
        "data-status",
        "unknown",
    );
});

test("size refusals name both sizes and keep the saved draft", async ({
    page,
}) => {
    await start(page, imported(hash("1")), () => hash("1"));
    await page.route(`${API_URL}/api/v2/document`, (route) =>
        route.request().method() === "PUT"
            ? route.fulfill({
                  status: 413,
                  json: {
                      code: "DOCUMENT_TOO_LARGE",
                      serverId: "test",
                      actualBytes: 17 * MiB + 1024,
                      limitBytes: 16 * MiB,
                  },
              })
            : route.fallback(),
    );
    await page.route(`${API_URL}/api/v2/catalog`, (route) =>
        route.fulfill({
            status: 422,
            json: {
                code: "CATALOG_DOCUMENT_TOO_LARGE",
                diagnostics: [
                    {
                        code: "CATALOG.DOCUMENT_TOO_LARGE",
                        severity: "ERROR",
                        origin: "agent",
                        messageKey: "diagnostics.catalog.document_too_large",
                        params: {
                            actualBytes: String(18 * MiB),
                            limitBytes: String(16 * MiB),
                        },
                    },
                ],
            },
        }),
    );
    await page.getByTestId("open-settings").click();
    const namespace = page.getByTestId("project-namespace");
    await namespace.fill("grown");
    await namespace.press("Enter");
    await expect(page.getByTestId("toast-stack")).toContainText(
        "the document is 17.00 MiB and the plugin accepts 16.00 MiB",
    );
    await page.getByTestId("catalog-read").click();
    const error = page.getByTestId("catalog-error");
    await expect(error).toContainText("too large to import");
    await expect(error).toContainText(
        "The document is 18.00 MiB; the plugin accepts 16.00 MiB.",
    );
    await expect(error).toContainText("Reduce the configuration");
    await expect(page.getByTestId("catalog-draft-kept")).toBeVisible();
    await expect(page.getByTestId("catalog-review")).toHaveCount(0);
});
