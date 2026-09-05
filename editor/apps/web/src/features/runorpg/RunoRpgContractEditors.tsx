import { useTranslation } from "react-i18next";
import type {
    RunoRpgAttributeDefinition,
    RunoRpgAttributeModifier,
    RunoRpgItemSkill,
} from "@itemerness/protocol";

const SOURCE_TYPES = [
    "runorpg:item",
    "runorpg:item-affix",
    "runorpg:socket",
    "runorpg:set",
    "runorpg:profession",
    "runorpg:class",
    "runorpg:core-attribute",
    "runorpg:temporary",
] as const;

const SKILL_TRIGGERS = [
    "runorpg:left-click",
    "runorpg:right-click",
    "runorpg:shift-left-click",
    "runorpg:shift-right-click",
    "runorpg:swap-items",
    "runorpg:sneak",
    "runorpg:timer",
    "runorpg:consume",
    "runorpg:right-charge-release",
    "runorpg:shield-block",
    "runorpg:critical-strike",
    "runorpg:crossbow-shoot",
] as const;

function pathPart(value: string): string {
    return value.split(":", 2)[1] ?? value;
}

function replaceAt<T>(values: readonly T[], index: number, value: T): T[] {
    return values.map((entry, at) => (at === index ? value : entry));
}

function moveAt<T>(values: readonly T[], index: number, offset: number): T[] {
    const target = index + offset;
    if (target < 0 || target >= values.length) return [...values];
    const result = [...values];
    const [entry] = result.splice(index, 1);
    result.splice(target, 0, entry!);
    return result;
}

function defaultModifier(
    attributes: readonly RunoRpgAttributeDefinition[],
    modifiers: readonly RunoRpgAttributeModifier[],
    itemId: string,
): RunoRpgAttributeModifier | null {
    const used = new Set(modifiers.map((entry) => entry.attribute));
    const definition =
        attributes.find((entry) => !used.has(entry.id)) ?? attributes[0];
    if (!definition) return null;
    const finalValue =
        definition.id === "runocraft:attack_damage" ||
        definition.id === "runocraft:attack_speed";
    return {
        attribute: definition.id,
        operation: "runorpg:flat",
        value: 0,
        valueMode: finalValue ? "runorpg:final" : "runorpg:bonus",
        sourceType: "runorpg:item",
        sourceId: itemId,
        priority: 100,
    };
}

function nextSkill(skills: readonly RunoRpgItemSkill[]): RunoRpgItemSkill {
    const ids = new Set(skills.map((entry) => entry.id));
    let suffix = skills.length + 1;
    while (ids.has(`runocraft:new-skill-${suffix}`)) suffix += 1;
    const id = `runocraft:new-skill-${suffix}`;
    return {
        id,
        mythicSkill: "RUNORPG_NEW_SKILL",
        trigger: "runorpg:right-click",
        cooldownGroup: id,
        cooldownSeconds: 0,
        manaCost: 0,
        staminaCost: 0,
        power: 1,
        cancelVanilla: true,
        hidden: false,
        lore: "",
    };
}

interface ModifierEditorProps {
    readonly attributes: readonly RunoRpgAttributeDefinition[];
    readonly itemId: string;
    readonly modifiers: readonly RunoRpgAttributeModifier[];
    readonly onChange: (modifiers: RunoRpgAttributeModifier[]) => void;
}

export function RunoRpgModifierEditor({
    attributes,
    itemId,
    modifiers,
    onChange,
}: ModifierEditorProps) {
    const { t } = useTranslation();
    const update = (
        index: number,
        mutate: (
            modifier: RunoRpgAttributeModifier,
        ) => RunoRpgAttributeModifier,
    ) => onChange(replaceAt(modifiers, index, mutate(modifiers[index]!)));

    return (
        <div
            className="runorpg-contract-editor"
            data-testid="runorpg-attribute-editor"
        >
            <div className="runorpg-contract-head">
                <div>
                    <strong>{t("runorpg.attributes")}</strong>
                    <p className="muted small">
                        {t("runorpg.registeredAttributesHint", {
                            count: attributes.length,
                        })}
                    </p>
                </div>
                <button
                    type="button"
                    disabled={
                        attributes.length === 0 || modifiers.length >= 128
                    }
                    onClick={() => {
                        const modifier = defaultModifier(
                            attributes,
                            modifiers,
                            itemId,
                        );
                        if (modifier) onChange([...modifiers, modifier]);
                    }}
                    data-testid="runorpg-add-attribute"
                >
                    + {t("runorpg.addAttribute")}
                </button>
            </div>

            <ol className="runorpg-contract-list">
                {modifiers.map((entry, index) => {
                    const canUseFinal =
                        entry.operation === "runorpg:flat" &&
                        entry.sourceType === "runorpg:item";
                    return (
                        <li
                            key={`modifier-${index}`}
                            data-testid={`runorpg-modifier-row-${index}`}
                        >
                            <div className="contract-order-controls">
                                <button
                                    type="button"
                                    disabled={index === 0}
                                    title={t("inspector.content.moveUp")}
                                    aria-label={t("inspector.content.moveUp")}
                                    onClick={() =>
                                        onChange(moveAt(modifiers, index, -1))
                                    }
                                >
                                    &uarr;
                                </button>
                                <button
                                    type="button"
                                    disabled={index === modifiers.length - 1}
                                    title={t("inspector.content.moveDown")}
                                    aria-label={t("inspector.content.moveDown")}
                                    onClick={() =>
                                        onChange(moveAt(modifiers, index, 1))
                                    }
                                >
                                    &darr;
                                </button>
                            </div>

                            <div className="contract-fields modifier-contract-fields">
                                <label className="contract-field-wide">
                                    {t("runorpg.attribute")}
                                    <select
                                        value={entry.attribute}
                                        onChange={(event) =>
                                            update(index, (current) => ({
                                                ...current,
                                                attribute: event.target.value,
                                            }))
                                        }
                                        data-testid={`runorpg-attribute-${index}`}
                                    >
                                        {attributes.map((attribute) => (
                                            <option
                                                key={attribute.id}
                                                value={attribute.id}
                                            >
                                                {attribute.name} ({attribute.id}
                                                )
                                            </option>
                                        ))}
                                    </select>
                                </label>
                                <label>
                                    {t("runorpg.operationLabel")}
                                    <select
                                        value={entry.operation}
                                        onChange={(event) =>
                                            update(index, (current) => {
                                                const operation = event.target
                                                    .value as RunoRpgAttributeModifier["operation"];
                                                return {
                                                    ...current,
                                                    operation,
                                                    valueMode:
                                                        operation ===
                                                        "runorpg:relative"
                                                            ? "runorpg:bonus"
                                                            : current.valueMode,
                                                };
                                            })
                                        }
                                        data-testid={`runorpg-operation-${index}`}
                                    >
                                        <option value="runorpg:flat">
                                            {t("runorpg.operation.flat")}
                                        </option>
                                        <option value="runorpg:relative">
                                            {t("runorpg.operation.relative")}
                                        </option>
                                    </select>
                                </label>
                                <label>
                                    {t("runorpg.value")}
                                    <input
                                        type="number"
                                        step="any"
                                        value={entry.value}
                                        onChange={(event) => {
                                            const value = Number(
                                                event.target.value,
                                            );
                                            if (Number.isFinite(value)) {
                                                update(index, (current) => ({
                                                    ...current,
                                                    value,
                                                }));
                                            }
                                        }}
                                        data-testid={`runorpg-value-${index}`}
                                    />
                                </label>
                                <label>
                                    {t("runorpg.valueMode")}
                                    <select
                                        value={entry.valueMode}
                                        onChange={(event) =>
                                            update(index, (current) => ({
                                                ...current,
                                                valueMode: event.target
                                                    .value as RunoRpgAttributeModifier["valueMode"],
                                            }))
                                        }
                                        data-testid={`runorpg-value-mode-${index}`}
                                    >
                                        <option value="runorpg:bonus">
                                            {t("runorpg.valueModeValue.bonus")}
                                        </option>
                                        <option
                                            value="runorpg:final"
                                            disabled={!canUseFinal}
                                        >
                                            {t("runorpg.valueModeValue.final")}
                                        </option>
                                    </select>
                                </label>
                                <label>
                                    {t("runorpg.sourceType")}
                                    <select
                                        value={entry.sourceType}
                                        onChange={(event) =>
                                            update(index, (current) => {
                                                const sourceType = event.target
                                                    .value as RunoRpgAttributeModifier["sourceType"];
                                                return {
                                                    ...current,
                                                    sourceType,
                                                    valueMode:
                                                        sourceType !==
                                                            "runorpg:item" &&
                                                        current.valueMode ===
                                                            "runorpg:final"
                                                            ? "runorpg:bonus"
                                                            : current.valueMode,
                                                };
                                            })
                                        }
                                    >
                                        {SOURCE_TYPES.map((sourceType) => (
                                            <option
                                                key={sourceType}
                                                value={sourceType}
                                            >
                                                {t(
                                                    `runorpg.source.${pathPart(sourceType)}`,
                                                )}
                                            </option>
                                        ))}
                                    </select>
                                </label>
                                <label>
                                    {t("runorpg.sourceId")}
                                    <input
                                        value={entry.sourceId ?? ""}
                                        placeholder={itemId}
                                        maxLength={256}
                                        onChange={(event) =>
                                            update(index, (current) => ({
                                                ...current,
                                                sourceId:
                                                    event.target.value.trim() ||
                                                    null,
                                            }))
                                        }
                                    />
                                </label>
                                <label>
                                    {t("runorpg.priority")}
                                    <input
                                        type="number"
                                        min={-1_000_000}
                                        max={1_000_000}
                                        value={entry.priority}
                                        onChange={(event) => {
                                            const priority = Number.parseInt(
                                                event.target.value,
                                                10,
                                            );
                                            if (Number.isInteger(priority)) {
                                                update(index, (current) => ({
                                                    ...current,
                                                    priority,
                                                }));
                                            }
                                        }}
                                    />
                                </label>
                            </div>

                            <button
                                type="button"
                                className="modifier-remove"
                                title={t("runorpg.removeAttribute")}
                                aria-label={t("runorpg.removeAttribute")}
                                onClick={() =>
                                    onChange(
                                        modifiers.filter(
                                            (_, at) => at !== index,
                                        ),
                                    )
                                }
                            >
                                &times;
                            </button>
                        </li>
                    );
                })}
            </ol>
        </div>
    );
}

interface SkillEditorProps {
    readonly skills: readonly RunoRpgItemSkill[];
    readonly onChange: (skills: RunoRpgItemSkill[]) => void;
}

export function RunoRpgSkillEditor({ skills, onChange }: SkillEditorProps) {
    const { t } = useTranslation();
    const update = (
        index: number,
        mutate: (skill: RunoRpgItemSkill) => RunoRpgItemSkill,
    ) => onChange(replaceAt(skills, index, mutate(skills[index]!)));

    return (
        <div
            className="runorpg-contract-editor"
            data-testid="runorpg-skill-editor"
        >
            <div className="runorpg-contract-head">
                <div>
                    <strong>{t("runorpg.skills")}</strong>
                    <p className="muted small">{t("runorpg.skillsHint")}</p>
                </div>
                <button
                    type="button"
                    disabled={skills.length >= 32}
                    onClick={() => onChange([...skills, nextSkill(skills)])}
                    data-testid="runorpg-add-skill"
                >
                    + {t("runorpg.addSkill")}
                </button>
            </div>

            <ol className="runorpg-contract-list">
                {skills.map((entry, index) => (
                    <li
                        key={`skill-${index}`}
                        data-testid={`runorpg-skill-row-${index}`}
                    >
                        <div className="contract-order-controls">
                            <button
                                type="button"
                                disabled={index === 0}
                                title={t("inspector.content.moveUp")}
                                aria-label={t("inspector.content.moveUp")}
                                onClick={() =>
                                    onChange(moveAt(skills, index, -1))
                                }
                            >
                                &uarr;
                            </button>
                            <button
                                type="button"
                                disabled={index === skills.length - 1}
                                title={t("inspector.content.moveDown")}
                                aria-label={t("inspector.content.moveDown")}
                                onClick={() =>
                                    onChange(moveAt(skills, index, 1))
                                }
                            >
                                &darr;
                            </button>
                        </div>

                        <div className="contract-fields skill-contract-fields">
                            <label>
                                {t("runorpg.skillId")}
                                <input
                                    value={entry.id}
                                    maxLength={128}
                                    onChange={(event) =>
                                        update(index, (current) => ({
                                            ...current,
                                            id: event.target.value,
                                        }))
                                    }
                                    data-testid={`runorpg-skill-id-${index}`}
                                />
                            </label>
                            <label>
                                {t("runorpg.mythicSkill")}
                                <input
                                    value={entry.mythicSkill}
                                    maxLength={128}
                                    onChange={(event) =>
                                        update(index, (current) => ({
                                            ...current,
                                            mythicSkill: event.target.value,
                                        }))
                                    }
                                    data-testid={`runorpg-mythic-skill-${index}`}
                                />
                            </label>
                            <label>
                                {t("runorpg.trigger")}
                                <select
                                    value={entry.trigger}
                                    onChange={(event) =>
                                        update(index, (current) => ({
                                            ...current,
                                            trigger: event.target
                                                .value as RunoRpgItemSkill["trigger"],
                                        }))
                                    }
                                >
                                    {SKILL_TRIGGERS.map((trigger) => (
                                        <option key={trigger} value={trigger}>
                                            {t(
                                                `runorpg.triggerValue.${pathPart(trigger)}`,
                                            )}
                                        </option>
                                    ))}
                                </select>
                            </label>
                            <label>
                                {t("runorpg.cooldownGroup")}
                                <input
                                    value={entry.cooldownGroup}
                                    maxLength={128}
                                    onChange={(event) =>
                                        update(index, (current) => ({
                                            ...current,
                                            cooldownGroup: event.target.value,
                                        }))
                                    }
                                />
                            </label>
                            {(
                                [
                                    [
                                        "cooldownSeconds",
                                        "runorpg.cooldownSeconds",
                                        86_400,
                                    ],
                                    ["manaCost", "runorpg.manaCost", undefined],
                                    [
                                        "staminaCost",
                                        "runorpg.staminaCost",
                                        undefined,
                                    ],
                                    ["power", "runorpg.power", 10_000],
                                ] as const
                            ).map(([key, label, maximum]) => (
                                <label key={key}>
                                    {t(label)}
                                    <input
                                        type="number"
                                        min={0}
                                        max={maximum}
                                        step="any"
                                        value={entry[key]}
                                        onChange={(event) => {
                                            const value = Number(
                                                event.target.value,
                                            );
                                            if (Number.isFinite(value)) {
                                                update(index, (current) => ({
                                                    ...current,
                                                    [key]: value,
                                                }));
                                            }
                                        }}
                                    />
                                </label>
                            ))}
                            <label className="contract-field-wide">
                                {t("runorpg.skillLore")}
                                <input
                                    value={entry.lore}
                                    maxLength={512}
                                    onChange={(event) =>
                                        update(index, (current) => ({
                                            ...current,
                                            lore: event.target.value,
                                        }))
                                    }
                                    data-testid={`runorpg-skill-lore-${index}`}
                                />
                            </label>
                            <div className="contract-options contract-field-wide">
                                <label className="toggle-row">
                                    <input
                                        type="checkbox"
                                        checked={entry.cancelVanilla}
                                        onChange={(event) =>
                                            update(index, (current) => ({
                                                ...current,
                                                cancelVanilla:
                                                    event.target.checked,
                                            }))
                                        }
                                    />
                                    {t("runorpg.cancelVanilla")}
                                </label>
                                <label className="toggle-row">
                                    <input
                                        type="checkbox"
                                        checked={entry.hidden}
                                        onChange={(event) =>
                                            update(index, (current) => ({
                                                ...current,
                                                hidden: event.target.checked,
                                            }))
                                        }
                                    />
                                    {t("runorpg.hiddenSkill")}
                                </label>
                            </div>
                        </div>

                        <button
                            type="button"
                            className="modifier-remove"
                            title={t("runorpg.removeSkill")}
                            aria-label={t("runorpg.removeSkill")}
                            onClick={() =>
                                onChange(skills.filter((_, at) => at !== index))
                            }
                        >
                            &times;
                        </button>
                    </li>
                ))}
            </ol>
        </div>
    );
}
