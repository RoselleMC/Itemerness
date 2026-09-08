import { useState } from "react";
import { Plus, RotateCcw, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { DataValue } from "@itemerness/protocol";
import { BufferedInput } from "../common/BufferedInput.js";
import { DataValueEditor } from "../common/DataValueEditor.js";
import { commitInlineEditor } from "../common/inlineEdit.js";
import {
    componentScalarValue,
    enchantmentKeyIssue,
    enchantmentLevelField,
    renameEnchantment,
} from "./baseComponents.js";

export function EnchantmentComponentEditor({
    entries,
    owner,
    onChange,
}: {
    entries: Record<string, DataValue>;
    owner: string;
    onChange(entries: Record<string, DataValue>): void;
}) {
    const { t } = useTranslation();
    const [pending, setPending] = useState("");
    const error = enchantmentKeyIssue(entries, pending);
    const full = Object.keys(entries).length >= 64;
    const add = () => {
        if (error || full || !commitInlineEditor()) return;
        onChange({ ...entries, [pending]: { kind: "integer", value: "1" } });
        setPending("");
    };
    return (
        <div className="component-fields">
            {Object.entries(entries).map(([name, value], index) => (
                <div className="component-field" key={name}>
                    <div className="definition-row-heading">
                        <span>{t("itemDefinition.enchantment")}</span>
                        <button
                            type="button"
                            className="icon-button"
                            aria-label={t("itemDefinition.removeEntry")}
                            data-tooltip={t("itemDefinition.removeEntry")}
                            data-testid={`${owner}-${index}-remove`}
                            onClick={() => {
                                if (!commitInlineEditor()) return;
                                const next = { ...entries };
                                delete next[name];
                                onChange(next);
                            }}
                        >
                            <Trash2 size={15} />
                        </button>
                    </div>
                    <BufferedInput
                        value={name}
                        label={t("itemDefinition.enchantment")}
                        owner={`${owner}:${name}`}
                        testId={`${owner}-${index}-key`}
                        validate={(raw) => {
                            const issue = enchantmentKeyIssue(
                                entries,
                                raw,
                                name,
                            );
                            return issue
                                ? t(`itemDefinition.errors.${issue}`)
                                : null;
                        }}
                        onCommit={(raw) => {
                            const next = renameEnchantment(entries, name, raw);
                            if (next) onChange(next);
                        }}
                    />
                    <div className="definition-field">
                        <div className="definition-row-heading">
                            <span>{t("itemDefinition.enchantmentLevel")}</span>
                            {value.kind !== "integer" && (
                                <button
                                    type="button"
                                    className="icon-button"
                                    aria-label={t("itemDefinition.resetValue")}
                                    data-tooltip={t(
                                        "itemDefinition.resetValue",
                                    )}
                                    data-testid={`${owner}-${index}-repair`}
                                    onClick={() => {
                                        if (commitInlineEditor())
                                            onChange({
                                                ...entries,
                                                [name]: {
                                                    kind: "integer",
                                                    value: "1",
                                                },
                                            });
                                    }}
                                >
                                    <RotateCcw size={15} />
                                </button>
                            )}
                        </div>
                        {value.kind === "integer" ? (
                            <BufferedInput
                                value={value.value}
                                label={t("itemDefinition.enchantmentLevel")}
                                owner={`${owner}:${name}:level`}
                                testId={`${owner}-${index}-level`}
                                inputMode="numeric"
                                validate={(raw) =>
                                    componentScalarValue(
                                        enchantmentLevelField,
                                        raw,
                                    )
                                        ? null
                                        : t(
                                              "itemDefinition.errors.enchantmentLevel",
                                          )
                                }
                                onCommit={(raw) => {
                                    const next = componentScalarValue(
                                        enchantmentLevelField,
                                        raw,
                                    );
                                    if (next)
                                        onChange({ ...entries, [name]: next });
                                }}
                            />
                        ) : (
                            <DataValueEditor
                                value={value}
                                label={t("itemDefinition.enchantmentLevel")}
                                testId={`${owner}-${index}-level`}
                                owner={`${owner}:${name}:level`}
                                type={{ kind: "integer" }}
                                allowNull={false}
                                validateValue={(next) =>
                                    next.kind === "integer" &&
                                    componentScalarValue(
                                        enchantmentLevelField,
                                        next.value,
                                    )
                                        ? null
                                        : t(
                                              "itemDefinition.errors.enchantmentLevel",
                                          )
                                }
                                onChange={(next) =>
                                    onChange({ ...entries, [name]: next })
                                }
                            />
                        )}
                    </div>
                </div>
            ))}
            {!Object.keys(entries).length && (
                <span className="muted small">
                    {t("itemDefinition.explicitlyCleared")}
                </span>
            )}
            <div className="definition-add-row">
                <input
                    type="text"
                    aria-label={t("itemDefinition.newEnchantment")}
                    data-testid={`${owner}-new-key`}
                    value={pending}
                    onChange={(event) => setPending(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.key === "Enter") {
                            event.preventDefault();
                            add();
                        }
                        if (event.key === "Escape") {
                            event.preventDefault();
                            event.stopPropagation();
                            setPending("");
                        }
                    }}
                />
                <button
                    type="button"
                    className="icon-button"
                    aria-label={t("itemDefinition.addEnchantment")}
                    data-tooltip={t("itemDefinition.addEnchantment")}
                    data-testid={`${owner}-add`}
                    disabled={!!error || full}
                    onClick={add}
                >
                    <Plus size={15} />
                </button>
            </div>
            {pending && error && (
                <span className="error small" role="alert">
                    {t(`itemDefinition.errors.${error}`)}
                </span>
            )}
            {full && (
                <span className="muted small">
                    {t("itemDefinition.enchantmentLimit")}
                </span>
            )}
        </div>
    );
}
