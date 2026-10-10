import { useTranslation } from "react-i18next";
import { Plus, Trash2 } from "lucide-react";
import type { DataConstraints, DataTypeNode } from "@itemerness/protocol";
import { BufferedInput } from "./BufferedInput.js";
import { DataValueEditor } from "./DataValueEditor.js";
import { initialDataValue, valueKindForType } from "./typedValues.js";
import { commitInlineEditor } from "./inlineEdit.js";
import {
    applicableConstraints,
    constraintLimits,
    validOptionalConstraint,
} from "../inspector/dataKeyEditing.js";

/** Edits the constraints of one value position: a data key or a compound field. */
export function DataConstraintsEditor({
    constraints,
    type,
    owner,
    testId,
    onChange,
}: {
    constraints: DataConstraints;
    type: DataTypeNode;
    owner: string;
    /** Prefix producing `<testId>-constraint-<name>`, `<testId>-add-allowed` and `<testId>-allowed-<n>`. */
    testId: string;
    onChange(constraints: DataConstraints): void;
}) {
    const { t } = useTranslation();
    const applicable = applicableConstraints(type.kind);
    const constraint = (
        key: "minimum" | "maximum" | keyof typeof constraintLimits,
    ) => {
        const value = constraints[key];
        if (!applicable.has(key) && value === null) return null;
        const maximum =
            key === "minimum" || key === "maximum"
                ? undefined
                : constraintLimits[key];
        return (
            <div className="data-constraint" key={key}>
                <span className="field-label">
                    {t(`dataEditing.constraints.${key}`)}
                </span>
                <BufferedInput
                    value={value === null ? "" : String(value)}
                    owner={`${owner}-${key}`}
                    label={t(`dataEditing.constraints.${key}`)}
                    testId={`${testId}-constraint-${key}`}
                    inputMode="decimal"
                    validate={(raw) =>
                        validOptionalConstraint(raw, maximum)
                            ? null
                            : t(
                                  maximum === undefined
                                      ? "dataEditing.invalidNumber"
                                      : "dataEditing.invalidLimit",
                                  { maximum },
                              )
                    }
                    onCommit={(raw) =>
                        onChange({
                            ...constraints,
                            [key]:
                                raw === ""
                                    ? null
                                    : maximum === undefined
                                      ? raw
                                      : Number(raw),
                        })
                    }
                />
                {!applicable.has(key) && (
                    <span className="error small">
                        {t("dataEditing.incompatibleConstraint")}
                    </span>
                )}
            </div>
        );
    };
    return (
        <>
            <div className="data-constraints">
                {constraint("minimum")}
                {constraint("maximum")}
                {Object.keys(constraintLimits).map((key) =>
                    constraint(key as keyof typeof constraintLimits),
                )}
            </div>
            <div className="data-editor-row">
                <h4>{t("inspector.data.allowed")}</h4>
                <button
                    type="button"
                    className="icon-button"
                    aria-label={t("dataEditing.addAllowed")}
                    data-tooltip={t("dataEditing.addAllowed")}
                    data-testid={`${testId}-add-allowed`}
                    onClick={() => {
                        if (commitInlineEditor())
                            onChange({
                                ...constraints,
                                allowedValues: [
                                    ...constraints.allowedValues,
                                    initialDataValue(
                                        valueKindForType(type),
                                        type,
                                    ),
                                ],
                            });
                    }}
                >
                    <Plus size={16} />
                </button>
            </div>
            {constraints.allowedValues.map((value, index) => (
                <div className="data-allowed-entry" key={index}>
                    <DataValueEditor
                        value={value}
                        type={type}
                        nullable={false}
                        constraints={{ ...constraints, allowedValues: [] }}
                        label={t("values.entry", { index: index + 1 })}
                        owner={`${owner}-allowed-${index}`}
                        testId={`${testId}-allowed-${index}`}
                        onChange={(next) =>
                            onChange({
                                ...constraints,
                                allowedValues: constraints.allowedValues.map(
                                    (old, i) => (i === index ? next : old),
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
                                    ...constraints,
                                    allowedValues:
                                        constraints.allowedValues.filter(
                                            (_, i) => i !== index,
                                        ),
                                });
                        }}
                    >
                        <Trash2 size={15} />
                    </button>
                </div>
            ))}
        </>
    );
}
