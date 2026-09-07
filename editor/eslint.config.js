import tseslint from "typescript-eslint";

export default tseslint.config(
    {
        ignores: [
            "**/dist/**",
            "**/target/**",
            "**/src-tauri/gen/**",
            "**/node_modules/**",
            "**/playwright-report/**",
            "**/test-results/**",
            "vanilla-cache/**",
        ],
    },
    ...tseslint.configs.recommended,
    {
        rules: {
            "@typescript-eslint/no-unused-vars": [
                "error",
                { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
            ],
        },
    },
);
