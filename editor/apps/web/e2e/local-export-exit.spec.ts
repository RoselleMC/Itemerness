import { expect, test, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";

const config = fileURLToPath(
    new URL(
        "../../../../itemerness-bukkit/src/main/resources/config.yml",
        import.meta.url,
    ),
);
async function nativeExitBridge(page: Page) {
    await page.addInitScript(() => {
        const runtime = window as unknown as Record<string, unknown>;
        const callbacks = new Map<number, (event: unknown) => void>();
        const listeners = new Map<number, { event: string; handler: number }>();
        let next = 0;
        runtime.isTauri = true;
        runtime.exitConfirmed = 0;
        runtime.exportResult = false;
        runtime.exports = [];
        runtime.emitNativeExit = () => {
            for (const [id, listener] of listeners)
                if (listener.event === "editor-exit-requested")
                    callbacks.get(listener.handler)?.({
                        event: listener.event,
                        id,
                        payload: null,
                    });
        };
        runtime.__TAURI_INTERNALS__ = {
            metadata: { currentWindow: { label: "main" } },
            transformCallback: (callback: (event: unknown) => void) => {
                callbacks.set(++next, callback);
                return next;
            },
            unregisterCallback: (id: number) => callbacks.delete(id),
            invoke: async (command: string, args: Record<string, unknown>) => {
                if (command === "plugin:event|listen") {
                    listeners.set(
                        ++next,
                        args as { event: string; handler: number },
                    );
                    return next;
                }
                if (command === "plugin:event|unlisten") {
                    listeners.delete(Number(args.eventId));
                    return;
                }
                if (command === "confirm_editor_exit")
                    runtime.exitConfirmed = Number(runtime.exitConfirmed) + 1;
                if (command === "save_editor_export") {
                    (runtime.exports as unknown[]).push(args);
                    if (runtime.exportResult === "error")
                        throw new Error("EXPORT_SAVE_FAILED");
                    return runtime.exportResult;
                }
                if (command === "plugin:window|is_maximized") return false;
                if (command === "plugin:window|is_focused") return true;
            },
        };
        runtime.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
            unregisterListener: (id: number) => listeners.delete(id),
        };
    });
}
async function exit(page: Page) {
    await page.evaluate(() =>
        (window as unknown as { emitNativeExit(): void }).emitNativeExit(),
    );
}

test("disconnected local edits participate in exit protection; cancel and failed exports never close", async ({
    page,
}) => {
    await nativeExitBridge(page);
    await page.goto("/?lang=en-US");
    await page.getByTestId("open-settings").click();
    await page.getByTestId("local-file-input").setInputFiles(config);
    const input = page.getByTestId("local-editor-port");
    await input.fill("18328");
    await expect(page.getByTestId("workspace")).toHaveAttribute(
        "data-ready",
        "false",
    );
    await page.keyboard.press("Control+s");
    expect(
        await page.evaluate(
            () => (window as unknown as { exports: unknown[] }).exports,
        ),
    ).toHaveLength(0);
    await exit(page);
    await expect(page.getByTestId("unsaved-dialog")).toContainText(
        "Export local configuration changes",
    );
    await page.getByTestId("leave-cancel").click();
    await expect(input).toHaveValue("18328");
    await exit(page);
    await page.getByTestId("leave-save").click();
    await expect(page.getByTestId("unsaved-dialog")).toContainText(
        "did not complete",
    );
    expect(
        await page.evaluate(
            () =>
                (window as unknown as { exitConfirmed: number }).exitConfirmed,
        ),
    ).toBe(0);
    await page.evaluate(() => {
        (window as unknown as { exportResult: unknown }).exportResult = "error";
    });
    await page.getByTestId("leave-save").click();
    await expect(page.getByTestId("unsaved-dialog")).toBeVisible();
    expect(
        await page.evaluate(
            () =>
                (window as unknown as { exitConfirmed: number }).exitConfirmed,
        ),
    ).toBe(0);
    await page.evaluate(() => {
        (window as unknown as { exportResult: unknown }).exportResult = true;
    });
    await page.getByTestId("leave-save").click();
    await expect
        .poll(() =>
            page.evaluate(
                () =>
                    (window as unknown as { exitConfirmed: number })
                        .exitConfirmed,
            ),
        )
        .toBe(1);
    const exports = await page.evaluate(
        () =>
            (
                window as unknown as {
                    exports: { kind: string; bytes: number[] }[];
                }
            ).exports,
    );
    expect(exports).toHaveLength(3);
    expect(exports.at(-1)!.kind).toBe("config");
    expect(
        new TextDecoder().decode(Uint8Array.from(exports.at(-1)!.bytes)),
    ).toContain("port: 18328");
});

test("invalid local fields block exit export, while browser unload also sees local dirty state", async ({
    page,
}) => {
    await nativeExitBridge(page);
    await page.goto("/?lang=en-US");
    await page.getByTestId("open-settings").click();
    await page.getByTestId("local-file-input").setInputFiles(config);
    await page.getByTestId("local-editor-port").fill("-");
    expect(
        await page.evaluate(() => {
            const event = new Event("beforeunload", { cancelable: true });
            window.dispatchEvent(event);
            return event.defaultPrevented;
        }),
    ).toBe(true);
    await exit(page);
    await page.getByTestId("leave-save").click();
    await expect(page.getByTestId("unsaved-dialog")).toContainText(
        "did not complete",
    );
    expect(
        await page.evaluate(
            () => (window as unknown as { exports: unknown[] }).exports,
        ),
    ).toHaveLength(0);
    expect(
        await page.evaluate(
            () =>
                (window as unknown as { exitConfirmed: number }).exitConfirmed,
        ),
    ).toBe(0);
    await page.getByTestId("leave-discard").click();
    await expect
        .poll(() =>
            page.evaluate(
                () =>
                    (window as unknown as { exitConfirmed: number })
                        .exitConfirmed,
            ),
        )
        .toBe(1);
});
