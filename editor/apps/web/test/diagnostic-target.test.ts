import { describe, expect, it } from "vitest";
import { diagnosticSchema, projectDocumentSchema } from "@itemerness/protocol";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import {
    createDiagnosticResolver,
    diagnosticTarget,
} from "../src/features/diagnostics/diagnosticTarget.js";

const issue = (extra: Record<string, unknown>) =>
    diagnosticSchema.parse({
        code: "CATALOG.INVALID_VALUE",
        severity: "ERROR",
        origin: "agent",
        messageKey: "diagnostics.catalog.invalid_value",
        ...extra,
    });

describe("diagnostic navigation", () => {
    it("locates exact item block compiler paths without changing documents", () => {
        const before = JSON.stringify(baselineDocument);
        const item = baselineDocument.items[0]!;
        expect(
            diagnosticTarget(
                baselineDocument,
                issue({
                    params: {
                        path: `presentation.items.${baselineDocument.namespace}:${item.id}.blocks[1].data`,
                    },
                }),
            ),
        ).toEqual({
            kind: "item",
            id: `${baselineDocument.namespace}:${item.id}`,
            blockUuid: item.presentation.blocks[1]!.uuid,
        });
        expect(JSON.stringify(baselineDocument)).toBe(before);
    });
    it("prefers stable UUID and does not fall back from an obsolete UUID", () => {
        const key = baselineDocument.dataSchemas[0]!.keys[0]!;
        expect(
            diagnosticTarget(
                baselineDocument,
                issue({ nodeUuid: key.uuid, pointer: "/items/0" }),
            ),
        ).toEqual({ kind: "key", uuid: key.uuid });
        expect(
            diagnosticTarget(
                baselineDocument,
                issue({
                    nodeUuid: "00000000-0000-4000-8000-000000000099",
                    pointer: "/items/0",
                }),
            ),
        ).toBeNull();
    });
    it("resolves RFC 6901 and core indexed schema locations", () => {
        const key = baselineDocument.dataSchemas[0]!.keys[0]!;
        for (const extra of [
            { pointer: "/dataSchemas/0/keys/0/constraints/maximum" },
            { params: { path: "schemas[0].keys[0].type" } },
        ])
            expect(diagnosticTarget(baselineDocument, issue(extra))).toEqual({
                kind: "key",
                uuid: key.uuid,
            });
    });
    it("refuses out-of-range indices, ambiguous identities and malformed pointers", () => {
        for (const extra of [
            { pointer: "/items/999/presentation" },
            { pointer: "/items/0/presentation/blocks/999/data" },
            { pointer: "/items/~2" },
            { params: { path: "items[0].blocks[999].data" } },
            { params: { detail: "items[0].material" } },
        ])
            expect(diagnosticTarget(baselineDocument, issue(extra))).toBeNull();
        const document = structuredClone(baselineDocument);
        const schema = structuredClone(document.dataSchemas[0]!);
        schema.uuid = crypto.randomUUID();
        schema.version++;
        schema.keys.forEach((key) => {
            key.uuid = crypto.randomUUID();
        });
        document.dataSchemas.push(schema);
        expect(
            diagnosticTarget(
                document,
                issue({
                    params: { path: `data-keys.${schema.keys[0]!.id}.access` },
                }),
            ),
        ).toBeNull();
    });
    it("distinguishes punctuation inside qualified identities", () => {
        const document = structuredClone(baselineDocument);
        document.schemaVersion = 2;
        document.items[0]!.id = "other:item.blocks";
        expect(
            diagnosticTarget(
                document,
                issue({
                    params: {
                        path: "presentation.items.other:item.blocks.blocks[0].data",
                    },
                }),
            ),
        ).toEqual({
            kind: "item",
            id: "other:item.blocks",
            blockUuid: document.items[0]!.presentation.blocks[0]!.uuid,
        });
    });
    it("navigates all directly identified editing libraries", () => {
        for (const [collection, path, kind] of [
            ["themes", "themes", "theme"],
            ["layouts", "layouts", "layout"],
            ["formats", "formats", "format"],
            ["viewerFacts", "viewer-facts", "fact"],
        ] as const) {
            expect(
                diagnosticTarget(
                    baselineDocument,
                    issue({ params: { path: `${path}[0].id` } }),
                ),
            ).toEqual(
                kind === "theme" || kind === "layout"
                    ? { kind, id: baselineDocument[collection][0]!.id }
                    : { kind, uuid: baselineDocument[collection][0]!.uuid },
            );
        }
    });
    it("does not guess when a business ID and a structural suffix collide", () => {
        const document = structuredClone(baselineDocument);
        const key = document.dataSchemas[0]!.keys[0]!;
        document.dataSchemas[0]!.keys.push({
            ...structuredClone(key),
            uuid: crypto.randomUUID(),
            id: key.id + ".type",
        });
        expect(
            diagnosticTarget(
                document,
                issue({ params: { path: `data-keys.${key.id}.type` } }),
            ),
        ).toBeNull();
    });
    it("keeps independently indexed document identities isolated", () => {
        const original = structuredClone(baselineDocument);
        const replacement = structuredClone(original);
        replacement.items[0]!.uuid = crypto.randomUUID();
        replacement.items[0]!.id = "replacement";
        const first = createDiagnosticResolver(original);
        const second = createDiagnosticResolver(replacement);
        const pointer = issue({ pointer: "/items/0/material" });
        const oldIdentity = issue({
            nodeUuid: original.items[0]!.uuid,
            pointer: "/items/0",
        });
        expect(first(pointer)).toEqual({
            kind: "item",
            id: `${original.namespace}:${original.items[0]!.id}`,
            blockUuid: null,
        });
        expect(second(pointer)).toEqual({
            kind: "item",
            id: `${replacement.namespace}:replacement`,
            blockUuid: null,
        });
        expect(second(oldIdentity)).toBeNull();
        expect(first(oldIdentity)).toEqual(first(pointer));
    });
    it("keeps duplicate UUIDs and business IDs ambiguous while exact pointers remain usable", () => {
        const document = structuredClone(baselineDocument);
        document.items.push({
            ...structuredClone(document.items[0]!),
            presentation: { ...document.items[0]!.presentation, blocks: [] },
        });
        const resolve = createDiagnosticResolver(document);
        expect(
            resolve(
                issue({
                    nodeUuid: document.items[0]!.uuid,
                    pointer: "/items/0",
                }),
            ),
        ).toBeNull();
        expect(
            resolve(
                issue({
                    businessId: `${document.namespace}:${document.items[0]!.id}`,
                }),
            ),
        ).toBeNull();
        expect(resolve(issue({ pointer: "/items/0/material" }))).toEqual({
            kind: "item",
            id: `${document.namespace}:${document.items[0]!.id}`,
            blockUuid: null,
        });
    });
    it("validates escaped pointer segments and canonical array indices before ancestor lookup", () => {
        const document = structuredClone(baselineDocument);
        document.items[0]!.extensions = { "a/b": { "~value": ["entry"] } };
        const resolve = createDiagnosticResolver(document);
        expect(
            resolve(issue({ pointer: "/items/0/extensions/a~1b/~0value/0" })),
        ).toEqual({
            kind: "item",
            id: `${document.namespace}:${document.items[0]!.id}`,
            blockUuid: null,
        });
        for (const suffix of [
            "1",
            "01",
            "-1",
            "-",
            "1e0",
            "999999999999999999999",
        ])
            expect(
                resolve(
                    issue({
                        pointer: `/items/0/extensions/a~1b/~0value/${suffix}`,
                    }),
                ),
            ).toBeNull();
        expect(
            resolve(issue({ pointer: "/items/0/extensions/a~2b" })),
        ).toBeNull();
    });
    it("walks a large catalog once and resolves a full diagnostic batch without rescanning collections", () => {
        const document = structuredClone(baselineDocument);
        const template = document.items[0]!;
        const block = template.presentation.blocks[0]!;
        document.items = Array.from({ length: 500 }, (_, index) => ({
            ...structuredClone(template),
            uuid: crypto.randomUUID(),
            id: `entry-${index}`,
            presentation: {
                ...template.presentation,
                blocks: Array.from({ length: 20 }, () => ({
                    ...structuredClone(block),
                    uuid: crypto.randomUUID(),
                })),
            },
        }));
        expect(projectDocumentSchema.safeParse(document).success).toBe(true);
        const before = JSON.stringify(document);
        let traversals = 0;
        document.items = new Proxy(document.items, {
            get(target, property, receiver) {
                if (property === "forEach") traversals++;
                return Reflect.get(target, property, receiver);
            },
        });
        const resolve = createDiagnosticResolver(document);
        for (let index = 0; index < 512; index++) {
            const itemIndex = index % document.items.length;
            const item = document.items[itemIndex]!;
            const expected = {
                kind: "item",
                id: `${document.namespace}:${item.id}`,
                blockUuid: item.presentation.blocks[0]!.uuid,
            };
            for (const extra of [
                { nodeUuid: expected.blockUuid },
                { pointer: `/items/${itemIndex}/presentation/blocks/0/text` },
                {
                    params: {
                        path: `presentation.items.${expected.id}.blocks[0].text`,
                    },
                },
                { params: { path: `items[${itemIndex}].blocks[0].text` } },
            ])
                expect(resolve(issue(extra))).toEqual(expected);
        }
        expect(traversals).toBe(1);
        expect(JSON.stringify(document)).toBe(before);
    });
});
