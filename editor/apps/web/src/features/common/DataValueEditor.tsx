import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import type { DataTypeNode, DataValue } from "@itemerness/protocol";
import { SelectField } from "./SelectField.js";
import {
    initialDataValue,
    parseScalarValue,
    valueKindForType,
    type ValueKind,
} from "./typedValues.js";
import { commitInlineEditor } from "./inlineEdit.js";
import { BufferedInput } from "./BufferedInput.js";
import { validCompoundFieldName } from "../inspector/dataKeyEditing.js";

export function DataValueEditor({
    value,
    onChange: commitChange,
    label,
    type,
    nullable = true,
    testId,
    depth = 0,
    owner = testId,
    allowNull = true,
    validateValue,
}: {
    value: DataValue;
    onChange(value: DataValue): void;
    label: string;
    type?: DataTypeNode;
    nullable?: boolean;
    testId: string;
    depth?: number;
    owner?: string;
    allowNull?: boolean;
    validateValue?(value: DataValue): string | null;
}) {
    const { t } = useTranslation();
    const [constraintError, setConstraintError] = useState<string | null>(null);
    useEffect(() => setConstraintError(null), [owner, value]);
    const onChange = (next: DataValue) => {
        const failure = validateValue?.(next) ?? null;
        setConstraintError(failure);
        if (!failure) commitChange(next);
    };
    const remembered = useRef(new Map<ValueKind, DataValue>());
    const memoryOwner = useRef(owner);
    if (memoryOwner.current !== owner) {
        remembered.current.clear();
        memoryOwner.current = owner;
    }
    remembered.current.set(value.kind, value);
    const [fieldName, setFieldName] = useState("");
    useEffect(() => setFieldName(""), [owner]);
    const kinds: ValueKind[] = (
        type
            ? [valueKindForType(type), ...(nullable ? ["null" as const] : [])]
            : ([
                  "string",
                  "integer",
                  "decimal",
                  "boolean",
                  "null",
                  "list",
                  "compound",
              ] as ValueKind[])
    ).filter((kind) => kind !== "null" || (nullable && allowNull));
    const showTypeSelector = kinds.length !== 1 || kinds[0] !== value.kind;
    const canNest = !type || depth < 16;
    const compoundType = type?.kind === "compound" ? type : undefined;
    const fields = compoundType?.fields;
    const unusedFields = fields?.filter(
        (field) =>
            value.kind === "compound" &&
            !Object.hasOwn(value.entries, field.name),
    );
    const duplicate =
        value.kind === "compound" && Object.hasOwn(value.entries, fieldName);
    const validFieldName = validCompoundFieldName(fieldName);
    const addField = () => {
        if (
            value.kind !== "compound" ||
            !validFieldName ||
            duplicate ||
            !commitInlineEditor()
        )
            return;
        const field = fields?.find((entry) => entry.name === fieldName);
        if (fields && !field) return;
        onChange({
            kind: "compound",
            entries: {
                ...value.entries,
                [fieldName]: field
                    ? initialDataValue(
                          field.nullable
                              ? "null"
                              : valueKindForType(field.type),
                          field.type,
                      )
                    : initialDataValue("string"),
            },
        });
        setFieldName("");
    };
    const action = (
        command: string,
        Icon: typeof Plus,
        disabled: boolean,
        run: () => void,
    ) => (
        <button
            type="button"
            className="icon-button"
            aria-label={t(`values.${command}`)}
            data-tooltip={t(`values.${command}`)}
            disabled={disabled}
            onClick={() => {
                if (commitInlineEditor()) run();
            }}
        >
            <Icon size={15} />
        </button>
    );
    return (
        <fieldset className="typed-value" data-testid={testId}>
            <legend>{label}</legend>
            {constraintError && (
                <p className="error small" role="alert">
                    {constraintError}
                </p>
            )}
            {showTypeSelector && (
                <div className="typed-value-toolbar">
                    <SelectField
                        label={`${label}: ${t("values.type")}`}
                        value={value.kind}
                        options={kinds.map((kind) => ({
                            value: kind,
                            label: t(
                                `values.types.${type && kind === valueKindForType(type) ? type.kind : kind}`,
                            ),
                            disabled:
                                !canNest &&
                                (kind === "list" || kind === "compound"),
                        }))}
                        data-testid={`${testId}-type`}
                        onValueChange={(kind) => {
                            if (
                                !kinds.includes(kind as ValueKind) ||
                                !commitInlineEditor()
                            )
                                return;
                            const next = kind as ValueKind;
                            onChange(
                                remembered.current.get(next) ??
                                    initialDataValue(next, type),
                            );
                        }}
                    />
                </div>
            )}
            {(value.kind === "string" ||
                value.kind === "integer" ||
                value.kind === "decimal") && (
                <BufferedInput
                    key={value.kind}
                    multiline={value.kind === "string"}
                    owner={`${owner}:${value.kind}`}
                    value={value.value}
                    label={label}
                    testId={`${testId}-input`}
                    inputMode={
                        value.kind === "integer"
                            ? "numeric"
                            : value.kind === "decimal"
                              ? "decimal"
                              : "text"
                    }
                    validate={(raw) => {
                        const result = parseScalarValue(value.kind, raw, type);
                        return result.error
                            ? t(`values.errors.${result.error}`)
                            : (validateValue?.(result.value) ?? null);
                    }}
                    onCommit={(raw) => {
                        const result = parseScalarValue(value.kind, raw, type);
                        if (result.value) onChange(result.value);
                    }}
                />
            )}
            {value.kind === "boolean" && (
                <label className="typed-boolean">
                    <input
                        type="checkbox"
                        checked={value.value}
                        aria-label={label}
                        data-testid={`${testId}-input`}
                        onChange={(event) =>
                            onChange({
                                kind: "boolean",
                                value: event.target.checked,
                            })
                        }
                    />
                    {t(value.value ? "values.true" : "values.false")}
                </label>
            )}
            {value.kind === "null" && (
                <span
                    className={
                        nullable && allowNull ? "muted small" : "error small"
                    }
                >
                    {t(
                        nullable && allowNull
                            ? "values.types.null"
                            : "values.errors.nullNotAllowed",
                    )}
                </span>
            )}
            {value.kind === "list" && (
                <>
                    {value.values.map((entry, index) => (
                        <div className="typed-value-entry" key={index}>
                            <DataValueEditor
                                owner={`${owner}:${index}`}
                                allowNull={allowNull}
                                value={entry}
                                type={
                                    type?.kind === "list"
                                        ? type.element
                                        : undefined
                                }
                                nullable={false}
                                label={t("values.entry", { index: index + 1 })}
                                testId={`${testId}-${index}`}
                                depth={depth + 1}
                                onChange={(next) =>
                                    onChange({
                                        kind: "list",
                                        values: value.values.map(
                                            (old, position) =>
                                                position === index ? next : old,
                                        ),
                                    })
                                }
                            />
                            <div className="typed-value-actions">
                                {action("moveUp", ArrowUp, index === 0, () => {
                                    const values = [...value.values];
                                    [values[index - 1], values[index]] = [
                                        values[index]!,
                                        values[index - 1]!,
                                    ];
                                    onChange({ kind: "list", values });
                                })}
                                {action(
                                    "moveDown",
                                    ArrowDown,
                                    index === value.values.length - 1,
                                    () => {
                                        const values = [...value.values];
                                        [values[index + 1], values[index]] = [
                                            values[index]!,
                                            values[index + 1]!,
                                        ];
                                        onChange({ kind: "list", values });
                                    },
                                )}
                                {action("remove", Trash2, false, () =>
                                    onChange({
                                        kind: "list",
                                        values: value.values.filter(
                                            (_, position) => position !== index,
                                        ),
                                    }),
                                )}
                            </div>
                        </div>
                    ))}
                    {action(
                        "addEntry",
                        Plus,
                        !canNest ||
                            (type?.kind === "list" &&
                                value.values.length >= 256),
                        () =>
                            onChange({
                                kind: "list",
                                values: [
                                    ...value.values,
                                    initialDataValue(
                                        type?.kind === "list"
                                            ? valueKindForType(type.element)
                                            : "string",
                                        type?.kind === "list"
                                            ? type.element
                                            : undefined,
                                    ),
                                ],
                            }),
                    )}
                </>
            )}
            {value.kind === "compound" && (
                <>
                    {Object.entries(value.entries).map(([name, entry]) => {
                        const field = fields?.find(
                            (candidate) => candidate.name === name,
                        );
                        return (
                            <div className="typed-value-entry" key={name}>
                                <DataValueEditor
                                    owner={`${owner}:${name}`}
                                    allowNull={allowNull}
                                    value={entry}
                                    type={field?.type}
                                    nullable={field?.nullable ?? true}
                                    label={name}
                                    testId={`${testId}-${name}`}
                                    depth={depth + 1}
                                    onChange={(next) =>
                                        onChange({
                                            kind: "compound",
                                            entries: {
                                                ...value.entries,
                                                [name]: next,
                                            },
                                        })
                                    }
                                />
                                {action("remove", Trash2, false, () => {
                                    const entries = { ...value.entries };
                                    delete entries[name];
                                    onChange({ kind: "compound", entries });
                                })}
                            </div>
                        );
                    })}
                    <div className="typed-value-toolbar">
                        {fields ? (
                            <SelectField
                                label={t("values.fieldName")}
                                value={fieldName}
                                onValueChange={setFieldName}
                                options={[
                                    {
                                        value: "",
                                        label: t("values.fieldName"),
                                        disabled: true,
                                    },
                                    ...(unusedFields ?? []).map((field) => ({
                                        value: field.name,
                                        label: field.name,
                                    })),
                                ]}
                            />
                        ) : (
                            <input
                                aria-label={t("values.fieldName")}
                                value={fieldName}
                                aria-invalid={
                                    duplicate ||
                                    (fieldName !== "" && !validFieldName)
                                        ? true
                                        : undefined
                                }
                                onChange={(event) =>
                                    setFieldName(event.target.value)
                                }
                                onKeyDown={(event) => {
                                    if (event.key === "Enter") {
                                        event.preventDefault();
                                        addField();
                                    }
                                }}
                            />
                        )}
                        {action(
                            "addField",
                            Plus,
                            !canNest || !validFieldName || duplicate,
                            addField,
                        )}
                    </div>
                    {duplicate && (
                        <span className="error small" role="alert">
                            {t("values.duplicateField")}
                        </span>
                    )}
                    {fieldName !== "" && !validFieldName && (
                        <span className="error small" role="alert">
                            {t("dataEditing.invalidFieldName")}
                        </span>
                    )}
                </>
            )}
        </fieldset>
    );
}
