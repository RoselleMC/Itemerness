import {
    namespacedIdSchema,
    type DataTypeNode,
    type DataValue,
    type FormatNode,
} from "@itemerness/protocol";
import {
    formatDefaultDecimal,
    formatJavaNumber,
    LocalFormatError,
} from "./decimalFormat.js";

export interface FormatMessages {
    readonly effectiveLocale: string;
    resolve(key: string): string | null;
}

/** Formatting.kt's value and failure semantics, shared by every local content block. */
export class LocalValueFormatter {
    private readonly formats: ReadonlyMap<string, FormatNode>;

    constructor(
        formats: readonly FormatNode[],
        private readonly messages: FormatMessages,
    ) {
        this.formats = new Map(formats.map((format) => [format.id, format]));
        if (this.formats.size !== formats.length)
            throw new LocalFormatError("Formatter identifiers must be unique");
        const visited = new Set<string>();
        const active = new Set<string>();
        const visit = (id: string) => {
            if (active.has(id))
                throw new LocalFormatError(
                    `Formatter recursion detected at ${id}`,
                );
            if (visited.has(id)) return;
            const format = this.formats.get(id);
            if (!format) throw new LocalFormatError(`Unknown formatter ${id}`);
            active.add(id);
            if (format.kind === "list") visit(format.elementFormat);
            active.delete(id);
            visited.add(id);
        };
        formats.forEach((format) => visit(format.id));
    }

    format(
        value: DataValue,
        id: string | null = null,
        type?: DataTypeNode,
    ): string {
        return id === null
            ? this.defaultFormat(value, type)
            : this.apply(value, id, new Set(), type);
    }

    requiredMessage(key: string): string {
        const value = this.messages.resolve(key);
        if (value === null)
            throw new LocalFormatError(`Missing message ${key}`);
        return value;
    }

    private apply(
        value: DataValue,
        id: string,
        active: Set<string>,
        type?: DataTypeNode,
    ): string {
        if (active.has(id))
            throw new LocalFormatError(`Formatter recursion detected at ${id}`);
        const format = this.formats.get(id);
        if (!format) throw new LocalFormatError(`Unknown formatter ${id}`);
        active.add(id);
        try {
            switch (format.kind) {
                case "integer":
                    if (
                        value.kind !== "integer" ||
                        (type &&
                            type.kind !== "integer" &&
                            type.kind !== "long")
                    )
                        throw new LocalFormatError(
                            `Formatter ${id} requires integer data`,
                        );
                    return formatJavaNumber(
                        value.value,
                        "integer",
                        format.pattern,
                        this.messages.effectiveLocale,
                    );
                case "decimal": {
                    if (
                        (value.kind !== "integer" &&
                            value.kind !== "decimal") ||
                        (type &&
                            type.kind !== "integer" &&
                            type.kind !== "long" &&
                            type.kind !== "decimal")
                    )
                        throw new LocalFormatError(
                            `Formatter ${id} requires decimal data`,
                        );
                    const number = formatJavaNumber(
                        value.value,
                        "decimal",
                        format.pattern,
                        this.messages.effectiveLocale,
                        format.multiply,
                    );
                    return (
                        number +
                        (format.suffixMessage === null
                            ? ""
                            : this.requiredMessage(format.suffixMessage))
                    );
                }
                case "boolean":
                    if (value.kind !== "boolean")
                        throw new LocalFormatError(
                            `Formatter ${id} requires boolean data`,
                        );
                    return this.requiredMessage(
                        value.value ? format.trueMessage : format.falseMessage,
                    );
                case "namespacedKey": {
                    if (
                        value.kind !== "string" ||
                        (type && type.kind !== "namespacedKey") ||
                        !namespacedIdSchema.safeParse(value.value).success
                    )
                        throw new LocalFormatError(
                            `Formatter ${id} requires namespaced-key data`,
                        );
                    const [namespace, path] = value.value.split(":") as [
                        string,
                        string,
                    ];
                    if (format.mode === "PATH") return path;
                    if (format.messagePattern === null)
                        throw new LocalFormatError(
                            `Formatter ${id} has no message pattern`,
                        );
                    const key = format.messagePattern
                        .replaceAll("{namespace}", namespace)
                        .replaceAll("{path}", path);
                    const message = this.messages.resolve(key);
                    if (message !== null) return message;
                    if (format.missingValue === "PATH") return path;
                    if (format.missingValue === "FULL_KEY") return value.value;
                    throw new LocalFormatError(`Missing value message ${key}`);
                }
                case "list": {
                    if (value.kind !== "list")
                        throw new LocalFormatError(
                            `Formatter ${id} requires list data`,
                        );
                    const separator = this.requiredMessage(
                        format.separatorMessage,
                    );
                    if (!this.formats.has(format.elementFormat))
                        throw new LocalFormatError(
                            `Unknown formatter ${format.elementFormat}`,
                        );
                    return value.values
                        .map((entry) =>
                            this.apply(
                                entry,
                                format.elementFormat,
                                active,
                                type?.kind === "list"
                                    ? type.element
                                    : undefined,
                            ),
                        )
                        .join(separator);
                }
            }
        } finally {
            active.delete(id);
        }
    }

    private defaultFormat(value: DataValue, type?: DataTypeNode): string {
        switch (value.kind) {
            case "null":
                throw new LocalFormatError(
                    "Null cannot be formatted as an item data value",
                );
            case "boolean":
                return String(value.value);
            case "integer":
                return type?.kind === "decimal"
                    ? formatDefaultDecimal(value.value)
                    : BigInt(value.value).toString();
            case "decimal":
                return formatDefaultDecimal(value.value);
            case "string":
                return type?.kind === "uuid"
                    ? value.value.toLowerCase()
                    : value.value;
            case "list":
                return value.values
                    .map((entry) =>
                        this.defaultFormat(
                            entry,
                            type?.kind === "list" ? type.element : undefined,
                        ),
                    )
                    .join(", ");
            case "compound":
                return Object.keys(value.entries)
                    .sort()
                    .map(
                        (key) =>
                            `${key}=${this.defaultFormat(value.entries[key]!, type?.kind === "compound" ? type.fields?.find((field) => field.name === key)?.type : undefined)}`,
                    )
                    .join(", ");
        }
    }
}
