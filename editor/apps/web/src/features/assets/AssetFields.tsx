import { useTranslation } from "react-i18next";
import { BufferedInput } from "../common/BufferedInput.js";
import { SelectField, type SelectChoice } from "../common/SelectField.js";

export function AssetText({
    name,
    value,
    owner,
    onChange,
    validate,
    suggestions,
    testId,
}: {
    name: string;
    value: string;
    owner: string;
    onChange(value: string): void;
    validate?(value: string): string | null;
    suggestions?: readonly string[];
    testId?: string;
}) {
    const { t } = useTranslation();
    return (
        <label className="asset-field">
            <span>{t(`assetAuthoring.${name}`)}</span>
            <BufferedInput
                label={t(`assetAuthoring.${name}`)}
                value={value}
                owner={`${owner}:${name}`}
                testId={testId ?? `asset-${name}`}
                suggestions={suggestions}
                validate={(raw) => {
                    const error = validate?.(raw);
                    return error ? t(`assetAuthoring.errors.${error}`) : null;
                }}
                onCommit={onChange}
            />
        </label>
    );
}

export function AssetNumber({
    name,
    value,
    owner,
    onChange,
    minimum = -4096,
    maximum = 4096,
    integer = false,
    optional = false,
    testId,
}: {
    name: string;
    value: number | null;
    owner: string;
    onChange(value: number | null): void;
    minimum?: number;
    maximum?: number;
    integer?: boolean;
    optional?: boolean;
    testId?: string;
}) {
    const { t } = useTranslation();
    return (
        <label className="asset-field">
            <span>{t(`assetAuthoring.${name}`)}</span>
            <BufferedInput
                label={t(`assetAuthoring.${name}`)}
                value={value === null ? "" : String(value)}
                owner={`${owner}:${name}`}
                testId={testId ?? `asset-${name}`}
                inputMode={integer ? "numeric" : "decimal"}
                validate={(raw) => {
                    if (optional && raw === "") return null;
                    if (
                        !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(
                            raw,
                        )
                    )
                        return t("assetAuthoring.errors.numberRange", {
                            minimum,
                            maximum,
                        });
                    const value = Number(raw);
                    return Number.isFinite(value) &&
                        (!integer || Number.isInteger(value)) &&
                        value >= minimum &&
                        value <= maximum
                        ? null
                        : t(
                              `assetAuthoring.errors.${integer ? "integerRange" : "numberRange"}`,
                              { minimum, maximum },
                          );
                }}
                onCommit={(raw) => onChange(raw === "" ? null : Number(raw))}
            />
        </label>
    );
}

export function AssetSelect({
    name,
    value,
    options,
    onChange,
    disabled = false,
    testId,
}: {
    name: string;
    value: string;
    options: readonly SelectChoice[];
    onChange(value: string): void;
    disabled?: boolean;
    testId?: string;
}) {
    const { t } = useTranslation();
    return (
        <label className="asset-field">
            <span>{t(`assetAuthoring.${name}`)}</span>
            <SelectField
                label={t(`assetAuthoring.${name}`)}
                value={value}
                options={options}
                onValueChange={onChange}
                disabled={disabled}
                data-testid={testId ?? `asset-${name}`}
            />
        </label>
    );
}

export function AssetToggle({
    name,
    checked,
    onChange,
}: {
    name: string;
    checked: boolean;
    onChange(value: boolean): void;
}) {
    const { t } = useTranslation();
    return (
        <label className="toggle-row">
            <input
                type="checkbox"
                checked={checked}
                data-testid={`asset-${name}`}
                onChange={(event) => onChange(event.target.checked)}
            />
            {t(`assetAuthoring.${name}`)}
        </label>
    );
}

export function AssetBounds({
    bounds,
    owner,
    maximumWidth,
    maximumHeight,
    onChange,
    absolute = true,
}: {
    bounds: { left: number; right: number; top: number; bottom: number };
    owner: string;
    maximumWidth: number;
    maximumHeight: number;
    onChange(value: Partial<typeof bounds>): void;
    absolute?: boolean;
}) {
    const { t } = useTranslation();
    return (
        <section>
            <h3>{t("assetAuthoring.visualBounds")}</h3>
            <div className="asset-field-grid">
                {(["left", "right", "top", "bottom"] as const).map((name) => (
                    <AssetNumber
                        key={name}
                        name={name}
                        owner={`${owner}:bounds`}
                        value={bounds[name]}
                        minimum={
                            name === "left"
                                ? absolute
                                    ? -maximumWidth
                                    : -Number.MAX_VALUE
                                : name === "top"
                                  ? absolute
                                      ? -maximumHeight
                                      : -Number.MAX_VALUE
                                  : name === "right"
                                    ? bounds.left
                                    : bounds.top
                        }
                        maximum={
                            name === "left"
                                ? bounds.right
                                : name === "top"
                                  ? bounds.bottom
                                  : absolute
                                    ? name === "right"
                                        ? maximumWidth
                                        : maximumHeight
                                    : Number.MAX_VALUE
                        }
                        onChange={(value) => onChange({ [name]: value! })}
                    />
                ))}
            </div>
        </section>
    );
}

export function codePointError(value: string): string | null {
    if (!/^(?:U\+[0-9a-f]{1,6}|\d{1,7})$/i.test(value)) return "codePoint";
    const number = /^U\+/i.test(value)
        ? Number.parseInt(value.slice(2), 16)
        : Number(value);
    return number >= 0 &&
        number <= 0x10ffff &&
        !(number >= 0xd800 && number <= 0xdfff)
        ? null
        : "codePoint";
}
export function parseCodePoint(value: string): number {
    return /^U\+/i.test(value)
        ? Number.parseInt(value.slice(2), 16)
        : Number(value);
}
