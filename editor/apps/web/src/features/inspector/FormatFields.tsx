import { useTranslation } from "react-i18next";
import type { FormatNode, ProjectDocument } from "@itemerness/protocol";
import { BufferedInput } from "../common/BufferedInput.js";
import { SelectField } from "../common/SelectField.js";
import { collectDocumentMessageKeys } from "../common/messages.js";
import { formatDependsOn } from "../../state/presentationLibrary.js";
import { formatMessageError } from "./formatEditing.js";

export function FormatFields({
    document,
    format,
    onChange,
}: {
    document: ProjectDocument;
    format: FormatNode;
    onChange(value: FormatNode): void;
}) {
    const { t } = useTranslation();
    const text = (
        name: string,
        value: string,
        change: (raw: string) => void,
        validate: (raw: string) => string | null,
        suggestions?: readonly string[],
    ) => (
        <label className="field" key={name}>
            <span>{t(`presentationLibrary.${name}`)}</span>
            <BufferedInput
                value={value}
                label={t(`presentationLibrary.${name}`)}
                owner={`${format.uuid}:${format.kind}:${name}`}
                testId={`format-${name}`}
                onCommit={change}
                validate={validate}
                suggestions={suggestions}
            />
        </label>
    );
    const message = (
        name: string,
        value: string | null,
        change: (raw: string) => void,
        optional = false,
    ) =>
        text(
            name,
            value ?? "",
            change,
            (raw) => {
                if (optional && raw === "") return null;
                const error = formatMessageError(document, raw);
                return error ? t(`presentationLibrary.errors.${error}`) : null;
            },
            collectDocumentMessageKeys(document),
        );
    const select = (
        name: string,
        value: string,
        choices: string[],
        change: (raw: string) => void,
    ) => (
        <label className="field">
            <span>{t(`presentationLibrary.${name}`)}</span>
            <SelectField
                label={t(`presentationLibrary.${name}`)}
                value={value}
                options={choices.map((entry) => ({
                    value: entry,
                    label: t(`presentationLibrary.options.${entry}`),
                }))}
                data-testid={`format-${name}`}
                onValueChange={change}
            />
        </label>
    );
    return (
        <>
            {(format.kind === "integer" || format.kind === "decimal") &&
                text(
                    "pattern",
                    format.pattern,
                    (pattern) => onChange({ ...format, pattern }),
                    () => null,
                )}
            {format.kind === "decimal" && (
                <>
                    {text(
                        "multiply",
                        String(format.multiply),
                        (raw) => onChange({ ...format, multiply: Number(raw) }),
                        (raw) =>
                            raw.trim() !== "" &&
                            /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(
                                raw,
                            ) &&
                            Number.isFinite(Number(raw))
                                ? null
                                : t("presentationLibrary.errors.finiteNumber"),
                    )}
                    {message(
                        "suffixMessage",
                        format.suffixMessage,
                        (raw) =>
                            onChange({ ...format, suffixMessage: raw || null }),
                        true,
                    )}
                </>
            )}
            {format.kind === "boolean" && (
                <>
                    {message("trueMessage", format.trueMessage, (trueMessage) =>
                        onChange({ ...format, trueMessage }),
                    )}
                    {message(
                        "falseMessage",
                        format.falseMessage,
                        (falseMessage) => onChange({ ...format, falseMessage }),
                    )}
                </>
            )}
            {format.kind === "namespacedKey" && (
                <>
                    {select(
                        "keyMode",
                        format.mode,
                        ["PATH", "MESSAGE"],
                        (mode) =>
                            onChange({
                                ...format,
                                mode: mode as typeof format.mode,
                                messagePattern:
                                    mode === "MESSAGE"
                                        ? (format.messagePattern ?? "")
                                        : format.messagePattern,
                            }),
                    )}
                    {text(
                        "messagePattern",
                        format.messagePattern ?? "",
                        (raw) =>
                            onChange({
                                ...format,
                                messagePattern: raw,
                            }),
                        () => null,
                    )}
                    {select(
                        "missingValue",
                        format.missingValue,
                        ["PATH", "FULL_KEY", "ERROR"],
                        (missingValue) =>
                            onChange({
                                ...format,
                                missingValue:
                                    missingValue as typeof format.missingValue,
                            }),
                    )}
                </>
            )}
            {format.kind === "list" && (
                <>
                    <label className="field">
                        <span>{t("presentationLibrary.elementFormat")}</span>
                        <SelectField
                            label={t("presentationLibrary.elementFormat")}
                            value={format.elementFormat}
                            data-testid="format-elementFormat"
                            options={document.formats.map((entry) => ({
                                value: entry.id,
                                label: entry.id,
                                disabled: formatDependsOn(
                                    document,
                                    entry.id,
                                    format.id,
                                ),
                            }))}
                            onValueChange={(elementFormat) =>
                                onChange({ ...format, elementFormat })
                            }
                        />
                    </label>
                    {message(
                        "separatorMessage",
                        format.separatorMessage,
                        (separatorMessage) =>
                            onChange({ ...format, separatorMessage }),
                    )}
                </>
            )}
        </>
    );
}
