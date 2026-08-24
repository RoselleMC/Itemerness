import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const resolve = (relative: string) =>
    fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig({
    resolve: {
        alias: {
            "@itemerness/protocol/fixtures/baseline.js": resolve(
                "./packages/protocol/fixtures/baseline.ts",
            ),
            "@itemerness/protocol": resolve("./packages/protocol/src/index.ts"),
            "@itemerness/mc-assets": resolve(
                "./packages/mc-assets/src/index.ts",
            ),
            "@itemerness/mc-render/canvas": resolve(
                "./packages/mc-render/src/canvas.ts",
            ),
            "@itemerness/mc-render": resolve(
                "./packages/mc-render/src/index.ts",
            ),
            "@itemerness/ui": resolve("./packages/ui/src/index.ts"),
        },
    },
    test: {
        include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
        environment: "node",
        reporters: ["default"],
    },
});
