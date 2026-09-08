import { describe, expect, it } from "vitest";
import {
    dataKeyNodeSchema,
    type DataKeyIntegration,
    type DataTypeNode,
} from "@itemerness/protocol";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import {
    emptyReviewPolicy,
    formatAcceptsType,
    integrationIssues,
    mergeIntegrationEdit,
    pdcCandidateIssue,
    upgradeWithReviewedPolicies,
    writerIssue,
} from "../src/features/inspector/dataIntegrationEditing.js";

const fixture = () => {
    const document = structuredClone(baselineDocument);
    const key = dataKeyNodeSchema.parse({
        uuid: crypto.randomUUID(),
        id: "test:count",
        scope: "INSTANCE",
        type: { kind: "long" },
    });
    document.dataSchemas = [
        {
            uuid: crypto.randomUUID(),
            id: "test:schema",
            version: 1,
            keys: [key],
        },
    ];
    return { document, key };
};
const reviewed = (key: ReturnType<typeof fixture>["key"]) => ({
    policy: {
        ...emptyReviewPolicy(key),
        access: { read: "INTERNAL" as const, write: ["internal"] },
    },
    readChosen: true,
    confirmed: true,
});

describe("data integration authoring", () => {
    it("starts review without choosing instance write authority and never upgrades an unreviewed key", () => {
        const { document, key } = fixture();
        expect(emptyReviewPolicy(key)).toMatchObject({
            readSources: [{ kind: "canonicalNbt" }],
            access: { write: [] },
        });
        expect(() => upgradeWithReviewedPolicies(document, {})).toThrow(
            "UNREVIEWED_POLICY",
        );
        expect(() =>
            upgradeWithReviewedPolicies(document, {
                [key.uuid]: { ...reviewed(key), readChosen: false },
            }),
        ).toThrow("UNREVIEWED_POLICY");
        const upgraded = upgradeWithReviewedPolicies(document, {
            [key.uuid]: reviewed(key),
        });
        expect(upgraded.schemaVersion).toBe(2);
        expect(upgraded.measurement).toEqual({ boldExtraAdvancePixels: 1 });
        expect(document.schemaVersion).toBe(1);
        expect(key.integration).toBeUndefined();
    });
    it("keeps scope-fixed policies separate from unsupported owner reads", () => {
        const { document, key } = fixture();
        const definition = { ...key, scope: "DEFINITION" as const };
        expect(emptyReviewPolicy(definition)).toMatchObject({
            readSources: [{ kind: "catalogDefinition" }],
            access: { write: ["definition"] },
        });
        expect(writerIssue(definition, "internal", [])).toBe("writerScope");
        expect(writerIssue(key, "definition", [])).toBe("writerScope");
        expect(writerIssue(key, "plugin:Example", ["plugin:example"])).toBe(
            "duplicateWriter",
        );
        expect(writerIssue(key, "plugin:bad name", [])).toBe("writerSyntax");
        expect(
            integrationIssues(document, key, {
                ...reviewed(key).policy,
                access: { read: "OWNER_ONLY", write: ["internal"] },
            }),
        ).toContainEqual({ code: "ownerUnavailable" });
    });
    it("validates ordered PDC fallbacks, global budgets, and physical type conflicts", () => {
        const { document, key } = fixture();
        const policy: DataKeyIntegration = {
            ...reviewed(key).policy,
            readSources: [
                { kind: "canonicalNbt" },
                {
                    kind: "pdc",
                    key: "other:counter",
                    mode: "FALLBACK_READ_ONLY",
                },
            ],
        };
        expect(pdcCandidateIssue(document, key, policy, "other:counter")).toBe(
            "duplicatePdc",
        );
        expect(
            pdcCandidateIssue(document, key, policy, "other:counter", 1),
        ).toBeNull();
        expect(
            pdcCandidateIssue(
                document,
                { ...key, type: { kind: "list", element: { kind: "long" } } },
                policy,
                "other:key",
            ),
        ).toBe("pdcScope");
        const other = {
            ...key,
            uuid: crypto.randomUUID(),
            id: "test:text",
            type: { kind: "string" as const },
            integration: policy,
        };
        document.dataSchemas[0]!.keys.push(other);
        expect(
            pdcCandidateIssue(
                document,
                key,
                reviewed(key).policy,
                "other:counter",
            ),
        ).toBe("pdcPhysicalType");
        other.integration = {
            ...policy,
            readSources: [
                { kind: "canonicalNbt" },
                ...Array.from({ length: 256 }, (_, index) => ({
                    kind: "pdc" as const,
                    key: `old:key_${index}`,
                    mode: "FALLBACK_READ_ONLY" as const,
                })),
            ],
        };
        expect(
            pdcCandidateIssue(document, key, reviewed(key).policy, "other:new"),
        ).toBe("pdcBudget");
    });
    it("filters formatter types recursively and rejects cycles/missing references", () => {
        const { document } = fixture();
        for (const kind of ["integer", "long", "decimal"] as const)
            expect(
                formatAcceptsType(document, "itemerness:decimal-one", { kind }),
            ).toBe(true);
        expect(
            formatAcceptsType(document, "itemerness:integer", {
                kind: "string",
            }),
        ).toBe(false);
        expect(
            formatAcceptsType(document, "itemerness:key-path", {
                kind: "namespacedKey",
            }),
        ).toBe(true);
        expect(
            formatAcceptsType(document, "missing:format", { kind: "long" }),
        ).toBe(false);
        document.formats.push({
            uuid: crypto.randomUUID(),
            id: "test:list",
            kind: "list",
            elementFormat: "test:list",
            separatorMessage: "format.separator",
        });
        const type: DataTypeNode = {
            kind: "list",
            element: { kind: "list", element: { kind: "long" } },
        };
        expect(formatAcceptsType(document, "test:list", type)).toBe(false);
    });
    it("requires public scalar exposure and validates formatter even when not exposed", () => {
        const { document, key } = fixture();
        const policy = reviewed(key).policy;
        expect(
            integrationIssues(document, key, {
                ...policy,
                placeholderApi: { exposed: true, formatter: null },
            }),
        ).toContainEqual({ code: "placeholderExposure" });
        expect(
            integrationIssues(document, key, {
                ...policy,
                placeholderApi: {
                    exposed: false,
                    formatter: "itemerness:boolean",
                },
            }),
        ).toContainEqual({
            code: "placeholderFormat",
            detail: "itemerness:boolean",
        });
    });
    it("preserves same-click inline commits when changing unrelated policy fields or list structure", () => {
        const { key } = fixture();
        const previous = reviewed(key).policy;
        const current = {
            ...previous,
            access: { ...previous.access, write: ["plugin:Edited"] },
        };
        const next = {
            ...previous,
            access: {
                ...previous.access,
                read: "PUBLIC" as const,
                write: [...previous.access.write, "plugin:Added"],
            },
        };
        expect(mergeIntegrationEdit(current, previous, next).access).toEqual({
            read: "PUBLIC",
            write: ["plugin:Edited", "plugin:Added"],
        });
    });
});
