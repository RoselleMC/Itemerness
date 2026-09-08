import { expect, test } from "@playwright/test";
import { contentHash } from "@itemerness/protocol";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import { chooseValue, enterWorkspace, mockPlugin } from "./fixtures/plugin.js";

for (const missingValue of ["PATH", "FULL_KEY"] as const) {
    test(`MESSAGE empty pattern saves as a string and undoes with ${missingValue} fallback`, async ({
        page,
    }) => {
        const initial = structuredClone(baselineDocument);
        const format = initial.formats.find(
            (entry) => entry.id === "itemerness:key-path",
        )!;
        if (format.kind !== "namespacedKey")
            throw new Error("Missing key formatter fixture");
        format.mode = "MESSAGE";
        format.messagePattern = "values.{namespace}.{path}";
        format.missingValue = missingValue;
        const plugin = await mockPlugin(page, initial);
        await page.goto("/?lang=en-US");
        await enterWorkspace(page);
        await page.getByTestId("open-settings").click();
        await page.getByTestId("auto-save-toggle").uncheck();
        await page.getByTestId("mode-formats").click();
        await page.getByTestId(`formats-${format.id}`).click();
        const input = page.getByTestId("format-messagePattern");
        await input.clear();
        await input.press("Enter");
        await expect(input).toHaveAttribute("data-dirty", "false");
        await expect(page.getByTestId("format-apply")).toHaveCount(0);
        await page.keyboard.press("ControlOrMeta+s");
        await expect.poll(() => plugin.writes.length).toBe(1);
        expect(
            plugin.writes[0]!.document.formats.find(
                (entry) => entry.id === format.id,
            ),
        ).toMatchObject({ mode: "MESSAGE", messagePattern: "", missingValue });
        expect(plugin.writes[0]!.expectedHash).toBe(contentHash(initial));
        await page.getByTestId("undo").click();
        await expect(input).toHaveValue(format.messagePattern);
        await page.keyboard.press("ControlOrMeta+s");
        await expect.poll(() => plugin.writes.length).toBe(2);
        expect(
            plugin.writes[1]!.document.formats.find(
                (entry) => entry.id === format.id,
            ),
        ).toEqual(format);
        expect(plugin.writes[1]!.expectedHash).toBe(
            contentHash(plugin.writes[0]!.document),
        );
    });
}

for (const messagePattern of [null, "values.{namespace}.{path}"]) {
    test(`choosing MESSAGE initializes only a missing pattern and preserves ${messagePattern === null ? "empty" : "existing"} text through PATH`, async ({
        page,
    }) => {
        const initial = structuredClone(baselineDocument);
        const format = initial.formats.find(
            (entry) => entry.id === "itemerness:key-path",
        )!;
        if (format.kind !== "namespacedKey")
            throw new Error("Missing key formatter fixture");
        format.mode = "PATH";
        format.messagePattern = messagePattern;
        const plugin = await mockPlugin(page, initial);
        await page.goto("/?lang=en-US");
        await enterWorkspace(page);
        await page.getByTestId("open-settings").click();
        await page.getByTestId("auto-save-toggle").uncheck();
        await page.getByTestId("mode-formats").click();
        await page.getByTestId(`formats-${format.id}`).click();
        const mode = page.getByTestId("format-keyMode");
        const input = page.getByTestId("format-messagePattern");
        await chooseValue(page, mode, "MESSAGE");
        await expect(input).toHaveValue(messagePattern ?? "");
        await expect(page.getByTestId("format-apply")).toHaveCount(0);
        await page.keyboard.press("ControlOrMeta+s");
        await expect.poll(() => plugin.writes.length).toBe(1);
        const selected = (index: number) =>
            plugin.writes[index]!.document.formats.find(
                (entry) => entry.id === format.id,
            );
        expect(selected(0)).toEqual({
            ...format,
            mode: "MESSAGE",
            messagePattern: messagePattern ?? "",
        });
        await chooseValue(page, mode, "PATH");
        await expect(input).toHaveValue(messagePattern ?? "");
        await page.keyboard.press("ControlOrMeta+s");
        await expect.poll(() => plugin.writes.length).toBe(2);
        expect(selected(1)).toEqual({
            ...format,
            messagePattern: messagePattern ?? "",
        });
        await page.getByTestId("undo").click();
        await expect(mode).toHaveAttribute("data-field-value", "MESSAGE");
        await page.keyboard.press("ControlOrMeta+s");
        await expect.poll(() => plugin.writes.length).toBe(3);
        expect(selected(2)).toEqual(selected(0));
        await page.getByTestId("undo").click();
        await expect(mode).toHaveAttribute("data-field-value", "PATH");
        await page.keyboard.press("ControlOrMeta+s");
        await expect.poll(() => plugin.writes.length).toBe(4);
        expect(selected(3)).toEqual(format);
        expect(plugin.writes[0]!.expectedHash).toBe(contentHash(initial));
        for (let index = 1; index < plugin.writes.length; index++)
            expect(plugin.writes[index]!.expectedHash).toBe(
                contentHash(plugin.writes[index - 1]!.document),
            );
    });
}
