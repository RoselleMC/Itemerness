import { beforeEach, describe, expect, it } from "vitest";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import {
    projectDocumentSchema,
    type FormatNode,
    type PresentationBlock,
    type ViewerFactNode,
} from "@itemerness/protocol";
import {
    builtinFactType,
    formatDependsOn,
    libraryIdError,
    newFormat,
    newViewerFact,
    presentationLibraryItems,
    presentationLibraryReferences,
    removePresentationEntry,
    renamePresentationEntry,
} from "../src/state/presentationLibrary.js";
import {
    factValueError,
    initialFactValue,
    providerError,
    switchFactType,
} from "../src/features/inspector/factEditing.js";
import {
    formatError,
    formatVariant,
    retainFormatVariant,
} from "../src/features/inspector/formatEditing.js";
import { useEditorStore } from "../src/state/store.js";

const document = () => structuredClone(baselineDocument);
const state = () => useEditorStore.getState();
const field = (format: string): PresentationBlock => ({
    uuid: crypto.randomUUID(),
    type: "field",
    labelMessage: "label.value",
    data: "test:value",
    format,
    style: null,
    anchor: null,
    wrapping: null,
    icon: null,
    missingPolicy: "ERROR",
});
const condition = (children: PresentationBlock[]): PresentationBlock => ({
    uuid: crypto.randomUUID(),
    type: "conditional",
    style: null,
    anchor: null,
    condition: {
        operator: "EQUALS",
        left: { kind: "fact", key: "test:fact" },
        right: { kind: "fact", key: "test:fact" },
    },
    thenBlocks: children,
    otherwiseBlocks: [field("test:base")],
});

describe("presentation library references", () => {
    it("migrates data integration formatter references without touching dynamic MESSAGE patterns", () => {
        const doc = document();
        const format = doc.formats[0]!;
        const schema = doc.dataSchemas[0]!;
        schema.keys[0]!.integration = {
            readSources: [{ kind: "canonicalNbt" }],
            access: { read: "PUBLIC", write: ["internal"] },
            placeholderApi: { exposed: true, formatter: format.id },
        };
        const dynamic = doc.formats.find(
            (entry) =>
                entry.kind === "namespacedKey" && entry.mode === "MESSAGE",
        )!;
        if (dynamic.kind !== "namespacedKey")
            throw new Error("Expected key format");
        dynamic.messagePattern = format.id;
        const migrated = renamePresentationEntry(
            doc,
            "formats",
            format.uuid,
            "test:whole",
        );
        expect(
            migrated.dataSchemas[0]!.keys[0]!.integration?.placeholderApi
                .formatter,
        ).toBe("test:whole");
        expect(
            migrated.formats.find((entry) => entry.uuid === dynamic.uuid),
        ).toMatchObject({ messagePattern: format.id });
        expect(
            presentationLibraryReferences(migrated, "formats", "test:whole"),
        ).toContain(`${schema.id}@${schema.version}: ${schema.keys[0]!.id}`);
    });
    it("renames recursive format references, list edges and retained variants atomically", () => {
        const doc = document();
        const base = {
            uuid: crypto.randomUUID(),
            id: "test:base",
            kind: "integer",
            pattern: "0",
        } as const;
        doc.formats.push(base, {
            uuid: crypto.randomUUID(),
            id: "test:list",
            kind: "list",
            elementFormat: base.id,
            separatorMessage: "list.separator",
        });
        doc.formats[0]!.extensions = {
            vendor: "keep",
            editorFormatVariants: {
                list: {
                    kind: "list",
                    elementFormat: base.id,
                    separatorMessage: "list.separator",
                },
            },
        };
        doc.items[0]!.presentation.blocks = [condition([field(base.id)])];
        const result = renamePresentationEntry(
            doc,
            "formats",
            base.uuid,
            "test:renamed",
        );
        expect(
            JSON.stringify(result.items[0]!.presentation.blocks),
        ).not.toContain(base.id);
        expect(
            result.formats.find((entry) => entry.id === "test:list"),
        ).toMatchObject({ elementFormat: "test:renamed" });
        expect(result.formats[0]!.extensions).toEqual({
            vendor: "keep",
            editorFormatVariants: {
                list: {
                    kind: "list",
                    elementFormat: "test:renamed",
                    separatorMessage: "list.separator",
                },
            },
        });
        expect(doc.formats.find((entry) => entry.id === base.id)).toBe(base);
        expect(
            presentationLibraryReferences(result, "formats", "test:renamed")
                .length,
        ).toBeGreaterThanOrEqual(3);
        expect(removePresentationEntry(result, "formats", base.uuid)).toBe(
            result,
        );
    });

    it("renames both conditional fact operands but never arbitrary literal strings", () => {
        const doc = document();
        const fact = { ...newViewerFact(doc), id: "test:fact" };
        doc.viewerFacts.push(fact);
        const block = condition([]);
        doc.items[0]!.presentation.blocks = [block];
        const result = renamePresentationEntry(
            doc,
            "facts",
            fact.uuid,
            "test:renamed",
        );
        expect(result.items[0]!.presentation.blocks[0]).toMatchObject({
            condition: {
                left: { key: "test:renamed" },
                right: { key: "test:renamed" },
            },
        });
        expect(
            presentationLibraryItems(result, "facts", "test:renamed"),
        ).toHaveLength(1);
        expect(removePresentationEntry(result, "facts", fact.uuid)).toBe(
            result,
        );
    });

    it("finds users through list chains and terminates cycles", () => {
        const doc = document();
        doc.formats = [
            {
                uuid: crypto.randomUUID(),
                id: "test:a",
                kind: "list",
                elementFormat: "test:b",
                separatorMessage: "separator",
            },
            {
                uuid: crypto.randomUUID(),
                id: "test:b",
                kind: "list",
                elementFormat: "test:a",
                separatorMessage: "separator",
            },
        ];
        doc.items[0]!.presentation.blocks = [field("test:a")];
        expect(formatDependsOn(doc, "test:a", "test:b")).toBe(true);
        expect(formatDependsOn(doc, "test:a", "test:missing")).toBe(false);
        expect(presentationLibraryItems(doc, "formats", "test:b")).toHaveLength(
            1,
        );
        expect(formatError(doc, doc.formats[0]!)).toBe("formatCycle");
    });

    it("marks system roles without restricting YAML-supported deletion or renames", () => {
        const doc = document();
        const builtin = doc.viewerFacts.find(
            (entry) => entry.id === "itemerness:locale",
        )!;
        expect(builtinFactType(builtin.id)).toBe("LOCALE");
        expect(
            renamePresentationEntry(
                doc,
                "facts",
                builtin.uuid,
                "test:locale",
            ).viewerFacts.find((entry) => entry.uuid === builtin.uuid)?.id,
        ).toBe("test:locale");
        expect(
            removePresentationEntry(doc, "facts", builtin.uuid).viewerFacts,
        ).not.toContain(builtin);
        const custom = { ...newViewerFact(doc), id: "itemerness:custom" };
        doc.viewerFacts.push(custom);
        expect(builtinFactType(custom.id)).toBeNull();
        expect(
            removePresentationEntry(doc, "facts", custom.uuid).viewerFacts,
        ).not.toContain(custom);
        expect(libraryIdError(doc, "facts", custom.uuid, builtin.id)).toBe(
            "duplicateId",
        );
    });

    it("creates independent UUIDs and bounded collision-free IDs", () => {
        const doc = document();
        const source = {
            ...newFormat(doc),
            id: `test:${"a".repeat(251)}`,
            extensions: { arbitrary: { value: 1 } },
        };
        doc.formats.push(source);
        const copy = newFormat(doc, source);
        doc.formats.push(copy);
        const second = newFormat(doc, source);
        expect(copy.id.length).toBeLessThanOrEqual(256);
        expect(second.id).not.toBe(copy.id);
        expect(copy.uuid).not.toBe(source.uuid);
        expect(copy.extensions).toEqual(source.extensions);
        expect(copy.extensions).not.toBe(source.extensions);
        doc.viewerFacts.push(newViewerFact(doc));
        expect(projectDocumentSchema.safeParse(doc).success).toBe(true);
    });
});

describe("format variants", () => {
    it("retains each variant and opaque extensions while requiring new references", () => {
        const doc = document();
        const integer: FormatNode = {
            ...newFormat(doc),
            kind: "integer",
            pattern: "#,##0;(#,##0)",
            extensions: { vendor: [1], editorFormatVariants: "opaque" },
        };
        const decimal = retainFormatVariant(
            integer,
            formatVariant(integer, "decimal"),
        );
        expect(formatVariant(decimal, "integer")).toMatchObject({
            kind: "integer",
            pattern: integer.pattern,
        });
        expect(decimal.extensions).toMatchObject({
            vendor: [1],
            editorFormatVariants: { previousValue: "opaque" },
        });
        expect(
            formatError(doc, formatVariant(integer, "boolean")),
        ).toBeTruthy();
        expect(formatError(doc, formatVariant(integer, "list"))).toBeTruthy();
        expect(formatError(doc, integer)).toBeNull();
    });

    it("requires a MESSAGE pattern but never treats it as a static message key", () => {
        const doc = document();
        const format: FormatNode = {
            uuid: crypto.randomUUID(),
            id: "test:key",
            kind: "namespacedKey",
            mode: "MESSAGE",
            messagePattern: null,
            missingValue: "ERROR",
        };
        expect(formatError(doc, format)).toBe("messagePattern");
        expect(
            formatError(doc, {
                ...format,
                messagePattern: "names.{namespace}.{path}",
            }),
        ).toBeNull();
    });
});

describe("viewer fact values", () => {
    const fact = (type: ViewerFactNode["type"]): ViewerFactNode => ({
        uuid: crypto.randomUUID(),
        id: "test:fact",
        type,
        providers: ["api"],
        nullable: false,
        cacheKey: true,
        defaultValue: null,
        previewValue: null,
    });
    it.each([
        ["INTEGER", "2147483647", "2147483648"],
        ["LONG", "9223372036854775807", "9223372036854775808"],
    ] as const)(
        "validates %s without JS integer precision loss",
        (type, valid, invalid) => {
            expect(
                factValueError(document(), fact(type), {
                    kind: "integer",
                    value: valid,
                }),
            ).toBeNull();
            expect(
                factValueError(document(), fact(type), {
                    kind: "integer",
                    value: invalid,
                }),
            ).toBeTruthy();
        },
    );
    it("validates locale, UUID, namespaced keys, value kinds and codepoint budgets", () => {
        const doc = document();
        expect(
            factValueError(doc, fact("LOCALE"), {
                kind: "string",
                value: doc.defaultLocale,
            }),
        ).toBeNull();
        expect(
            factValueError(doc, fact("LOCALE"), {
                kind: "string",
                value: "missing",
            }),
        ).toBe("unknownLocale");
        expect(
            factValueError(doc, fact("UUID"), {
                kind: "string",
                value: "not-a-uuid",
            }),
        ).toBeTruthy();
        expect(
            factValueError(doc, fact("NAMESPACED_KEY"), {
                kind: "string",
                value: "no namespace",
            }),
        ).toBeTruthy();
        expect(
            factValueError(doc, fact("BOOLEAN"), {
                kind: "string",
                value: "true",
            }),
        ).toBe("typeMismatch");
        doc.budgets.maximumTextCodePoints = 2;
        expect(
            factValueError(doc, fact("STRING"), {
                kind: "string",
                value: "abc",
            }),
        ).toBe("stringLimit");
    });
    it("keeps runtime defaults independent from preview overrides across type changes", () => {
        const doc = document();
        const source = {
            ...fact("LONG"),
            defaultValue: {
                kind: "integer",
                value: "9223372036854775807",
            } as const,
            previewValue: { kind: "integer", value: "123" } as const,
            extensions: { vendor: true },
        };
        const changed = switchFactType(doc, source, "BOOLEAN");
        expect(changed.defaultValue).toEqual({ kind: "boolean", value: false });
        expect(changed.previewValue).toBeNull();
        const restored = switchFactType(doc, changed, "LONG");
        expect(restored.defaultValue).toEqual(source.defaultValue);
        expect(restored.previewValue).toEqual(source.previewValue);
        expect(restored.extensions?.vendor).toBe(true);
        expect(initialFactValue(doc, fact("LOCALE"))).toEqual({
            kind: "string",
            value: doc.defaultLocale,
        });
    });
    it("allows core-supported built-in types and rejects invalid or duplicate providers", () => {
        const doc = document();
        const builtin = doc.viewerFacts.find(
            (entry) => entry.id === "itemerness:locale",
        )!;
        expect(switchFactType(doc, builtin, "INTEGER")).toMatchObject({
            type: "INTEGER",
            defaultValue: { kind: "integer", value: "0" },
        });
        expect(providerError("api", ["api"])).toBe("duplicateProvider");
        expect(providerError("api", ["api"], "api")).toBeNull();
        expect(providerError("My Provider", [])).toBe("invalidProvider");
        expect(providerError("custom.provider-2", [])).toBeNull();
        const theme = doc.viewerFacts.find(
            (entry) => entry.id === "itemerness:theme",
        )!;
        const changed = switchFactType(
            doc,
            { ...theme, nullable: false },
            "BOOLEAN",
        );
        expect(changed.defaultValue).toEqual({ kind: "boolean", value: false });
        expect(factValueError(doc, changed, changed.defaultValue!)).toBeNull();
    });
});

describe("presentation library history", () => {
    beforeEach(() => {
        state().resetDraft();
        state().setDocument(document());
    });
    it("restores selections and a whole reference rename in one document step", () => {
        const format = state().document.formats[0]!;
        state().setMode("formats");
        state().selectFormat(format.uuid);
        const before = state().snapshotHash;
        state().updateDocument((doc) =>
            renamePresentationEntry(
                doc,
                "formats",
                format.uuid,
                "test:renamed",
            ),
        );
        const after = state().snapshotHash;
        expect(after).not.toBe(before);
        state().undo();
        expect(state().snapshotHash).toBe(before);
        expect(state().selectedFormatUuid).toBe(format.uuid);
        state().redo();
        expect(state().snapshotHash).toBe(after);
        expect(state().persistenceDocument).toBe(state().document);
    });
    it("reconciles deleted selections and clears both libraries on disconnect", () => {
        const added = newViewerFact(state().document);
        state().updateDocument((doc) => ({
            ...doc,
            viewerFacts: [...doc.viewerFacts, added],
        }));
        state().selectViewerFact(added.uuid);
        state().updateDocument((doc) =>
            removePresentationEntry(doc, "facts", added.uuid),
        );
        expect(state().selectedViewerFactUuid).not.toBe(added.uuid);
        state().undo();
        expect(state().selectedViewerFactUuid).toBe(added.uuid);
        state().resetDraft();
        expect(state().selectedViewerFactUuid).toBeNull();
        expect(state().selectedFormatUuid).toBeNull();
    });
});
