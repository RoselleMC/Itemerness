import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    configurationValue,
    decodeLocalConfiguration,
    editLocalConfiguration,
    isJavaHttpOrigin,
    numberInput,
    parseLocalConfiguration,
} from "../src/features/settings/localConfiguration.js";
import { useLocalOperationsStore } from "../src/state/localOperations.js";
import { saveLocalExport } from "../src/features/settings/saveLocalExport.js";
import loaderCases from "../../../packages/protocol/fixtures/local-operations-cases.json";

vi.mock("../src/features/settings/saveLocalExport.js", () => ({
    MAX_LOCAL_YAML_BYTES: 2 * 1024 * 1024,
    saveLocalExport: vi.fn(),
}));
const configText = readFileSync(
    new URL(
        "../../../../itemerness-bukkit/src/main/resources/config.yml",
        import.meta.url,
    ),
    "utf8",
);
const accessText = readFileSync(
    new URL(
        "../../../../itemerness-bukkit/src/main/resources/access.yml",
        import.meta.url,
    ),
    "utf8",
);
const config = () => parseLocalConfiguration("config.yml", configText);
const access = () => parseLocalConfiguration("access.yml", accessText);
const codes = (result: ReturnType<typeof config>) =>
    result.diagnostics
        .filter((issue) => !issue.warning)
        .map((issue) => issue.code);
const encode = (text: string) => new TextEncoder().encode(text);
beforeEach(() => {
    vi.clearAllMocks();
    useLocalOperationsStore.getState().discard();
    useLocalOperationsStore.setState({ busy: false });
});

describe("local configuration loader contracts", () => {
    it.each(loaderCases)("matches the real JVM loader: $name", (fixture) => {
        const original = fixture.kind === "config" ? configText : accessText;
        if (fixture.from !== undefined)
            expect(original).toContain(fixture.from);
        const source =
            (fixture.prefix ?? "") +
            (fixture.from === undefined
                ? original
                : original.replaceAll(fixture.from, fixture.to ?? "")) +
            (fixture.suffix ?? "");
        expect(
            codes(parseLocalConfiguration(`${fixture.kind}.yml`, source))
                .length === 0,
        ).toBe(fixture.valid);
    });
    it("accepts both production resources without rewriting any bytes", () => {
        expect(codes(config())).toEqual([]);
        expect(codes(access())).toEqual([]);
        expect(config().text).toBe(configText);
        expect(access().text).toBe(accessText);
        const bom = "\uFEFF" + configText.replaceAll("\n", "\r\n");
        expect(decodeLocalConfiguration("config.yml", encode(bom)).text).toBe(
            bom,
        );
    });
    it("keeps comments, key order, quoting and unknown values when editing a known scalar", () => {
        const source =
            configText +
            "\n# Keep future settings\nfuture: {value: 'secret-value'} # tail\n";
        const edited = editLocalConfiguration(
            parseLocalConfiguration("config.yml", source),
            ["editor", "port"],
            19000n,
        );
        expect(codes(edited)).toContain("unknownKey");
        expect(edited.text).toContain("# Keep future settings");
        expect(edited.text).toContain(
            "future: { value: 'secret-value' } # tail",
        );
        expect(edited.text.indexOf("catalog:")).toBeLessThan(
            edited.text.indexOf("editor:"),
        );
        expect(configurationValue(edited, ["editor", "port"])).toBe(19000n);
        expect(JSON.stringify(edited.diagnostics)).not.toContain(
            "secret-value",
        );
    });
    it.each([
        [["config-version"], 2n, "version"],
        [["catalog", "default-namespace"], "Upper", "namespace"],
        [["editor", "port"], 1023n, "port"],
        [["editor", "port"], 65536n, "port"],
        [["editor", "port"], "18087", "port"],
        [["editor", "port"], 18087.5, "port"],
        [["editor", "enabled"], "true", "boolean"],
        [["editor", "bind-host"], "hello world", "host"],
        [["locale", "default"], "en_us_extra", "locale"],
        [["presentation", "default-theme"], "noNamespace", "itemKey"],
        [["canonical-item", "pending-name", "text"], "none", "template"],
        [
            ["canonical-item", "pending-name", "text"],
            "{item-id} {item-id}",
            "template",
        ],
        [["canonical-item", "pending-name", "color"], "pink", "color"],
        [
            ["editor", "allowed-origins"],
            Array(17).fill("https://example.com"),
            "originsLimit",
        ],
    ] as const)("rejects invalid config field %j", (path, value, code) => {
        expect(
            codes(editLocalConfiguration(config(), [...path], value)),
        ).toContain(code);
    });
    it("accepts exact boundary ports and a disabled listener with an invalid literal token", () => {
        for (const port of [1024n, 65535n])
            expect(
                codes(
                    editLocalConfiguration(config(), ["editor", "port"], port),
                ),
            ).toEqual([]);
        expect(
            codes(
                editLocalConfiguration(
                    config(),
                    ["editor", "token"],
                    "short secret",
                ),
            ),
        ).toEqual([]);
    });
    it("validates enabled tokens without resolving server environment variables", () => {
        const enabled = editLocalConfiguration(
            config(),
            ["editor", "enabled"],
            true,
        );
        expect(enabled.diagnostics).toContainEqual({
            path: "editor.token",
            code: "unauthenticated",
            warning: true,
        });
        expect(
            codes(
                editLocalConfiguration(
                    enabled,
                    ["editor", "token"],
                    "short secret",
                ),
            ),
        ).toContain("token");
        expect(
            codes(
                editLocalConfiguration(
                    enabled,
                    ["editor", "token"],
                    "a".repeat(32),
                ),
            ),
        ).toEqual([]);
        expect(
            editLocalConfiguration(
                enabled,
                ["editor", "token"],
                "${SERVER_TOKEN}",
            ).diagnostics,
        ).toContainEqual({
            path: "editor.token",
            code: "environment",
            warning: true,
        });
    });
    it("uses Kotlin whitespace semantics without stripping a token BOM", () => {
        const enabled = editLocalConfiguration(
            config(),
            ["editor", "enabled"],
            true,
        );
        for (const whitespace of [
            "\u001c",
            "\u001f",
            "\u00a0",
            "\u2007",
            "\u202f",
        ]) {
            expect(
                codes(
                    editLocalConfiguration(
                        enabled,
                        ["editor", "token"],
                        whitespace + "a".repeat(32) + whitespace,
                    ),
                ),
            ).toEqual([]);
        }
        for (const significant of ["\ufeff", "\u0085"]) {
            expect(
                codes(
                    editLocalConfiguration(
                        enabled,
                        ["editor", "token"],
                        significant + "a".repeat(32),
                    ),
                ),
            ).toContain("token");
        }
    });
    it.each([
        ["https://example.com", true],
        ["http://localhost:18107", true],
        ["http://127.0.0.1:99999", true],
        ["http://[::1]:18107", true],
        ["http://example.com:", true],
        ["http://example.com.", true],
        ["HTTPS://example.com", false],
        ["https://example.com/", false],
        ["https://user@example.com", false],
        ["https://example.com?q=x", false],
        ["https://example.com#x", false],
        ["https://a_b.com", false],
        ["https://例子.com", false],
        ["https://999.1.1.1", false],
        ["http://example.com:2147483648", false],
    ])("matches exact Java origin restrictions: %s", (origin, valid) =>
        expect(isJavaHttpOrigin(origin)).toBe(valid),
    );
    it("retains legacy empty editor settings until an explicit replacement", () => {
        const old = editLocalConfiguration(config(), ["editor"], {
            url: "",
            token: "",
        });
        expect(codes(old)).toEqual([]);
        expect(old.diagnostics.some((issue) => issue.code === "legacy")).toBe(
            true,
        );
        expect(
            codes(
                editLocalConfiguration(
                    old,
                    ["editor", "url"],
                    "wss://retired.example",
                ),
            ),
        ).toContain("retired");
    });
    it("enforces conditional namespace grants and all default actions", () => {
        const grant = {
            plugin: "Example_Plugin",
            actions: ["read-data"],
            "item-namespaces": ["example"],
            "data-namespaces": ["data"],
        };
        const valid = editLocalConfiguration(
            access(),
            ["api", "grants"],
            [grant],
        );
        expect(codes(valid)).toEqual([]);
        for (const key of ["item-namespaces", "data-namespaces"])
            expect(
                codes(
                    editLocalConfiguration(
                        valid,
                        ["api", "grants", 0, key],
                        [],
                    ),
                ),
            ).toContain("required");
        expect(
            codes(
                editLocalConfiguration(
                    valid,
                    ["api", "grants", 0, "actions"],
                    ["read-data", "read-data"],
                ),
            ),
        ).toContain("duplicate");
        expect(
            codes(
                editLocalConfiguration(
                    valid,
                    ["api", "grants", 0, "actions"],
                    ["write-viewer-fact"],
                ),
            ),
        ).toContain("required");
        expect(
            codes(
                editLocalConfiguration(
                    valid,
                    ["api", "defaults", "create"],
                    "schema-policy",
                ),
            ),
        ).toContain("decision");
        expect(
            codes(
                editLocalConfiguration(
                    valid,
                    ["api", "defaults", "read-data"],
                    "schema-policy",
                ),
            ),
        ).toEqual([]);
        expect(
            codes(
                editLocalConfiguration(
                    access(),
                    ["api", "grants"],
                    [
                        {
                            plugin: "Facts",
                            actions: ["write-viewer-fact"],
                            "viewer-fact-namespaces": ["facts"],
                        },
                    ],
                ),
            ),
        ).toEqual([]);
    });
    it.each([
        "config-version: 3\nconfig-version: 3\n",
        "config-version: 3\n---\nconfig-version: 3\n",
        "[a, b]",
        "x: &collection [1]\ny: *collection\n",
        "x: !secret credential\n",
        "x: 2026-09-08\n",
        "1: value\n",
    ])(
        "fails closed for unsafe YAML without displaying source values: %s",
        (source) => {
            const parsed = parseLocalConfiguration("config.yml", source);
            expect(parsed.editable).toBe(false);
            expect(parsed.diagnostics.length).toBeGreaterThan(0);
            expect(JSON.stringify(parsed.diagnostics)).not.toContain(
                "credential",
            );
        },
    );
    it("supports scalar aliases and detaches only consumers of an edited anchor", () => {
        const source = configText
            .replace(
                "default-layout: itemerness:plain",
                "default-layout: &shared itemerness:plain",
            )
            .replace(
                "default-theme: itemerness:default",
                "default-theme: *shared",
            );
        const parsed = parseLocalConfiguration("config.yml", source);
        expect(codes(parsed)).toEqual([]);
        const edited = editLocalConfiguration(
            parsed,
            ["presentation", "default-layout"],
            "other:layout",
        );
        expect(codes(edited)).toEqual([]);
        expect(
            configurationValue(edited, ["presentation", "default-theme"]),
        ).toBe("itemerness:plain");
        expect(
            configurationValue(edited, ["presentation", "default-layout"]),
        ).toBe("other:layout");
    });
    it("preserves adjacent sequence comments during append and removal", () => {
        const source = configText.replace(
            "allowed-origins: []",
            "allowed-origins:\n    - 'https://one.example' # first\n    - 'https://two.example' # second",
        );
        const parsed = parseLocalConfiguration("config.yml", source);
        const append = editLocalConfiguration(
            parsed,
            ["editor", "allowed-origins", 2],
            "https://three.example",
        );
        expect(append.text).toContain("# first");
        expect(append.text).toContain("# second");
        const removed = editLocalConfiguration(
            append,
            ["editor", "allowed-origins", 0],
            undefined,
            true,
        );
        expect(removed.text).toContain("# second");
        expect(
            configurationValue(removed, ["editor", "allowed-origins"]),
        ).toEqual(["https://two.example", "https://three.example"]);
    });
    it("checks encoding, code point limits and incomplete numeric input without rounding", () => {
        expect(() =>
            decodeLocalConfiguration("config.yml", new Uint8Array([0xff])),
        ).toThrow("FILE_ENCODING_INVALID");
        expect(() =>
            parseLocalConfiguration("config.yml", "x".repeat(1_000_001)),
        ).toThrow("FILE_SIZE_INVALID");
        expect(numberInput("9223372036854775807")).toBe(9223372036854775807n);
        expect(numberInput("-")).toBe("-");
    });
});

describe("RAM-only local configuration history and export", () => {
    const open = () => {
        useLocalOperationsStore
            .getState()
            .open("config.yml", encode(configText));
        return useLocalOperationsStore.getState();
    };
    it("accounts for invalid partial input immediately and never calls the network", () => {
        const fetch = vi.fn();
        vi.stubGlobal("fetch", fetch);
        open().edit(["editor", "port"], "-");
        const state = useLocalOperationsStore.getState();
        expect(state.dirty).toBe(true);
        expect(codes(state.session!.configuration)).toContain("port");
        expect(fetch).not.toHaveBeenCalled();
        vi.unstubAllGlobals();
    });
    it("undo returns exact original bytes, redo is local, and discard clears credentials/history", () => {
        open().edit(["editor", "token"], "session-only-secret");
        useLocalOperationsStore.getState().undo();
        expect(
            useLocalOperationsStore.getState().session!.configuration.text,
        ).toBe(configText);
        expect(useLocalOperationsStore.getState().dirty).toBe(false);
        useLocalOperationsStore.getState().redo();
        expect(useLocalOperationsStore.getState().dirty).toBe(true);
        useLocalOperationsStore.getState().discard();
        expect(useLocalOperationsStore.getState().session).toBe(null);
    });
    it("bounds independent history and clears redo on a new edit", () => {
        open();
        for (let index = 0; index < 130; index++)
            useLocalOperationsStore
                .getState()
                .edit(["editor", "port"], BigInt(18088 + index), {
                    discrete: true,
                });
        expect(useLocalOperationsStore.getState().session!.past.length).toBe(
            100,
        );
        useLocalOperationsStore.getState().undo();
        useLocalOperationsStore.getState().edit(["editor", "port"], 19000n);
        expect(useLocalOperationsStore.getState().session!.future).toEqual([]);
    });
    it("export cancellation and failure preserve dirty and never leak exception text", async () => {
        open().edit(["editor", "port"], 19000n);
        vi.mocked(saveLocalExport)
            .mockResolvedValueOnce(false)
            .mockRejectedValueOnce(new Error("SECRET TOKEN"));
        expect(await useLocalOperationsStore.getState().exportCurrent()).toBe(
            false,
        );
        expect(useLocalOperationsStore.getState().dirty).toBe(true);
        expect(await useLocalOperationsStore.getState().exportCurrent()).toBe(
            false,
        );
        expect(useLocalOperationsStore.getState().error).toBe(
            "EXPORT_SAVE_FAILED",
        );
    });
    it("exports unchanged original bytes and marks only the exported snapshot clean", async () => {
        let done!: (saved: boolean) => void;
        vi.mocked(saveLocalExport).mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    done = resolve;
                }),
        );
        open();
        const pending = useLocalOperationsStore.getState().exportCurrent();
        expect(saveLocalExport).toHaveBeenCalledWith(
            "config",
            encode(configText),
        );
        useLocalOperationsStore.getState().edit(["editor", "port"], 19000n);
        done(true);
        expect(await pending).toBe(true);
        expect(useLocalOperationsStore.getState().dirty).toBe(true);
        expect(useLocalOperationsStore.getState().busy).toBe(false);
    });
    it("does not export invalid preserved data", async () => {
        open().edit(["editor", "port"], "bad");
        expect(await useLocalOperationsStore.getState().exportCurrent()).toBe(
            false,
        );
        expect(saveLocalExport).not.toHaveBeenCalled();
    });
});
