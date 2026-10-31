import { z } from "zod";
import {
    dataValueSchema,
    EMPTY_DATA_CONSTRAINTS,
    type DataConstraints,
    type DataTypeNode,
    type DataValue,
} from "./common.js";

/**
 * Preview data providers: plugins that compute an item's instance data for a named scenario, so a
 * preview shows the values the plugin would write at runtime. Values only live in one preview.
 */
export type PreviewParameterType =
    | {
          kind:
              | "integer"
              | "long"
              | "decimal"
              | "boolean"
              | "string"
              | "namespaced-key";
      }
    | { kind: "list"; element: PreviewParameterType; maximumSize: number }
    | { kind: "compound"; fields: PreviewParameter[] };

export interface PreviewParameter {
    id: string;
    label: string;
    type: PreviewParameterType;
    optional: boolean;
    choices: string[];
    minimum: number | null;
    maximum: number | null;
    defaultValue: DataValue | null;
}

const identifier = z.string().regex(/^[a-z0-9][a-z0-9._/-]{0,63}$/);
const label = z.string().min(1).max(128);

export const previewParameterTypeSchema: z.ZodType<PreviewParameterType> =
    z.lazy(() =>
        z.discriminatedUnion("kind", [
            z.strictObject({ kind: z.literal("integer") }),
            z.strictObject({ kind: z.literal("long") }),
            z.strictObject({ kind: z.literal("decimal") }),
            z.strictObject({ kind: z.literal("boolean") }),
            z.strictObject({ kind: z.literal("string") }),
            z.strictObject({ kind: z.literal("namespaced-key") }),
            z.strictObject({
                kind: z.literal("list"),
                element: previewParameterTypeSchema,
                maximumSize: z.number().int().min(1).max(256),
            }),
            z.strictObject({
                kind: z.literal("compound"),
                fields: z.array(previewParameterSchema).min(1).max(16),
            }),
        ]),
    );

export const previewParameterSchema: z.ZodType<PreviewParameter> = z.lazy(
    () =>
        z.strictObject({
            id: identifier,
            label,
            type: previewParameterTypeSchema,
            optional: z.boolean(),
            choices: z.array(z.string().min(1).max(128)).max(256),
            minimum: z.number().nullable(),
            maximum: z.number().nullable(),
            defaultValue: dataValueSchema.nullable(),
        }),
);

export const previewScenarioSchema = z.strictObject({
    id: identifier,
    label,
    description: z.string().max(1024).nullable(),
    parameters: z.array(previewParameterSchema).max(32),
});
export type PreviewScenario = z.infer<typeof previewScenarioSchema>;

const providerFailureSchema = z.strictObject({
    code: z.string().max(64),
    detail: z.string().max(512),
});

export const previewProvidersSchema = z.strictObject({
    itemId: z.string().max(256),
    providers: z
        .array(
            z.strictObject({
                plugin: z.string().min(1).max(64),
                status: z.enum(["offered", "failed"]),
                revision: z.string().max(256).nullable(),
                scenarios: z.array(previewScenarioSchema).max(32),
                failure: providerFailureSchema.nullable(),
            }),
        )
        .max(64),
    /** Why no providers were consulted, for example a draft that does not compile. */
    failure: z.string().max(64).nullable(),
});
export type PreviewProviders = z.infer<typeof previewProvidersSchema>;

/** The scenario a preview is computed for. Not part of documents; the revision only keys caches. */
export const previewScenarioChoiceSchema = z.strictObject({
    plugin: z.string().min(1).max(64),
    id: identifier,
    revision: z.string().max(256),
    parameters: z.record(identifier, dataValueSchema),
});
export type PreviewScenarioChoice = z.infer<typeof previewScenarioChoiceSchema>;

/** Which values in a preview came from a provider, and which a manual preview value overrode. */
export const previewDataProvenanceSchema = z.object({
    plugin: z.string().max(64),
    scenario: z.string().max(64),
    revision: z.string().max(256).nullable(),
    status: z.enum(["applied", "failed"]),
    providedKeys: z.array(z.string().max(256)).max(256),
    overriddenKeys: z.array(z.string().max(256)).max(256),
    messages: z.array(z.string().max(512)).max(16),
    /** Every value the provider returned, including overridden ones; older plugins omit it. */
    values: z
        .array(z.strictObject({ key: z.string().max(256), value: dataValueSchema }))
        .max(256)
        .default([]),
    failure: providerFailureSchema.nullable(),
});
export type PreviewDataProvenance = z.infer<typeof previewDataProvenanceSchema>;

/** The data key type and constraints that let the shared typed value editor edit a parameter. */
export function previewParameterField(parameter: PreviewParameter): {
    type: DataTypeNode;
    constraints: DataConstraints;
} {
    const bounds = (target: PreviewParameter): DataConstraints => ({
        ...EMPTY_DATA_CONSTRAINTS,
        minimum: target.minimum === null ? null : String(target.minimum),
        maximum: target.maximum === null ? null : String(target.maximum),
        allowedValues: target.choices.map((value) => ({
            kind: "string" as const,
            value,
        })),
    });
    const type = (target: PreviewParameterType): DataTypeNode => {
        switch (target.kind) {
            case "namespaced-key":
                return { kind: "namespacedKey" };
            case "list":
                return { kind: "list", element: type(target.element) };
            case "compound":
                return {
                    kind: "compound",
                    fields: target.fields.map((field) => ({
                        name: field.id,
                        type: type(field.type),
                        nullable: field.optional,
                        constraints: bounds(field),
                    })),
                };
            default:
                return { kind: target.kind };
        }
    };
    const constraints = bounds(parameter);
    return {
        type: type(parameter.type),
        // On a list parameter, choices and bounds describe its elements, which the editor validates per element.
        constraints:
            parameter.type.kind === "list"
                ? {
                      ...EMPTY_DATA_CONSTRAINTS,
                      maximumElements: parameter.type.maximumSize,
                  }
                : constraints,
    };
}
