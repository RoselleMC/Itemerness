import { spawnSync } from "node:child_process";
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function portablePlan({
    target,
    version,
    explicitTarget = false,
    targetRoot,
}) {
    if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/.test(version))
        throw new Error("Invalid app version");
    const match = /^(aarch64|x86_64)-(apple-darwin|pc-windows-msvc)$/.exec(
        target,
    );
    if (!match) throw new Error(`Unsupported portable target: ${target}`);
    const [, arch, os] = match;
    const macos = os === "apple-darwin";
    const release = join(
        targetRoot,
        ...(explicitTarget ? [target] : []),
        "release",
    );
    const filename = `Itemerness-Editor_${version}_${macos ? "macos" : "windows"}_${arch}.${macos ? "app.zip" : "exe"}`;
    return {
        macos,
        release,
        source: macos
            ? join(release, "bundle", "macos", "Itemerness Editor.app")
            : join(release, "itemerness-editor.exe"),
        artifact: join(release, "portable", filename),
        buildArgs: [
            "build",
            ...(macos ? ["--bundles", "app"] : ["--no-bundle"]),
            ...(explicitTarget ? ["--target", target] : []),
        ],
    };
}

function run(command, args, options = {}) {
    const result = spawnSync(command, args, {
        cwd: webRoot,
        stdio: "inherit",
        ...options,
    });
    if (result.error) throw result.error;
    if (result.status !== 0)
        throw new Error(`${command} exited with status ${result.status}`);
    return result;
}

function main() {
    const args = process.argv.slice(2);
    let target;
    let runner;
    let ci = false;
    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (arg === "--ci") ci = true;
        else if (arg === "--target" || arg === "--runner") {
            const value = args[++index];
            if (!value || value.startsWith("-"))
                throw new Error(`Missing value for ${arg}`);
            if (arg === "--target") target = value;
            else runner = value;
        } else throw new Error(`Unknown argument: ${arg}`);
    }
    const explicitTarget = target !== undefined;
    if (!target) {
        const rust = run("rustc", ["-vV"], { stdio: "pipe", encoding: "utf8" });
        target = /^host: (.+)$/m.exec(rust.stdout)?.[1];
    }
    const config = JSON.parse(
        readFileSync(join(webRoot, "src-tauri", "tauri.conf.json"), "utf8"),
    );
    const targetRoot = join(webRoot, "src-tauri", "target");
    const plan = portablePlan({
        target,
        version: config.version,
        explicitTarget,
        targetRoot,
    });
    if (plan.macos && process.platform !== "darwin")
        throw new Error("macOS app bundles must be built on macOS");
    if (!plan.macos && process.platform !== "win32" && !runner)
        throw new Error(
            "Cross-building Windows requires --runner and an MSVC cross toolchain",
        );
    const pnpm = process.env.npm_execpath;
    if (!pnpm || !existsSync(pnpm))
        throw new Error("Run this command through pnpm desktop:build");
    // Force all outputs to the project, independently of a machine-wide Cargo target-dir setting.
    run(
        process.execPath,
        [
            pnpm,
            "exec",
            "tauri",
            ...plan.buildArgs,
            ...(runner ? ["--runner", runner] : []),
            ...(ci ? ["--ci"] : []),
            "--",
            "--locked",
        ],
        {
            env: { ...process.env, CARGO_TARGET_DIR: targetRoot },
        },
    );
    if (!existsSync(plan.source))
        throw new Error(`Build output missing: ${plan.source}`);
    if (plan.macos)
        run("codesign", ["--verify", "--deep", "--strict", plan.source]);
    mkdirSync(dirname(plan.artifact), { recursive: true });
    const temporary = plan.artifact + ".partial";
    try {
        if (plan.macos) {
            // ditto preserves executable modes, symlinks, and bundle metadata when Finder unzips it.
            run("ditto", [
                "-c",
                "-k",
                "--sequesterRsrc",
                "--keepParent",
                plan.source,
                temporary,
            ]);
        } else {
            copyFileSync(plan.source, temporary);
        }
        renameSync(temporary, plan.artifact);
    } finally {
        rmSync(temporary, { force: true });
    }
    process.stdout.write(`Portable artifact: ${plan.artifact}\n`);
}

if (
    process.argv[1] &&
    pathToFileURL(resolve(process.argv[1])).href === import.meta.url
)
    main();
