import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Trash2 } from "lucide-react";
import { BufferedInput } from "../common/BufferedInput.js";
import { SelectField } from "../common/SelectField.js";
import { layoutNumberError } from "./layoutEditing.js";
import type { LayoutEditError } from "./layoutEditing.js";
import type { Wrapping } from "@itemerness/protocol";
import { SOURCE_INT_MAX } from "./presentationNumbers.js";

export function LayoutNumber({
    name,
    value,
    minimum = 0,
    maximum = SOURCE_INT_MAX,
    step = 1,
    owner,
    onChange,
    testId,
}: {
    name: string;
    value: number;
    minimum?: number;
    maximum?: number;
    step?: number;
    owner: string;
    onChange(value: number): void;
    testId?: string;
}) {
    const { t } = useTranslation();
    return (
        <label className="field-inline layout-number-field">
            <span>{t(`layoutAuthoring.${name}`)}</span>
            <BufferedInput
                label={t(`layoutAuthoring.${name}`)}
                value={String(value)}
                owner={`${owner}:${name}`}
                inputMode="numeric"
                testId={testId ?? `layout-${name}`}
                validate={(raw) => {
                    const error = layoutNumberError(
                        raw,
                        minimum,
                        maximum,
                        step,
                    );
                    return error
                        ? t(`layoutAuthoring.${error}`, {
                              minimum,
                              maximum,
                              step,
                          })
                        : null;
                }}
                onCommit={(raw) => onChange(Number(raw))}
            />
        </label>
    );
}

export function LayoutOverflow({
    value,
    onChange,
    testId,
}: {
    value: Wrapping["overflow"];
    onChange(value: Wrapping["overflow"]): void;
    testId: string;
}) {
    const { t } = useTranslation();
    return (
        <label className="field-inline">
            <span>{t("inspector.layout.overflow")}</span>
            <SelectField
                label={t("inspector.layout.overflow")}
                value={value}
                data-testid={testId}
                onValueChange={(next) => onChange(next as Wrapping["overflow"])}
                options={(["ELLIPSIS", "ALLOW_OVERFLOW", "ERROR"] as const).map(
                    (policy) => ({
                        value: policy,
                        label: t(`inspector.overflow.${policy}`),
                    }),
                )}
            />
        </label>
    );
}

export function LayoutEntryHeader({
    name,
    owner,
    references,
    validate,
    onRename,
    onDelete,
}: {
    name: string;
    owner: string;
    references: number;
    validate(name: string): LayoutEditError | null;
    onRename(name: string): void;
    onDelete(): void;
}) {
    const { t } = useTranslation();
    const removeLabel = references
        ? t("layoutAuthoring.referenced", { count: references })
        : t("menus.delete");
    return (
        <div className="layout-entry-heading">
            <BufferedInput
                label={t("layoutAuthoring.entryName")}
                value={name}
                owner={owner}
                testId={`${owner}-name`}
                validate={(raw) => {
                    const error = validate(raw);
                    return error ? t(`layoutAuthoring.${error}`) : null;
                }}
                onCommit={onRename}
            />
            <button
                type="button"
                className="icon-button"
                aria-label={removeLabel}
                data-tooltip={removeLabel}
                data-testid={`${owner}-delete`}
                disabled={references > 0}
                onClick={onDelete}
            >
                <Trash2 size={15} />
            </button>
        </div>
    );
}

export function AddLayoutEntry({
    kind,
    validate,
    onAdd,
}: {
    kind: "wrapping" | "anchor";
    validate(name: string): LayoutEditError | null;
    onAdd(name: string): void;
}) {
    const { t } = useTranslation();
    const [name, setName] = useState("");
    const [error, setError] = useState<LayoutEditError | null>(null);
    const submit = () => {
        const failure = validate(name);
        setError(failure);
        if (!failure) {
            onAdd(name);
            setName("");
        }
    };
    const label = t(
        `layoutAuthoring.add${kind === "wrapping" ? "Wrapping" : "Anchor"}`,
    );
    return (
        <div className="layout-add-entry">
            <div className="layout-add-row">
                <input
                    aria-label={label}
                    placeholder={label}
                    value={name}
                    aria-invalid={error !== null}
                    data-testid={`layout-add-${kind}-input`}
                    onChange={(event) => {
                        setName(event.target.value);
                        setError(null);
                    }}
                    onKeyDown={(event) => {
                        if (event.key === "Enter") {
                            event.preventDefault();
                            event.stopPropagation();
                            submit();
                        }
                    }}
                />
                <button
                    type="button"
                    className="icon-button"
                    aria-label={label}
                    data-tooltip={label}
                    data-testid={`layout-add-${kind}`}
                    onClick={submit}
                >
                    <Plus size={15} />
                </button>
            </div>
            {error && (
                <p role="alert" className="error small">
                    {t(`layoutAuthoring.${error}`)}
                </p>
            )}
        </div>
    );
}
