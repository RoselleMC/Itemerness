import { describe, expect, it } from "vitest";
import { previewParameterField } from "@itemerness/protocol";

describe("preview scenario parameters", () => {
    it("map onto the shared typed value editor's types and constraints", () => {
        const parameter = {
            id: "sockets",
            label: "Sockets",
            type: {
                kind: "list" as const,
                maximumSize: 8,
                element: {
                    kind: "compound" as const,
                    fields: [
                        {
                            id: "rune",
                            label: "Rune",
                            type: { kind: "namespaced-key" as const },
                            optional: false,
                            choices: ["runo:fire"],
                            minimum: null,
                            maximum: null,
                            defaultValue: null,
                        },
                        {
                            id: "rank",
                            label: "Rank",
                            type: { kind: "integer" as const },
                            optional: true,
                            choices: [],
                            minimum: 1,
                            maximum: 5,
                            defaultValue: null,
                        },
                    ],
                },
            },
            optional: true,
            choices: [],
            minimum: null,
            maximum: null,
            defaultValue: null,
        };
        const field = previewParameterField(parameter);
        expect(field.type).toEqual({
            kind: "list",
            element: {
                kind: "compound",
                fields: [
                    expect.objectContaining({
                        name: "rune",
                        type: { kind: "namespacedKey" },
                        nullable: false,
                        constraints: expect.objectContaining({
                            allowedValues: [{ kind: "string", value: "runo:fire" }],
                        }),
                    }),
                    expect.objectContaining({
                        name: "rank",
                        nullable: true,
                        constraints: expect.objectContaining({
                            minimum: "1",
                            maximum: "5",
                        }),
                    }),
                ],
            },
        });
        expect(field.constraints.maximumElements).toBe(8);
    });
});
