import { beforeEach, describe, expect, it } from "vitest";
import { presentationBlockSchema } from "@itemerness/protocol";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import { useEditorStore } from "../src/state/store.js";
import {
    applicableConstraints,
    dataKeyReferences,
    dataKeyPreviewItem,
    initialDataType,
    validCompoundFieldName,
    validOptionalConstraint,
} from "../src/features/inspector/dataKeyEditing.js";

beforeEach(() => {
    useEditorStore.getState().resetDraft();
});

describe("data key editing", () => {
    it("previews an item that actually presents the selected key without changing item selection", () => {
        const document = structuredClone(baselineDocument);
        const key = document.dataSchemas[0]!.keys.find(
            (entry) => entry.id === "example:charges",
        )!;
        expect(
            dataKeyPreviewItem(document, key.uuid, "itemerness:ember-blade")
                ?.id,
        ).toBe("travel-token");
        expect(dataKeyPreviewItem(document, "missing", null)).toBeNull();
    });
    it("edits only the selected UUID when different schema versions contain the same key", () => {
        const document = structuredClone(baselineDocument);
        const original = document.dataSchemas[0]!;
        const copy = structuredClone(original);
        copy.uuid = crypto.randomUUID();
        copy.version++;
        copy.keys.forEach((key) => {
            key.uuid = crypto.randomUUID();
        });
        document.dataSchemas.push(copy);
        const uuid = copy.keys[0]!.uuid;
        const store = () => useEditorStore.getState();
        store().setDocument(document);
        store().selectDataKey(uuid);
        store().updateDataKey(uuid, (key) => ({
            ...key,
            nullable: !key.nullable,
        }));
        expect(store().document.dataSchemas[0]).toEqual(original);
        expect(store().document.dataSchemas.at(-1)!.keys[0]!.nullable).toBe(
            !copy.keys[0]!.nullable,
        );
        store().undo();
        expect(store().document).toEqual(document);
        expect(store().selectedDataKeyUuid).toBe(uuid);
        store().redo();
        expect(store().document.dataSchemas.at(-1)!.keys[0]!.nullable).toBe(
            !copy.keys[0]!.nullable,
        );
    });

    it("collects actual labels through both branches, scoped to the bound schema version", () => {
        const document = structuredClone(baselineDocument);
        const schema = document.dataSchemas[0]!;
        const key = schema.keys[0]!;
        const item = document.items[0]!;
        document.items = [item];
        item.definition.instance.schemas = [
            { id: schema.id, version: schema.version },
        ];
        item.presentation.blocks = [
            presentationBlockSchema.parse({
                uuid: crypto.randomUUID(),
                type: "conditional",
                condition: {
                    operator: "EXISTS",
                    left: { kind: "data", key: key.id },
                },
                thenBlocks: [
                    {
                        uuid: crypto.randomUUID(),
                        type: "field",
                        data: key.id,
                        labelMessage: "custom.attack.label",
                    },
                ],
                otherwiseBlocks: [
                    {
                        uuid: crypto.randomUUID(),
                        type: "repeat",
                        data: key.id,
                        maximumElements: 1,
                        template: {
                            labelMessage: "custom.repeat.label",
                            valuePath: "name",
                            missingMessage: "custom.empty",
                        },
                    },
                ],
            }),
        ];
        expect(dataKeyReferences(document, key.uuid)).toEqual({
            items: [item],
            labels: ["custom.attack.label", "custom.repeat.label"],
        });
        item.definition.instance.schemas[0]!.version++;
        expect(dataKeyReferences(document, key.uuid)).toEqual({
            items: [],
            labels: [],
        });
    });

    it("does not invent labels for keys with no content label reference", () => {
        const document = structuredClone(baselineDocument);
        document.items.forEach((item) => {
            item.presentation.blocks = [];
        });
        expect(
            dataKeyReferences(document, document.dataSchemas[0]!.keys[0]!.uuid)
                .labels,
        ).toEqual([]);
    });

    it("selects a key after empty schemas without falling into a blank inspector", () => {
        const document = structuredClone(baselineDocument);
        const first = structuredClone(document.dataSchemas[0]!);
        first.uuid = crypto.randomUUID();
        first.id = "example:empty";
        first.keys = [];
        document.dataSchemas.unshift(first);
        useEditorStore.getState().setDocument(document);
        expect(useEditorStore.getState().selectedDataKeyUuid).toBe(
            document.dataSchemas[1]!.keys[0]!.uuid,
        );
    });

    it("keeps constraint applicability and limits aligned with the compiler", () => {
        expect([...applicableConstraints("decimal")]).toEqual([
            "allowedValues",
            "minimum",
            "maximum",
            "scale",
        ]);
        expect([...applicableConstraints("compound")]).toEqual([
            "allowedValues",
            "maximumEntries",
            "maximumDepth",
        ]);
        expect(validOptionalConstraint("", 12)).toBe(true);
        expect(validOptionalConstraint("12", 12)).toBe(true);
        expect(validOptionalConstraint("13", 12)).toBe(false);
        expect(validOptionalConstraint("-", 12)).toBe(false);
        expect(validOptionalConstraint("1e2")).toBe(true);
        expect(validOptionalConstraint("1e999")).toBe(false);
    });

    it("creates nested types and accepts only the compiler's compound field names", () => {
        expect(initialDataType("list")).toEqual({
            kind: "list",
            element: { kind: "string" },
        });
        expect(initialDataType("compound")).toEqual({
            kind: "compound",
            fields: null,
        });
        expect(validCompoundFieldName("key with spaces")).toBe(true);
        expect(validCompoundFieldName(" ")).toBe(false);
        expect(validCompoundFieldName("a\u0085b")).toBe(false);
        expect(validCompoundFieldName("a".repeat(129))).toBe(false);
    });
});
