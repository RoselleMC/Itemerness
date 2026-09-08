import { expect, type Page, type Locator } from "@playwright/test";
import { contentHash, type ProjectDocument } from "@itemerness/protocol";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";

export const API_URL = "http://127.0.0.1:18087";
export const TEST_TOKEN = "test-" + "a".repeat(40);
export const HANDSHAKE = {
    product: "itemerness",
    serverId: "test",
    serverAlias: "",
    pluginVersion: "0.1.0",
    minecraftVersion: "26.1.2",
    platform: "Folia",
    authentication: "none",
    compilerDigest: "sha256:" + "0".repeat(64),
    protocols: [{ major: 2, minMinor: 0, maxMinor: 0 }],
    documentSchemas: [1],
    previewSchemas: [1],
    capabilities: [
        "draft.read",
        "draft.write",
        "preview.compile",
        "presentation.segmented-frame.decorations",
        "catalog.base-components.attributes-enchantments",
    ],
};

export async function mockPlugin(
    page: Page,
    initial: ProjectDocument | null = baselineDocument,
    baseUrl = API_URL,
    handshake = HANDSHAKE,
) {
    let document = initial && structuredClone(initial);
    let revision = 1;
    const writes: { document: ProjectDocument; expectedHash: string }[] = [];
    await page.route(`${baseUrl}/api/handshake`, (route) =>
        route.fulfill({ json: handshake }),
    );
    await page.route(`${baseUrl}/api/v2/server`, (route) => {
        const body = route.request().postDataJSON();
        if (body.targetServerId !== handshake.serverId)
            return route.fulfill({
                status: 409,
                json: { code: "TARGET_MISMATCH" },
            });
        if (body.expectedAlias !== handshake.serverAlias)
            return route.fulfill({
                status: 409,
                json: { code: "SERVER_ALIAS_CONFLICT" },
            });
        handshake.serverAlias = body.alias;
        return route.fulfill({
            json: {
                serverId: handshake.serverId,
                serverAlias: handshake.serverAlias,
            },
        });
    });
    await page.route(`${baseUrl}/api/v2/document`, (route) => {
        if (route.request().method() === "PUT") {
            const body = route.request().postDataJSON() as {
                document: ProjectDocument;
                expectedHash: string;
            };
            writes.push(body);
            if (body.expectedHash !== (document ? contentHash(document) : ""))
                return route.fulfill({
                    status: 409,
                    json: {
                        code: "DRAFT_CONFLICT",
                        actualHash: document ? contentHash(document) : "",
                    },
                });
            document = body.document;
            revision++;
            return route.fulfill({
                json: {
                    serverId: handshake.serverId,
                    snapshotHash: contentHash(document),
                    revision,
                    diagnostics: [],
                },
            });
        }
        return document
            ? route.fulfill({
                  json: {
                      serverId: handshake.serverId,
                      document,
                      snapshotHash: contentHash(document),
                      revision,
                  },
              })
            : route.fulfill({ status: 404, json: { code: "DRAFT_NOT_FOUND" } });
    });
    await page.route(`${baseUrl}/api/v2/preview`, (route) =>
        route.fulfill({ status: 503, json: { code: "PREVIEW_UNAVAILABLE" } }),
    );
    return {
        writes,
        replace(next: ProjectDocument | null) {
            document = next && structuredClone(next);
            revision++;
        },
    };
}

export async function connectPlugin(page: Page, url = API_URL, token = "") {
    if (!(await page.getByTestId("connection-popup").isVisible()))
        await page.getByTestId("connection-trigger").click();
    if (await page.getByTestId("disconnect-plugin").isVisible())
        await page.getByTestId("disconnect-plugin").click();
    await page.getByTestId("plugin-api-url").fill(url);
    await page.getByTestId("plugin-api-token").fill(token);
    await page.getByTestId("connect-plugin").click();
}

export async function enterWorkspace(page: Page, url = API_URL) {
    await connectPlugin(page, url);
    await expect(page.getByTestId("workspace")).toHaveAttribute(
        "data-ready",
        "true",
    );
    await page.getByTestId("close-connection").click();
}

export function namedDocument(name: string) {
    const document = structuredClone(baselineDocument);
    document.locales.find(
        (entry) => entry.locale === document.defaultLocale,
    )!.messages[document.items[0]!.presentation.nameMessage] = name;
    return document;
}

export async function setNavigationExpanded(page: Page, expanded: boolean) {
    const toggle = page.getByTestId("toggle-navigation");
    if ((await toggle.getAttribute("aria-expanded")) !== String(expanded))
        await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", String(expanded));
}

export async function setZoom(page: Page, scale: number) {
    await page.getByTestId("canvas-zoom").click();
    await page.getByTestId(`canvas-zoom-${scale}`).click();
    await expect(page.getByTestId("canvas-viewport")).toHaveAttribute(
        "data-zoom",
        String(scale),
    );
}

export async function selectContent(page: Page, uuid: string) {
    await page.getByTestId("content-menu").click();
    await page.getByTestId(`select-content-${uuid}`).click();
}

export async function selectPreviewLanguage(page: Page, locale: string) {
    await chooseValue(page, page.getByTestId("preview-language"), locale);
}

export async function chooseValue(page: Page, target: Locator, value: string) {
    await target.click();
    await page
        .getByRole("option")
        .and(page.locator(`[data-option-value=${JSON.stringify(value)}]`))
        .click();
    await expect(target).toHaveAttribute("data-field-value", value);
}
export async function setColor(page: Page, id: string, value: string) {
    await page.getByTestId(id).click();
    await page.getByTestId(`${id}-hex`).fill(value);
    await page.getByTestId(`${id}-hex`).press("Escape");
    await expect(page.getByTestId(id)).toHaveAttribute("data-color", value);
}
