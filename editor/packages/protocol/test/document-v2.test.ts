import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { contentHash } from "../src/canonical.js";
import {
    emptyProjectDocument,
    projectDocumentSchema,
    upgradeProjectDocument,
    type DataKeyIntegration,
    type DataKeyNode,
} from "../src/document.js";

const rawLegacy = () =>
    JSON.parse(
        readFileSync(
            new URL("../fixtures/baseline.json", import.meta.url),
            "utf8",
        ),
    );
const policy = (key: DataKeyNode): DataKeyIntegration => ({
    readSources: [
        {
            kind:
                key.scope === "DEFINITION"
                    ? "catalogDefinition"
                    : "canonicalNbt",
        },
    ],
    access: {
        read: "INTERNAL",
        write: [key.scope === "DEFINITION" ? "definition" : "internal"],
    },
    placeholderApi: { exposed: false, formatter: null },
});
const upgraded = () =>
    upgradeProjectDocument(rawLegacy(), (_schema, key) => policy(key));

describe("document schema 2", () => {
    it("preserves the original schema 1 fixture and recorded hash without inserting new fields", () => {
        const raw = rawLegacy();
        const parsed = projectDocumentSchema.parse(raw);
        expect(parsed).toEqual(raw);
        expect(parsed.schemaVersion).toBe(1);
        expect(parsed).not.toHaveProperty("measurement");
        expect(parsed.dataSchemas[0]!.keys[0]).not.toHaveProperty(
            "integration",
        );
        expect(contentHash(parsed)).toBe(
            readFileSync(
                new URL("../fixtures/baseline.sha256", import.meta.url),
                "utf8",
            ).trim(),
        );
    });

    it("requires explicit identity-scoped policy resolution for an upgrade and leaves the input unchanged", () => {
        const raw = rawLegacy();
        const before = contentHash(raw);
        const identities: string[] = [];
        const document = upgradeProjectDocument(raw, (schema, key) => {
            identities.push(
                `${schema.uuid}:${schema.id}:${schema.version}:${key.uuid}`,
            );
            return policy(key);
        });
        expect(identities).toHaveLength(
            raw.dataSchemas.flatMap(
                (schema: { keys: unknown[] }) => schema.keys,
            ).length,
        );
        expect(new Set(identities).size).toBe(identities.length);
        expect(document.schemaVersion).toBe(2);
        expect(document.measurement).toEqual({ boldExtraAdvancePixels: 1 });
        expect(contentHash(document)).not.toBe(before);
        expect(contentHash(raw)).toBe(before);
        expect(() =>
            upgradeProjectDocument(document, (_schema, key) => policy(key)),
        ).toThrow("DOCUMENT_ALREADY_UPGRADED");
    });

    it("requires all new fields in schema 2 and refuses them in legacy documents", () => {
        const missingMeasurement = upgraded();
        delete missingMeasurement.measurement;
        expect(
            projectDocumentSchema.safeParse(missingMeasurement).success,
        ).toBe(false);
        const missingPolicy = upgraded();
        delete missingPolicy.dataSchemas[0]!.keys[0]!.integration;
        expect(projectDocumentSchema.safeParse(missingPolicy).success).toBe(
            false,
        );
        const legacy = rawLegacy();
        legacy.measurement = { boldExtraAdvancePixels: 1 };
        expect(projectDocumentSchema.safeParse(legacy).success).toBe(false);
        delete legacy.measurement;
        legacy.dataSchemas[0].keys[0].integration = policy(
            legacy.dataSchemas[0].keys[0],
        );
        expect(projectDocumentSchema.safeParse(legacy).success).toBe(false);
        expect(
            emptyProjectDocument("00000000-0000-4000-8000-000000000001")
                .schemaVersion,
        ).toBe(2);
    });

    it("preserves PDC order, plugin principal spelling and PlaceholderAPI formatter", () => {
        const document = upgraded();
        const key = document.dataSchemas
            .flatMap((schema) => schema.keys)
            .find(
                (key) =>
                    key.scope === "INSTANCE" && key.type.kind === "integer",
            )!;
        key.integration = {
            readSources: [
                { kind: "canonicalNbt" },
                {
                    kind: "pdc",
                    key: "legacy:first",
                    mode: "FALLBACK_READ_ONLY",
                },
                {
                    kind: "pdc",
                    key: "legacy:second",
                    mode: "FALLBACK_READ_ONLY",
                },
            ],
            access: {
                read: "PUBLIC",
                write: ["internal", "plugin:Other_Plugin"],
            },
            placeholderApi: { exposed: true, formatter: "itemerness:integer" },
        };
        expect(projectDocumentSchema.parse(document)).toEqual(document);
    });

    it("rejects invalid read-source order, scope, complex type and duplicates", () => {
        const sourceCases: DataKeyIntegration["readSources"][] = [
            [],
            [{ kind: "catalogDefinition" }],
            [{ kind: "pdc", key: "legacy:value", mode: "FALLBACK_READ_ONLY" }],
            [{ kind: "canonicalNbt" }, { kind: "canonicalNbt" }],
            [
                { kind: "canonicalNbt" },
                {
                    kind: "pdc",
                    key: "legacy:value",
                    mode: "FALLBACK_READ_ONLY",
                },
                {
                    kind: "pdc",
                    key: "legacy:value",
                    mode: "FALLBACK_READ_ONLY",
                },
            ],
        ];
        for (const sources of sourceCases) {
            const document = upgraded();
            const key = document.dataSchemas
                .flatMap((schema) => schema.keys)
                .find((key) => key.scope === "INSTANCE")!;
            key.integration!.readSources = sources;
            expect(projectDocumentSchema.safeParse(document).success).toBe(
                false,
            );
        }
        for (const selector of [
            (key: DataKeyNode) => key.scope === "DEFINITION",
            (key: DataKeyNode) => key.type.kind === "list",
        ]) {
            const document = upgraded();
            const key = document.dataSchemas
                .flatMap((schema) => schema.keys)
                .find(selector)!;
            key.integration!.readSources.push({
                kind: "pdc",
                key: "legacy:value",
                mode: "FALLBACK_READ_ONLY",
            });
            expect(projectDocumentSchema.safeParse(document).success).toBe(
                false,
            );
        }
    });

    it("rejects empty, malformed, duplicate and scope-incompatible write principals", () => {
        for (const writers of [
            [],
            ["definition"],
            ["plugin:"],
            ["plugin:A/B"],
            ["plugin:Test", "plugin:test"],
            ["internal", "internal"],
        ]) {
            const document = upgraded();
            const key = document.dataSchemas
                .flatMap((schema) => schema.keys)
                .find((key) => key.scope === "INSTANCE")!;
            key.integration!.access.write = writers;
            expect(projectDocumentSchema.safeParse(document).success).toBe(
                false,
            );
        }
    });

    it("rejects nonpublic or complex PlaceholderAPI exposure and duplicate integration ids", () => {
        for (const selector of [
            (key: DataKeyNode) => key.type.kind === "integer",
            (key: DataKeyNode) => key.type.kind === "list",
        ]) {
            const document = upgraded();
            const key = document.dataSchemas
                .flatMap((schema) => schema.keys)
                .find(selector)!;
            key.integration!.placeholderApi.exposed = true;
            if (key.type.kind === "list")
                key.integration!.access.read = "PUBLIC";
            expect(projectDocumentSchema.safeParse(document).success).toBe(
                false,
            );
        }
        const document = upgraded();
        document.dataSchemas.push({
            ...structuredClone(document.dataSchemas[0]!),
            version: 2,
        });
        expect(projectDocumentSchema.safeParse(document).success).toBe(false);
    });

    it("rejects unknown fields at all document nesting levels while preserving explicit extensions", () => {
        const mutations = [
            (document: ReturnType<typeof rawLegacy>) => {
                document.future = true;
            },
            (document: ReturnType<typeof rawLegacy>) => {
                document.fonts[0].future = true;
            },
            (document: ReturnType<typeof rawLegacy>) => {
                document.dataSchemas[0].keys[0].type.future = true;
            },
            (document: ReturnType<typeof rawLegacy>) => {
                document.items[0].definition.instance.future = true;
            },
            (document: ReturnType<typeof rawLegacy>) => {
                document.budgets.future = true;
            },
        ];
        for (const mutate of mutations) {
            const document = rawLegacy();
            mutate(document);
            expect(projectDocumentSchema.safeParse(document).success).toBe(
                false,
            );
        }
        const document = rawLegacy();
        document.extensions = {
            future: { nested: ["preserved", { exact: true }] },
        };
        document.fonts[0].extensions = { future: { pixels: 123 } };
        expect(projectDocumentSchema.parse(document)).toEqual(document);
    });

    it("rejects invalid measurements and includes every policy/measurement change in the hash", () => {
        for (const pixels of [-1, 4097, Infinity, NaN]) {
            const document = upgraded();
            document.measurement!.boldExtraAdvancePixels = pixels;
            expect(projectDocumentSchema.safeParse(document).success).toBe(
                false,
            );
        }
        const document = upgraded();
        const hash = contentHash(document);
        document.measurement!.boldExtraAdvancePixels = 2.5;
        expect(contentHash(document)).not.toBe(hash);
        const secondHash = contentHash(document);
        document.dataSchemas[0]!.keys[0]!.integration!.access.read = "PUBLIC";
        expect(contentHash(document)).not.toBe(secondHash);
    });
});
