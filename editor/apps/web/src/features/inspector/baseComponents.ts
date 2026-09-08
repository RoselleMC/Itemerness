import { namespacedIdSchema, type DataValue } from "@itemerness/protocol";
import { parseScalarValue } from "../common/typedValues.js";

export type ComponentField =
    | {
          kind: "integer" | "decimal";
          initial: string;
          minimum: number;
          maximum: number;
      }
    | { kind: "string" | "key" | "color"; initial: string }
    | { kind: "enum"; initial: string; options: readonly string[] }
    | { kind: "boolean"; initial: boolean }
    | { kind: "list"; element: ComponentField }
    | { kind: "emptyList" }
    | { kind: "enchantments" }
    | {
          kind: "compound";
          fields: Record<string, ComponentField & { optional?: boolean }>;
      };

const integer = (
    initial: string,
    minimum: number,
    maximum = 2147483647,
): ComponentField => ({ kind: "integer", initial, minimum, maximum });
const decimal = (
    initial: string,
    minimum = -3.4028234663852886e38,
): ComponentField => ({
    kind: "decimal",
    initial,
    minimum,
    maximum: 3.4028234663852886e38,
});
const bool = (initial: boolean): ComponentField => ({
    kind: "boolean",
    initial,
});
const key = (initial: string): ComponentField => ({ kind: "key", initial });

export const componentFields: Record<string, ComponentField> = {
    "minecraft:max_stack_size": integer("64", 1, 99),
    "minecraft:max_damage": integer("1", 1),
    "minecraft:damage": integer("0", 0),
    "minecraft:repair_cost": integer("0", 0),
    "minecraft:attribute_modifiers": { kind: "emptyList" },
    "minecraft:enchantments": { kind: "enchantments" },
    "minecraft:stored_enchantments": { kind: "enchantments" },
    "minecraft:unbreakable": bool(true),
    "minecraft:enchantment_glint_override": bool(true),
    "minecraft:item_model": key("minecraft:paper"),
    "minecraft:rarity": {
        kind: "enum",
        initial: "common",
        options: ["common", "uncommon", "rare", "epic"],
    },
    "minecraft:custom_model_data": {
        kind: "compound",
        fields: {
            floats: { kind: "list", element: decimal("0"), optional: true },
            flags: { kind: "list", element: bool(false), optional: true },
            strings: {
                kind: "list",
                element: { kind: "string", initial: "" },
                optional: true,
            },
            colors: {
                kind: "list",
                element: { kind: "color", initial: "#ffffff" },
                optional: true,
            },
        },
    },
    "minecraft:food": {
        kind: "compound",
        fields: {
            nutrition: integer("0", 0),
            saturation: decimal("0", 0),
            "can-always-eat": bool(false),
        },
    },
    "minecraft:use_cooldown": {
        kind: "compound",
        fields: {
            seconds: decimal("1", 1.401298464324817e-45),
            "cooldown-group": { ...key("minecraft:default"), optional: true },
        },
    },
    "minecraft:consumable": {
        kind: "compound",
        fields: {
            "consume-seconds": decimal("1.6", 0),
            animation: {
                kind: "enum",
                initial: "eat",
                options: [
                    "none",
                    "eat",
                    "drink",
                    "block",
                    "bow",
                    "trident",
                    "crossbow",
                    "spyglass",
                    "toot-horn",
                    "brush",
                    "bundle",
                    "spear",
                ],
            },
            sound: key("minecraft:entity.generic.eat"),
            "has-consume-particles": bool(true),
        },
    },
};

export function initialComponentValue(field: ComponentField): DataValue {
    if (field.kind === "list" || field.kind === "emptyList")
        return { kind: "list", values: [] };
    if (field.kind === "enchantments") return { kind: "compound", entries: {} };
    if (field.kind === "compound")
        return {
            kind: "compound",
            entries: Object.fromEntries(
                Object.entries(field.fields)
                    .filter(([, child]) => !child.optional)
                    .map(([name, child]) => [
                        name,
                        initialComponentValue(child),
                    ]),
            ),
        };
    if (field.kind === "boolean")
        return { kind: "boolean", value: field.initial };
    return {
        kind:
            field.kind === "integer" || field.kind === "decimal"
                ? field.kind
                : "string",
        value: field.initial,
    };
}

export function componentScalarValue(
    field: ComponentField,
    raw: string,
): DataValue | null {
    if (field.kind === "integer" || field.kind === "decimal") {
        const result = parseScalarValue(field.kind, raw, { kind: field.kind });
        return result.value &&
            Number(raw) >= field.minimum &&
            Number(raw) <= field.maximum
            ? result.value
            : null;
    }
    if (field.kind === "key")
        return namespacedIdSchema.safeParse(raw).success
            ? { kind: "string", value: raw }
            : null;
    if (field.kind === "color")
        return /^#?[a-fA-F0-9]{6}$/.test(raw)
            ? { kind: "string", value: raw }
            : null;
    if (field.kind === "string")
        return Array.from(raw).length <= 256 &&
            !/[\u0000-\u001f\u007f-\u009f]/u.test(raw)
            ? { kind: "string", value: raw }
            : null;
    if (field.kind === "enum")
        return field.options.includes(raw.toLowerCase().replaceAll("_", "-"))
            ? { kind: "string", value: raw }
            : null;
    return null;
}

export function componentValueIssues(
    field: ComponentField,
    value: DataValue,
    path = "",
): string[] {
    if (field.kind === "emptyList")
        return value.kind === "list" && value.values.length === 0 ? [] : [path];
    if (field.kind === "enchantments") {
        if (value.kind !== "compound") return [path];
        return [
            ...(Object.keys(value.entries).length > 64 ? [path] : []),
            ...Object.entries(value.entries).flatMap(([name, level]) =>
                namespacedIdSchema.safeParse(name).success &&
                level.kind === "integer" &&
                componentScalarValue(enchantmentLevelField, level.value)
                    ? []
                    : [`${path}.${name}`],
            ),
        ];
    }
    if (field.kind === "compound") {
        if (value.kind !== "compound") return [path];
        return [
            ...Object.keys(value.entries)
                .filter((name) => !Object.hasOwn(field.fields, name))
                .map((name) => `${path}.${name}`),
            ...Object.entries(field.fields).flatMap(([name, child]) => {
                const current = value.entries[name];
                return current
                    ? componentValueIssues(child, current, `${path}.${name}`)
                    : child.optional
                      ? []
                      : [`${path}.${name}`];
            }),
        ];
    }
    if (field.kind === "list") {
        if (value.kind !== "list") return [path];
        return [
            ...(value.values.length > 64 ? [path] : []),
            ...value.values.flatMap((child, index) =>
                componentValueIssues(field.element, child, `${path}[${index}]`),
            ),
        ];
    }
    if (field.kind === "boolean") return value.kind === "boolean" ? [] : [path];
    // Floating components accept integer YAML scalars as well as decimal scalars.
    if (field.kind === "decimal" && value.kind === "integer")
        return componentScalarValue(field, value.value) ? [] : [path];
    const expected =
        field.kind === "integer" || field.kind === "decimal"
            ? field.kind
            : "string";
    return value.kind === expected &&
        "value" in value &&
        typeof value.value === "string" &&
        componentScalarValue(field, value.value)
        ? []
        : [path];
}

export const enchantmentLevelField = integer("1", 1, 255);

export function enchantmentKeyIssue(
    entries: Record<string, DataValue>,
    name: string,
    previous?: string,
): string | null {
    if (!namespacedIdSchema.safeParse(name).success) return "enchantmentKey";
    return name !== previous && Object.hasOwn(entries, name)
        ? "enchantmentDuplicate"
        : null;
}

export function renameEnchantment(
    entries: Record<string, DataValue>,
    previous: string,
    name: string,
): Record<string, DataValue> | null {
    if (
        !Object.hasOwn(entries, previous) ||
        enchantmentKeyIssue(entries, name, previous)
    )
        return null;
    return Object.fromEntries(
        Object.entries(entries).map(([key, value]) => [
            key === previous ? name : key,
            value,
        ]),
    );
}

export function baseComponentIssue(
    id: string,
    value: DataValue,
): string | null {
    const field = componentFields[id];
    if (!field) return "unsupportedComponent";
    if (id === "minecraft:unbreakable")
        return (value.kind === "boolean" && value.value) ||
            (value.kind === "compound" &&
                Object.keys(value.entries).length === 0)
            ? null
            : "unbreakable";
    return componentValueIssues(field, value, id).length
        ? "componentValue"
        : null;
}
