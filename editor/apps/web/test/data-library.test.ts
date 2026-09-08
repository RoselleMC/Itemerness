import { describe, expect, it } from "vitest";
import { projectDocumentSchema, upgradeProjectDocument } from "@itemerness/protocol";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import { keyReferenceItems, newDataKey, newDataSchema, removeDataKey, removeDataSchema, renameDataKey, renameDataSchema, schemaItems } from "../src/state/dataLibrary.js";
import { useEditorStore } from "../src/state/store.js";

describe("data library commands", () => {
    it("creates empty schemas and private keys without copying production presets", () => {
        const document = upgradeProjectDocument(baselineDocument, (_schema, key) => ({
            readSources: [{ kind: key.scope === "INSTANCE" ? "canonicalNbt" : "catalogDefinition" }],
            access: { read: "INTERNAL", write: [key.scope === "INSTANCE" ? "internal" : "definition"] },
            placeholderApi: { exposed: false, formatter: null },
        }));
        const schema = newDataSchema(document);
        expect(schema.keys).toEqual([]);
        const key = newDataKey(document);
        expect(key.defaultValue).toBeNull();
        expect(key.integration?.access).toEqual({ read: "INTERNAL", write: ["internal"] });
        schema.keys.push(key);
        document.dataSchemas.push(schema);
        expect(projectDocumentSchema.safeParse(document).success).toBe(true);
    });

    it("duplicates schemas with independent key UUIDs and globally unique key IDs", () => {
        const document = structuredClone(baselineDocument);
        const source = document.dataSchemas[0]!;
        const copy = newDataSchema(document, source);
        expect(copy.uuid).not.toBe(source.uuid);
        expect(copy.keys).toHaveLength(source.keys.length);
        copy.keys.forEach((key, index) => {
            expect(key.uuid).not.toBe(source.keys[index]!.uuid);
            expect(key.id).not.toBe(source.keys[index]!.id);
            expect(key.defaultValue).toEqual(source.keys[index]!.defaultValue);
        });
        expect(schemaItems(document, copy)).toEqual([]);
    });

    it("renames schema identities and all exact version bindings as one undo step", () => {
        const state = () => useEditorStore.getState();
        state().resetDraft();
        state().setDocument(structuredClone(baselineDocument));
        const before = state().document;
        const schema = before.dataSchemas[0]!;
        state().selectDataSchema(schema.uuid);
        state().updateDocument((document) => renameDataSchema(document, schema.uuid, "example:renamed", 2147483647));
        expect(state().document.items.every((item) => item.definition.instance.schemas.some((ref) => ref.id === "example:renamed" && ref.version === 2147483647))).toBe(true);
        expect(projectDocumentSchema.safeParse(state().document).success).toBe(true);
        state().undo();
        expect(state().document).toEqual(before);
        expect(state().selectedDataSchemaUuid).toBe(schema.uuid);
    });

    it("renames key references only in items bound to its schema", () => {
        const document = structuredClone(baselineDocument);
        const schema = document.dataSchemas[0]!;
        const key = schema.keys.find((entry) => entry.id === "example:charges")!;
        const unrelated = structuredClone(document.items.find((item) => item.id === "travel-token")!);
        unrelated.uuid = crypto.randomUUID();
        unrelated.id = "unrelated";
        unrelated.definition.instance.schemas = [];
        document.items.push(unrelated);
        const renamed = renameDataKey(document, key.uuid, "example:uses");
        expect(renamed.items.at(-1)).toEqual(unrelated);
        const bound = renamed.items.find((item) => item.id === "travel-token")!;
        expect(JSON.stringify(bound)).not.toContain('"example:charges"');
        expect(JSON.stringify(bound)).toContain('"example:uses"');
        expect(document.dataSchemas[0]!.keys.find((entry) => entry.uuid === key.uuid)!.id).toBe("example:charges");
    });

    it("refuses duplicate or malformed identities without partial reference changes", () => {
        const document = structuredClone(baselineDocument);
        const schema = document.dataSchemas[0]!;
        expect(renameDataSchema(document, schema.uuid, "BAD", 1)).toBe(document);
        expect(renameDataSchema(document, schema.uuid, schema.id, 0)).toBe(document);
        expect(renameDataKey(document, schema.keys[0]!.uuid, schema.keys[1]!.id)).toBe(document);
    });

    it("prevents deleting referenced keys and schemas, while allowing unused entries", () => {
        const document = structuredClone(baselineDocument);
        const schema = document.dataSchemas[0]!;
        const key = schema.keys.find((entry) => entry.id === "example:charges")!;
        expect(keyReferenceItems(document, schema, key).some((item) => item.id === "travel-token")).toBe(true);
        expect(removeDataKey(document, key.uuid)).toBe(document);
        expect(removeDataSchema(document, schema.uuid)).toBe(document);
        const extra = newDataKey(document);
        schema.keys.push(extra);
        expect(removeDataKey(document, extra.uuid).dataSchemas[0]!.keys).not.toContainEqual(extra);
        const empty = newDataSchema(document);
        document.dataSchemas.push(empty);
        expect(removeDataSchema(document, empty.uuid).dataSchemas).not.toContainEqual(empty);
    });
});
