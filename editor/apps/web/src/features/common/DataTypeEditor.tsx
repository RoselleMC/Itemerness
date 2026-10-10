import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Trash2 } from "lucide-react";
import {
    EMPTY_DATA_CONSTRAINTS,
    isEmptyDataConstraints,
    type CompoundFieldNode,
    type DataConstraints,
    type DataTypeNode,
} from "@itemerness/protocol";
import { DataConstraintsEditor } from "./DataConstraintsEditor.js";
import { SelectField } from "./SelectField.js";
import { BufferedInput } from "./BufferedInput.js";
import { commitInlineEditor } from "./inlineEdit.js";
import {
    initialDataType,
    validCompoundFieldName,
} from "../inspector/dataKeyEditing.js";

const kinds: DataTypeNode["kind"][] = [
    "boolean",
    "integer",
    "long",
    "decimal",
    "string",
    "uuid",
    "namespacedKey",
    "list",
    "compound",
];

export function DataTypeEditor({
    type,
    onChange,
    label,
    testId,
    depth = 0,
    fieldConstraints = false,
}: {
    type: DataTypeNode;
    onChange(type: DataTypeNode): void;
    label: string;
    testId: string;
    depth?: number;
    /** Offers per-field constraints; existing ones stay visible either way. */
    fieldConstraints?: boolean;
}) {
    const { t } = useTranslation();
    const remembered = useRef(new Map<DataTypeNode["kind"], DataTypeNode>());
    remembered.current.set(type.kind, type);
    const closedFields = useRef<
        Extract<DataTypeNode, { kind: "compound" }>["fields"]
    >([]);
    if (type.kind === "compound" && type.fields)
        closedFields.current = type.fields;
    return (
        <fieldset className="data-type-editor" data-testid={testId}>
            <legend>{label}</legend>
            <SelectField
                label={label}
                value={type.kind}
                data-testid={`${testId}-kind`}
                options={kinds.map((kind) => ({
                    value: kind,
                    label: t(`values.types.${kind}`),
                    disabled:
                        depth >= 16 && (kind === "list" || kind === "compound"),
                }))}
                onValueChange={(kind) => {
                    if (!commitInlineEditor()) return;
                    const next = kind as DataTypeNode["kind"];
                    onChange(
                        remembered.current.get(next) ?? initialDataType(next),
                    );
                }}
            />
            {type.kind === "list" && (
                <DataTypeEditor
                    type={type.element}
                    label={t("dataEditing.elementType")}
                    testId={`${testId}-element`}
                    depth={depth + 1}
                    fieldConstraints={fieldConstraints}
                    onChange={(element) => onChange({ ...type, element })}
                />
            )}
            {type.kind === "compound" && (
                <>
                    <label className="toggle-row">
                        <input
                            type="checkbox"
                            checked={type.fields === null}
                            onChange={(event) => {
                                if (commitInlineEditor())
                                    onChange({
                                        ...type,
                                        fields: event.target.checked
                                            ? null
                                            : (closedFields.current ?? []),
                                    });
                            }}
                        />
                        {t("dataEditing.openCompound")}
                    </label>
                    {type.fields?.map((field, index) => (
                        <div className="data-type-field" key={index}>
                            <div className="data-editor-row">
                                <BufferedInput
                                    value={field.name}
                                    owner={`${testId}-${index}`}
                                    label={t("values.fieldName")}
                                    testId={`${testId}-field-${index}-name`}
                                    validate={(name) =>
                                        !validCompoundFieldName(name)
                                            ? t("dataEditing.invalidFieldName")
                                            : type.fields!.some(
                                                    (other, i) =>
                                                        i !== index &&
                                                        other.name === name,
                                                )
                                              ? t("values.duplicateField")
                                              : null
                                    }
                                    onCommit={(name) =>
                                        onChange({
                                            ...type,
                                            fields: type.fields!.map(
                                                (other, i) =>
                                                    i === index
                                                        ? { ...other, name }
                                                        : other,
                                            ),
                                        })
                                    }
                                />
                                <button
                                    type="button"
                                    className="icon-button"
                                    aria-label={t("values.remove")}
                                    data-tooltip={t("values.remove")}
                                    onClick={() => {
                                        if (commitInlineEditor())
                                            onChange({
                                                ...type,
                                                fields: type.fields!.filter(
                                                    (_, i) => i !== index,
                                                ),
                                            });
                                    }}
                                >
                                    <Trash2 size={15} />
                                </button>
                            </div>
                            <label className="toggle-row">
                                <input
                                    type="checkbox"
                                    checked={field.nullable}
                                    onChange={(event) =>
                                        onChange({
                                            ...type,
                                            fields: type.fields!.map(
                                                (other, i) =>
                                                    i === index
                                                        ? {
                                                              ...other,
                                                              nullable:
                                                                  event.target
                                                                      .checked,
                                                          }
                                                        : other,
                                            ),
                                        })
                                    }
                                />
                                {t("dataEditing.nullable")}
                            </label>
                            <DataTypeEditor
                                type={field.type}
                                label={t("dataEditing.type")}
                                testId={`${testId}-field-${index}`}
                                depth={depth + 1}
                                fieldConstraints={fieldConstraints}
                                onChange={(value) =>
                                    onChange({
                                        ...type,
                                        fields: type.fields!.map((other, i) =>
                                            i === index
                                                ? { ...other, type: value }
                                                : other,
                                        ),
                                    })
                                }
                            />
                            {(fieldConstraints ||
                                field.constraints !== undefined) && (
                                <details
                                    className="data-field-constraints"
                                    open={field.constraints !== undefined}
                                >
                                    <summary>
                                        {t("dataEditing.fieldConstraints")}
                                    </summary>
                                    <DataConstraintsEditor
                                        constraints={
                                            field.constraints ??
                                            EMPTY_DATA_CONSTRAINTS
                                        }
                                        type={field.type}
                                        owner={`${testId}-${index}`}
                                        testId={`${testId}-field-${index}`}
                                        onChange={(constraints) =>
                                            onChange({
                                                ...type,
                                                fields: type.fields!.map(
                                                    (other, i) =>
                                                        i === index
                                                            ? withConstraints(
                                                                  other,
                                                                  constraints,
                                                              )
                                                            : other,
                                                ),
                                            })
                                        }
                                    />
                                </details>
                            )}
                        </div>
                    ))}
                    {type.fields !== null && (
                        <button
                            type="button"
                            className="icon-button"
                            aria-label={t("values.addField")}
                            data-tooltip={t("values.addField")}
                            disabled={depth >= 16}
                            onClick={() => {
                                if (!commitInlineEditor()) return;
                                let number = 1;
                                while (
                                    type.fields!.some(
                                        (field) =>
                                            field.name === `field${number}`,
                                    )
                                )
                                    number++;
                                onChange({
                                    ...type,
                                    fields: [
                                        ...type.fields!,
                                        {
                                            name: `field${number}`,
                                            nullable: false,
                                            type: { kind: "string" },
                                        },
                                    ],
                                });
                            }}
                        >
                            <Plus size={16} />
                        </button>
                    )}
                </>
            )}
        </fieldset>
    );
}

/** Empty constraints are omitted so documents stay readable by plugins without the capability. */
function withConstraints(
    field: CompoundFieldNode,
    constraints: DataConstraints,
): CompoundFieldNode {
    const { constraints: _previous, ...rest } = field;
    return isEmptyDataConstraints(constraints)
        ? rest
        : { ...rest, constraints };
}
