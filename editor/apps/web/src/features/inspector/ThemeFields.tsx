import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import { BufferedInput } from "../common/BufferedInput.js";
import { numericThemeError } from "./themeEditing.js";
import { SOURCE_INT_MAX } from "./presentationNumbers.js";

export function ThemeNumber({
    name,
    value,
    minimum = 0,
    maximum = SOURCE_INT_MAX,
    owner,
    onChange,
    testId,
}: {
    name: string;
    value: number;
    minimum?: number;
    maximum?: number;
    owner: string;
    onChange(value: number): void;
    testId?: string;
}) {
    const { t } = useTranslation();
    return (
        <label className="field-inline theme-number-field">
            <span>{t(`themeAuthoring.${name}`)}</span>
            <BufferedInput
                label={t(`themeAuthoring.${name}`)}
                value={String(value)}
                owner={`${owner}:${name}`}
                inputMode="numeric"
                testId={testId ?? `theme-${name}`}
                validate={(raw) =>
                    numericThemeError(raw, minimum, maximum)
                        ? t("themeAuthoring.integerRange", { minimum, maximum })
                        : null
                }
                onCommit={(raw) => onChange(Number(raw))}
            />
        </label>
    );
}

export function ThemeToggle({
    name,
    checked,
    onChange,
    disabled = false,
}: {
    name: string;
    checked: boolean;
    onChange(value: boolean): void;
    disabled?: boolean;
}) {
    const { t } = useTranslation();
    return (
        <label className="toggle-row">
            <input
                type="checkbox"
                checked={checked}
                disabled={disabled}
                data-testid={`theme-${name}`}
                onChange={(event) => onChange(event.target.checked)}
            />
            {t(`themeAuthoring.${name}`)}
        </label>
    );
}

export function AddThemeEntry({
    label,
    owner,
    validate,
    onAdd,
    disabled = false,
    children,
}: {
    label: string;
    owner: string;
    validate(value: string): string | null;
    onAdd(value: string): void;
    disabled?: boolean;
    children?: ReactNode;
}) {
    const [raw, setRaw] = useState("");
    const [error, setError] = useState<string | null>(null);
    const submit = () => {
        const failure = validate(raw);
        setError(failure);
        if (failure || disabled) return;
        onAdd(raw);
        setRaw("");
    };
    return (
        <div className="theme-add-entry">
            <div className="theme-add-row">
                <input
                    aria-label={label}
                    placeholder={label}
                    value={raw}
                    disabled={disabled}
                    data-testid={`theme-add-${owner}-input`}
                    aria-invalid={error !== null}
                    onChange={(event) => {
                        setRaw(event.target.value);
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
                    disabled={disabled}
                    aria-label={label}
                    data-tooltip={label}
                    data-testid={`theme-add-${owner}`}
                    onClick={submit}
                >
                    <Plus size={15} />
                </button>
            </div>
            {children}
            {error && (
                <p role="alert" className="error small">
                    {error}
                </p>
            )}
        </div>
    );
}
