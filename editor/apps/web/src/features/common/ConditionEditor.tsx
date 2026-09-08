import { useRef } from "react";
import { useTranslation } from "react-i18next";
import {
    conditionOperatorSchema,
    type DataTypeNode,
    type DataValue,
    type ItemNode,
    type PresentationBlock,
    type ProjectDocument,
} from "@itemerness/protocol";
import { SelectField } from "./SelectField.js";
import { DataValueEditor } from "./DataValueEditor.js";
import {
    initialDataValue,
    itemDataKeys,
    resolveSampleValue,
    valueKindForType,
} from "./typedValues.js";
import { commitInlineEditor } from "./inlineEdit.js";

type Condition = Extract<
    PresentationBlock,
    { type: "conditional" }
>["condition"];
type Reference = Condition["left"];

function literalFromValue(value: DataValue): DataValue | null {
    if (value.kind === "null") return null;
    if (value.kind === "list") {
        const values = value.values.map(literalFromValue);
        return values.every((entry): entry is DataValue => entry !== null)
            ? { kind: "list", values }
            : null;
    }
    if (value.kind === "compound")
        return {
            kind: "compound",
            entries: Object.fromEntries(
                Object.entries(value.entries).flatMap(([key, entry]) => {
                    const decoded = literalFromValue(entry);
                    return decoded ? [[key, decoded]] : [];
                }),
            ),
        };
    return value;
}

export function referenceValue(
    document: ProjectDocument,
    item: ItemNode,
    reference: Reference,
): DataValue {
    if (reference.kind === "literal") return reference.value;
    if (reference.kind === "data") {
        const sample = resolveSampleValue(document, item, reference.key);
        return (
            (sample.value && literalFromValue(sample.value)) ??
            (sample.schema
                ? literalFromValue(
                      initialDataValue(
                          valueKindForType(sample.schema.type),
                          sample.schema.type,
                      ),
                  )!
                : initialDataValue("string"))
        );
    }
    const fact = document.viewerFacts.find(
        (entry) => entry.id === reference.key,
    );
    if (!fact) return initialDataValue("string");
    if (fact.previewValue !== null && literalFromValue(fact.previewValue))
        return literalFromValue(fact.previewValue)!;
    if (fact.defaultValue !== null && literalFromValue(fact.defaultValue))
        return literalFromValue(fact.defaultValue)!;
    const kind =
        fact.type === "NAMESPACED_KEY"
            ? "namespacedKey"
            : fact.type === "LOCALE"
              ? "string"
              : fact.type.toLowerCase();
    const type = { kind } as DataTypeNode;
    return initialDataValue(valueKindForType(type), type);
}

export function ConditionEditor({
    document,
    item,
    condition,
    onChange,
    testId,
}: {
    document: ProjectDocument;
    item: ItemNode;
    condition: Condition;
    onChange(condition: Condition): void;
    testId: string;
}) {
    const { t } = useTranslation();
    const literals = useRef<Partial<Record<"left" | "right", DataValue>>>({});
    const previousRight = useRef<Reference | null>(condition.right);
    if (condition.right) previousRight.current = condition.right;
    for (const side of ["left", "right"] as const) {
        const reference = condition[side];
        if (reference?.kind === "literal")
            literals.current[side] = reference.value;
    }
    const references = [
        ...document.viewerFacts.map((fact) => ({
            value: `fact:${fact.id}`,
            label: fact.id,
            group: t("inspector.content.factGroup"),
        })),
        ...itemDataKeys(document, item)
            .filter((key) => key.presentationReadable)
            .map((key) => ({
                value: `data:${key.id}`,
                label: key.id,
                group: t("inspector.content.dataGroup"),
            })),
        { value: "literal", label: t("inspector.content.literal") },
    ];
    const operand = (side: "left" | "right") => {
        const reference = condition[side];
        const disabled = side === "right" && condition.operator === "EXISTS";
        const label = t(
            side === "left" ? "menus.leftOperand" : "menus.rightOperand",
        );
        return (
            <div
                className="condition-operand"
                role="group"
                aria-label={label}
                data-testid={`${testId}-${side}`}
            >
                <label>{label}</label>
                <SelectField
                    label={label}
                    disabled={disabled}
                    data-testid={`${testId}-${side}-reference`}
                    value={
                        reference
                            ? reference.kind === "literal"
                                ? "literal"
                                : `${reference.kind}:${reference.key}`
                            : ""
                    }
                    options={[
                        {
                            value: "",
                            label: t("inspector.none"),
                            disabled: true,
                        },
                        ...references,
                    ]}
                    onValueChange={(encoded) => {
                        if (disabled || !commitInlineEditor()) return;
                        let next: Reference;
                        if (encoded === "literal")
                            next = {
                                kind: "literal",
                                value:
                                    literals.current[side] ??
                                    referenceValue(
                                        document,
                                        item,
                                        reference ?? condition.left,
                                    ),
                            };
                        else {
                            const boundary = encoded.indexOf(":");
                            const kind = encoded.slice(0, boundary);
                            if (kind !== "fact" && kind !== "data") return;
                            next = { kind, key: encoded.slice(boundary + 1) };
                        }
                        onChange({ ...condition, [side]: next });
                    }}
                />
                {!disabled && reference?.kind === "literal" && (
                    <DataValueEditor
                        allowNull={false}
                        value={reference.value}
                        label={t("values.literalValue")}
                        testId={`${testId}-${side}-literal`}
                        onChange={(value) =>
                            onChange({
                                ...condition,
                                [side]: { kind: "literal", value },
                            })
                        }
                    />
                )}
            </div>
        );
    };
    return (
        <div className="condition-editor">
            {operand("left")}
            <SelectField
                label={t("menus.comparison")}
                value={condition.operator}
                data-testid={`${testId}-operator`}
                options={conditionOperatorSchema.options.map((operator) => ({
                    value: operator,
                    label: t(`values.operators.${operator}`),
                }))}
                onValueChange={(value) => {
                    if (!commitInlineEditor()) return;
                    const operator = conditionOperatorSchema.parse(value);
                    onChange({
                        ...condition,
                        operator,
                        right:
                            operator === "EXISTS"
                                ? null
                                : (condition.right ??
                                  previousRight.current ?? {
                                      kind: "literal",
                                      value: referenceValue(
                                          document,
                                          item,
                                          condition.left,
                                      ),
                                  }),
                    });
                }}
            />
            {operand("right")}
        </div>
    );
}
