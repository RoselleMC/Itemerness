import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const resolve = (relative: string) =>
    fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig({
    plugins: [react()],
    resolve: {
        // Workspace packages are consumed as TypeScript source. Aliasing keeps Vite's dependency
        // optimizer out of the way and means a change in the render engine is hot-reloaded here.
        alias: {
            "@itemerness/protocol/fixtures/baseline.js": resolve(
                "../../packages/protocol/fixtures/baseline.ts",
            ),
            "@itemerness/protocol": resolve(
                "../../packages/protocol/src/index.ts",
            ),
            "@itemerness/mc-assets": resolve(
                "../../packages/mc-assets/src/index.ts",
            ),
            "@itemerness/mc-render/canvas": resolve(
                "../../packages/mc-render/src/canvas.ts",
            ),
            "@itemerness/mc-render": resolve(
                "../../packages/mc-render/src/index.ts",
            ),
        },
    },
    server: {
        port: 5173,
        proxy: {
            "/api": { target: "http://127.0.0.1:8080", changeOrigin: true },
        },
    },
    build: { outDir: "dist", sourcemap: true, target: "es2022" },
});
