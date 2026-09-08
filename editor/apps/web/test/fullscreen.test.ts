import { describe, expect, it } from "vitest";
import { createFullscreenToggle } from "../src/window/fullscreen.js";

function fakeWindow(initialMaximized: boolean) {
    let maximized = initialMaximized;
    let fullscreen = false;
    const calls: string[] = [];
    return {
        calls,
        isMaximized: async () => maximized,
        isFullscreen: async () => fullscreen,
        toggleMaximize: async () => {
            maximized = !maximized;
            calls.push(`maximized:${maximized}`);
        },
        setFullscreen: async (value: boolean) => {
            fullscreen = value;
            calls.push(`fullscreen:${value}`);
        },
    };
}

describe("native fullscreen transitions", () => {
    it("leaves maximized mode before fullscreen and restores it on exit", async () => {
        const window = fakeWindow(true);
        const toggle = createFullscreenToggle(window);
        await toggle();
        await toggle();
        expect(window.calls).toEqual([
            "maximized:false",
            "fullscreen:true",
            "fullscreen:false",
            "maximized:true",
        ]);
    });
    it("does not maximize a previously floating window", async () => {
        const window = fakeWindow(false);
        const toggle = createFullscreenToggle(window);
        await toggle();
        await toggle();
        expect(window.calls).toEqual(["fullscreen:true", "fullscreen:false"]);
    });
    it("restores maximization after an entry failure and permits retry", async () => {
        const window = fakeWindow(true);
        const change = window.setFullscreen;
        window.setFullscreen = async () => {
            throw new Error("Unavailable");
        };
        const toggle = createFullscreenToggle(window);
        await expect(toggle()).rejects.toThrow("Unavailable");
        expect(await window.isMaximized()).toBe(true);
        window.setFullscreen = change;
        await toggle();
        expect(await window.isFullscreen()).toBe(true);
    });
    it("ignores overlapping transitions instead of racing window state", async () => {
        const window = fakeWindow(true);
        const toggle = createFullscreenToggle(window);
        await Promise.all([toggle(), toggle()]);
        expect(window.calls).toEqual(["maximized:false", "fullscreen:true"]);
    });
});
