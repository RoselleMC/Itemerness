import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { unzipSync, strFromU8 } from "fflate";
import {
    contentHash,
    upgradeProjectDocument,
    type ProjectDocument,
} from "@itemerness/protocol";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import {
    API_URL,
    HANDSHAKE,
    connectPlugin,
    enterWorkspace,
    mockPlugin,
} from "./fixtures/plugin.js";

function fixture(namespace = "imported") {
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
    return document;
}
async function start(
    page: Page,
    initial: ProjectDocument | null = fixture("original"),
) {
    const plugin = await mockPlugin(page, initial);
    const candidate = fixture();
    await page.route(`${API_URL}/api/handshake`, (route) =>
        route.fulfill({
            json: {
                ...HANDSHAKE,
                documentSchemas: [1, 2],
                capabilities: [
                    ...HANDSHAKE.capabilities,
                    "catalog.read",
                    "catalog.export",
                ],
            },
        }),
    );
    await page.route(`${API_URL}/api/v2/catalog`, (route) =>
        route.fulfill({
            json: {
                document: candidate,
                sourceHash: "sha256:" + "1".repeat(64),
                diagnostics: [],
            },
        }),
    );
    await page.goto("/?lang=en-US");
    if (initial) await enterWorkspace(page);
    else {
        await connectPlugin(page);
        await expect(page.getByTestId("document-sync-status")).toHaveAttribute(
            "data-sync-kind",
            "empty",
        );
        await page.getByTestId("close-connection").click();
    }
    await page.getByTestId("open-settings").click();
    await page.getByTestId("auto-save-toggle").uncheck();
    return { ...plugin, candidate };
}

test("empty server draft stays locked until explicit reviewed import passes CAS creation", async ({
    page,
}, info) => {
    const plugin = await start(page, null);
    await expect(page.getByTestId("catalog-export")).toBeDisabled();
    expect(plugin.writes).toHaveLength(0);
    await page.getByTestId("catalog-read").click();
    await expect(page.getByTestId("catalog-review-close")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("catalog-review")).toHaveCount(0);
    expect(plugin.writes).toHaveLength(0);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    await page.route(`${API_URL}/api/v2/document`, async (route) => {
        if (route.request().method() === "PUT") await gate;
        await route.fallback();
    });
    await page.getByTestId("catalog-read").click();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByTestId("catalog-review")).toBeVisible();
    expect(
        await page
            .getByTestId("catalog-review")
            .evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
    await page.screenshot({
        path: info.outputPath("catalog-review-narrow.png"),
    });
    await page.getByTestId("catalog-replace").click();
    await expect(page.getByTestId("catalog-replace")).toBeDisabled();
    await expect(page.getByTestId("workspace")).toHaveAttribute(
        "data-ready",
        "false",
    );
    await page.keyboard.press("Control+s");
    await page.getByTestId("mode-items").click({ force: true });
    await expect(page.getByTestId("catalog-review")).toBeVisible();
    release();
    await expect(page.getByTestId("workspace")).toHaveAttribute(
        "data-ready",
        "true",
    );
    await expect(page.getByTestId("project-namespace")).toHaveValue("imported");
    expect(plugin.writes).toHaveLength(1);
    expect(plugin.writes[0]!.expectedHash).toBe("");
    expect(plugin.writes[0]!.document).toEqual(plugin.candidate);
});

test("dirty draft replacement supports Cancel, Save and Discard without clearing the original on failure", async ({
    page,
}) => {
    const plugin = await start(page);
    const input = page.getByTestId("project-namespace");
    await input.fill("unsaved");
    await input.press("Enter");
    await page.getByTestId("catalog-read").click();
    await page.getByTestId("catalog-replace").click();
    await expect(page.getByTestId("unsaved-dialog")).toBeVisible();
    await page.getByTestId("leave-cancel").click();
    await expect(page.getByTestId("catalog-review")).toBeVisible();
    expect(plugin.writes).toHaveLength(0);
    await page.getByTestId("catalog-replace").click();
    let releaseRecovery!: () => void;
    const recoveryGate = new Promise<void>((resolve) => {
        releaseRecovery = resolve;
    });
    await page.route(`${API_URL}/api/handshake`, async (route) => {
        await recoveryGate;
        await route.fallback();
    });
    await page.route(`${API_URL}/api/v2/document`, async (route) => {
        if (
            route.request().method() === "PUT" &&
            route.request().postDataJSON().document.namespace === "imported"
        )
            return route.fulfill({
                status: 503,
                json: { code: "UNAVAILABLE" },
            });
        await route.fallback();
    });
    await page.getByTestId("leave-save").click();
    await expect(page.getByTestId("catalog-error")).toContainText(
        "previous editor document",
    );
    expect(plugin.writes).toHaveLength(1);
    expect(plugin.writes[0]!.document.namespace).toBe("unsaved");
    await page.getByTestId("catalog-review-close").click();
    await expect(input).toHaveValue("unsaved");
    await expect(page.getByTestId("undo")).toBeEnabled();
    await expect(page.getByTestId("catalog-read")).toBeDisabled();
    await input.fill("discarded");
    await input.press("Enter");
    await page.unroute(`${API_URL}/api/v2/document`);
    let requests = 0;
    await page.route(`${API_URL}/api/v2/document`, async (route) => {
        if (route.request().method() === "PUT") {
            requests++;
            expect(route.request().postDataJSON().expectedHash).toBe(
                contentHash(plugin.writes[0]!.document),
            );
            return route.fulfill({
                json: {
                    snapshotHash: contentHash(plugin.candidate),
                    revision: 3,
                    diagnostics: [],
                },
            });
        }
        return route.fulfill({
            json: {
                document: plugin.writes[0]!.document,
                snapshotHash: contentHash(plugin.writes[0]!.document),
                revision: 2,
            },
        });
    });
    releaseRecovery();
    await page.getByTestId("catalog-read").click();
    await page.getByTestId("catalog-replace").click();
    await page.getByTestId("leave-discard").click();
    await expect(input).toHaveValue("imported");
    expect(requests).toBe(1);
    await expect(page.getByTestId("undo")).toBeDisabled();
});

test("import review exposes runtime differences without writing and cancels when the current draft changes", async ({
    page,
}, info) => {
    const plugin = await start(page);
    const namespace = page.getByTestId("project-namespace");
    await namespace.fill("current");
    await namespace.press("Enter");
    const candidate = plugin.candidate;
    candidate.namespace = "current";
    candidate.defaultLocale = "zh_cn";
    candidate.defaultTheme = candidate.themes[1]!.id;
    candidate.items.forEach((item) => {
        item.enabled = false;
        item.uuid = crypto.randomUUID();
    });
    candidate.bitmaps[0]!.texture = "itemerness:changed.png";
    candidate.formats.push({
        ...structuredClone(candidate.formats[0]!),
        uuid: crypto.randomUUID(),
        id: "itemerness:new-format",
    });
    const messages = candidate.locales[0]!.messages;
    const keys = Object.keys(messages);
    messages[keys[0]!] = "Changed translation";
    delete messages[keys[1]!];
    messages["new.message"] = "New translation";
    await page.getByTestId("catalog-read").click();
    await expect(
        page.getByTestId("catalog-setting-schemaVersion").locator("td"),
    ).toHaveText(["2", "2"]);
    await expect(
        page.getByTestId("catalog-setting-defaultLocale").locator("td"),
    ).toHaveText(["en_us", "zh_cn"]);
    await expect(
        page.getByTestId("catalog-setting-defaultTheme").locator("td"),
    ).toHaveText(["itemerness:default", candidate.defaultTheme]);
    await expect(
        page.getByTestId("catalog-enabled-items").locator("td"),
    ).toHaveText(["5", "0"]);
    await expect(page.getByTestId("catalog-count-items")).toContainText(
        "Added: 0, removed: 0, changed: 5",
    );
    await expect(page.getByTestId("catalog-count-formats")).toContainText(
        "Added: 1, removed: 0, changed: 0",
    );
    await expect(page.getByTestId("catalog-count-bitmaps")).toContainText(
        "Added: 0, removed: 0, changed: 1",
    );
    await expect(page.getByTestId("catalog-message-diff")).toContainText(
        "Added: 1, removed: 1, changed: 1",
    );
    expect(plugin.writes).toHaveLength(0);
    await page.screenshot({
        path: info.outputPath("catalog-diff-desktop.png"),
    });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
        await page
            .getByTestId("catalog-review")
            .evaluate((element) =>
                [...element.querySelectorAll("table, th, td")].every(
                    (child) => child.scrollWidth <= child.clientWidth,
                ),
            ),
    ).toBe(true);
    const footer = await page.getByTestId("catalog-replace").boundingBox();
    expect(footer!.y + footer!.height).toBeLessThan(844);
    await page.screenshot({ path: info.outputPath("catalog-diff-narrow.png") });
    await page.setViewportSize({ width: 320, height: 700 });
    expect(
        await page
            .locator(".catalog-counts-diff thead th")
            .evaluateAll((cells) =>
                cells.every((cell) => {
                    const range = document.createRange();
                    range.selectNodeContents(cell);
                    return range.getClientRects().length === 1;
                }),
            ),
    ).toBe(true);
    await page.setViewportSize({ width: 390, height: 844 });
    for (const inputType of ["historyUndo", "historyRedo"]) {
        await namespace.evaluate((element, inputType) => {
            element.dispatchEvent(
                new InputEvent("beforeinput", {
                    inputType,
                    bubbles: true,
                    cancelable: true,
                }),
            );
        }, inputType);
        await expect(page.getByTestId("catalog-review")).toBeVisible();
        await expect(namespace).toHaveValue("current");
    }
    await page.keyboard.press("ControlOrMeta+z");
    await expect(page.getByTestId("catalog-review")).toBeVisible();
    await expect(namespace).toHaveValue("current");
    await applicationMenuAction(page, "edit", "undo");
    await expect(page.getByTestId("catalog-review")).toHaveCount(0);
    await expect(namespace).toHaveValue("original");
    expect(plugin.writes).toHaveLength(0);
});

test("failed empty import cannot seed the workspace on later polls", async ({
    page,
}) => {
    const plugin = await start(page, null);
    let attempts = 0;
    await page.route(`${API_URL}/api/v2/document`, async (route) => {
        if (route.request().method() === "PUT") {
            attempts++;
            return route.fulfill({
                status: 409,
                json: {
                    code: "DRAFT_CONFLICT",
                    actualHash: "sha256:" + "2".repeat(64),
                },
            });
        }
        return route.fallback();
    });
    await page.getByTestId("catalog-read").click();
    await page.getByTestId("catalog-replace").click();
    await expect(page.getByTestId("catalog-error")).toBeVisible();
    plugin.replace(fixture("other-editor"));
    await page.waitForTimeout(3600);
    await expect(page.getByTestId("workspace")).toHaveAttribute(
        "data-ready",
        "false",
    );
    expect(attempts).toBe(1);
});

test("exports a bounded ZIP with a config patch and never publishes or saves a draft", async ({
    page,
}) => {
    const plugin = await start(page);
    let exports = 0;
    await page.route(`${API_URL}/api/v2/catalog/export`, (route) => {
        exports++;
        expect(route.request().postDataJSON()).toMatchObject({
            snapshotHash: contentHash(fixture("original")),
            targetServerId: "test",
        });
        return route.fulfill({
            json: {
                files: [{ path: "items/editor.yml", content: "items: {}\n" }],
                settingsPatch: "locale:\n  default: en_us\n",
                diagnostics: [],
            },
        });
    });
    const download = page.waitForEvent("download");
    await page.getByTestId("catalog-export").click();
    const file = await download;
    expect(file.suggestedFilename()).toBe("itemerness-catalog.zip");
    const files = unzipSync(await readFile((await file.path())!));
    expect(Object.keys(files).sort()).toEqual([
        "config.patch.yml",
        "items/editor.yml",
    ]);
    expect(strFromU8(files["config.patch.yml"]!)).toContain("default: en_us");
    expect(plugin.writes).toHaveLength(0);
    expect(exports).toBe(1);
});

test("busy reads have an actionable error without retries and stale read results never replace context", async ({
    page,
}) => {
    const plugin = await start(page);
    let reads = 0;
    await page.route(`${API_URL}/api/v2/catalog`, (route) => {
        reads++;
        return route.fulfill({
            status: 429,
            headers: { "Retry-After": "1" },
            json: { code: "CATALOG_BUSY" },
        });
    });
    await page.getByTestId("catalog-read").click();
    await expect(page.getByTestId("catalog-error")).toContainText(
        "Try again shortly",
    );
    await page.waitForTimeout(1200);
    expect(reads).toBe(1);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    await page.route(`${API_URL}/api/v2/catalog`, async (route) => {
        await gate;
        await route.fulfill({
            json: {
                document: plugin.candidate,
                sourceHash: "sha256:" + "1".repeat(64),
                diagnostics: [],
            },
        });
    });
    await page.getByTestId("catalog-read").click();
    await page.getByTestId("mode-items").click();
    release();
    await page.getByTestId("open-settings").click();
    await expect(page.getByTestId("catalog-review")).toHaveCount(0);
    await expect(page.getByTestId("project-namespace")).toHaveValue("original");
    expect(plugin.writes).toHaveLength(0);
});

test("a late empty poll cannot undo a successful first import", async ({
    page,
}) => {
    const plugin = await start(page, null);
    let release!: () => void;
    let polled = false;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    await page.route(`${API_URL}/api/v2/document`, async (route) => {
        if (route.request().method() !== "GET" || polled)
            return route.fallback();
        polled = true;
        await gate;
        return route.fulfill({
            status: 404,
            json: { code: "DRAFT_NOT_FOUND" },
        });
    });
    await expect.poll(() => polled).toBe(true);
    await page.getByTestId("catalog-read").click();
    await page.getByTestId("catalog-replace").click();
    await expect(page.getByTestId("project-namespace")).toHaveValue("imported");
    release();
    await page.waitForTimeout(3500);
    await expect(page.getByTestId("workspace")).toHaveAttribute(
        "data-ready",
        "true",
    );
    await expect(page.getByTestId("project-namespace")).toHaveValue("imported");
    expect(plugin.writes).toHaveLength(1);
});

test("import serializes after an in-flight autosave using its accepted hash", async ({
    page,
}) => {
    const plugin = await start(page);
    await page.getByTestId("auto-save-toggle").check();
    let release!: () => void;
    let saving = false;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    await page.route(`${API_URL}/api/v2/document`, async (route) => {
        if (route.request().method() === "PUT" && !saving) {
            saving = true;
            await gate;
        }
        return route.fallback();
    });
    const input = page.getByTestId("project-namespace");
    await input.fill("automatic");
    await input.press("Enter");
    await expect.poll(() => saving).toBe(true);
    await page.getByTestId("catalog-read").click();
    await page.getByTestId("catalog-replace").click();
    await page.getByTestId("leave-discard").click();
    await expect(page.getByTestId("catalog-replace")).toBeDisabled();
    expect(plugin.writes).toHaveLength(0);
    release();
    await expect(input).toHaveValue("imported");
    expect(plugin.writes).toHaveLength(2);
    expect(plugin.writes[1]!.expectedHash).toBe(
        contentHash(plugin.writes[0]!.document),
    );
    expect(plugin.writes[0]!.document.namespace).toBe("automatic");
    expect(plugin.writes[1]!.document.namespace).toBe("imported");
});

test("a failed replacement preserves the original even when a later poll reports no draft", async ({
    page,
}) => {
    const plugin = await start(page);
    const input = page.getByTestId("project-namespace");
    await input.fill("recoverable");
    await input.press("Enter");
    let attempts = 0;
    await page.route(`${API_URL}/api/v2/document`, async (route) => {
        if (route.request().method() === "PUT") {
            attempts++;
            return route.fulfill({
                status: 503,
                json: { code: "UNAVAILABLE" },
            });
        }
        return route.fallback();
    });
    await page.getByTestId("catalog-read").click();
    await page.getByTestId("catalog-replace").click();
    await page.getByTestId("leave-discard").click();
    await expect(page.getByTestId("catalog-error")).toBeVisible();
    await page.getByTestId("catalog-review-close").click();
    plugin.replace(null);
    await expect(page.getByTestId("document-sync-status")).toHaveAttribute(
        "data-sync-kind",
        "conflict",
    );
    await expect(page.getByTestId("workspace")).toHaveAttribute(
        "data-ready",
        "true",
    );
    await expect(input).toHaveValue("recoverable");
    await expect(page.getByTestId("undo")).toBeEnabled();
    expect(attempts).toBe(1);
});
import { applicationMenuAction } from "./fixtures/applicationMenu.js";
