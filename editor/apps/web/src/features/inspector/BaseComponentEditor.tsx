import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowDown, ArrowUp, Plus, RotateCcw, Trash2 } from "lucide-react";
import {
    isExtendedBaseComponent,
    supportsExtendedBaseComponents,
    type DataValue,
} from "@itemerness/protocol";
import { useConnectionStore } from "../../state/connection.js";
import { BufferedInput } from "../common/BufferedInput.js";
import { DataValueEditor } from "../common/DataValueEditor.js";
import { SelectField } from "../common/SelectField.js";
import { ColorWell } from "../common/ColorWell.js";
import { EnchantmentComponentEditor } from "./EnchantmentComponentEditor.js";
import { commitInlineEditor } from "../common/inlineEdit.js";
import {
    baseComponentIssue,
    componentFields,
    componentScalarValue,
    initialComponentValue,
    type ComponentField,
} from "./baseComponents.js";
import type { ItemDefinition } from "./itemDefinitionEditing.js";

export function DefinitionAction({
    label,
    testId,
    disabled,
    onClick,
    icon: Icon = Trash2,
}: {
    label: string;
    testId?: string;
    disabled?: boolean;
    onClick(): void;
    icon?: typeof Trash2;
}) {
    return (
        <button
            type="button"
            className="icon-button"
            aria-label={label}
            data-tooltip={label}
            data-testid={testId}
            disabled={disabled}
            onClick={() => {
                if (commitInlineEditor()) onClick();
            }}
        >
            <Icon size={15} />
        </button>
    );
}

function ComponentValue({
    field,
    value,
    label,
    owner,
    onChange,
}: {
    field: ComponentField;
    value: DataValue;
    label: string;
    owner: string;
    onChange(value: DataValue): void;
}) {
    const { t } = useTranslation();
    const expected =
        field.kind === "emptyList"
            ? "list"
            : field.kind === "enchantments"
              ? "compound"
              : field.kind === "key" ||
                  field.kind === "color" ||
                  field.kind === "enum"
                ? "string"
                : field.kind;
    const matches =
        value.kind === expected ||
        (field.kind === "decimal" && value.kind === "integer");
    if (
        !matches ||
        (field.kind === "emptyList" &&
            value.kind === "list" &&
            value.values.length > 0)
    )
        return (
            <div className="definition-invalid-value">
                <p className="error small" role="alert">
                    {t("itemDefinition.errors.componentValue")}
                </p>
                <DataValueEditor
                    value={value}
                    label={label}
                    testId={owner}
                    owner={owner}
                    onChange={onChange}
                />
                <DefinitionAction
                    label={t("itemDefinition.resetValue")}
                    icon={RotateCcw}
                    onClick={() => onChange(initialComponentValue(field))}
                />
            </div>
        );
    if (field.kind === "emptyList")
        return (
            <span className="muted small">
                {t("itemDefinition.explicitlyCleared")}
            </span>
        );
    if (field.kind === "enchantments" && value.kind === "compound")
        return (
            <EnchantmentComponentEditor
                key={owner}
                entries={value.entries}
                owner={owner}
                onChange={(entries) => onChange({ kind: "compound", entries })}
            />
        );
    if (field.kind === "compound" && value.kind === "compound") {
        const set = (name: string, next: DataValue | null) => {
            const entries = { ...value.entries };
            if (next === null) delete entries[name];
            else entries[name] = next;
            onChange({ kind: "compound", entries });
        };
        return (
            <div className="component-fields">
                {Object.entries(field.fields).map(([name, child]) => (
                    <div className="component-field" key={name}>
                        <div className="definition-row-heading">
                            <span>{t(`itemDefinition.fields.${name}`)}</span>
                            {child.optional && value.entries[name] && (
                                <DefinitionAction
                                    label={t("itemDefinition.inherit")}
                                    onClick={() => set(name, null)}
                                />
                            )}
                        </div>
                        {value.entries[name] ? (
                            <ComponentValue
                                field={child}
                                value={value.entries[name]!}
                                label={t(`itemDefinition.fields.${name}`)}
                                owner={`${owner}-${name}`}
                                onChange={(next) => set(name, next)}
                            />
                        ) : (
                            <button
                                type="button"
                                className="definition-add-field"
                                data-testid={`${owner}-${name}-add`}
                                onClick={() => {
                                    if (commitInlineEditor())
                                        set(name, initialComponentValue(child));
                                }}
                            >
                                <Plus size={14} />
                                {t(
                                    child.optional
                                        ? "itemDefinition.addOverride"
                                        : "itemDefinition.addRequired",
                                )}
                            </button>
                        )}
                    </div>
                ))}
                {Object.entries(value.entries)
                    .filter(([name]) => !Object.hasOwn(field.fields, name))
                    .map(([name, child]) => (
                        <div key={name}>
                            <div className="definition-row-heading">
                                <code>{name}</code>
                                <DefinitionAction
                                    label={t("itemDefinition.removeEntry")}
                                    onClick={() => set(name, null)}
                                />
                            </div>
                            <p className="error small">
                                {t("itemDefinition.errors.unknownField")}
                            </p>
                            <DataValueEditor
                                value={child}
                                label={name}
                                owner={`${owner}-${name}`}
                                testId={`${owner}-${name}`}
                                onChange={(next) => set(name, next)}
                            />
                        </div>
                    ))}
            </div>
        );
    }
    if (field.kind === "list" && value.kind === "list")
        return (
            <div className="component-list">
                {value.values.map((entry, index) => (
                    <div className="component-list-entry" key={index}>
                        <ComponentValue
                            field={field.element}
                            value={entry}
                            label={`${label} ${index + 1}`}
                            owner={`${owner}-${index}`}
                            onChange={(next) =>
                                onChange({
                                    kind: "list",
                                    values: value.values.map((old, position) =>
                                        position === index ? next : old,
                                    ),
                                })
                            }
                        />
                        <div className="definition-row-actions">
                            <DefinitionAction
                                label={t("values.moveUp")}
                                icon={ArrowUp}
                                disabled={index === 0}
                                onClick={() => {
                                    const values = [...value.values];
                                    [values[index - 1], values[index]] = [
                                        values[index]!,
                                        values[index - 1]!,
                                    ];
                                    onChange({ kind: "list", values });
                                }}
                            />
                            <DefinitionAction
                                label={t("values.moveDown")}
                                icon={ArrowDown}
                                disabled={index === value.values.length - 1}
                                onClick={() => {
                                    const values = [...value.values];
                                    [values[index], values[index + 1]] = [
                                        values[index + 1]!,
                                        values[index]!,
                                    ];
                                    onChange({ kind: "list", values });
                                }}
                            />
                            <DefinitionAction
                                label={t("itemDefinition.removeEntry")}
                                onClick={() =>
                                    onChange({
                                        kind: "list",
                                        values: value.values.filter(
                                            (_, position) => position !== index,
                                        ),
                                    })
                                }
                            />
                        </div>
                    </div>
                ))}
                <DefinitionAction
                    icon={Plus}
                    label={t("values.addEntry")}
                    testId={`${owner}-add`}
                    disabled={value.values.length >= 64}
                    onClick={() =>
                        onChange({
                            kind: "list",
                            values: [
                                ...value.values,
                                initialComponentValue(field.element),
                            ],
                        })
                    }
                />
            </div>
        );
    if (field.kind === "boolean" && value.kind === "boolean")
        return (
            <label className="toggle-row">
                <input
                    type="checkbox"
                    aria-label={label}
                    data-testid={owner}
                    checked={value.value}
                    onChange={(event) => {
                        if (commitInlineEditor())
                            onChange({
                                kind: "boolean",
                                value: event.target.checked,
                            });
                    }}
                />
                {t(value.value ? "values.true" : "values.false")}
            </label>
        );
    if (field.kind === "enum" && value.kind === "string")
        return (
            <SelectField
                label={label}
                data-testid={owner}
                value={value.value}
                options={field.options.map((option) => ({
                    value: option,
                    label: t(`itemDefinition.options.${option}`),
                }))}
                onValueChange={(next) => {
                    if (commitInlineEditor())
                        onChange({ kind: "string", value: next });
                }}
            />
        );
    if (!(
        (value.kind === "string" ||
            value.kind === "integer" ||
            value.kind === "decimal") &&
        field.kind !== "compound" &&
        field.kind !== "list" &&
        field.kind !== "enchantments" &&
        field.kind !== "boolean"
    ))
        return null;
    return (
        <div className="component-scalar">
            {field.kind === "color" && (
                <ColorWell
                    value={
                        value.value.startsWith("#")
                            ? value.value
                            : `#${value.value}`
                    }
                    label={label}
                    id={`${owner}-swatch`}
                    owner={owner}
                    onValueChange={(next) =>
                        onChange({ kind: "string", value: next })
                    }
                    onClear={() => onChange(initialComponentValue(field))}
                />
            )}
            <BufferedInput
                owner={owner}
                value={value.value}
                label={label}
                testId={owner}
                inputMode={
                    field.kind === "integer"
                        ? "numeric"
                        : field.kind === "decimal"
                          ? "decimal"
                          : "text"
                }
                validate={(raw) =>
                    componentScalarValue(field, raw)
                        ? null
                        : t("itemDefinition.errors.componentValue")
                }
                onCommit={(raw) => {
                    const next = componentScalarValue(field, raw);
                    if (next) onChange(next);
                }}
            />
        </div>
    );
}

export function BaseComponentEditor({
    definition,
    owner,
    update,
}: {
    definition: ItemDefinition;
    owner: string;
    update(edit: (definition: ItemDefinition) => ItemDefinition): void;
}) {
    const { t } = useTranslation();
    const [adding, setAdding] = useState("");
    const extendedSupported = useConnectionStore((state) =>
        supportsExtendedBaseComponents(state.info?.capabilities),
    );
    const available = Object.keys(componentFields).filter(
        (id) => !definition.baseComponents.some((entry) => entry.id === id),
    );
    const number = (id: string) => {
        const value = definition.baseComponents.find(
            (entry) => entry.id === id,
        )?.value;
        return value?.kind === "integer" ? Number(value.value) : null;
    };
    const stack = number("minecraft:max_stack_size"),
        maximum = number("minecraft:max_damage"),
        damage = number("minecraft:damage");
    const conflicts = [
        definition.instance.mode === "UNIQUE" && stack !== null && stack !== 1
            ? "uniqueStack"
            : null,
        stack !== null && stack > 1 && maximum !== null ? "damageStack" : null,
        damage !== null && maximum !== null && damage > maximum
            ? "damageRange"
            : null,
    ].filter((entry): entry is string => entry !== null);
    return (
        <details className="definition-section" data-testid="item-components">
            <summary>{t("itemDefinition.components")}</summary>
            {!extendedSupported && (
                <p className="muted small" role="status">
                    {t("itemDefinition.extendedUnsupported")}
                </p>
            )}
            {conflicts.map((code) => (
                <p className="error small" role="alert" key={code}>
                    {t(`itemDefinition.errors.${code}`)}
                </p>
            ))}
            {definition.baseComponents.map((component, index) => {
                const id = `${owner}-component-${component.id.slice(10)}-${index}`;
                const field = componentFields[component.id];
                const error = baseComponentIssue(component.id, component.value);
                const set = (value: DataValue) =>
                    update((current) => ({
                        ...current,
                        baseComponents: current.baseComponents.map(
                            (entry, position) =>
                                position === index
                                    ? { ...entry, value }
                                    : entry,
                        ),
                    }));
                return (
                    <div
                        className="definition-entry"
                        data-testid={`component-${component.id}`}
                        key={`${component.id}-${index}`}
                    >
                        <div className="definition-row-heading">
                            <strong>
                                {field
                                    ? t(
                                          `itemDefinition.componentsNames.${component.id.slice(10)}`,
                                      )
                                    : component.id}
                            </strong>
                            <DefinitionAction
                                label={t("itemDefinition.inherit")}
                                testId={`${id}-remove`}
                                onClick={() =>
                                    update((current) => ({
                                        ...current,
                                        baseComponents:
                                            current.baseComponents.filter(
                                                (_, position) =>
                                                    position !== index,
                                            ),
                                    }))
                                }
                            />
                        </div>
                        {error && (
                            <p className="error small" role="alert">
                                {t(`itemDefinition.errors.${error}`)}
                            </p>
                        )}
                        {definition.baseComponents.some(
                            (entry, position) =>
                                position !== index && entry.id === component.id,
                        ) && (
                            <p className="error small">
                                {t("itemDefinition.errors.duplicateComponent")}
                            </p>
                        )}
                        {component.id === "minecraft:unbreakable" && !error ? (
                            <span className="muted small">
                                {t("values.true")}
                            </span>
                        ) : field ? (
                            <fieldset
                                className="component-value-fields"
                                disabled={
                                    !extendedSupported &&
                                    isExtendedBaseComponent(component.id)
                                }
                            >
                                <ComponentValue
                                    field={field}
                                    value={component.value}
                                    label={t(
                                        `itemDefinition.componentsNames.${component.id.slice(10)}`,
                                    )}
                                    owner={id}
                                    onChange={set}
                                />
                            </fieldset>
                        ) : (
                            <DataValueEditor
                                label={component.id}
                                value={component.value}
                                testId={id}
                                owner={id}
                                onChange={set}
                            />
                        )}
                        {component.id === "minecraft:unbreakable" && error && (
                            <DefinitionAction
                                label={t("itemDefinition.resetValue")}
                                icon={RotateCcw}
                                onClick={() =>
                                    set({ kind: "boolean", value: true })
                                }
                            />
                        )}
                    </div>
                );
            })}
            <div className="definition-add-row">
                <SelectField
                    label={t("itemDefinition.addComponent")}
                    data-testid="component-add-choice"
                    value={adding}
                    options={[
                        { value: "", label: t("itemDefinition.addComponent") },
                        ...available.map((id) => ({
                            value: id,
                            disabled:
                                !extendedSupported &&
                                isExtendedBaseComponent(id),
                            label: t(
                                `itemDefinition.componentsNames.${id.slice(10)}`,
                            ),
                        })),
                    ]}
                    onValueChange={setAdding}
                />
                <DefinitionAction
                    icon={Plus}
                    label={t("itemDefinition.addComponent")}
                    testId="component-add"
                    disabled={
                        !available.includes(adding) ||
                        (!extendedSupported && isExtendedBaseComponent(adding))
                    }
                    onClick={() => {
                        const field = componentFields[adding];
                        if (
                            !field ||
                            (!extendedSupported &&
                                isExtendedBaseComponent(adding))
                        )
                            return;
                        const value =
                            adding === "minecraft:max_stack_size" &&
                            definition.instance.mode === "UNIQUE"
                                ? { kind: "integer" as const, value: "1" }
                                : initialComponentValue(field);
                        update((current) => ({
                            ...current,
                            baseComponents: [
                                ...current.baseComponents,
                                { id: adding, value },
                            ],
                        }));
                        setAdding("");
                    }}
                />
            </div>
        </details>
    );
}
