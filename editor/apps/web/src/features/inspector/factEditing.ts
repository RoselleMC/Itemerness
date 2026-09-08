import {
    dataValueSchema,
    type DataTypeNode,
    type DataValue,
    type ProjectDocument,
    type ViewerFactNode,
} from "@itemerness/protocol";
import {
    initialDataValue,
    parseScalarValue,
    valueKindForType,
} from "../common/typedValues.js";

export function factDataType(type: ViewerFactNode["type"]): DataTypeNode {
    switch (type) {
        case "LOCALE":
        case "STRING":
            return { kind: "string" };
        case "BOOLEAN":
            return { kind: "boolean" };
        case "INTEGER":
            return { kind: "integer" };
        case "LONG":
            return { kind: "long" };
        case "DECIMAL":
            return { kind: "decimal" };
        case "UUID":
            return { kind: "uuid" };
        case "NAMESPACED_KEY":
            return { kind: "namespacedKey" };
    }
}

export function initialFactValue(
    document: ProjectDocument,
    fact: Pick<ViewerFactNode, "id" | "type">,
): DataValue | null {
    if (fact.type === "LOCALE")
        return document.locales.some(
            (locale) => locale.locale === document.defaultLocale,
        )
            ? { kind: "string", value: document.defaultLocale }
            : null;
    if (fact.id === "itemerness:theme" && fact.type === "NAMESPACED_KEY")
        return document.themes[0]
            ? { kind: "string", value: document.themes[0].id }
            : null;
    if (
        fact.id === "itemerness:asset-profile" &&
        fact.type === "NAMESPACED_KEY"
    )
        return document.assetProfiles[0]
            ? { kind: "string", value: document.assetProfiles[0].id }
            : null;
    const type = factDataType(fact.type);
    return initialDataValue(valueKindForType(type), type);
}

export function factValueError(
    document: ProjectDocument,
    fact: Pick<ViewerFactNode, "id" | "type">,
    value: DataValue,
): string | null {
    const type = factDataType(fact.type);
    if (value.kind !== valueKindForType(type)) return "typeMismatch";
    if (
        value.kind === "integer" ||
        value.kind === "decimal" ||
        value.kind === "string"
    ) {
        const error = parseScalarValue(value.kind, value.value, type).error;
        if (error) return error;
    }
    if (value.kind === "string") {
        if (
            (fact.type === "STRING" || fact.type === "LOCALE") &&
            (value.value.length > 8192 ||
                [...value.value].length >
                    document.budgets.maximumTextCodePoints)
        )
            return "stringLimit";
        if (
            fact.type === "LOCALE" &&
            !document.locales.some((locale) => locale.locale === value.value)
        )
            return "unknownLocale";
        if (
            fact.id === "itemerness:theme" &&
            fact.type === "NAMESPACED_KEY" &&
            !document.themes.some((theme) => theme.id === value.value)
        )
            return "unknownTheme";
        if (
            fact.id === "itemerness:asset-profile" &&
            fact.type === "NAMESPACED_KEY" &&
            !document.assetProfiles.some(
                (profile) => profile.id === value.value,
            )
        )
            return "unknownProfile";
    }
    return null;
}

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
}

export function switchFactType(
    document: ProjectDocument,
    fact: ViewerFactNode,
    type: ViewerFactNode["type"],
): ViewerFactNode {
    if (fact.type === type) return fact;
    const original = fact.extensions?.editorFactTypes;
    const previous =
        original !== undefined &&
        (!original || typeof original !== "object" || Array.isArray(original))
            ? { previousValue: original }
            : record(original);
    const saved = record(previous[type]);
    const next = { ...fact, type };
    const valid = (value: unknown): value is DataValue => {
        const parsed = dataValueSchema.safeParse(value);
        return (
            parsed.success &&
            factValueError(document, next, parsed.data) === null
        );
    };
    const defaultValue = valid(saved.defaultValue)
        ? saved.defaultValue
        : saved.defaultValue === null && fact.nullable
          ? null
          : fact.defaultValue && valid(fact.defaultValue)
            ? fact.defaultValue
            : fact.nullable
              ? null
              : initialFactValue(document, next);
    const previewValue = valid(saved.previewValue)
        ? saved.previewValue
        : fact.previewValue && valid(fact.previewValue)
          ? fact.previewValue
          : null;
    return {
        ...next,
        defaultValue,
        previewValue,
        extensions: {
            ...fact.extensions,
            editorFactTypes: {
                ...previous,
                [fact.type]: {
                    ...record(previous[fact.type]),
                    defaultValue: fact.defaultValue,
                    previewValue: fact.previewValue,
                },
            },
        },
    };
}

export function providerError(
    value: string,
    providers: string[],
    previous?: string,
): "invalidProvider" | "duplicateProvider" | null {
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(value)) return "invalidProvider";
    return value !== previous && providers.includes(value)
        ? "duplicateProvider"
        : null;
}
