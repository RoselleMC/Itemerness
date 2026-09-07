import { expect, test, type Page } from "@playwright/test";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import { zipSync } from "fflate";
import {
    API_URL,
    HANDSHAKE,
    TEST_TOKEN,
    connectPlugin,
    enterWorkspace,
    mockPlugin,
    namedDocument,
} from "./fixtures/plugin.js";

async function locked(page: Page, message = "Not connected") {
    await expect(page.getByTestId("workspace")).toHaveAttribute(
        "data-ready",
        "false",
    );
    await expect(page.getByTestId("workspace-status")).toContainText(message);
    await expect(page.getByTestId("item-tree")).toHaveCount(0);
    await expect(page.getByTestId("tooltip-canvas")).toHaveCount(0);
    await expect(page.getByTestId("name-input")).toHaveCount(0);
    for (const id of [
        "mode-items",
        "mode-themes",
        "mode-layouts",
        "mode-data",
        "open-assets",
        "open-translations",
    ])
        await expect(page.getByTestId(id)).toBeDisabled();
}

test("direct IP HTTP connections allow empty tokens and show a non-blocking encryption warning", async ({
    page,
}) => {
    const address = "http://192.168.1.10:18087";
    await mockPlugin(page, namedDocument("Direct IP server"), address);
    const requests: { url: string; authorization?: string }[] = [];
    page.on("request", (request) => {
        if (request.url().startsWith(address))
            requests.push({
                url: request.url(),
                authorization: request.headers()["authorization"],
            });
    });
    await page.goto("/?lang=en-US");
    await connectPlugin(page, address);
    await expect(page.getByTestId("workspace")).toHaveAttribute(
        "data-ready",
        "true",
    );
    await expect(
        page.getByTestId("connection-transport-warning"),
    ).toContainText("not encrypted");
    await expect(page.getByTestId("connection-authentication")).toHaveText(
        "No token required",
    );
    await expect(page.getByTestId("item-tree")).toContainText(
        "Direct IP server",
    );
    expect(
        requests.some((request) => request.url.endsWith("/api/v2/document")),
    ).toBe(true);
    expect(
        requests.every((request) => request.authorization === undefined),
    ).toBe(true);
    await page.getByTestId("disconnect-plugin").click();
    await page.getByTestId("plugin-api-url").fill("https://server.example.com");
    await expect(page.getByTestId("connection-transport-warning")).toHaveCount(
        0,
    );
});

test("startup ignores local examples and recovery caches and keeps the workspace grey", async ({
    page,
}, testInfo) => {
    const requests: string[] = [];
    page.on("request", (request) => {
        if (new URL(request.url()).pathname.startsWith("/api/"))
            requests.push(request.url());
    });
    await page.addInitScript((document) => {
        localStorage.setItem(
            "itemerness.local-draft.v1",
            JSON.stringify(document),
        );
        localStorage.setItem(
            "itemerness.recovery.v2:http%3A%2F%2F127.0.0.1%3A18087",
            JSON.stringify({ document, serverId: "old" }),
        );
    }, baselineDocument);
    await page.goto("/?lang=en-US");
    await locked(page);
    await expect(page.locator("body")).not.toContainText("Ember Blade");
    expect(requests).toEqual([]);
    await page.getByTestId("connection-trigger").click();
    await expect(page.getByTestId("plugin-api-url")).toBeFocused();
    await page.getByTestId("close-connection").click();
    await page.screenshot({
        path: testInfo.outputPath("disconnected-workspace.png"),
        fullPage: true,
    });
});

test("handshake alone does not unlock editing and initial load never uploads a seed document", async ({
    page,
}) => {
    const remote = await mockPlugin(
        page,
        namedDocument("Only from the plugin"),
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    await page.route(`${API_URL}/api/v2/document`, async (route) => {
        await gate;
        await route.fallback();
    });
    await page.goto("/?lang=en-US");
    await connectPlugin(page);
    await expect(page.getByTestId("connection-trigger")).toHaveAttribute(
        "data-state",
        "connected",
    );
    await locked(page, "Loading server configuration");
    release();
    await expect(page.getByTestId("preview-name")).toHaveText(
        "Only from the plugin",
    );
    expect(remote.writes).toHaveLength(0);
    await page.getByTestId("close-connection").click();
    await page.getByTestId("name-input").fill("Edited while connected");
    await expect.poll(() => remote.writes.length).toBe(1);
    await expect(page.getByTestId("document-sync-status")).toHaveAttribute(
        "data-sync-kind",
        "saved",
    );
});

test("a plugin without a document stays empty and never receives editor defaults", async ({
    page,
}) => {
    const remote = await mockPlugin(page, null);
    await page.goto("/?lang=en-US");
    await connectPlugin(page);
    await locked(page, "No configuration document");
    await expect(page.getByTestId("connection-status")).toHaveText("Connected");
    expect(remote.writes).toHaveLength(0);
    remote.replace(namedDocument("Published authoring document"));
    await expect(page.getByTestId("preview-name")).toHaveText(
        "Published authoring document",
    );
    expect(remote.writes).toHaveLength(0);
});

test("disconnect and server switching remove the previous server's content", async ({
    page,
}) => {
    await mockPlugin(page, namedDocument("Server A"));
    await mockPlugin(page, namedDocument("Server B"), "http://127.0.0.1:18088");
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    await expect(page.getByTestId("preview-name")).toHaveText("Server A");
    await page.getByTestId("connection-trigger").click();
    await page.getByTestId("disconnect-plugin").click();
    await locked(page);
    await expect(page.locator("body")).not.toContainText("Server A");
    await connectPlugin(page, "http://127.0.0.1:18088");
    await expect(page.getByTestId("preview-name")).toHaveText("Server B");
    await expect(page.getByTestId("document-sync-status")).toHaveAttribute(
        "data-sync-kind",
        "saved",
    );
    await page.reload();
    await locked(page);
    await expect(page.locator("body")).not.toContainText("Server B");
});

test("a stale document response cannot unlock a cancelled or replaced session", async ({
    page,
}) => {
    await mockPlugin(page, namedDocument("Old response"));
    await mockPlugin(
        page,
        namedDocument("New connection"),
        "http://127.0.0.1:18088",
    );
    let started = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    await page.route(`${API_URL}/api/v2/document`, async (route) => {
        started = true;
        await gate;
        await route.fallback();
    });
    await page.goto("/?lang=en-US");
    await connectPlugin(page);
    await expect.poll(() => started).toBe(true);
    await connectPlugin(page, "http://127.0.0.1:18088");
    await expect(page.getByTestId("preview-name")).toHaveText("New connection");
    release();
    await expect(page.getByTestId("preview-name")).toHaveText("New connection");
    await expect(page.locator("body")).not.toContainText("Old response");
});

test("protocol incompatibility and missing credentials never expose a workspace", async ({
    page,
}) => {
    const remote = await mockPlugin(page);
    await page.route(`${API_URL}/api/handshake`, (route) =>
        route.fulfill({
            json: {
                ...HANDSHAKE,
                protocols: [{ major: 3, minMinor: 0, maxMinor: 0 }],
            },
        }),
    );
    await page.goto("/?lang=en-US");
    await connectPlugin(page);
    await expect(page.getByTestId("connection-error")).toContainText(
        "Incompatible",
    );
    await locked(page);
    expect(remote.writes).toHaveLength(0);
    await page.route(`${API_URL}/api/handshake`, (route) =>
        route.fulfill({ status: 401, json: { code: "UNAUTHORIZED" } }),
    );
    await connectPlugin(page);
    await expect(page.getByTestId("connection-error")).toContainText(
        "requires an access token",
    );
    await locked(page);
});

test("a cancelled handshake never reconnects after the response arrives", async ({
    page,
}) => {
    await mockPlugin(page);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    let started = false;
    await page.route(`${API_URL}/api/handshake`, async (route) => {
        started = true;
        await gate;
        await route.fallback();
    });
    await page.goto("/?lang=en-US");
    await connectPlugin(page);
    await expect.poll(() => started).toBe(true);
    await page.getByTestId("disconnect-plugin").click();
    release();
    await locked(page);
    await expect(page.getByTestId("connection-status")).toHaveText("Offline");
});

test("connection popup handles keyboard dismissal without storing unsubmitted tokens", async ({
    page,
}) => {
    await page.goto("/?lang=en-US");
    const trigger = page.getByTestId("connection-trigger");
    await trigger.focus();
    await trigger.press("ArrowDown");
    await expect(page.getByTestId("plugin-api-url")).toBeFocused();
    await page.getByTestId("plugin-api-token").fill(TEST_TOKEN);
    await page.getByTestId("plugin-api-token").press("Escape");
    await expect(trigger).toBeFocused();
    await trigger.press("Enter");
    await expect(page.getByTestId("plugin-api-token")).toHaveValue("");
    await page.getByTestId("workspace-status").click();
    await expect(page.getByTestId("connection-popup")).toHaveCount(0);
    expect(
        await page.evaluate(() => JSON.stringify({ ...localStorage })),
    ).not.toContain(TEST_TOKEN);
});

test("an incompatible plugin restart clears the current workspace even with the popup closed", async ({
    page,
}) => {
    await mockPlugin(page, namedDocument("Before restart"));
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    await page.route(`${API_URL}/api/handshake`, (route) =>
        route.fulfill({ json: { ...HANDSHAKE, documentSchemas: [2] } }),
    );
    await locked(page);
    await expect(page.getByTestId("connection-summary")).toHaveText(
        "Incompatible",
    );
    await expect(page.locator("body")).not.toContainText("Before restart");
});

test("deleting the server document locks and clears the workspace without seeding it again", async ({
    page,
}) => {
    const remote = await mockPlugin(page);
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    remote.replace(null);
    await locked(page, "No configuration document");
    expect(remote.writes).toHaveLength(0);
});

test("conflicts within a connected editing session require an explicit reload", async ({
    page,
}) => {
    const remote = await mockPlugin(page, namedDocument("Server original"));
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    await page.getByTestId("name-input").fill("Unsaved local edit");
    remote.replace(namedDocument("Other editor's change"));
    await expect(page.getByTestId("document-sync-status")).toHaveAttribute(
        "data-sync-kind",
        "conflict",
    );
    await expect(page.getByTestId("preview-name")).toHaveText(
        "Unsaved local edit",
    );
    await page.getByTestId("connection-trigger").click();
    await page.getByTestId("connection-resolve-draft").click();
    await expect(page.getByTestId("preview-name")).toHaveText(
        "Other editor's change",
    );
    await expect(page.getByTestId("connection-trigger")).toBeFocused();
});

test("empty token connects without Authorization and reveals only the plugin document", async ({
    page,
}, testInfo) => {
    const document = namedDocument("Anonymous plugin document");
    await mockPlugin(page, document);
    await page.route(`${API_URL}/api/**`, async (route) => {
        expect(route.request().headers()).not.toHaveProperty("authorization");
        await route.fallback();
    });
    await page.goto("/?lang=en-US");
    await connectPlugin(page);
    await expect(page.getByTestId("connection-authentication")).toHaveText(
        "No token required",
    );
    await expect(page.getByTestId("preview-name")).toHaveText(
        "Anonymous plugin document",
    );
    await page.screenshot({
        path: testInfo.outputPath("connected-workspace.png"),
        fullPage: true,
    });
});

test("closing the popup keeps the connection attempt without prematurely enabling editing", async ({
    page,
}) => {
    await mockPlugin(page);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    let started = false;
    await page.route(`${API_URL}/api/handshake`, async (route) => {
        started = true;
        await gate;
        await route.fallback();
    });
    await page.goto("/?lang=en-US");
    await connectPlugin(page);
    await expect.poll(() => started).toBe(true);
    await page.getByTestId("close-connection").click();
    await locked(page, "Loading");
    release();
    await expect(page.getByTestId("workspace")).toHaveAttribute(
        "data-ready",
        "true",
    );
    await expect(page.getByTestId("connection-popup")).toHaveCount(0);
});

test("an asset import from a disconnected session cannot populate a new workspace", async ({
    page,
}) => {
    await mockPlugin(page);
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    await page.evaluate(() => {
        const original = File.prototype.arrayBuffer;
        File.prototype.arrayBuffer = function () {
            return new Promise<ArrayBuffer>((resolve) => {
                (
                    window as unknown as { releaseImport: () => void }
                ).releaseImport = () => resolve(original.call(this));
            });
        };
    });
    await page.getByTestId("open-assets").click();
    const archive = zipSync({
        "pack.mcmeta": new TextEncoder().encode(
            JSON.stringify({
                pack: { pack_format: 0, description: "Old session" },
            }),
        ),
    });
    await page.getByTestId("asset-file-input").setInputFiles({
        name: "old-session.zip",
        mimeType: "application/zip",
        buffer: Buffer.from(archive),
    });
    await enterWorkspace(page);
    await page.evaluate(() =>
        (window as unknown as { releaseImport: () => void }).releaseImport(),
    );
    await page.getByTestId("open-assets").click();
    await expect(page.getByTestId("assets-empty")).toBeVisible();
    await expect(page.getByTestId("pack-list")).toHaveCount(0);
    await expect(page.getByTestId("mount-error")).toHaveCount(0);
});
