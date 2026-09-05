import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useDragReorder } from "../common/dragReorder.js";
import type {
    DataValue,
    ItemNode,
    PresentationBlock,
    ProjectDocument,
} from "@itemerness/protocol";
import { useEditorStore } from "../../state/store.js";
import { humanizePath, resolveMessage } from "../common/messages.js";
import { ItemIcon } from "../common/ItemIcon.js";
import type { PreviewBundle } from "../preview/usePreview.js";
import { newUuid } from "../common/uuid.js";

/**
 * The inspector: edit what the preview shows, in the words the preview shows it.
 *
 * The design rule throughout is direct manipulation over schema exposure. The name field edits the
 * name; behind it the store writes the message for the language being previewed, but the person
 * typing never chooses a message key. Content rows read as "Attack Damage — 38.5", not as a block
 * type with a labelMessage. The ids, uuids, and keys that make the document robust still exist and
 * are still stable — folded into an advanced section, where the people who need them will look.
 */

/** Common item materials for the picker; free text is still accepted. */
const COMMON_MATERIALS = [
    "paper",
    "book",
    "writable_book",
    "netherite_sword",
    "diamond_sword",
    "iron_sword",
    "bow",
    "crossbow",
    "trident",
    "mace",
    "shield",
    "iron_pickaxe",
    "diamond_pickaxe",
    "golden_apple",
    "enchanted_golden_apple",
    "emerald",
    "diamond",
    "amethyst_shard",
    "echo_shard",
    "ender_pearl",
    "nether_star",
    "blaze_rod",
    "stick",
    "compass",
    "clock",
    "filled_map",
    "name_tag",
    "bundle",
    "potion",
    "elytra",
    "totem_of_undying",
    "goat_horn",
];

const OPERATOR_GLYPHS: Record<string, string> = {
    LESS_THAN: "<",
    LESS_THAN_OR_EQUAL: "≤",
    GREATER_THAN: ">",
    GREATER_THAN_OR_EQUAL: "≥",
    EQUALS: "=",
    NOT_EQUALS: "≠",
    EXISTS: "∃",
};

/** The scalar sample value shown next to a data reference, from preview data then item defaults. */
function sampleValue(item: ItemNode, dataKey: string): DataValue | null {
    for (const source of [
        item.previewData,
        item.definition.instance.defaults,
        item.definition.definitionData,
    ]) {
        const found = source.find((assignment) => assignment.key === dataKey);
        if (found) return found.value;
    }
    return null;
}

function scalarText(value: DataValue | null): string | null {
    if (!value) return null;
    switch (value.kind) {
        case "integer":
        case "decimal":
            return value.value;
        case "string":
            return value.value.includes(":")
                ? (value.value.split(":").pop() ?? value.value)
                : value.value;
        case "boolean":
            return String(value.value);
        default:
            return null;
    }
}

export function ItemInspector({ preview }: { preview: PreviewBundle }) {
    const { t } = useTranslation();
    const store = useEditorStore();
    const { document: doc, viewerLocale } = store;

    const item = doc.items.find(
        (entry) => `${doc.namespace}:${entry.id}` === store.selectedItemId,
    );
    if (!item) {
        return (
            <aside className="inspector">
                <p className="muted">{t("stage.noItem")}</p>
            </aside>
        );
    }

    const setMessage = (key: string, value: string) =>
        store.setMessage(viewerLocale, key, value);
    const name = resolveMessage(
        doc,
        viewerLocale,
        item.presentation.nameMessage,
    );
    const nameInputRef = useRef<HTMLInputElement | null>(null);

    // Selection made on the canvas lands here: scroll the matching row into view, or focus the
    // name input when the display name itself was clicked.
    useEffect(() => {
        if (store.selectedBlockUuid === "__name") {
            nameInputRef.current?.focus();
            return;
        }
        if (store.selectedBlockUuid) {
            window.document
                .querySelector(`[data-block="${store.selectedBlockUuid}"]`)
                ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
        }
    }, [store.selectedBlockUuid]);

    const updateBlocks = (
        mutate: (blocks: PresentationBlock[]) => PresentationBlock[],
    ) =>
        store.updateItem(item.uuid, (current) => ({
            ...current,
            presentation: {
                ...current.presentation,
                blocks: mutate([...current.presentation.blocks]),
            },
        }));

    const moveBlockTo = (from: number, to: number) =>
        updateBlocks((blocks) => {
            if (
                from < 0 ||
                from >= blocks.length ||
                to < 0 ||
                to >= blocks.length
            )
                return blocks;
            const [moved] = blocks.splice(from, 1);
            blocks.splice(to, 0, moved!);
            return blocks;
        });

    const removeBlock = (index: number) =>
        updateBlocks((blocks) => blocks.filter((_, at) => at !== index));

    const drag = useDragReorder(
        item.presentation.blocks.length,
        moveBlockTo,
        t("inspector.content.dragHandle"),
    );

    const presentationKeys = doc.dataSchemas
        .flatMap((schema) => schema.keys)
        .filter((key) => key.presentationReadable)
        .map((key) => key.id);

    const addFieldRow = () => {
        const dataKey = presentationKeys[0];
        if (!dataKey) return;
        const path = dataKey.split(":").pop() ?? dataKey;
        // Reuse the shared label when one exists, otherwise mint an item-scoped key so the label
        // is immediately editable text rather than a naming decision.
        const sharedKey = `data.${path}.label`;
        const hasShared = doc.locales.some(
            (locale) => locale.messages[sharedKey] !== undefined,
        );
        const labelKey = hasShared
            ? sharedKey
            : `item.${item.id}.label.${newUuid().slice(0, 4)}`;
        if (!hasShared)
            store.setMessage(doc.defaultLocale, labelKey, humanizePath(path));
        updateBlocks((blocks) => [
            ...blocks,
            {
                uuid: newUuid(),
                type: "field",
                labelMessage: labelKey,
                data: dataKey,
                format: null,
                icon: null,
                style: null,
                anchor: null,
                wrapping: null,
                missingPolicy: "OMIT",
            },
        ]);
    };

    const addTextRow = () => {
        const textKey = `item.${item.id}.text.${newUuid().slice(0, 4)}`;
        store.setMessage(
            doc.defaultLocale,
            textKey,
            t("inspector.content.newTextDefault"),
        );
        updateBlocks((blocks) => [
            ...blocks,
            {
                uuid: newUuid(),
                type: "description",
                message: textKey,
                style: "description",
                anchor: null,
                wrapping: "body",
            },
        ]);
    };

    const addConditionalRow = () => {
        const fact =
            doc.viewerFacts.find((entry) => entry.type === "INTEGER") ??
            doc.viewerFacts[0];
        const dataKey = presentationKeys[0];
        if (!fact || !dataKey) return;
        const textKey = `item.${item.id}.text.${newUuid().slice(0, 4)}`;
        store.setMessage(
            doc.defaultLocale,
            textKey,
            t("inspector.content.newTextDefault"),
        );
        updateBlocks((blocks) => [
            ...blocks,
            {
                uuid: newUuid(),
                type: "conditional",
                condition: {
                    operator: "GREATER_THAN_OR_EQUAL",
                    left: { kind: "fact", key: fact.id },
                    right: {
                        kind: "literal",
                        value: { kind: "integer", value: "1" },
                    },
                },
                thenBlocks: [
                    {
                        uuid: newUuid(),
                        type: "description",
                        message: textKey,
                        style: "description",
                        anchor: null,
                        wrapping: "body",
                    },
                ],
                otherwiseBlocks: [],
                style: null,
                anchor: null,
            },
        ]);
    };

    const selectedTheme =
        preview.display?.selectedTheme ?? item.presentation.theme;
    const themeFellBack =
        preview.display != null &&
        preview.display.selectedTheme !== item.presentation.theme;

    return (
        <aside className="inspector" aria-label={t("inspector.heading")}>
            {/* --- Name -------------------------------------------------------------------- */}
            <section>
                <h3>{t("inspector.name.heading")}</h3>
                <input
                    ref={nameInputRef}
                    className="name-input"
                    value={
                        name.source === "own"
                            ? name.text
                            : name.source === "missing"
                              ? ""
                              : name.text
                    }
                    placeholder={
                        name.source === "missing" ? item.id : undefined
                    }
                    onChange={(event) =>
                        setMessage(
                            item.presentation.nameMessage,
                            event.target.value,
                        )
                    }
                    data-testid="name-input"
                />
                <p className="muted small">
                    {name.source === "own"
                        ? t("inspector.name.editingIn", {
                              locale: viewerLocale,
                          })
                        : t("inspector.name.inherited", {
                              locale: name.sourceLocale ?? doc.defaultLocale,
                          })}
                </p>
                <label className="toggle-row">
                    <input
                        type="checkbox"
                        checked={item.enabled}
                        onChange={(event) =>
                            store.updateItem(item.uuid, (current) => ({
                                ...current,
                                enabled: event.target.checked,
                            }))
                        }
                        data-testid="form-enabled"
                    />
                    {t("inspector.enabled")}
                </label>
            </section>

            {/* --- Appearance -------------------------------------------------------------- */}
            <section>
                <h3>{t("inspector.appearance.heading")}</h3>
                <div className="material-row">
                    <ItemIcon
                        materialId={item.definition.material}
                        label={name.text}
                        size={32}
                    />
                    <input
                        list="material-suggestions"
                        value={item.definition.material.split(":").pop() ?? ""}
                        onChange={(event) => {
                            const path = event.target.value
                                .trim()
                                .toLowerCase()
                                .replace(/\s+/g, "_");
                            if (!/^[a-z0-9_./-]+$/.test(path)) return;
                            store.updateItem(item.uuid, (current) => ({
                                ...current,
                                definition: {
                                    ...current.definition,
                                    material: `minecraft:${path}`,
                                },
                            }));
                        }}
                        data-testid="material-input"
                    />
                    <datalist id="material-suggestions">
                        {COMMON_MATERIALS.map((material) => (
                            <option key={material} value={material} />
                        ))}
                    </datalist>
                </div>

                <p className="field-label">{t("inspector.appearance.theme")}</p>
                <div className="theme-grid" data-testid="theme-grid">
                    {doc.themes.map((theme) => (
                        <button
                            key={theme.uuid}
                            type="button"
                            className={`theme-card ${item.presentation.theme === theme.id ? "selected" : ""}`}
                            onClick={() =>
                                store.updateItem(item.uuid, (current) => ({
                                    ...current,
                                    presentation: {
                                        ...current.presentation,
                                        theme: theme.id,
                                    },
                                }))
                            }
                            data-testid={`theme-card-${theme.id.split(":").pop()}`}
                        >
                            <span className="theme-card-name">
                                {humanizePath(
                                    theme.id.split(":").pop() ?? theme.id,
                                )}
                            </span>
                            <span className="theme-card-kind">
                                {t(`inspector.renderer.${theme.renderer}`)}
                            </span>
                            {theme.requiresResourcePack ? (
                                <span className="tag tag-pack">
                                    {t("inspector.appearance.requiresPack")}
                                </span>
                            ) : null}
                        </button>
                    ))}
                </div>

                <p className="muted small" data-testid="selected-theme">
                    {t("inspector.appearance.effective")}{" "}
                    <strong>
                        {humanizePath(
                            selectedTheme.split(":").pop() ?? selectedTheme,
                        )}
                    </strong>{" "}
                    <span className="dim">({selectedTheme})</span>
                </p>
                {themeFellBack &&
                preview.display &&
                preview.display.fallbackReasons.length > 0 ? (
                    <div
                        className="fallback-note"
                        data-testid="fallback-reasons"
                    >
                        {t("inspector.appearance.fallbackNotice")}
                        <ul>
                            {preview.display.fallbackReasons.map((reason) => (
                                <li key={`${reason.theme}-${reason.code}`}>
                                    <code>{reason.code}</code> — {reason.theme}
                                </li>
                            ))}
                        </ul>
                    </div>
                ) : null}

                <label className="field-label" htmlFor="layout-select">
                    {t("inspector.appearance.layout")}
                </label>
                <select
                    id="layout-select"
                    value={item.presentation.layout}
                    onChange={(event) =>
                        store.updateItem(item.uuid, (current) => ({
                            ...current,
                            presentation: {
                                ...current.presentation,
                                layout: event.target.value,
                            },
                        }))
                    }
                    data-testid="form-layout"
                >
                    {doc.layouts.map((layout) => (
                        <option key={layout.uuid} value={layout.id}>
                            {humanizePath(
                                layout.id.split(":").pop() ?? layout.id,
                            )}{" "}
                            — {t(`inspector.layoutKind.${layout.kind}`)}
                        </option>
                    ))}
                </select>
            </section>

            {/* --- Content rows ------------------------------------------------------------ */}
            <section>
                <h3>{t("inspector.content.heading")}</h3>
                <ol className="block-list" data-testid="block-list">
                    {item.presentation.blocks.map((block, index) => (
                        <BlockRow
                            key={block.uuid}
                            doc={doc}
                            item={item}
                            block={block}
                            locale={viewerLocale}
                            onSetMessage={setMessage}
                            onReplace={(next) =>
                                updateBlocks((blocks) =>
                                    blocks.map((entry, at) =>
                                        at === index ? next : entry,
                                    ),
                                )
                            }
                            onRemove={() => removeBlock(index)}
                            dragItemProps={drag.itemProps(index)}
                            dragHandleProps={drag.handleProps(index)}
                        />
                    ))}
                </ol>
                <div className="row-actions">
                    <button
                        type="button"
                        onClick={addFieldRow}
                        disabled={presentationKeys.length === 0}
                        data-testid="add-field-row"
                    >
                        + {t("inspector.content.addField")}
                    </button>
                    <button
                        type="button"
                        onClick={addTextRow}
                        data-testid="add-text-row"
                    >
                        + {t("inspector.content.addText")}
                    </button>
                    <button
                        type="button"
                        onClick={addConditionalRow}
                        disabled={
                            doc.viewerFacts.length === 0 ||
                            presentationKeys.length === 0
                        }
                        data-testid="add-conditional-row"
                    >
                        + {t("inspector.content.conditional")}
                    </button>
                </div>
            </section>

            {/* --- Advanced ---------------------------------------------------------------- */}
            <details className="advanced">
                <summary>{t("inspector.advanced.heading")}</summary>
                <dl>
                    <dt>{t("inspector.advanced.id")}</dt>
                    <dd>
                        <code>
                            {doc.namespace}:{item.id}
                        </code>
                    </dd>
                    <dt>{t("inspector.advanced.material")}</dt>
                    <dd>
                        <code>{item.definition.material}</code>
                    </dd>
                    <dt>{t("inspector.advanced.nameKey")}</dt>
                    <dd>
                        <code>{item.presentation.nameMessage}</code>
                    </dd>
                    <dt>{t("inspector.advanced.mode")}</dt>
                    <dd>
                        <code>{item.definition.instance.mode}</code>
                    </dd>
                </dl>
                <button
                    type="button"
                    className="danger"
                    onClick={() => {
                        if (
                            window.confirm(
                                t("inspector.advanced.deleteConfirm", {
                                    name: name.text,
                                }),
                            )
                        ) {
                            store.removeItem(item.uuid);
                        }
                    }}
                    data-testid="delete-item"
                >
                    {t("inspector.advanced.deleteItem")}
                </button>
            </details>
        </aside>
    );
}

function BlockRow({
    doc,
    item,
    block,
    locale,
    onSetMessage,
    onReplace,
    onRemove,
    dragItemProps,
    dragHandleProps,
    nested = false,
}: {
    doc: ProjectDocument;
    item: ItemNode;
    block: PresentationBlock;
    locale: string;
    onSetMessage: (key: string, value: string) => void;
    onReplace: (next: PresentationBlock) => void;
    onRemove: () => void;
    dragItemProps?: Record<string, unknown>;
    dragHandleProps?: Record<string, unknown>;
    nested?: boolean;
}) {
    const { t } = useTranslation();
    const store = useEditorStore();

    const messageInput = (key: string, testid: string) => {
        const resolved = resolveMessage(doc, locale, key);
        return (
            <span className="block-message">
                <input
                    value={resolved.source === "own" ? resolved.text : ""}
                    placeholder={
                        resolved.source === "own" ? undefined : resolved.text
                    }
                    onChange={(event) => onSetMessage(key, event.target.value)}
                    data-testid={testid}
                />
                {resolved.source !== "own" && resolved.source !== "missing" ? (
                    <span className="inherit-hint">
                        {t("inspector.name.inherited", {
                            locale: resolved.sourceLocale,
                        })}
                    </span>
                ) : null}
            </span>
        );
    };

    const sampleEditor = (dataKey: string) => {
        const value = sampleValue(item, dataKey);
        const text = scalarText(value);
        if (value === null || text === null) {
            return value === null ? null : (
                <span className="tag">
                    {t("inspector.content.complexValue")}
                </span>
            );
        }
        const commit = (raw: string) => {
            let next: DataValue | null = null;
            if (value.kind === "integer" && /^-?\d+$/.test(raw))
                next = { kind: "integer", value: raw };
            if (value.kind === "decimal" && /^-?\d+(\.\d+)?$/.test(raw))
                next = { kind: "decimal", value: raw };
            if (value.kind === "string") {
                // Namespaced values keep their namespace; the input edits the readable path half.
                const namespace = value.value.includes(":")
                    ? value.value.split(":")[0] + ":"
                    : "";
                next = { kind: "string", value: namespace + raw };
            }
            if (value.kind === "boolean")
                next = { kind: "boolean", value: raw === "true" };
            if (!next) return;
            store.updateItem(item.uuid, (current) => ({
                ...current,
                previewData: [
                    ...current.previewData.filter(
                        (assignment) => assignment.key !== dataKey,
                    ),
                    { key: dataKey, value: next },
                ],
            }));
        };
        if (value.kind === "boolean") {
            return (
                <label className="sample-bool">
                    <input
                        type="checkbox"
                        checked={value.value}
                        onChange={(event) =>
                            commit(String(event.target.checked))
                        }
                    />
                    {t("inspector.content.sample")}
                </label>
            );
        }
        return (
            <input
                className="sample-input"
                value={text}
                onChange={(event) => commit(event.target.value)}
                title={t("inspector.content.sampleHint")}
            />
        );
    };

    const presentationKeys = doc.dataSchemas
        .flatMap((schema) => schema.keys)
        .filter((key) => key.presentationReadable)
        .map((key) => key.id);
    const iconIds = doc.glyphs
        .filter((glyph) => glyph.id.startsWith("icon."))
        .map((glyph) => glyph.id);

    const handle = nested ? null : (
        <span
            {...(dragHandleProps ?? {})}
            title={t("inspector.content.dragHandle")}
        >
            ⠿
        </span>
    );
    const controls = nested ? null : (
        <span className="block-controls">
            <button
                type="button"
                onClick={onRemove}
                aria-label={t("inspector.content.remove")}
            >
                ×
            </button>
        </span>
    );
    const itemProps = nested ? {} : (dragItemProps ?? {});
    // Selection is shared with the canvas overlay: clicking either surface highlights both.
    const selected = store.selectedBlockUuid === block.uuid;
    const rowProps = {
        "data-block": block.uuid,
        "data-selected": selected,
        onClick: () => store.selectBlock(block.uuid),
    };
    const rowClass = (extra = "") =>
        `block-row${extra ? ` ${extra}` : ""}${selected ? " selected" : ""}`;

    switch (block.type) {
        case "field":
            return (
                <li className={rowClass()} {...rowProps} {...itemProps}>
                    {handle}
                    <span className="block-kind">
                        {t("inspector.content.field")}
                    </span>
                    {messageInput(
                        block.labelMessage,
                        `label-${block.uuid.slice(0, 8)}`,
                    )}
                    {sampleEditor(block.data)}
                    {controls}
                    <div className="block-detail">
                        <label>
                            {t("inspector.content.dataLabel")}
                            <select
                                value={block.data}
                                onChange={(event) =>
                                    onReplace({
                                        ...block,
                                        data: event.target.value,
                                    })
                                }
                            >
                                {presentationKeys.map((key) => (
                                    <option key={key} value={key}>
                                        {key.split(":").pop()}
                                    </option>
                                ))}
                            </select>
                        </label>
                        <label>
                            {t("inspector.content.iconLabel")}
                            <select
                                value={block.icon ?? ""}
                                onChange={(event) =>
                                    onReplace({
                                        ...block,
                                        icon: event.target.value || null,
                                    })
                                }
                            >
                                <option value="">{t("inspector.none")}</option>
                                {iconIds.map((icon) => (
                                    <option key={icon} value={icon}>
                                        {icon.replace("icon.", "")}
                                    </option>
                                ))}
                            </select>
                        </label>
                        <label>
                            {t("inspector.content.formatLabel")}
                            <select
                                value={block.format ?? ""}
                                onChange={(event) =>
                                    onReplace({
                                        ...block,
                                        format: event.target.value || null,
                                    })
                                }
                            >
                                <option value="">{t("inspector.none")}</option>
                                {doc.formats.map((format) => (
                                    <option key={format.uuid} value={format.id}>
                                        {format.id.split(":").pop()}
                                    </option>
                                ))}
                            </select>
                        </label>
                    </div>
                </li>
            );
        case "description":
            return (
                <li className={rowClass()} {...rowProps} {...itemProps}>
                    {handle}
                    <span className="block-kind">
                        {t("inspector.content.text")}
                    </span>
                    {messageInput(
                        block.message,
                        `text-${block.uuid.slice(0, 8)}`,
                    )}
                    {controls}
                </li>
            );
        case "text":
            return (
                <li className={rowClass()} {...rowProps} {...itemProps}>
                    {handle}
                    <span className="block-kind">
                        {t("inspector.content.value")}
                    </span>
                    {sampleEditor(block.data)}
                    <span className="dim small">
                        {block.data.split(":").pop()}
                    </span>
                    {controls}
                </li>
            );
        case "conditional": {
            const encode = (reference: {
                kind: string;
                key?: string;
            }): string =>
                reference.kind === "literal"
                    ? "literal"
                    : `${reference.kind}:${reference.key}`;
            const decode = (
                encoded: string,
            ): PresentationBlock extends never
                ? never
                : NonNullable<unknown> => {
                if (encoded === "literal")
                    return {
                        kind: "literal",
                        value: { kind: "integer", value: "1" },
                    };
                const [kind, ...rest] = encoded.split(":");
                return { kind: kind as "fact" | "data", key: rest.join(":") };
            };
            const literalValue =
                block.condition.right?.kind === "literal" &&
                "value" in block.condition.right
                    ? scalarText(block.condition.right.value)
                    : null;
            const referenceOptions = (
                <>
                    <optgroup label={t("inspector.content.factGroup")}>
                        {doc.viewerFacts.map((fact) => (
                            <option key={fact.id} value={`fact:${fact.id}`}>
                                {fact.id.split(":").pop()}
                            </option>
                        ))}
                    </optgroup>
                    <optgroup label={t("inspector.content.dataGroup")}>
                        {presentationKeys.map((key) => (
                            <option key={key} value={`data:${key}`}>
                                {key.split(":").pop()}
                            </option>
                        ))}
                    </optgroup>
                    <option value="literal">
                        {t("inspector.content.literal")}
                    </option>
                </>
            );
            return (
                <li
                    className={rowClass("block-group")}
                    {...rowProps}
                    {...itemProps}
                >
                    {handle}
                    <span className="block-kind">
                        {t("inspector.content.conditional")}
                    </span>
                    <span className="condition-editor">
                        <select
                            value={encode(block.condition.left)}
                            onChange={(event) =>
                                onReplace({
                                    ...block,
                                    condition: {
                                        ...block.condition,
                                        left: decode(
                                            event.target.value,
                                        ) as never,
                                    },
                                })
                            }
                        >
                            {referenceOptions}
                        </select>
                        <select
                            value={block.condition.operator}
                            onChange={(event) =>
                                onReplace({
                                    ...block,
                                    condition: {
                                        ...block.condition,
                                        operator: event.target.value as never,
                                        right:
                                            event.target.value === "EXISTS"
                                                ? null
                                                : block.condition.right,
                                    },
                                })
                            }
                        >
                            {Object.entries(OPERATOR_GLYPHS).map(
                                ([operator, glyph]) => (
                                    <option key={operator} value={operator}>
                                        {glyph}
                                    </option>
                                ),
                            )}
                        </select>
                        {block.condition.operator !== "EXISTS" ? (
                            <>
                                <select
                                    value={
                                        block.condition.right
                                            ? encode(block.condition.right)
                                            : "literal"
                                    }
                                    onChange={(event) =>
                                        onReplace({
                                            ...block,
                                            condition: {
                                                ...block.condition,
                                                right: decode(
                                                    event.target.value,
                                                ) as never,
                                            },
                                        })
                                    }
                                >
                                    {referenceOptions}
                                </select>
                                {literalValue !== null ? (
                                    <input
                                        className="sample-input"
                                        value={literalValue}
                                        onChange={(event) => {
                                            if (
                                                !/^-?\d+$/.test(
                                                    event.target.value,
                                                )
                                            )
                                                return;
                                            onReplace({
                                                ...block,
                                                condition: {
                                                    ...block.condition,
                                                    right: {
                                                        kind: "literal",
                                                        value: {
                                                            kind: "integer",
                                                            value: event.target
                                                                .value,
                                                        },
                                                    },
                                                },
                                            });
                                        }}
                                    />
                                ) : null}
                            </>
                        ) : null}
                    </span>
                    {controls}
                    <div className="block-nested">
                        <p className="dim small">
                            {t("inspector.content.then")}
                        </p>
                        <NestedRows
                            doc={doc}
                            item={item}
                            blocks={block.thenBlocks}
                            locale={locale}
                            onSetMessage={onSetMessage}
                        />
                        {block.otherwiseBlocks.length > 0 ? (
                            <>
                                <p className="dim small">
                                    {t("inspector.content.otherwise")}
                                </p>
                                <NestedRows
                                    doc={doc}
                                    item={item}
                                    blocks={block.otherwiseBlocks}
                                    locale={locale}
                                    onSetMessage={onSetMessage}
                                />
                            </>
                        ) : null}
                    </div>
                </li>
            );
        }
        case "repeat":
            return (
                <li
                    className={rowClass("block-group")}
                    {...rowProps}
                    {...itemProps}
                >
                    {handle}
                    <span className="block-kind">
                        {t("inspector.content.repeat")}
                    </span>
                    <span className="dim small">
                        {t("inspector.content.each", {
                            key: block.data.split(":").pop(),
                        })}
                    </span>
                    {controls}
                    <div className="block-nested">
                        {messageInput(
                            block.template.labelMessage,
                            `repeat-label-${block.uuid.slice(0, 8)}`,
                        )}
                        {messageInput(
                            block.template.missingMessage,
                            `repeat-missing-${block.uuid.slice(0, 8)}`,
                        )}
                    </div>
                </li>
            );
        case "nestedItemList":
            return (
                <li className={rowClass()} {...rowProps} {...itemProps}>
                    {handle}
                    <span className="block-kind">
                        {t("inspector.content.nested")}
                    </span>
                    <span className="dim small">
                        {t("inspector.content.nestedHint")}
                    </span>
                    {controls}
                </li>
            );
        default:
            return null;
    }
}

function NestedRows({
    doc,
    item,
    blocks,
    locale,
    onSetMessage,
}: {
    doc: ProjectDocument;
    item: ItemNode;
    blocks: readonly PresentationBlock[];
    locale: string;
    onSetMessage: (key: string, value: string) => void;
}) {
    return (
        <ol className="block-list">
            {blocks.map((nested) => (
                <BlockRow
                    key={nested.uuid}
                    doc={doc}
                    item={item}
                    block={nested}
                    locale={locale}
                    onSetMessage={onSetMessage}
                    onReplace={() => {}}
                    onRemove={() => {}}
                    nested
                />
            ))}
        </ol>
    );
}
