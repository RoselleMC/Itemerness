import { expect, test } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import {
    contentHash,
    previewArtifactSchema,
    type PreviewRequest,
} from "@itemerness/protocol";
import {
    API_URL,
    HANDSHAKE,
    enterWorkspace,
    mockPlugin,
} from "./fixtures/plugin.js";

test("warms full previews, switches within a frame, and invalidates on viewer/document/compiler/session changes", async ({
    page,
}, testInfo) => {
    await mockPlugin(page);
    const requests: PreviewRequest[] = [];
    let compiler = HANDSHAKE.compilerDigest;
    let handshakes = 0;
    await page.route(`${API_URL}/api/handshake`, (route) => {
        handshakes++;
        return route.fulfill({
            json: { ...HANDSHAKE, compilerDigest: compiler },
        });
    });
    await page.route(`${API_URL}/api/v2/preview`, async (route) => {
        const input = route.request().postDataJSON() as PreviewRequest;
        requests.push(input);
        const text = `Verified ${input.itemId}`;
        const line = {
            runs: [
                { text, kind: "TEXT", style: { font: "minecraft:default" } },
            ],
            logicalWidthPixels: 100,
            visualBounds: { left: 0, right: 100, top: -7, bottom: 1 },
        };
        const artifact = previewArtifactSchema.parse({
            schemaVersion: 1,
            origin: "agent",
            itemId: input.itemId,
            viewer: input.viewer,
            display: {
                displayName: line,
                lore: [line],
                tooltipStyle: null,
                renderer: "VANILLA_CHARACTER_FRAME",
                selectedTheme: "itemerness:vanilla-frame",
                requestedTheme: "itemerness:vanilla-frame",
                catalogRevision: 1,
            },
            fidelity: [],
            diagnostics: [],
            digests: { snapshot: input.snapshotHash, compiler },
            failure: null,
        });
        await route.fulfill({ json: { artifact, stale: false } });
    });
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    await expect
        .poll(() => new Set(requests.map((request) => request.itemId)).size)
        .toBe(5);
    await expect(page.getByTestId("preview-name")).toHaveText(
        "Verified itemerness:travel-token",
    );
    for (const item of [
        "travel-token",
        "ember-blade",
        "survey-codex",
        "nested-satchel",
        "framed-relic",
    ]) {
        await expect(page.getByTestId(`item-status-${item}`)).toHaveAttribute(
            "data-state",
            "verified",
        );
    }
    // Wait for already-started background responses to finish without a timing assumption.
    for (const item of ["ember-blade", "survey-codex", "framed-relic"]) {
        await page.getByTestId(`item-${item}`).click();
        await expect(page.getByTestId("preview-name")).toHaveText(
            `Verified itemerness:${item}`,
        );
    }
    const before = requests.length;
    const timings = [];
    for (const item of [
        "travel-token",
        "ember-blade",
        "survey-codex",
        "travel-token",
    ]) {
        const result = await page.evaluate((item) => {
            const start = performance.now();
            document
                .querySelector<HTMLButtonElement>(
                    `[data-testid="item-${item}"]`,
                )!
                .click();
            return new Promise<{
                elapsed: number;
                name: string | null;
                origin: string | null;
            }>((resolve) =>
                requestAnimationFrame(() =>
                    resolve({
                        elapsed: performance.now() - start,
                        name: document.querySelector(
                            '[data-testid="preview-name"]',
                        )!.textContent,
                        origin: document
                            .querySelector('[data-testid="tooltip-canvas"]')!
                            .getAttribute("data-preview-origin"),
                    }),
                ),
            );
        }, item);
        expect(result.name).toBe(`Verified itemerness:${item}`);
        expect(result.origin).toBe("agent");
        expect(result.elapsed).toBeLessThan(200);
        timings.push({ item, ...result });
    }
    expect(requests.length).toBe(before);
    await expect.poll(() => handshakes).toBeGreaterThan(1);
    expect(requests.length).toBe(before);
    await testInfo.attach("warm-preview-switches", {
        body: JSON.stringify(timings),
        contentType: "application/json",
    });
    mkdirSync(testInfo.outputPath(), { recursive: true });
    writeFileSync(
        testInfo.outputPath("warm-preview-switches.json"),
        JSON.stringify(timings, null, 2),
    );
    await page.getByTestId("preview-language").click();
    await page.getByTestId("preview-language-option-zh_cn").click();
    await expect
        .poll(() =>
            requests.some((request) => request.viewer.locale === "zh_cn"),
        )
        .toBe(true);
    const oldHash = requests[0]!.snapshotHash;
    await page.getByTestId("name-input").fill("Changed document");
    await expect
        .poll(() =>
            requests.some((request) => request.snapshotHash !== oldHash),
        )
        .toBe(true);
    await expect
        .poll(
            () =>
                new Set(
                    requests
                        .filter(
                            (request) =>
                                request.snapshotHash !== oldHash &&
                                request.viewer.locale === "zh_cn",
                        )
                        .map((request) => request.itemId),
                ).size,
        )
        .toBe(5);
    const count = requests.length;
    compiler = "sha256:" + "1".repeat(64);
    await expect
        .poll(() => requests.length, { timeout: 10000 })
        .toBeGreaterThan(count);
    const beforeReconnect = requests.length;
    await enterWorkspace(page);
    await expect.poll(() => requests.length).toBeGreaterThan(beforeReconnect);
    await expect
        .poll(
            () =>
                requests.filter(
                    (request) =>
                        request.viewer.locale === "en_us" &&
                        contentHash(request.document) === request.snapshotHash,
                ).length,
        )
        .toBeGreaterThan(1);
});
