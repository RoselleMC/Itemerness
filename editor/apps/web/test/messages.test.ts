import { describe, expect, it } from "vitest";
import {
    formatNodeSchema,
    presentationBlockSchema,
    type LocaleNode,
} from "@itemerness/protocol";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import {
    collectDocumentMessageKeys,
    resolveMessage,
} from "../src/features/common/messages.js";

const locale = (
    code: string,
    messages: Record<string, string> = {},
    fallback: string | null = null,
): LocaleNode => ({
    uuid: crypto.randomUUID(),
    locale: code,
    messages,
    fallback,
});

describe("document message inventory", () => {
    it("includes undeclared references in every block branch and format, without inventing data keys", () => {
        const document = structuredClone(baselineDocument);
        document.locales = [locale("en_us", { orphan: "Kept", name: "Name" })];
        document.items = [
            {
                ...document.items[0]!,
                enabled: false,
                presentation: {
                    ...document.items[0]!.presentation,
                    nameMessage: "name",
                    blocks: [
                        presentationBlockSchema.parse({
                            uuid: crypto.randomUUID(),
                            type: "conditional",
                            condition: {
                                operator: "EXISTS",
                                left: { kind: "data", key: "example:flag" },
                            },
                            thenBlocks: [
                                {
                                    uuid: crypto.randomUUID(),
                                    type: "field",
                                    labelMessage: "field.label",
                                    data: "example:value",
                                },
                                {
                                    uuid: crypto.randomUUID(),
                                    type: "text",
                                    data: "example:raw-text",
                                },
                            ],
                            otherwiseBlocks: [
                                {
                                    uuid: crypto.randomUUID(),
                                    type: "conditional",
                                    condition: {
                                        operator: "EXISTS",
                                        left: {
                                            kind: "data",
                                            key: "example:flag",
                                        },
                                    },
                                    thenBlocks: [
                                        {
                                            uuid: crypto.randomUUID(),
                                            type: "description",
                                            message: "description",
                                        },
                                    ],
                                    otherwiseBlocks: [
                                        {
                                            uuid: crypto.randomUUID(),
                                            type: "repeat",
                                            data: "example:compound",
                                            maximumElements: 5,
                                            template: {
                                                labelMessage: "repeat.label",
                                                missingMessage:
                                                    "repeat.missing",
                                                valuePath: "value",
                                            },
                                        },
                                    ],
                                },
                            ],
                        }),
                    ],
                },
            },
        ];
        document.formats = [
            { kind: "integer", pattern: "0" },
            { kind: "decimal", pattern: "0.0", suffixMessage: "format.suffix" },
            { kind: "decimal", pattern: "0.0", suffixMessage: null },
            {
                kind: "boolean",
                trueMessage: "format.true",
                falseMessage: "format.false",
            },
            {
                kind: "list",
                elementFormat: "example:integer",
                separatorMessage: "format.separator",
            },
            {
                kind: "namespacedKey",
                mode: "MESSAGE",
                messagePattern: "value.{namespace}.{path}",
            },
        ].map((format, index) =>
            formatNodeSchema.parse({
                uuid: crypto.randomUUID(),
                id: `example:format-${index}`,
                ...format,
            }),
        );
        const before = structuredClone(document);
        expect(collectDocumentMessageKeys(document)).toEqual([
            "description",
            "field.label",
            "format.false",
            "format.separator",
            "format.suffix",
            "format.true",
            "name",
            "orphan",
            "repeat.label",
            "repeat.missing",
        ]);
        expect(document).toEqual(before);
    });

    it("still exposes referenced keys when no locale declares any messages", () => {
        const document = structuredClone(baselineDocument);
        document.locales.forEach((entry) => {
            entry.messages = {};
        });
        const keys = collectDocumentMessageKeys(document);
        expect(keys).toContain(document.items[0]!.presentation.nameMessage);
        expect(new Set(keys).size).toBe(keys.length);
    });
});

describe("editing message resolution", () => {
    it("distinguishes owned empty text, explicit fallback, default fallback and missing messages", () => {
        const document = structuredClone(baselineDocument);
        document.defaultLocale = "en_us";
        document.locales = [
            locale("en_us", { name: "Default", empty: "" }),
            locale("fr_fr", { name: "French" }, "en_us"),
            locale("fr_ca", { empty: "" }, "fr_fr"),
            locale("de_de"),
        ];
        expect(resolveMessage(document, "fr_ca", "empty")).toEqual({
            text: "",
            source: "own",
            sourceLocale: "fr_ca",
        });
        expect(resolveMessage(document, "fr_ca", "name")).toEqual({
            text: "French",
            source: "fallback",
            sourceLocale: "fr_fr",
        });
        expect(resolveMessage(document, "de_de", "name")).toEqual({
            text: "Default",
            source: "default",
            sourceLocale: "en_us",
        });
        expect(resolveMessage(document, "de_de", "empty")).toEqual({
            text: "",
            source: "default",
            sourceLocale: "en_us",
        });
        expect(resolveMessage(document, "fr_ca", "unknown")).toEqual({
            text: "unknown",
            source: "missing",
            sourceLocale: null,
        });
    });

    it("follows the default chain only when the requested locale is unavailable, matching the production resolver", () => {
        const document = structuredClone(baselineDocument);
        document.defaultLocale = "en_us";
        document.locales = [
            locale("en_us", {}, "fr_fr"),
            locale("fr_fr", { name: "French" }),
            locale("de_de"),
        ];
        expect(resolveMessage(document, "en_us", "name")).toEqual({
            text: "French",
            source: "fallback",
            sourceLocale: "fr_fr",
        });
        expect(resolveMessage(document, "unknown", "name")).toEqual({
            text: "French",
            source: "default",
            sourceLocale: "fr_fr",
        });
        expect(resolveMessage(document, "de_de", "name").source).toBe(
            "missing",
        );
    });

    it("terminates broken and cyclic fallback chains and does not resolve object prototype members", () => {
        const document = structuredClone(baselineDocument);
        document.defaultLocale = "en_us";
        document.locales = [
            locale("en_us", { name: "Default" }),
            locale("fr_fr", {}, "fr_ca"),
            locale("fr_ca", {}, "fr_fr"),
            locale("de_de", {}, "unknown"),
        ];
        expect(resolveMessage(document, "fr_fr", "name").source).toBe(
            "default",
        );
        expect(resolveMessage(document, "de_de", "name").source).toBe(
            "default",
        );
        expect(resolveMessage(document, "fr_fr", "toString").source).toBe(
            "missing",
        );
        expect(resolveMessage(document, "fr_fr", "unknown").source).toBe(
            "missing",
        );
    });
});
