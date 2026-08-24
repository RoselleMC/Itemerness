import { defineConfig } from "tsup";

/**
 * The workspace packages are consumed as TypeScript source, so they are bundled in rather than
 * left as runtime imports. That keeps the runtime image to `node dist/main.js` with no loader and
 * no `node_modules` for internal code.
 */
export default defineConfig({
    entry: ["src/main.ts"],
    format: ["esm"],
    target: "node22",
    platform: "node",
    clean: true,
    splitting: false,
    sourcemap: true,
    tsconfig: "tsconfig.json",
    noExternal: [/^@itemerness\//],
});
