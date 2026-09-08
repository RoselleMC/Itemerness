import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";
import { enterWorkspace, mockPlugin } from "./fixtures/plugin.js";

const resources = new URL(
    "../../../../itemerness-bukkit/src/main/resources/",
    import.meta.url,
);
const path = (name: string) => fileURLToPath(new URL(name, resources));
async function start(page: Page, file: string, connected = false) {
    const remote: string[] = [];
    page.on("request", (request) => {
        if (new URL(request.url()).pathname.startsWith("/api/"))
            remote.push(request.method());
    });
    if (connected) await mockPlugin(page);
    await page.goto("/?lang=en-US");
    if (connected) await enterWorkspace(page);
    await page.getByTestId("open-settings").click();
    await page.getByTestId("local-file-input").setInputFiles(path(file));
    await expect(page.locator(".local-file-name")).toHaveText(file);
    return remote;
}
async function downloadYaml(page: Page): Promise<string> {
    const pending = page.waitForEvent("download");
    await page.getByTestId("local-export").click();
    const download = await pending;
    return readFile((await download.path())!, "utf8");
}

test("local config edits remain isolated, preserve original bytes and reject incomplete values", async ({
    page,
}) => {
    const remote = await start(page, "config.yml");
    expect(await downloadYaml(page)).toBe(
        await readFile(path("config.yml"), "utf8"),
    );
    await page.getByTestId("local-editor-port").fill("-");
    await expect(page.getByTestId("local-export")).toBeDisabled();
    await expect(page.locator(".local-state")).toHaveText("Unexported changes");
    await page.getByTestId("local-undo").click();
    await expect(page.getByTestId("local-editor-port")).toHaveValue("18087");
    await page
        .getByTestId("local-editor-token")
        .fill("local-session-only-test-secret-123456");
    await page.getByTestId("local-editor-enabled").check();
    await expect(page.getByTestId("local-editor-token")).toHaveAttribute(
        "type",
        "password",
    );
    await page.getByTestId("local-editor-token").click({ button: "right" });
    await expect(
        page.getByRole("menuitem", { name: "Copy value", exact: true }),
    ).toHaveAttribute("aria-disabled", "true");
    await page.keyboard.press("Escape");
    await page.getByTestId("local-editor-port").fill("19000");
    const exported = parseDocument(await downloadYaml(page), {
        version: "1.1",
    }).toJS();
    expect(exported.editor).toMatchObject({
        enabled: true,
        port: 19000,
        token: "local-session-only-test-secret-123456",
    });
    await expect(page.locator(".local-state")).toHaveText(
        "No unexported changes",
    );
    const stored = await page.evaluate(
        () =>
            Object.values(localStorage).join(" ") +
            Object.values(sessionStorage).join(" "),
    );
    expect(stored).not.toContain("local-session-only-test-secret");
    expect(remote).toEqual([]);
});

test("access grants enforce conditional namespaces and retain unrelated fields across action changes", async ({
    page,
}, info) => {
    const remote = await start(page, "access.yml");
    await page.getByTestId("local-add-grant").click();
    await page.getByTestId("local-api-grants-0-plugin").fill("DemoPlugin");
    await page
        .getByRole("checkbox", { name: "Read Data", exact: true })
        .check();
    await expect(page.getByTestId("local-export")).toBeDisabled();
    const groups = page.locator(".local-grant .local-list");
    await groups.nth(0).getByRole("button", { name: "Add Entry" }).click();
    await page
        .getByTestId("local-api-grants-0-item-namespaces-0")
        .fill("items");
    await groups.nth(1).getByRole("button", { name: "Add Entry" }).click();
    await page
        .getByTestId("local-api-grants-0-data-namespaces-0")
        .fill("stats");
    await expect(page.getByTestId("local-export")).toBeEnabled();
    await page
        .getByRole("checkbox", { name: "Read Data", exact: true })
        .uncheck();
    await page
        .getByRole("checkbox", { name: "Write Viewer Fact", exact: true })
        .check();
    await expect(page.getByTestId("local-export")).toBeDisabled();
    await groups.nth(2).getByRole("button", { name: "Add Entry" }).click();
    await page
        .getByTestId("local-api-grants-0-viewer-fact-namespaces-0")
        .fill("viewer");
    const exported = parseDocument(await downloadYaml(page), {
        version: "1.1",
    }).toJS();
    expect(exported.api.grants[0]).toEqual({
        plugin: "DemoPlugin",
        actions: ["write-viewer-fact"],
        "item-namespaces": ["items"],
        "data-namespaces": ["stats"],
        "viewer-fact-namespaces": ["viewer"],
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page
        .getByTestId("local-api-grants-0-plugin")
        .scrollIntoViewIfNeeded();
    expect(
        await page
            .getByTestId("local-operations")
            .evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
    await page.screenshot({ path: info.outputPath("local-access-narrow.png") });
    await page
        .getByRole("button", { name: "Delete Grant", exact: true })
        .click();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page.locator(".local-grant")).toHaveCount(0);
    await page.getByTestId("local-undo").click();
    await expect(page.getByTestId("local-api-grants-0-plugin")).toHaveValue(
        "DemoPlugin",
    );
    expect(remote).toEqual([]);
});

test("dirty file replacement requires explicit discard and unknown YAML remains preserved and unexportable", async ({
    page,
}) => {
    await start(page, "config.yml", true);
    await page.getByTestId("local-editor-port").fill("19000");
    await page
        .getByTestId("local-file-input")
        .setInputFiles(path("access.yml"));
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByTestId("local-editor-port")).toHaveValue("19000");
    await page.getByTestId("open-assets").click();
    await page.getByTestId("open-settings").click();
    await expect(page.getByTestId("local-editor-port")).toHaveValue("19000");
    const original = await readFile(path("config.yml"), "utf8");
    await page
        .getByTestId("local-file-input")
        .setInputFiles({
            name: "config.yml",
            mimeType: "application/yaml",
            buffer: Buffer.from(
                original + "\n# future comment\nfuture: preserved-value\n",
            ),
        });
    await page.getByRole("button", { name: "Discard", exact: true }).click();
    await expect(page.locator(".local-diagnostics")).toContainText(
        "Unknown keys are preserved",
    );
    await expect(page.getByTestId("local-export")).toBeDisabled();
    await page.getByTestId("local-editor-port").fill("19500");
    await expect(page.getByTestId("local-export")).toBeDisabled();
    await page.getByTestId("local-undo").click();
    await expect(page.getByTestId("local-editor-port")).toHaveValue("18087");
    await page.getByTestId("local-close").click();
    await expect(page.locator(".local-file-name")).toHaveCount(0);
});

test("late local file reads never replace newer edits or report errors after close", async ({
    page,
}) => {
    await start(page, "config.yml");
    await page.evaluate(() => {
        const original = File.prototype.arrayBuffer;
        const runtime = window as unknown as {
            finishLocalRead?: () => void;
            failLocalRead?: () => void;
        };
        File.prototype.arrayBuffer = function () {
            return new Promise((resolve, reject) => {
                runtime.finishLocalRead = () => {
                    void original.call(this).then(resolve, reject);
                };
                runtime.failLocalRead = () =>
                    reject(new Error("private-file-detail"));
            });
        };
    });
    await page
        .getByTestId("local-file-input")
        .setInputFiles(path("access.yml"));
    await page.getByTestId("local-editor-port").fill("19000");
    await page.evaluate(() =>
        (window as unknown as { finishLocalRead(): void }).finishLocalRead(),
    );
    await expect(page.getByTestId("local-editor-port")).toHaveValue("19000");
    await expect(page.getByRole("alert")).toContainText("current file changed");
    await page.getByTestId("local-undo").click();
    await page
        .getByTestId("local-file-input")
        .setInputFiles(path("access.yml"));
    await page.getByTestId("local-close").click();
    await page.evaluate(() =>
        (window as unknown as { failLocalRead(): void }).failLocalRead(),
    );
    await expect(page.locator(".local-file-name")).toHaveCount(0);
    await expect(page.getByRole("alert")).toHaveCount(0);
});
