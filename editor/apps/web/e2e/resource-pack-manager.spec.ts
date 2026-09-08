import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { zipSync } from "fflate";
import { enterWorkspace, mockPlugin, chooseValue } from "./fixtures/plugin.js";
const manifests = ["1.21.11", "26.1.1", "26.1.2", "26.2"].map(
    (version) =>
        JSON.parse(
            readFileSync(
                new URL(
                    `../../../../tools/font-metrics/${version}.sources.json`,
                    import.meta.url,
                ),
                "utf8",
            ),
        ) as {
            clientVersion: string;
            client: { sha1: string };
            assetIndex: { sha1: string };
        },
);

const icon = new Uint8Array(
    readFileSync(new URL("../src-tauri/icons/32x32.png", import.meta.url)),
);
const archive = (description: string) =>
    zipSync(
        {
            "pack.mcmeta": new TextEncoder().encode(
                JSON.stringify({
                    pack: {
                        min_format: 84,
                        max_format: 84,
                        description: {
                            text: description,
                            extra: [
                                {
                                    text: "\nResource pack details",
                                    color: "green",
                                },
                            ],
                        },
                    },
                }),
            ),
            "pack.png": icon,
        },
        { mtime: new Date("1980-01-01") },
    );

async function cachedVersions(page: Page) {
    const entries = manifests.map((manifest) => {
        const bytes = archive(`Minecraft ${manifest.clientVersion}`);
        return {
            key: `vanilla-v2:${manifest.clientVersion}:${manifest.client.sha1}:${manifest.assetIndex.sha1}`,
            bytes: Array.from(bytes),
            sha1: createHash("sha1").update(bytes).digest("hex"),
        };
    });
    await page.addInitScript(async (entries) => {
        const db = await new Promise<IDBDatabase>((resolve) => {
            const open = indexedDB.open("itemerness-assets", 1);
            open.onupgradeneeded = () =>
                open.result.createObjectStore("bundles");
            open.onsuccess = () => resolve(open.result);
        });
        const tx = db.transaction("bundles", "readwrite");
        for (const entry of entries)
            tx.objectStore("bundles").put(
                { bytes: new Uint8Array(entry.bytes), sha1: entry.sha1 },
                entry.key,
            );
        tx.oncomplete = () => db.close();
    }, entries);
}

async function mutableFilePicker(page: Page, bytes: Uint8Array) {
    await page.addInitScript((initial) => {
        const runtime = window as unknown as {
            __packFixture: { bytes: number[]; modified: number };
            showOpenFilePicker: () => Promise<unknown[]>;
        };
        runtime.__packFixture = { bytes: initial, modified: 1 };
        runtime.showOpenFilePicker = async () => [
            {
                kind: "file",
                name: "Quality frames.zip",
                getFile: async () =>
                    new File(
                        [new Uint8Array(runtime.__packFixture.bytes)],
                        "Quality frames.zip",
                        {
                            type: "application/zip",
                            lastModified: runtime.__packFixture.modified,
                        },
                    ),
            },
        ];
    }, Array.from(bytes));
}

test("path handles reload automatically, retain valid bytes on failure, and keep the base fixed", async ({
    page,
}, testInfo) => {
    const plugin = await mockPlugin(page);
    await cachedVersions(page);
    await mutableFilePicker(page, archive("Initial pack"));
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    await page.getByTestId("open-assets").click();
    await expect(page.getByTestId("vanilla-pack")).toHaveAttribute(
        "data-status",
        "ready",
    );
    await page
        .getByRole("button", { name: "Import pack", exact: true })
        .click();
    const row = page.getByTestId("pack-0");
    await expect(row).toContainText("Initial pack");
    await expect(
        row.getByRole("switch", { name: "Auto reload" }),
    ).toBeChecked();
    await expect(row.getByTestId("pack-icon-canvas")).toBeVisible();
    expect(
        await row
            .getByTestId("pack-icon-canvas")
            .evaluate((canvas: HTMLCanvasElement) =>
                [
                    ...canvas
                        .getContext("2d")!
                        .getImageData(0, 0, canvas.width, canvas.height).data,
                ].some((value, i) => i % 4 === 3 && value > 0),
            ),
    ).toBe(true);
    await page.evaluate(
        (bytes) => {
            const fixture = (
                window as unknown as {
                    __packFixture: { bytes: number[]; modified: number };
                }
            ).__packFixture;
            fixture.bytes = bytes;
            fixture.modified++;
        },
        Array.from(archive("Auto updated pack")),
    );
    await expect(row).toContainText("Auto updated pack");
    await expect(
        page
            .getByTestId("app-toast")
            .filter({ hasText: "Reloaded Quality frames.zip" }),
    ).toHaveCount(1);
    await row.getByRole("switch", { name: "Auto reload" }).uncheck();
    await page.evaluate(() => {
        const fixture = (
            window as unknown as {
                __packFixture: { bytes: number[]; modified: number };
            }
        ).__packFixture;
        fixture.bytes = [1, 2, 3];
        fixture.modified++;
    });
    await row
        .getByRole("button", { name: "Reload resource pack", exact: true })
        .click();
    await expect(row).toContainText("Reload failed");
    await expect(row).toContainText("Previous valid content is still active");
    await expect(row).toContainText("Auto updated pack");
    await page.evaluate(
        (bytes) => {
            const fixture = (
                window as unknown as {
                    __packFixture: { bytes: number[]; modified: number };
                }
            ).__packFixture;
            fixture.bytes = bytes;
            fixture.modified++;
        },
        Array.from(archive("Repaired pack")),
    );
    await row
        .getByRole("button", { name: "Reload resource pack", exact: true })
        .click();
    await expect(row).toContainText("Repaired pack");
    await expect(page.getByTestId("mount-error")).toHaveCount(0);
    await chooseValue(page, page.getByTestId("vanilla-version"), "26.2");
    await expect(page.getByTestId("vanilla-pack")).toHaveAttribute(
        "data-status",
        "ready",
    );
    await expect(page.getByTestId("vanilla-pack")).toHaveCount(1);
    await expect(
        page.getByTestId("pack-list").locator("li").last(),
    ).toHaveAttribute("data-testid", "vanilla-pack");
    await expect(row).toContainText("Repaired pack");
    expect(plugin.writes).toHaveLength(0);
    for (const width of [1440, 900, 390, 320]) {
        await page.setViewportSize({ width, height: 844 });
        expect(
            await page.evaluate(
                () => document.documentElement.scrollWidth <= innerWidth,
            ),
        ).toBe(true);
        await page.screenshot({
            path: testInfo.outputPath(`packs-${width}.png`),
            fullPage: true,
        });
    }
});

test("the whole page accepts multiple packs, settings persist, and toast dismissal does not steal focus", async ({
    page,
}) => {
    const plugin = await mockPlugin(page);
    await cachedVersions(page);
    await page.goto("/?lang=en-US");
    await enterWorkspace(page);
    await page.getByTestId("open-assets").click();
    await expect(page.locator(".dropzone")).toHaveCount(0);
    const dataTransfer = await page.evaluateHandle(
        (bytes) => {
            const data = new DataTransfer();
            for (const name of ["first.zip", "second.zip"])
                data.items.add(
                    new File([new Uint8Array(bytes)], name, {
                        type: "application/zip",
                    }),
                );
            return data;
        },
        Array.from(archive("Dropped pack")),
    );
    await page
        .getByTestId("asset-dropzone")
        .dispatchEvent("drop", { dataTransfer });
    await expect(page.getByTestId("pack-list")).toContainText("first.zip");
    await expect(page.getByTestId("pack-list")).toContainText("second.zip");
    await expect(page.getByTestId("pack-0").getByRole("switch")).toBeDisabled();
    await page
        .getByTestId("pack-0")
        .getByRole("button", { name: "Priority", exact: true })
        .press("ArrowDown");
    await expect(page.getByTestId("pack-0")).toContainText("first.zip");
    const handle = page
        .getByTestId("pack-0")
        .getByRole("button", { name: "Priority", exact: true });
    const start = await handle.boundingBox();
    const target = await page.getByTestId("pack-1").boundingBox();
    await page.mouse.move(
        start!.x + start!.width / 2,
        start!.y + start!.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
        target!.x + target!.width / 2,
        target!.y + target!.height / 2,
        { steps: 5 },
    );
    await page.keyboard.press("Escape");
    await page.mouse.up();
    await expect(page.getByTestId("pack-0")).toContainText("first.zip");
    await page.mouse.move(
        start!.x + start!.width / 2,
        start!.y + start!.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
        target!.x + target!.width / 2,
        target!.y + target!.height / 2,
        { steps: 5 },
    );
    await page.mouse.up();
    await expect(page.getByTestId("pack-0")).toContainText("second.zip");
    await page.getByTestId("open-settings").click();
    const interval = page.getByTestId("pack-check-interval");
    await expect(interval).toHaveValue("1000");
    await interval.fill("100");
    await interval.press("Tab");
    await expect(interval).toHaveAttribute("aria-invalid", "true");
    await interval.press("Escape");
    await expect(interval).toHaveValue("1000");
    await interval.fill("750");
    await interval.press("Tab");
    expect(
        await page.evaluate(() =>
            localStorage.getItem("itemerness.pack-check-interval"),
        ),
    ).toBe("750");
    await expect(page.getByTestId("undo")).toBeDisabled();
    expect(plugin.writes).toHaveLength(0);
    await page
        .getByTestId("toast-stack")
        .getByRole("button", { name: "Close", exact: true })
        .last()
        .click();
    await page.reload();
    await enterWorkspace(page);
    await page.getByTestId("open-settings").click();
    await expect(page.getByTestId("pack-check-interval")).toHaveValue("750");
});
