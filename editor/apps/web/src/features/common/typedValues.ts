import {
    dataValueSchema,
    namespacedIdSchema,
    uuidSchema,
    type DataKeyNode,
    type DataTypeNode,
    type DataValue,
    type ItemNode,
    type ProjectDocument,
} from "@itemerness/protocol";

export type ValueKind = DataValue["kind"];
export type ValueError =
    "invalid" | "integerRange" | "decimalRange" | "uuid" | "namespacedKey";

export function valueKindForType(type: DataTypeNode): ValueKind {
    if (type.kind === "long") return "integer";
    if (type.kind === "uuid" || type.kind === "namespacedKey") return "string";
    return type.kind;
}

export function initialDataValue(
    kind: ValueKind,
    type?: DataTypeNode,
): DataValue {
    switch (kind) {
        case "null":
            return { kind };
        case "boolean":
            return { kind, value: false };
        case "integer":
            return { kind, value: "0" };
        case "decimal":
            return { kind, value: "0" };
        case "string":
            return {
                kind,
                value:
                    type?.kind === "namespacedKey"
                        ? "minecraft:air"
                        : type?.kind === "uuid"
                          ? "00000000-0000-0000-0000-000000000000"
                          : "",
            };
        case "list":
            return { kind, values: [] };
        case "compound":
            return {
                kind,
                entries: Object.fromEntries(
                    type?.kind === "compound"
                        ? (type.fields ?? []).map((field) => [
                              field.name,
                              field.nullable
                                  ? { kind: "null" }
                                  : initialDataValue(
                                        valueKindForType(field.type),
                                        field.type,
                                    ),
                          ])
                        : [],
                ),
            };
    }
}

export function parseScalarValue(
    kind: "string" | "integer" | "decimal",
    raw: string,
    type?: DataTypeNode,
): { value: DataValue; error: null } | { value: null; error: ValueError } {
    const value = { kind, value: raw };
    if (!dataValueSchema.safeParse(value).success)
        return { value: null, error: "invalid" };
    if (kind === "integer") {
        const number = BigInt(raw);
        const minimum =
            type?.kind === "integer" ? -2147483648n : -9223372036854775808n;
        const maximum =
            type?.kind === "integer" ? 2147483647n : 9223372036854775807n;
        if (number < minimum || number > maximum)
            return { value: null, error: "integerRange" };
    }
    if (kind === "decimal" && !Number.isFinite(Number(raw)))
        return { value: null, error: "decimalRange" };
    if (
        kind === "string" &&
        type?.kind === "uuid" &&
        !uuidSchema.safeParse(raw).success
    )
        return { value: null, error: "uuid" };
    if (
        kind === "string" &&
        type?.kind === "namespacedKey" &&
        !namespacedIdSchema.safeParse(raw).success
    )
        return { value: null, error: "namespacedKey" };
    return { value, error: null };
}

export function itemDataKeys(
    document: ProjectDocument,
    item: ItemNode,
): DataKeyNode[] {
    return item.definition.instance.schemas.flatMap(
        (reference) =>
            document.dataSchemas.find(
                (schema) =>
                    schema.id === reference.id &&
                    schema.version === reference.version,
            )?.keys ?? [],
    );
}

export function itemDataKey(
    document: ProjectDocument,
    item: ItemNode,
    key: string,
): DataKeyNode | null {
    const matches = itemDataKeys(document, item).filter(
        (entry) => entry.id === key,
    );
    return matches.length === 1 ? matches[0]! : null;
}

export type SampleSource =
    "preview" | "definition" | "instance" | "schema" | "missing";
export function resolveSampleValue(
    document: ProjectDocument,
    item: ItemNode,
    key: string,
): {
    value: DataValue | null;
    source: SampleSource;
    schema: DataKeyNode | null;
} {
    const schema = itemDataKey(document, item, key);
    const override = item.previewData.find((entry) => entry.key === key);
    if (override) return { value: override.value, source: "preview", schema };
    if (!schema) return { value: null, source: "missing", schema };
    const scope = schema.scope === "DEFINITION" ? "definition" : "instance";
    const assignments =
        scope === "definition"
            ? item.definition.definitionData
            : item.definition.instance.defaults;
    const assignment = assignments.find((entry) => entry.key === key);
    if (assignment) return { value: assignment.value, source: scope, schema };
    if (schema.defaultValue !== null)
        return { value: schema.defaultValue, source: "schema", schema };
    return { value: null, source: "missing", schema };
}
