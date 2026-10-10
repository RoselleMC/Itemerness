import type {
    DataConstraints,
    DataTypeNode,
    DataValue,
} from "@itemerness/protocol";

export const HARD_CONTAINER_ELEMENTS = 256;
export const HARD_STRING_CODEPOINTS = 8192;

export type ConstraintViolation =
    | { code: "minimum"; limit: string }
    | { code: "maximum"; limit: string }
    | { code: "scale"; limit: number }
    | { code: "maximumCodePoints"; limit: number }
    | { code: "maximumElements"; limit: number }
    | { code: "maximumEntries"; limit: number }
    | { code: "maximumDepth"; limit: number }
    | { code: "allowedValues" };

/**
 * Local mirror of the server's `DataValueValidator` constraint checks for one value position.
 * Nested positions validate themselves with constraints taken from their compound field, so an
 * existing violation elsewhere never blocks editing this value. The production compiler remains
 * authoritative; these results only provide immediate feedback.
 */
export function constraintViolation(
    constraints: DataConstraints | undefined,
    value: DataValue,
    type?: DataTypeNode,
): ConstraintViolation | null {
    if (!constraints || value.kind === "null") return null;
    if (value.kind === "integer" || value.kind === "decimal") {
        if (
            constraints.minimum !== null &&
            compareNumbers(value, constraints.minimum) < 0
        )
            return { code: "minimum", limit: constraints.minimum };
        if (
            constraints.maximum !== null &&
            compareNumbers(value, constraints.maximum) > 0
        )
            return { code: "maximum", limit: constraints.maximum };
    }
    if (
        value.kind === "decimal" &&
        constraints.scale !== null &&
        decimalScale(value.value) > constraints.scale
    )
        return { code: "scale", limit: constraints.scale };
    if (
        value.kind === "string" &&
        constraints.maximumCodePoints !== null &&
        [...value.value].length > constraints.maximumCodePoints
    )
        return {
            code: "maximumCodePoints",
            limit: constraints.maximumCodePoints,
        };
    if (
        value.kind === "list" &&
        value.values.length > elementLimit(constraints)
    )
        return { code: "maximumElements", limit: elementLimit(constraints) };
    if (
        value.kind === "compound" &&
        Object.keys(value.entries).length > entryLimit(constraints)
    )
        return { code: "maximumEntries", limit: entryLimit(constraints) };
    if (
        (value.kind === "list" || value.kind === "compound") &&
        constraints.maximumDepth !== null &&
        containerDepth(value) > constraints.maximumDepth
    )
        return { code: "maximumDepth", limit: constraints.maximumDepth };
    if (
        constraints.allowedValues.length > 0 &&
        !constraints.allowedValues.some((allowed) =>
            sameDataValue(allowed, value, type),
        )
    )
        return { code: "allowedValues" };
    return null;
}

export function elementLimit(constraints: DataConstraints | undefined): number {
    return Math.min(
        HARD_CONTAINER_ELEMENTS,
        constraints?.maximumElements ?? HARD_CONTAINER_ELEMENTS,
    );
}

export function entryLimit(constraints: DataConstraints | undefined): number {
    return Math.min(
        HARD_CONTAINER_ELEMENTS,
        constraints?.maximumEntries ?? HARD_CONTAINER_ELEMENTS,
    );
}

/** Scalars whose allowed values can be offered as a closed choice. */
export function selectableAllowedValues(
    constraints: DataConstraints | undefined,
): DataValue[] {
    const values = constraints?.allowedValues ?? [];
    return values.every(
        (value) =>
            value.kind === "string" ||
            value.kind === "integer" ||
            value.kind === "decimal" ||
            value.kind === "boolean",
    )
        ? values
        : [];
}

export function scalarText(value: DataValue): string {
    switch (value.kind) {
        case "string":
        case "integer":
        case "decimal":
            return value.value;
        case "boolean":
            return String(value.value);
        default:
            return "";
    }
}

/** Matches the server's typed equality: numbers by value, the rest structurally. */
export function sameDataValue(
    left: DataValue,
    right: DataValue,
    type?: DataTypeNode,
): boolean {
    if (
        (left.kind === "integer" || left.kind === "decimal") &&
        (right.kind === "integer" || right.kind === "decimal")
    )
        return compareNumbers(left, right.value) === 0;
    if (left.kind !== right.kind) return false;
    switch (left.kind) {
        case "null":
            return true;
        case "boolean":
        case "string":
            return left.value === (right as typeof left).value;
        case "list": {
            const values = (right as typeof left).values;
            const element = type?.kind === "list" ? type.element : undefined;
            return (
                left.values.length === values.length &&
                left.values.every((entry, index) =>
                    sameDataValue(entry, values[index]!, element),
                )
            );
        }
        case "compound": {
            const entries = (right as typeof left).entries;
            const keys = Object.keys(left.entries);
            return (
                keys.length === Object.keys(entries).length &&
                keys.every(
                    (key) =>
                        Object.hasOwn(entries, key) &&
                        sameDataValue(
                            left.entries[key]!,
                            entries[key]!,
                            type?.kind === "compound"
                                ? type.fields?.find(
                                      (field) => field.name === key,
                                  )?.type
                                : undefined,
                        ),
                )
            );
        }
        default:
            return false;
    }
}

function compareNumbers(
    value: Extract<DataValue, { kind: "integer" | "decimal" }>,
    limit: string,
): number {
    if (value.kind === "integer" && /^-?\d+$/.test(limit)) {
        const left = BigInt(value.value);
        const right = BigInt(limit);
        return left < right ? -1 : left > right ? 1 : 0;
    }
    // Decimal data is stored as a double on the server, so compare at that precision.
    const left = Number(value.value);
    const right = Number(limit);
    return left < right ? -1 : left > right ? 1 : 0;
}

/** Scale of the stored double, as `BigDecimal.valueOf(double).stripTrailingZeros()` reports it. */
function decimalScale(raw: string): number {
    const match = /^-?\d+(?:\.(\d+))?(?:e([-+]?\d+))?$/i.exec(
        String(Number(raw)),
    );
    if (!match) return 0;
    const fraction = (match[1] ?? "").replace(/0+$/, "");
    return Math.max(0, fraction.length - Number(match[2] ?? 0));
}

function containerDepth(value: DataValue): number {
    if (value.kind === "list")
        return 1 + Math.max(0, ...value.values.map(containerDepth));
    if (value.kind === "compound")
        return (
            1 + Math.max(0, ...Object.values(value.entries).map(containerDepth))
        );
    return 0;
}
