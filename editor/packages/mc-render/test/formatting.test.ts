import { describe, expect, it } from "vitest";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import {
    formatNodeSchema,
    type DataValue,
    type FormatNode,
} from "@itemerness/protocol";
import { LocalValueFormatter } from "../src/formatting.js";
import { LocalFormatError } from "../src/decimalFormat.js";
import { composeLocalPreview } from "../src/compose.js";
import { PresentationFonts } from "../src/fonts.js";
import valueCases from "../../protocol/fixtures/value-format-cases.json";
import { readFileSync } from "node:fs";
import type { DataTypeNode } from "@itemerness/protocol";

const node = (value: object): FormatNode =>
    formatNodeSchema.parse({
        uuid: crypto.randomUUID(),
        id: "test:format",
        ...value,
    });
const string = (value: string): DataValue => ({ kind: "string", value });
function formatter(
    formats: readonly FormatNode[] = [],
    messages: Record<string, string> = {},
    locale = "en_us",
) {
    return new LocalValueFormatter(formats, {
        effectiveLocale: locale,
        resolve: (key) => messages[key] ?? null,
    });
}

describe("local value formatter", () => {
    const golden = JSON.parse(
        readFileSync(
            new URL(
                "../../protocol/fixtures/value-format-golden.json",
                import.meta.url,
            ),
            "utf8",
        ),
    ) as Record<string, { text?: string; error?: string }>;
    it.each(valueCases.cases)(
        "matches the production formatter variants: $name",
        (fixture) => {
            const engine = formatter(
                valueCases.formats.map(node),
                valueCases.messages,
            );
            const format = () =>
                engine.format(
                    fixture.value as DataValue,
                    fixture.format,
                    (fixture as { type?: DataTypeNode }).type,
                );
            if (golden[fixture.name]!.error)
                expect(format).toThrow(LocalFormatError);
            else expect(format()).toBe(golden[fixture.name]!.text);
        },
    );
    it("keeps Long precision, expands decimal exponents, and sorts compound keys like the API", () => {
        const value: DataValue = {
            kind: "compound",
            entries: {
                z: { kind: "decimal", value: "1.2300e-7" },
                a: { kind: "integer", value: "9223372036854775807" },
                values: {
                    kind: "list",
                    values: [
                        string("minecraft:stone"),
                        { kind: "boolean", value: true },
                    ],
                },
            },
        };
        expect(formatter().format(value)).toBe(
            "a=9223372036854775807, values=minecraft:stone, true, z=0.000000123",
        );
        expect(formatter().format({ kind: "decimal", value: "-0.0" })).toBe(
            "0",
        );
    });

    it("uses declared decimal and UUID semantics for default formatting", () => {
        expect(
            formatter().format(
                { kind: "integer", value: "9223372036854775807" },
                null,
                { kind: "decimal" },
            ),
        ).toBe("9223372036854776000");
        expect(
            formatter().format(
                string("A0000000-0000-4000-8000-000000000001"),
                null,
                { kind: "uuid" },
            ),
        ).toBe("a0000000-0000-4000-8000-000000000001");
    });

    it("applies integer patterns without converting Long values to double", () => {
        const engine = formatter([node({ kind: "integer", pattern: "#,##0" })]);
        expect(
            engine.format(
                { kind: "integer", value: "9223372036854775807" },
                "test:format",
            ),
        ).toBe("9,223,372,036,854,775,807");
        expect(() =>
            engine.format({ kind: "decimal", value: "1.5" }, "test:format"),
        ).toThrow("requires integer");
        expect(() =>
            engine.format({ kind: "integer", value: "1" }, "test:format", {
                kind: "decimal",
            }),
        ).toThrow("requires integer");
    });

    it("uses the content locale, scaling and required suffix messages", () => {
        const format = node({
            kind: "decimal",
            pattern: "#,##0.00",
            multiply: 100,
            suffixMessage: "unit",
        });
        expect(
            formatter([format], { unit: " points" }, "de_de").format(
                { kind: "decimal", value: "12.345" },
                format.id,
            ),
        ).toBe("1.234,50 points");
        expect(() =>
            formatter([format]).format(
                { kind: "decimal", value: "12.345" },
                format.id,
            ),
        ).toThrow("Missing message unit");
    });

    it("does not treat non-booleans as the false branch", () => {
        const format = node({
            kind: "boolean",
            trueMessage: "yes",
            falseMessage: "no",
        });
        const engine = formatter([format], { yes: "Enabled", no: "Disabled" });
        expect(
            engine.format({ kind: "boolean", value: false }, format.id),
        ).toBe("Disabled");
        expect(() => engine.format(string("false"), format.id)).toThrow(
            "requires boolean",
        );
        expect(() =>
            formatter([format]).format(
                { kind: "boolean", value: true },
                format.id,
            ),
        ).toThrow("Missing message yes");
    });

    it.each(["PATH", "FULL_KEY", "ERROR"] as const)(
        "honors missing namespaced messages: %s",
        (missingValue) => {
            const format = node({
                kind: "namespacedKey",
                mode: "MESSAGE",
                messagePattern: "value.{namespace}.{path}",
                missingValue,
            });
            const engine = formatter([format]);
            if (missingValue === "ERROR")
                expect(() =>
                    engine.format(string("example:missing"), format.id),
                ).toThrow("Missing value message");
            else
                expect(
                    engine.format(string("example:missing"), format.id),
                ).toBe(missingValue === "PATH" ? "missing" : "example:missing");
        },
    );

    it("preserves translations equal to their key and replaces all placeholders", () => {
        const format = node({
            kind: "namespacedKey",
            mode: "MESSAGE",
            messagePattern: "{namespace}.{namespace}.{path}.{path}",
            missingValue: "ERROR",
        });
        const key = "example.example.stone.stone";
        expect(
            formatter([format], { [key]: key }).format(
                string("example:stone"),
                format.id,
            ),
        ).toBe(key);
    });

    it("PATH needs a typed key and never invents a minecraft namespace", () => {
        const format = node({
            kind: "namespacedKey",
            mode: "PATH",
            messagePattern: null,
            missingValue: "ERROR",
        });
        const engine = formatter([format]);
        expect(
            engine.format(string("example:stone"), format.id, {
                kind: "namespacedKey",
            }),
        ).toBe("stone");
        expect(() => engine.format(string("stone"), format.id)).toThrow(
            "requires namespaced-key",
        );
        expect(() =>
            engine.format(string("example:stone"), format.id, {
                kind: "string",
            }),
        ).toThrow("requires namespaced-key");
    });

    it("lists delegate to their formatter and do not keep an active sibling in the recursion set", () => {
        const integer = node({
            id: "test:integer",
            kind: "integer",
            pattern: "00",
        });
        const list = node({
            kind: "list",
            elementFormat: integer.id,
            separatorMessage: "separator",
        });
        expect(
            formatter([integer, list], { separator: " / " }).format(
                {
                    kind: "list",
                    values: [
                        { kind: "integer", value: "1" },
                        { kind: "integer", value: "2" },
                    ],
                },
                list.id,
            ),
        ).toBe("01 / 02");
        expect(() =>
            formatter([integer, list]).format(
                { kind: "list", values: [] },
                list.id,
            ),
        ).toThrow("Missing message separator");
    });

    it("rejects list cycles and missing references even when a list is empty", () => {
        const list = node({
            kind: "list",
            elementFormat: "test:format",
            separatorMessage: "separator",
        });
        expect(() => formatter([list])).toThrow("recursion");
        const left = node({
            id: "test:left",
            kind: "list",
            elementFormat: "test:right",
            separatorMessage: "separator",
        });
        const right = node({
            id: "test:right",
            kind: "list",
            elementFormat: "test:left",
            separatorMessage: "separator",
        });
        expect(() => formatter([left, right])).toThrow("recursion");
        expect(() => formatter([left])).toThrow("Unknown formatter test:right");
        expect(() =>
            formatter().format(string("value"), "test:missing"),
        ).toThrow("Unknown formatter");
    });

    it("does not omit nulls within default compound or list values", () => {
        expect(() =>
            formatter().format({ kind: "list", values: [{ kind: "null" }] }),
        ).toThrow(LocalFormatError);
        expect(() =>
            formatter().format({
                kind: "compound",
                entries: { bad: { kind: "null" } },
            }),
        ).toThrow(LocalFormatError);
    });

    it("returns a diagnostic and no partial local display for an invalid pattern", () => {
        const document = structuredClone(baselineDocument);
        const format = document.formats.find(
            (entry) => entry.kind === "integer",
        )!;
        if (format.kind !== "integer")
            throw new Error("Expected integer format");
        format.pattern = "0..0";
        const preview = composeLocalPreview({
            document,
            itemId: "itemerness:travel-token",
            viewer: {
                locale: "en_us",
                requestedTheme: null,
                assetProfile: null,
                capabilities: [],
                metricsRevision: null,
                resourcePackLoaded: false,
                managesVanillaTooltipLines: false,
                direction: "LEFT_TO_RIGHT",
            },
            fonts: new PresentationFonts({
                fonts: document.fonts,
                glyphs: document.glyphs,
                spacing: document.spacing,
            }),
        });
        expect(preview.display.lore).toEqual([]);
        expect(preview.diagnostics[0]!.code).toBe("FORMAT.INVALID_VALUE");
    });

    it("resolves data types only from the item's bound schema versions", () => {
        const document = structuredClone(baselineDocument);
        const futureSchema = structuredClone(document.dataSchemas[0]!);
        futureSchema.version += 1;
        futureSchema.keys.find((key) => key.id === "example:region")!.type = {
            kind: "string",
        };
        document.dataSchemas.push(futureSchema);
        const render = (value: typeof document) =>
            composeLocalPreview({
                document: value,
                itemId: "itemerness:travel-token",
                viewer: {
                    locale: "en_us",
                    requestedTheme: null,
                    assetProfile: null,
                    capabilities: [],
                    metricsRevision: null,
                    resourcePackLoaded: false,
                    managesVanillaTooltipLines: false,
                    direction: "LEFT_TO_RIGHT",
                },
                fonts: new PresentationFonts({
                    fonts: value.fonts,
                    glyphs: value.glyphs,
                    spacing: value.spacing,
                }),
            });
        const expected = render(baselineDocument);
        const actual = render(document);
        expect(actual.display).toEqual(expected.display);
        expect(actual.diagnostics).toEqual(expected.diagnostics);
        expect(actual.display.lore.length).toBeGreaterThan(0);
    });
});
