import {
    formatNodeSchema,
    messageKeySchema,
    type FormatNode,
    type ProjectDocument,
} from "@itemerness/protocol";
import { formatDependsOn } from "../../state/presentationLibrary.js";
import { resolveMessage } from "../common/messages.js";

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
}

function retainedRecord(value: unknown): Record<string, unknown> {
    return value !== undefined &&
        (!value || typeof value !== "object" || Array.isArray(value))
        ? { previousValue: value }
        : record(value);
}

export function formatVariant(
    source: FormatNode,
    kind: FormatNode["kind"],
): FormatNode {
    const saved = record(record(source.extensions?.editorFormatVariants)[kind]);
    const identity = {
        uuid: source.uuid,
        id: source.id,
        extensions: source.extensions,
    };
    const restored = formatNodeSchema.safeParse({
        ...saved,
        ...identity,
        kind,
    });
    if (restored.success) return restored.data;
    switch (kind) {
        case "integer":
            return { ...identity, kind, pattern: "0" };
        case "decimal":
            return {
                ...identity,
                kind,
                pattern: "0.00",
                multiply: 1,
                suffixMessage: null,
            };
        case "boolean":
            return { ...identity, kind, trueMessage: "", falseMessage: "" };
        case "namespacedKey":
            return {
                ...identity,
                kind,
                mode: "PATH",
                messagePattern: null,
                missingValue: "PATH",
            };
        case "list":
            return {
                ...identity,
                kind,
                elementFormat: "",
                separatorMessage: "",
            };
    }
}

export function retainFormatVariant(
    source: FormatNode,
    next: FormatNode,
): FormatNode {
    const settings = Object.fromEntries(
        Object.entries(source).filter(
            ([key]) => !["uuid", "id", "extensions"].includes(key),
        ),
    );
    return {
        ...next,
        extensions: {
            ...source.extensions,
            editorFormatVariants: {
                ...retainedRecord(source.extensions?.editorFormatVariants),
                [source.kind]: settings,
            },
        },
    };
}

export function formatMessageError(
    document: ProjectDocument,
    value: string,
): "messageKey" | "missingMessage" | null {
    if (!messageKeySchema.safeParse(value).success) return "messageKey";
    return resolveMessage(document, document.defaultLocale, value).source ===
        "missing"
        ? "missingMessage"
        : null;
}

export function formatError(
    document: ProjectDocument,
    format: FormatNode,
): string | null {
    if (!formatNodeSchema.safeParse(format).success) return "requiredFields";
    if (
        format.kind === "namespacedKey" &&
        format.mode === "MESSAGE" &&
        format.messagePattern == null
    )
        return "messagePattern";
    if (format.kind === "list") {
        if (
            !document.formats.some((entry) => entry.id === format.elementFormat)
        )
            return "missingFormat";
        if (formatDependsOn(document, format.elementFormat, format.id))
            return "formatCycle";
        return formatMessageError(document, format.separatorMessage);
    }
    if (format.kind === "boolean")
        return (
            formatMessageError(document, format.trueMessage) ??
            formatMessageError(document, format.falseMessage)
        );
    if (format.kind === "decimal" && format.suffixMessage)
        return formatMessageError(document, format.suffixMessage);
    return null;
}
