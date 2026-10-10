import { afterEach, describe, expect, it, vi } from "vitest";
import {
    DATA_FIELD_CONSTRAINTS_CAPABILITY,
    EMPTY_DATA_CONSTRAINTS,
    dataTypeSchema,
    usesDataFieldConstraints,
    type DataConstraints,
    type DataTypeNode,
    type ProjectDocument,
} from "@itemerness/protocol";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import { PluginClient } from "../src/api/client.js";
import {
    constraintViolation,
    elementLimit,
    selectableAllowedValues,
} from "../src/features/common/constraintValidation.js";

const constraints = (changes: Partial<DataConstraints>): DataConstraints => ({
    ...EMPTY_DATA_CONSTRAINTS,
    ...changes,
});

const skills: DataTypeNode = {
    kind: "list",
    element: {
        kind: "compound",
        fields: [
            {
                name: "trigger",
                type: { kind: "namespacedKey" },
                nullable: false,
                constraints: constraints({
                    allowedValues: [
                        { kind: "string", value: "example:on_hit" },
                    ],
                }),
            },
        ],
    },
};

describe("local constraint feedback", () => {
    it("mirrors numeric, scale, text and container limits", () => {
        const range = constraints({
            minimum: "0",
            maximum: "9223372036854775806",
        });
        expect(
            constraintViolation(range, { kind: "integer", value: "-1" }),
        ).toEqual({ code: "minimum", limit: "0" });
        expect(
            constraintViolation(range, {
                kind: "integer",
                value: "9223372036854775807",
            }),
        ).toEqual({ code: "maximum", limit: "9223372036854775806" });
        expect(
            constraintViolation(constraints({ scale: 1 }), {
                kind: "decimal",
                value: "1.50",
            }),
        ).toBeNull();
        expect(
            constraintViolation(constraints({ scale: 1 }), {
                kind: "decimal",
                value: "1.25",
            }),
        ).toEqual({ code: "scale", limit: 1 });
        expect(
            constraintViolation(constraints({ maximumCodePoints: 2 }), {
                kind: "string",
                value: "a😀",
            }),
        ).toBeNull();
        const list = {
            kind: "list" as const,
            values: [
                { kind: "string" as const, value: "a" },
                { kind: "string" as const, value: "b" },
            ],
        };
        expect(
            constraintViolation(constraints({ maximumElements: 1 }), list),
        ).toEqual({ code: "maximumElements", limit: 1 });
        expect(elementLimit(constraints({ maximumElements: 999 }))).toBe(256);
        expect(elementLimit(undefined)).toBe(256);
    });

    it("compares allowed numbers by value and offers only scalar choices", () => {
        const allowed = constraints({
            allowedValues: [{ kind: "decimal", value: "1.5" }],
        });
        expect(
            constraintViolation(allowed, { kind: "decimal", value: "1.50" }),
        ).toBeNull();
        expect(
            constraintViolation(allowed, { kind: "decimal", value: "2" }),
        ).toEqual({ code: "allowedValues" });
        expect(selectableAllowedValues(allowed)).toHaveLength(1);
        expect(
            selectableAllowedValues(
                constraints({
                    allowedValues: [{ kind: "list", values: [] }],
                }),
            ),
        ).toEqual([]);
    });
});

describe("compound field constraints in the document protocol", () => {
    it("parses complete field constraints and rejects partial ones", () => {
        expect(dataTypeSchema.parse(skills)).toEqual(skills);
        const partial = structuredClone(skills) as {
            element: { fields: { constraints: unknown }[] };
        };
        partial.element.fields[0]!.constraints = { minimum: "0" };
        expect(dataTypeSchema.safeParse(partial).success).toBe(false);
    });

    it("detects nested field constraints but not plain compounds", () => {
        const document = structuredClone(baselineDocument);
        expect(usesDataFieldConstraints(document)).toBe(false);
        document.dataSchemas[0]!.keys[0]!.type = skills;
        expect(usesDataFieldConstraints(document)).toBe(true);
    });
});

describe("plugin capability gate", () => {
    afterEach(() => vi.unstubAllGlobals());

    const handshake = (capabilities: string[]) => ({
        product: "itemerness",
        authentication: "none",
        serverId: "test",
        pluginVersion: "0.1.0",
        minecraftVersion: "26.1.2",
        platform: "Folia",
        compilerDigest: "sha256:" + "0".repeat(64),
        protocols: [{ major: 2, minMinor: 0, maxMinor: 0 }],
        documentSchemas: [1, 2],
        previewSchemas: [1],
        capabilities: ["draft.read", "draft.write", ...capabilities],
    });
    const constrainedDocument = (): ProjectDocument => {
        const document = structuredClone(baselineDocument);
        document.dataSchemas[0]!.keys[0]!.type = skills;
        return document;
    };

    it("refuses to send field constraints to a plugin that cannot read them", async () => {
        const fetch = vi
            .fn()
            .mockResolvedValueOnce(new Response(JSON.stringify(handshake([]))));
        vi.stubGlobal("fetch", fetch);
        const client = new PluginClient("http://example.test", "");
        await client.handshake();
        await expect(
            client.saveDocument(constrainedDocument(), ""),
        ).rejects.toThrow("DATA_FIELD_CONSTRAINTS_UNSUPPORTED");
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("sends field constraints when the capability is advertised", async () => {
        const document = constrainedDocument();
        const fetch = vi
            .fn()
            .mockResolvedValueOnce(
                new Response(
                    JSON.stringify(
                        handshake([DATA_FIELD_CONSTRAINTS_CAPABILITY]),
                    ),
                ),
            )
            .mockResolvedValueOnce(
                new Response(
                    JSON.stringify({
                        snapshotHash: "sha256:" + "1".repeat(64),
                        revision: 1,
                    }),
                ),
            );
        vi.stubGlobal("fetch", fetch);
        const client = new PluginClient("http://example.test", "");
        await client.handshake();
        await client.saveDocument(document, "").catch(() => undefined);
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(
            JSON.parse(fetch.mock.calls[1]![1].body).document.dataSchemas[0]
                .keys[0].type,
        ).toEqual(skills);
    });
});
