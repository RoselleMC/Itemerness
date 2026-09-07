import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { portablePlan } from "./portable.mjs";

const input = { version: "0.1.0", targetRoot: "target" };

test("macOS builds an app, then distributes its containing zip", () => {
    const plan = portablePlan({ ...input, target: "aarch64-apple-darwin" });
    assert.deepEqual(plan.buildArgs, ["build", "--bundles", "app"]);
    assert.equal(
        plan.source,
        join("target", "release", "bundle", "macos", "Itemerness Editor.app"),
    );
    assert.equal(
        plan.artifact,
        join(
            "target",
            "release",
            "portable",
            "Itemerness-Editor_0.1.0_macos_aarch64.app.zip",
        ),
    );
});

test("Windows distributes the executable, not an NSIS setup program", () => {
    const plan = portablePlan({
        ...input,
        target: "x86_64-pc-windows-msvc",
        explicitTarget: true,
    });
    assert.deepEqual(plan.buildArgs, [
        "build",
        "--no-bundle",
        "--target",
        "x86_64-pc-windows-msvc",
    ]);
    assert.equal(
        plan.source,
        join(
            "target",
            "x86_64-pc-windows-msvc",
            "release",
            "itemerness-editor.exe",
        ),
    );
    assert.ok(
        plan.artifact.endsWith("Itemerness-Editor_0.1.0_windows_x86_64.exe"),
    );
});

test("rejects unsupported targets and path-bearing metadata", () => {
    for (const target of [
        "x86_64-pc-windows-gnu",
        "x86_64-unknown-linux-gnu",
        "../../windows",
    ]) {
        assert.throws(() => portablePlan({ ...input, target }));
    }
    assert.throws(() =>
        portablePlan({
            ...input,
            target: "aarch64-apple-darwin",
            version: "../bad",
        }),
    );
});

test("platform overrides preserve main-window dimensions and omit installers", () => {
    const read = (name) =>
        JSON.parse(
            readFileSync(
                new URL(`../src-tauri/${name}`, import.meta.url),
                "utf8",
            ),
        );
    const common = read("tauri.conf.json");
    const mac = read("tauri.macos.conf.json");
    const win = read("tauri.windows.conf.json");
    for (const config of [mac, win]) {
        for (const key of [
            "label",
            "title",
            "width",
            "height",
            "minWidth",
            "minHeight",
            "dragDropEnabled",
        ]) {
            assert.equal(
                config.app.windows[0][key],
                common.app.windows[0][key],
                key,
            );
        }
    }
    assert.equal(mac.app.windows[0].titleBarStyle, "Overlay");
    assert.equal(mac.app.windows[0].hiddenTitle, true);
    assert.equal(mac.app.windows[0].trafficLightPosition, undefined);
    assert.equal(win.app.windows[0].decorations, false);
    assert.deepEqual(mac.bundle.targets, ["app"]);
    assert.equal(win.bundle.active, false);
    assert.deepEqual(win.bundle.targets, []);
    const cargo = readFileSync(
        new URL("../.cargo/config.toml", import.meta.url),
        "utf8",
    );
    assert.ok(cargo.includes("target-feature=+crt-static"));
    const chrome = readFileSync(
        new URL("../src-tauri/src/mac_chrome.rs", import.meta.url),
        "utf8",
    );
    assert.ok(chrome.includes("NSWindowToolbarStyle::Unified)"));
    assert.ok(!chrome.includes("setFrame"));
});
