import { describe, expect, it } from "vitest";
import {
    dataKeyNodeSchema,
    dataValueSchema,
    type DataTypeNode,
} from "@itemerness/protocol";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import {
    initialDataValue,
    itemDataKey,
    parseScalarValue,
    resolveSampleValue,
    valueKindForType,
} from "../src/features/common/typedValues.js";
import { referenceValue } from "../src/features/common/ConditionEditor.js";

describe("typed authoring values", () => {
    it("preserves string colons and decimal/integer kinds without implicit conversions", () => {
        expect(parseScalarValue("string", "12:34:56").value).toEqual({
            kind: "string",
            value: "12:34:56",
        });
        expect(parseScalarValue("decimal", "-1.250").value).toEqual({
            kind: "decimal",
            value: "-1.250",
        });
        expect(parseScalarValue("integer", "-42").value).toEqual({
            kind: "integer",
            value: "-42",
        });
        expect(parseScalarValue("decimal", "1e-3").value).toEqual({
            kind: "decimal",
            value: "1e-3",
        });
        for (const value of ["", "-", "1.", "01", "NaN"])
            expect(parseScalarValue("decimal", value).error).not.toBeNull();
    });

    it("validates actual declared types and numeric ranges while leaving generic strings unrestricted", () => {
        expect(
            parseScalarValue("integer", "2147483648", { kind: "integer" })
                .error,
        ).toBe("integerRange");
        expect(
            parseScalarValue("integer", "2147483648", { kind: "long" }).error,
        ).toBeNull();
        expect(parseScalarValue("integer", "9223372036854775808").error).toBe(
            "integerRange",
        );
        expect(
            parseScalarValue("integer", "-9223372036854775808").error,
        ).toBeNull();
        expect(parseScalarValue("decimal", "1e999").error).toBe("decimalRange");
        expect(
            parseScalarValue("string", "12:34:56", { kind: "string" }).error,
        ).toBeNull();
        expect(
            parseScalarValue("string", "12:34:56", { kind: "namespacedKey" })
                .error,
        ).toBe("namespacedKey");
        expect(
            parseScalarValue("string", "custom:gem", { kind: "namespacedKey" })
                .value,
        ).toEqual({ kind: "string", value: "custom:gem" });
        expect(
            parseScalarValue("string", "not-a-uuid", { kind: "uuid" }).error,
        ).toBe("uuid");
    });

    it("creates recursive typed values without flattening or sharing children", () => {
        const type: DataTypeNode = {
            kind: "compound",
            fields: [
                { name: "amount", nullable: false, type: { kind: "integer" } },
                { name: "optional", nullable: true, type: { kind: "boolean" } },
                {
                    name: "items",
                    nullable: false,
                    type: { kind: "list", element: { kind: "namespacedKey" } },
                },
            ],
        };
        const value = initialDataValue(valueKindForType(type), type);
        expect(value).toEqual({
            kind: "compound",
            entries: {
                amount: { kind: "integer", value: "0" },
                optional: { kind: "null" },
                items: { kind: "list", values: [] },
            },
        });
        expect(dataValueSchema.safeParse(value).success).toBe(true);
        expect(initialDataValue("compound", type)).not.toBe(value);
    });
});

describe("item-bound preview sources", () => {
    const fixture = () => {
        const document = structuredClone(baselineDocument);
        const item = document.items[0]!;
        const key = dataKeyNodeSchema.parse({
            uuid: crypto.randomUUID(),
            id: "test:clock",
            type: { kind: "string" },
            scope: "DEFINITION",
            defaultValue: { kind: "string", value: "schema:value" },
            presentationReadable: true,
        });
        document.dataSchemas = [
            {
                uuid: crypto.randomUUID(),
                id: "test:bound",
                version: 2,
                keys: [key],
            },
            {
                uuid: crypto.randomUUID(),
                id: "test:unbound",
                version: 1,
                keys: [
                    {
                        ...key,
                        uuid: crypto.randomUUID(),
                        type: { kind: "namespacedKey" },
                    },
                ],
            },
        ];
        item.definition.instance.schemas = [{ id: "test:bound", version: 2 }];
        item.definition.definitionData = [
            { key: key.id, value: { kind: "string", value: "12:34:56" } },
        ];
        item.definition.instance.defaults = [
            { key: key.id, value: { kind: "string", value: "wrong:scope" } },
        ];
        item.previewData = [];
        return { document, item, key };
    };

    it("resolves exact schema versions and source scopes, not unrelated schemas with the same key", () => {
        const { document, item, key } = fixture();
        expect(itemDataKey(document, item, key.id)?.type.kind).toBe("string");
        expect(resolveSampleValue(document, item, key.id)).toMatchObject({
            source: "definition",
            value: { kind: "string", value: "12:34:56" },
        });
        key.scope = "INSTANCE";
        expect(resolveSampleValue(document, item, key.id).source).toBe(
            "instance",
        );
        item.definition.instance.defaults = [];
        expect(resolveSampleValue(document, item, key.id).source).toBe(
            "schema",
        );
        item.definition.instance.schemas[0]!.version = 1;
        expect(resolveSampleValue(document, item, key.id)).toEqual({
            schema: null,
            source: "missing",
            value: null,
        });
    });

    it("keeps preview overrides separate, including explicit null, and refuses ambiguous bindings", () => {
        const { document, item, key } = fixture();
        item.previewData = [{ key: key.id, value: { kind: "null" } }];
        expect(resolveSampleValue(document, item, key.id)).toMatchObject({
            source: "preview",
            value: { kind: "null" },
        });
        item.definition.instance.schemas.push({
            id: "test:unbound",
            version: 1,
        });
        expect(itemDataKey(document, item, key.id)).toBeNull();
        expect(resolveSampleValue(document, item, key.id).schema).toBeNull();
    });

    it("initializes a literal from the selected reference's useful typed value", () => {
        const { document, item, key } = fixture();
        expect(
            referenceValue(document, item, { kind: "data", key: key.id }),
        ).toEqual({ kind: "string", value: "12:34:56" });
        expect(
            referenceValue(document, item, {
                kind: "literal",
                value: { kind: "boolean", value: true },
            }),
        ).toEqual({ kind: "boolean", value: true });
        expect(
            referenceValue(document, item, {
                kind: "data",
                key: "unknown:key",
            }),
        ).toEqual({ kind: "string", value: "" });
    });
});
