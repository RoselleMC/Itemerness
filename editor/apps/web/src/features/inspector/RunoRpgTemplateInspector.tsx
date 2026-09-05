import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
    ITEM_QUALITY_TIERS,
    qualityThemeOf,
    qualityTierOfTheme,
    type PresentationBlock,
    type RunoRpgAttributeModifier,
    type RunoRpgCatalogItem,
} from "@itemerness/protocol";
import { useEditorStore } from "../../state/store.js";
import { humanizePath } from "../common/messages.js";
import { ItemIcon } from "../common/ItemIcon.js";
import type { PreviewBundle } from "../preview/usePreview.js";
import { loadRunoRpgCatalog } from "../runorpg/catalogCache.js";
import {
    defaultRunoRpgAppearance,
    effectiveRunoRpgBlocks,
} from "../runorpg/templateProjection.js";
import {
    RunoRpgModifierEditor,
    RunoRpgSkillEditor,
} from "../runorpg/RunoRpgContractEditors.js";
import { newUuid } from "../common/uuid.js";

type ConditionalBlock = Extract<PresentationBlock, { type: "conditional" }>;
type ValueReference = ConditionalBlock["condition"]["left"];

interface TemplateDraft {
    displayName: string;
    enabled: boolean;
    material: string;
    layout: string;
    theme: string;
    mode: "unique" | "fungible";
    maxStackSize: number;
    unbreakable: boolean;
    itemLevel: number;
    itemTier: string;
    itemPrefix: string;
    modifiers: RunoRpgAttributeModifier[];
    skills: RunoRpgCatalogItem["skills"];
    presentationBlocks: PresentationBlock[];
    presentationMessages: Record<string, string>;
}

const ITEM_DATA = [
    ["runorpg:item-level", "物品等级"],
    ["runorpg:item-tier", "品质"],
    ["runorpg:item-prefix", "前缀"],
] as const;

const OPERATORS = [
    ["LESS_THAN", "<"],
    ["LESS_THAN_OR_EQUAL", "≤"],
    ["GREATER_THAN", ">"],
    ["GREATER_THAN_OR_EQUAL", "≥"],
    ["EQUALS", "="],
    ["NOT_EQUALS", "≠"],
    ["EXISTS", "存在"],
] as const;

function draftOf(item: RunoRpgCatalogItem): TemplateDraft {
    const appearance = defaultRunoRpgAppearance(item);
    return {
        displayName: item.displayName,
        enabled: item.enabled,
        material: item.material,
        layout: item.layout ?? appearance.layout,
        theme: item.theme ?? appearance.theme,
        mode: item.mode,
        maxStackSize: item.maxStackSize,
        unbreakable: item.unbreakable,
        itemLevel: item.itemLevel,
        itemTier: item.itemTier,
        itemPrefix: item.itemPrefix,
        modifiers: structuredClone(item.modifiers),
        skills: structuredClone(item.skills),
        presentationBlocks: effectiveRunoRpgBlocks(item),
        presentationMessages: { ...item.presentationMessages },
    };
}

function referenceCode(reference: ValueReference | null): string {
    if (!reference || reference.kind === "literal") return "literal";
    return `${reference.kind}:${reference.key}`;
}

function literalText(reference: ValueReference | null): string {
    if (!reference || reference.kind !== "literal") return "1";
    const value = reference.value;
    if (
        value.kind === "integer" ||
        value.kind === "decimal" ||
        value.kind === "string"
    ) {
        return value.value;
    }
    if (value.kind === "boolean") return String(value.value);
    return "1";
}

function literalReference(raw: string): ValueReference {
    if (/^-?\d+$/u.test(raw)) {
        return { kind: "literal", value: { kind: "integer", value: raw } };
    }
    if (/^-?\d+\.\d+$/u.test(raw)) {
        return { kind: "literal", value: { kind: "decimal", value: raw } };
    }
    return { kind: "literal", value: { kind: "string", value: raw } };
}

async function saveTemplate(
    item: RunoRpgCatalogItem,
    draft: TemplateDraft,
): Promise<void> {
    const response = await fetch("/api/v1/runorpg/catalog/item", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            id: item.id,
            expectedFileHash: item.fileHash,
            ...draft,
        }),
    });
    const body = (await response.json().catch(() => null)) as {
        error?: string;
        detail?: string;
    } | null;
    if (!response.ok) {
        throw new Error(
            body?.detail ?? body?.error ?? `HTTP ${response.status}`,
        );
    }
}

export function RunoRpgTemplateInspector({
    preview,
}: {
    preview: PreviewBundle;
}) {
    const { t } = useTranslation();
    const store = useEditorStore();
    const item = store.runoRpgCatalog?.items.find(
        (entry) => entry.id === store.selectedItemId,
    );
    const [draft, setDraft] = useState<TemplateDraft | null>(() =>
        item ? draftOf(item) : null,
    );
    const [saving, setSaving] = useState(false);
    const [message, setMessage] = useState<string | null>(null);

    useEffect(() => {
        setDraft(item ? draftOf(item) : null);
        setMessage(null);
    }, [item?.id, item?.fileHash]);

    useEffect(() => {
        if (!item || !draft) return;
        const catalog = useEditorStore.getState().runoRpgCatalog;
        if (!catalog) return;
        useEditorStore.getState().setRunoRpgCatalog({
            ...catalog,
            items: catalog.items.map((entry) =>
                entry.id === item.id ? { ...entry, ...draft } : entry,
            ),
        });
    }, [draft, item?.id]);

    const facts = useMemo(
        () => [
            ["runorpg:level", "玩家等级"] as const,
            ["runorpg:class", "玩家职业"] as const,
            ...(store.runoRpgCatalog?.attributes ?? []).map(
                (attribute) =>
                    [
                        `runorpg:attribute.${attribute.id.split(":", 2)[1]}`,
                        attribute.name,
                    ] as const,
            ),
        ],
        [store.runoRpgCatalog?.attributes],
    );

    if (!item || !draft) {
        return (
            <aside className="inspector">
                <p className="muted">{t("stage.noItem")}</p>
            </aside>
        );
    }

    const replaceBlock = (index: number, block: PresentationBlock) =>
        setDraft((current) =>
            current
                ? {
                      ...current,
                      presentationBlocks: current.presentationBlocks.map(
                          (entry, at) => (at === index ? block : entry),
                      ),
                  }
                : current,
        );
    const removeBlock = (index: number) =>
        setDraft((current) =>
            current
                ? {
                      ...current,
                      presentationBlocks: current.presentationBlocks.filter(
                          (_, at) => at !== index,
                      ),
                  }
                : current,
        );
    const moveBlock = (index: number, offset: number) =>
        setDraft((current) => {
            if (!current) return current;
            const target = index + offset;
            if (target < 0 || target >= current.presentationBlocks.length) {
                return current;
            }
            const blocks = [...current.presentationBlocks];
            const [block] = blocks.splice(index, 1);
            blocks.splice(target, 0, block!);
            return { ...current, presentationBlocks: blocks };
        });
    const setPresentationMessage = (key: string, value: string) =>
        setDraft((current) =>
            current
                ? {
                      ...current,
                      presentationMessages: {
                          ...current.presentationMessages,
                          [key]: value,
                      },
                  }
                : current,
        );
    const messageValue = (key: string) => draft.presentationMessages[key] ?? "";

    const decodeReference = (code: string): ValueReference => {
        if (code === "literal") return literalReference("1");
        const separator = code.indexOf(":");
        return {
            kind: code.slice(0, separator) as "data" | "fact",
            key: code.slice(separator + 1),
        };
    };

    const referenceOptions = () => (
        <>
            <optgroup label="RunoRPG 玩家属性">
                {facts.map(([key, label]) => (
                    <option key={`fact:${key}`} value={`fact:${key}`}>
                        {label}
                    </option>
                ))}
            </optgroup>
            <optgroup label="RunoRPG 物品数据">
                {ITEM_DATA.map(([key, label]) => (
                    <option key={`data:${key}`} value={`data:${key}`}>
                        {label}
                    </option>
                ))}
            </optgroup>
            <option value="literal">固定值</option>
        </>
    );

    const renderNestedBlock = (
        block: PresentationBlock,
        update: (next: PresentationBlock) => void,
        remove: () => void,
    ) => {
        if (block.type === "description") {
            return (
                <div className="nested-content-row" key={block.uuid}>
                    <span className="block-kind">文本</span>
                    <input
                        value={messageValue(block.message)}
                        onChange={(event) =>
                            setPresentationMessage(
                                block.message,
                                event.target.value,
                            )
                        }
                    />
                    <button
                        type="button"
                        onClick={remove}
                        aria-label="删除文本"
                    >
                        ×
                    </button>
                </div>
            );
        }
        if (block.type === "field") {
            return (
                <div className="nested-content-row" key={block.uuid}>
                    <span className="block-kind">物品数据</span>
                    <input
                        value={messageValue(block.labelMessage)}
                        onChange={(event) =>
                            setPresentationMessage(
                                block.labelMessage,
                                event.target.value,
                            )
                        }
                    />
                    <select
                        value={block.data}
                        onChange={(event) =>
                            update({ ...block, data: event.target.value })
                        }
                    >
                        {ITEM_DATA.map(([key, label]) => (
                            <option key={key} value={key}>
                                {label}
                            </option>
                        ))}
                    </select>
                    <button
                        type="button"
                        onClick={remove}
                        aria-label="删除物品数据"
                    >
                        ×
                    </button>
                </div>
            );
        }
        return (
            <p className="muted small" key={block.uuid}>
                该嵌套块只能由 Itemerness 高级编辑器读取。
            </p>
        );
    };

    const renderConditional = (block: ConditionalBlock, index: number) => {
        const replaceCondition = (condition: ConditionalBlock["condition"]) =>
            replaceBlock(index, { ...block, condition });
        const branch = (
            name: "thenBlocks" | "otherwiseBlocks",
            label: string,
        ) => (
            <div className="block-nested">
                <p className="dim small">{label}</p>
                {block[name].map((nested, nestedIndex) =>
                    renderNestedBlock(
                        nested,
                        (next) =>
                            replaceBlock(index, {
                                ...block,
                                [name]: block[name].map((entry, at) =>
                                    at === nestedIndex ? next : entry,
                                ),
                            }),
                        () =>
                            replaceBlock(index, {
                                ...block,
                                [name]: block[name].filter(
                                    (_, at) => at !== nestedIndex,
                                ),
                            }),
                    ),
                )}
            </div>
        );
        return (
            <>
                <span className="condition-editor">
                    <select
                        value={referenceCode(block.condition.left)}
                        onChange={(event) =>
                            replaceCondition({
                                ...block.condition,
                                left: decodeReference(event.target.value),
                            })
                        }
                        data-testid="runorpg-condition-left"
                    >
                        {referenceOptions()}
                    </select>
                    <select
                        value={block.condition.operator}
                        onChange={(event) =>
                            replaceCondition({
                                ...block.condition,
                                operator: event.target
                                    .value as ConditionalBlock["condition"]["operator"],
                                right:
                                    event.target.value === "EXISTS"
                                        ? null
                                        : (block.condition.right ??
                                          literalReference("1")),
                            })
                        }
                    >
                        {OPERATORS.map(([operator, label]) => (
                            <option key={operator} value={operator}>
                                {label}
                            </option>
                        ))}
                    </select>
                    {block.condition.operator !== "EXISTS" ? (
                        <>
                            <select
                                value={referenceCode(block.condition.right)}
                                onChange={(event) =>
                                    replaceCondition({
                                        ...block.condition,
                                        right: decodeReference(
                                            event.target.value,
                                        ),
                                    })
                                }
                                data-testid="runorpg-condition-right"
                            >
                                {referenceOptions()}
                            </select>
                            {block.condition.right?.kind === "literal" ? (
                                <input
                                    className="sample-input"
                                    value={literalText(block.condition.right)}
                                    onChange={(event) =>
                                        replaceCondition({
                                            ...block.condition,
                                            right: literalReference(
                                                event.target.value,
                                            ),
                                        })
                                    }
                                />
                            ) : null}
                        </>
                    ) : null}
                </span>
                {branch("thenBlocks", "满足时")}
                {branch("otherwiseBlocks", "否则")}
            </>
        );
    };

    const addText = () => {
        const suffix = newUuid().slice(0, 8);
        const key = `runorpg.item.${item.localId}.text.${suffix}`;
        setDraft((current) =>
            current
                ? {
                      ...current,
                      presentationMessages: {
                          ...current.presentationMessages,
                          [key]: "新文本",
                      },
                      presentationBlocks: [
                          ...current.presentationBlocks,
                          {
                              uuid: newUuid(),
                              type: "description",
                              message: key,
                              style: "description",
                              anchor: null,
                              wrapping: "body",
                          },
                      ],
                  }
                : current,
        );
    };

    const addField = () => {
        const suffix = newUuid().slice(0, 8);
        const key = `runorpg.item.${item.localId}.label.${suffix}`;
        setDraft((current) =>
            current
                ? {
                      ...current,
                      presentationMessages: {
                          ...current.presentationMessages,
                          [key]: "物品等级",
                      },
                      presentationBlocks: [
                          ...current.presentationBlocks,
                          {
                              uuid: newUuid(),
                              type: "field",
                              labelMessage: key,
                              data: "runorpg:item-level",
                              format: "itemerness:integer",
                              icon: null,
                              style: null,
                              anchor: null,
                              wrapping: null,
                              missingPolicy: "OMIT",
                          },
                      ],
                  }
                : current,
        );
    };

    const addConditional = () => {
        const key = `runorpg.item.${item.localId}.label.required-level`;
        setDraft((current) =>
            current
                ? {
                      ...current,
                      presentationMessages: {
                          ...current.presentationMessages,
                          [key]: "需求等级",
                      },
                      presentationBlocks: [
                          ...current.presentationBlocks,
                          {
                              uuid: newUuid(),
                              type: "conditional",
                              condition: {
                                  operator: "LESS_THAN",
                                  left: {
                                      kind: "fact",
                                      key: "runorpg:level",
                                  },
                                  right: {
                                      kind: "data",
                                      key: "runorpg:item-level",
                                  },
                              },
                              thenBlocks: [
                                  {
                                      uuid: newUuid(),
                                      type: "field",
                                      labelMessage: key,
                                      data: "runorpg:item-level",
                                      format: "itemerness:integer",
                                      icon: null,
                                      style: "requirement-unmet",
                                      anchor: null,
                                      wrapping: null,
                                      missingPolicy: "OMIT",
                                  },
                              ],
                              otherwiseBlocks: [
                                  {
                                      uuid: newUuid(),
                                      type: "field",
                                      labelMessage: key,
                                      data: "runorpg:item-level",
                                      format: "itemerness:integer",
                                      icon: null,
                                      style: "requirement-met",
                                      anchor: null,
                                      wrapping: null,
                                      missingPolicy: "OMIT",
                                  },
                              ],
                              style: null,
                              anchor: null,
                          },
                      ],
                  }
                : current,
        );
    };

    const save = async () => {
        setSaving(true);
        setMessage(null);
        try {
            await saveTemplate(item, draft);
            const catalog = await loadRunoRpgCatalog(true);
            store.setRunoRpgCatalog(catalog);
            setMessage(t("runorpg.saved"));
        } catch (error) {
            setMessage((error as Error).message);
        } finally {
            setSaving(false);
        }
    };

    return (
        <aside className="inspector" aria-label={t("inspector.heading")}>
            <section>
                <div className="runorpg-template-title">
                    <ItemIcon
                        materialId={draft.material}
                        label={draft.displayName}
                        size={32}
                    />
                    <div>
                        <input
                            className="name-input"
                            value={draft.displayName}
                            onChange={(event) =>
                                setDraft({
                                    ...draft,
                                    displayName: event.target.value,
                                })
                            }
                            data-testid="runorpg-template-name"
                        />
                        <code>{item.id}</code>
                    </div>
                </div>
                <p className="muted small">
                    属性数值只写入 RunoRPG，原版属性保持禁用。
                </p>
            </section>

            <section>
                <h3>{t("inspector.appearance.heading")}</h3>
                <p className="field-label">{t("inspector.appearance.theme")}</p>
                <div className="theme-grid" data-testid="theme-grid">
                    {preview.document.themes.map((entry) => (
                        <button
                            key={entry.uuid}
                            type="button"
                            className={`theme-card ${draft.theme === entry.id ? "selected" : ""}`}
                            onClick={() =>
                                setDraft({ ...draft, theme: entry.id })
                            }
                        >
                            <span className="theme-card-name">
                                {humanizePath(
                                    entry.id.split(":").pop() ?? entry.id,
                                )}
                            </span>
                            <span className="theme-card-kind">
                                {t(`inspector.renderer.${entry.renderer}`)}
                            </span>
                        </button>
                    ))}
                </div>
                <label className="field-label" htmlFor="runorpg-layout-select">
                    {t("inspector.appearance.layout")}
                </label>
                <select
                    id="runorpg-layout-select"
                    value={draft.layout}
                    onChange={(event) =>
                        setDraft({ ...draft, layout: event.target.value })
                    }
                >
                    {preview.document.layouts.map((entry) => (
                        <option key={entry.uuid} value={entry.id}>
                            {humanizePath(
                                entry.id.split(":").pop() ?? entry.id,
                            )}
                        </option>
                    ))}
                </select>
            </section>

            <section>
                <h3>RunoRPG 物品数据</h3>
                <div className="runorpg-template-data-grid">
                    <label>
                        物品等级
                        <input
                            type="number"
                            min={0}
                            value={draft.itemLevel}
                            onChange={(event) =>
                                setDraft({
                                    ...draft,
                                    itemLevel: Number(event.target.value),
                                })
                            }
                        />
                    </label>
                    <label>
                        品质
                        <select
                            value={
                                qualityTierOfTheme(draft.theme) ??
                                draft.itemTier.trim().toLowerCase()
                            }
                            onChange={(event) => {
                                // The frame follows the tier. Leaving them independent is how an
                                // item ends up labelled legendary inside a common border.
                                const tier = event.target.value;
                                setDraft({
                                    ...draft,
                                    itemTier: tier,
                                    theme: qualityThemeOf(tier) ?? draft.theme,
                                });
                            }}
                            data-testid="runorpg-item-tier"
                        >
                            {ITEM_QUALITY_TIERS.map((tier) => (
                                <option key={tier} value={tier}>
                                    {t(`inspector.quality.${tier}`)}
                                </option>
                            ))}
                            {qualityThemeOf(draft.itemTier) === null &&
                            draft.itemTier !== "" ? (
                                <option value={draft.itemTier}>
                                    {draft.itemTier}
                                </option>
                            ) : null}
                        </select>
                    </label>
                    <label>
                        前缀
                        <input
                            value={draft.itemPrefix}
                            onChange={(event) =>
                                setDraft({
                                    ...draft,
                                    itemPrefix: event.target.value,
                                })
                            }
                        />
                    </label>
                </div>
            </section>

            <section className="runorpg-contracts-section">
                <RunoRpgModifierEditor
                    attributes={store.runoRpgCatalog?.attributes ?? []}
                    itemId={item.id}
                    modifiers={draft.modifiers}
                    onChange={(modifiers) => setDraft({ ...draft, modifiers })}
                />
                <RunoRpgSkillEditor
                    skills={draft.skills}
                    onChange={(skills) => setDraft({ ...draft, skills })}
                />
            </section>

            <section>
                <h3>{t("inspector.content.heading")}</h3>
                <ol className="block-list" data-testid="runorpg-content-blocks">
                    {draft.presentationBlocks.map((block, index) => (
                        <li
                            key={block.uuid}
                            // Selection is shared with the canvas overlay, exactly as in the
                            // Itemerness item inspector: clicking a tooltip line highlights the
                            // block that drew it, and clicking the block highlights the line.
                            className={`block-row ${block.type === "conditional" || block.type === "repeat" ? "block-group" : ""}${store.selectedBlockUuid === block.uuid ? " selected" : ""}`}
                            data-testid={`runorpg-block-${block.type}`}
                            data-block={block.uuid}
                            data-selected={
                                store.selectedBlockUuid === block.uuid
                            }
                            onClick={() => store.selectBlock(block.uuid)}
                        >
                            <span className="block-controls block-order-controls">
                                <button
                                    type="button"
                                    onClick={() => moveBlock(index, -1)}
                                    disabled={index === 0}
                                    aria-label="上移"
                                >
                                    ↑
                                </button>
                                <button
                                    type="button"
                                    onClick={() => moveBlock(index, 1)}
                                    disabled={
                                        index ===
                                        draft.presentationBlocks.length - 1
                                    }
                                    aria-label="下移"
                                >
                                    ↓
                                </button>
                            </span>
                            {block.type === "repeat" &&
                            block.data === "runorpg:attribute-lore" ? (
                                <>
                                    <span className="block-kind">
                                        RunoRPG 属性 Lore
                                    </span>
                                    <span className="muted small">
                                        {draft.modifiers.length} 条，由 RunoRPG
                                        属性契约生成
                                    </span>
                                </>
                            ) : block.type === "repeat" &&
                              block.data === "runorpg:item-skills" ? (
                                <>
                                    <span className="block-kind">
                                        MythicMobs 技能 Lore
                                    </span>
                                    <span className="muted small">
                                        {
                                            draft.skills.filter(
                                                (skill) => !skill.hidden,
                                            ).length
                                        }{" "}
                                        条，由 RunoRPG 技能契约生成
                                    </span>
                                </>
                            ) : block.type === "description" ? (
                                <>
                                    <span className="block-kind">文本</span>
                                    <input
                                        value={messageValue(block.message)}
                                        onChange={(event) =>
                                            setPresentationMessage(
                                                block.message,
                                                event.target.value,
                                            )
                                        }
                                    />
                                    <button
                                        type="button"
                                        onClick={() => removeBlock(index)}
                                        aria-label="删除文本"
                                    >
                                        ×
                                    </button>
                                </>
                            ) : block.type === "field" ? (
                                <>
                                    <span className="block-kind">物品数据</span>
                                    <input
                                        value={messageValue(block.labelMessage)}
                                        onChange={(event) =>
                                            setPresentationMessage(
                                                block.labelMessage,
                                                event.target.value,
                                            )
                                        }
                                    />
                                    <select
                                        value={block.data}
                                        onChange={(event) =>
                                            replaceBlock(index, {
                                                ...block,
                                                data: event.target.value,
                                            })
                                        }
                                    >
                                        {ITEM_DATA.map(([key, label]) => (
                                            <option key={key} value={key}>
                                                {label}
                                            </option>
                                        ))}
                                    </select>
                                    <button
                                        type="button"
                                        onClick={() => removeBlock(index)}
                                        aria-label="删除物品数据"
                                    >
                                        ×
                                    </button>
                                </>
                            ) : block.type === "conditional" ? (
                                <>
                                    <span className="block-kind">
                                        RunoRPG 条件
                                    </span>
                                    {renderConditional(block, index)}
                                    <button
                                        type="button"
                                        onClick={() => removeBlock(index)}
                                        aria-label="删除条件"
                                    >
                                        ×
                                    </button>
                                </>
                            ) : (
                                <span className="muted small">
                                    不支持的展示块
                                </span>
                            )}
                        </li>
                    ))}
                </ol>
                <div className="row-actions">
                    <button
                        type="button"
                        onClick={addField}
                        data-testid="runorpg-add-field"
                    >
                        + 物品数据
                    </button>
                    <button
                        type="button"
                        onClick={addText}
                        data-testid="runorpg-add-text"
                    >
                        + 文本
                    </button>
                    <button
                        type="button"
                        onClick={addConditional}
                        data-testid="runorpg-add-condition"
                    >
                        + RunoRPG 条件
                    </button>
                </div>
            </section>

            <section className="runorpg-template-save">
                <button
                    type="button"
                    className="primary-command"
                    disabled={saving || !store.runoRpgCatalog?.writable}
                    onClick={() => void save()}
                    data-testid="save-runorpg-template"
                >
                    {saving ? t("runorpg.saving") : t("runorpg.saveItem")}
                </button>
                {message ? <p className="muted small">{message}</p> : null}
            </section>
        </aside>
    );
}
