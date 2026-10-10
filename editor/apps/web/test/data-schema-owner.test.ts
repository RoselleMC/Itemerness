import { describe, expect, it } from "vitest";
import {
    dataSchemaNodeSchema,
    usesDataSchemaOwners,
    type DataSchemaNode,
} from "@itemerness/protocol";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import {
    newDataSchema,
    suggestedSchemaOwner,
} from "../src/state/dataLibrary.js";

function schemaWithWriters(...writers: string[][]): DataSchemaNode {
    const schema = structuredClone(baselineDocument.dataSchemas[0]!);
    schema.keys = schema.keys.slice(0, writers.length).map((key, index) => ({
        ...key,
        integration: {
            readSources: [{ kind: "canonicalNbt" }],
            access: { read: "PUBLIC", write: writers[index]! },
            placeholderApi: { exposed: false, formatter: null },
        },
    }));
    return schema;
}

describe("schema ownership", () => {
    it("accepts only plugin principals as owners", () => {
        const schema = structuredClone(baselineDocument.dataSchemas[0]!);
        expect(
            dataSchemaNodeSchema.safeParse({
                ...schema,
                owner: "plugin:ExampleConsumer",
            }).success,
        ).toBe(true);
        expect(
            dataSchemaNodeSchema.safeParse({ ...schema, owner: "internal" })
                .success,
        ).toBe(false);
    });

    it("suggests but never infers an owner from write access", () => {
        expect(
            suggestedSchemaOwner(
                schemaWithWriters(["plugin:Consumer"], ["plugin:Consumer"]),
            ),
        ).toBe("plugin:Consumer");
        expect(
            suggestedSchemaOwner(
                schemaWithWriters(["plugin:Consumer"], ["internal"]),
            ),
        ).toBeNull();
        expect(
            suggestedSchemaOwner(
                schemaWithWriters(["plugin:Consumer", "plugin:Other"]),
            ),
        ).toBeNull();
        expect(
            suggestedSchemaOwner(baselineDocument.dataSchemas[0]!),
        ).toBeNull();
    });

    it("keeps owners out of copies and detects owned documents", () => {
        const document = structuredClone(baselineDocument);
        expect(usesDataSchemaOwners(document)).toBe(false);
        document.dataSchemas[0]!.owner = "plugin:Consumer";
        expect(usesDataSchemaOwners(document)).toBe(true);
        const copy = newDataSchema(document, document.dataSchemas[0]);
        expect(Object.hasOwn(copy, "owner")).toBe(false);
    });
});
