import { itemKey, itemLayout, itemTheme } from "@itemerness/protocol";
import { type ReactNode, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { Trash2, GitBranch, Copy, Plus, RotateCcw, Group } from "lucide-react";
import { duplicateSelectedContent } from "../../state/contentActions.js";
import type {
    DataValue,
    FieldSeparator,
    ItemNode,
    PresentationBlock,
    ProjectDocument,
} from "@itemerness/protocol";
import { useEditorStore } from "../../state/store.js";
import { locateBlock, editBlockTree } from "../../state/blocks.js";
import {
    blockLabel,
    humanizePath,
    resolveMessage,
} from "../common/messages.js";
import { ItemIcon } from "../common/ItemIcon.js";
import type { PreviewBundle } from "../preview/usePreview.js";
import { SelectField } from "../common/SelectField.js";
import { deleteItem, duplicateItem } from "../../state/itemActions.js";
import { describeContext } from "../../state/interface.js";
import { itemActions, contentActions } from "../common/contextActions.js";
import { ConditionEditor } from "../common/ConditionEditor.js";
import { commitInlineEditor } from "../common/inlineEdit.js";
import { DataValueEditor } from "../common/DataValueEditor.js";
import { BufferedInput } from "../common/BufferedInput.js";
import { ItemDefinitionEditor } from "./ItemDefinitionEditor.js";
import { ShownFlagsEditor } from "./ShownFlagsEditor.js";
import { GroupFields, RootGroupFields, SeparatorField } from "./GroupFields.js";
import {
    HidingFields,
    ItemOverflowField,
    NameDecorationFields,
    PartStylesFields,
    RowFields,
    RuleFields,
} from "./CompositionFields.js";
import { hiddenBlockUuids } from "../../state/composition.js";
import { itemIdIssue, renameItem } from "../../state/itemIdentity.js";
import {
    representativeTheme,
    themeSelectorById,
    themeSelectorsOf,
} from "../../state/themeSelectorLibrary.js";
import {
    inferContentComponent,
    normalizeMaterial,
} from "./itemDefinitionEditing.js";
import {
    initialDataValue,
    itemDataKeys,
    resolveSampleValue,
    valueKindForType,
} from "../common/typedValues.js";
import {
    itemSourceFiles,
    setSourceFile,
    validSourcePath,
} from "../../state/sourceLayout.js";

/**
 * The inspector: edit what the preview shows, in the words the preview shows it.
 *
 * The design rule throughout is direct manipulation over schema exposure. The name field edits the
 * name; behind it the store writes the message for the language being previewed, but the person
 * typing never chooses a message key. Content rows read as "Attack Damage — 38.5", not as a block
 * type with a labelMessage. The ids, uuids, and keys that make the document robust still exist and
 * are still stable — folded into an advanced section, where the people who need them will look.
 */

export function ItemInspector({
    preview,
    previewSettings,
}: {
    preview: PreviewBundle;
    previewSettings?: ReactNode;
}) {
    const { t } = useTranslation();
    const store = useEditorStore();
    const { document: doc, viewerLocale } = store;

    const item = doc.items.find(
        (entry) => itemKey(doc, entry) === store.selectedItemId,
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
    const selected = store.selectedBlockUuid
        ? locateBlock(item.presentation.blocks, store.selectedBlockUuid)
        : null;
    const hidden = hiddenBlockUuids(
        item.presentation.blocks,
        preview.display?.hiddenElements ?? [],
    );
    if (selected) {
        const block = selected.block;
        const hiddenCount = hidden.get(block.uuid) ?? 0;
        const replace = (next: PresentationBlock) =>
            store.updateItem(item.uuid, (current) => ({
                ...current,
                presentation: {
                    ...current.presentation,
                    blocks: editBlockTree(
                        current.presentation.blocks,
                        block.uuid,
                        () => next,
                    ),
                },
            }));
        return (
            <aside
                className="inspector content-inspector"
                data-testid="content-inspector"
                data-inspector-mode="content"
                aria-label={t("inspector.content.heading")}
                onContextMenu={(event) =>
                    describeContext(event, {
                        label: t("inspector.content.heading"),
                        items: contentActions(block.uuid, t),
                    })
                }
            >
                <header className="content-inspector-header">
                    <h3>{t("inspector.content.heading")}</h3>
                    <div className="content-commands">
                        <button
                            type="button"
                            className="icon-button"
                            data-testid="content-duplicate"
                            data-tooltip={t("history.duplicate")}
                            aria-label={t("history.duplicate")}
                            onClick={duplicateSelectedContent}
                        >
                            <Copy size={16} />
                        </button>
                        <button
                            type="button"
                            className="icon-button danger"
                            data-testid="content-delete"
                            data-tooltip={t("inspector.content.remove")}
                            aria-label={t("inspector.content.remove")}
                            onClick={() =>
                                store.updateItem(item.uuid, (current) => ({
                                    ...current,
                                    presentation: {
                                        ...current.presentation,
                                        blocks: editBlockTree(
                                            current.presentation.blocks,
                                            block.uuid,
                                            () => null,
                                        ),
                                    },
                                }))
                            }
                        >
                            <Trash2 size={16} />
                        </button>
                    </div>
                </header>
                {selected.ancestors.length > 0 && (
                    <nav
                        className="content-ancestors"
                        aria-label={t("inspector.content.ancestors")}
                    >
                        {selected.ancestors.map((ancestor) => (
                            <button
                                key={ancestor.uuid}
                                type="button"
                                onClick={() => {
                                    if (commitInlineEditor())
                                        store.selectBlock(ancestor.uuid);
                                }}
                                data-testid={`select-parent-${ancestor.uuid}`}
                            >
                                {ancestor.type === "group" ? (
                                    <Group size={14} />
                                ) : (
                                    <GitBranch size={14} />
                                )}
                                {t(
                                    ancestor.type === "group"
                                        ? "inspector.content.group"
                                        : "inspector.content.conditional",
                                )}
                            </button>
                        ))}
                    </nav>
                )}
                <ol className="block-list" data-testid="block-list">
                    <BlockRow
                        key={block.uuid}
                        doc={doc}
                        item={item}
                        block={block}
                        locale={viewerLocale}
                        onSetMessage={setMessage}
                        onReplace={replace}
                        onRemove={() => {}}
                        nested
                    />
                </ol>
                <section className="content-presentation">
                    {/* A group emits no text of its own, so a style would have no effect. */}
                    {block.type !== "group" && (
                        <label className="field-inline">
                            {t("inspector.content.style")}
                            <SelectField
                                label={t("inspector.content.style")}
                                value={block.style ?? ""}
                                onValueChange={(value) =>
                                    replace({
                                        ...block,
                                        style: value || null,
                                    })
                                }
                                options={[
                                    { value: "", label: t("inspector.none") },
                                    ...Object.keys(
                                        representativeTheme(
                                            doc,
                                            itemTheme(doc, item),
                                        )?.styles ?? {},
                                    ).map((style) => ({
                                        value: style,
                                        label: humanizePath(style),
                                    })),
                                ]}
                            />
                        </label>
                    )}
                    {"wrapping" in block && (
                        <label className="field-inline">
                            {t("inspector.content.wrapping")}
                            <SelectField
                                label={t("inspector.content.wrapping")}
                                value={block.wrapping ?? ""}
                                onValueChange={(value) =>
                                    replace({
                                        ...block,
                                        wrapping: value || null,
                                    })
                                }
                                options={[
                                    { value: "", label: t("inspector.none") },
                                    ...Object.keys(
                                        doc.layouts.find(
                                            (layout) =>
                                                layout.id ===
                                                itemLayout(doc, item),
                                        )?.wrapping ?? {},
                                    ).map((policy) => ({
                                        value: policy,
                                        label: humanizePath(policy),
                                    })),
                                ]}
                            />
                        </label>
                    )}
                    {hiddenCount > 0 && (
                        <p
                            className="fallback-note"
                            data-testid="content-hidden-note"
                        >
                            {t("inspector.hiding.hiddenNow", {
                                count: hiddenCount,
                            })}
                        </p>
                    )}
                    <HidingFields
                        key={block.uuid}
                        item={item}
                        block={block}
                        onReplace={replace}
                    />
                </section>
            </aside>
        );
    }

    const selectedTheme =
        preview.display?.selectedTheme ?? itemTheme(doc, item) ?? "";
    // A selector names no theme itself; compare against the concrete theme it chose.
    const boundTheme = themeSelectorById(doc, itemTheme(doc, item))
        ? preview.display?.requestedTheme
        : itemTheme(doc, item);
    const themeFellBack =
        preview.display != null && preview.display.selectedTheme !== boundTheme;

    return (
        <aside
            className="inspector"
            data-testid="global-inspector"
            data-inspector-mode="global"
            aria-label={t("inspector.heading")}
            onContextMenu={(event) =>
                describeContext(event, {
                    label: name.text,
                    items: itemActions(item.uuid, t),
                })
            }
        >
            <header className="content-inspector-header">
                <h3>{t("inspector.heading")}</h3>
                <div className="content-commands">
                    <button
                        type="button"
                        className="icon-button"
                        data-testid="duplicate-item"
                        aria-label={t("menus.duplicateItem")}
                        data-tooltip={t("menus.duplicateItem")}
                        onClick={() => {
                            if (commitInlineEditor())
                                duplicateItem(item.uuid, t);
                        }}
                    >
                        <Copy size={16} />
                    </button>
                    <button
                        type="button"
                        className="icon-button danger"
                        data-testid="delete-item"
                        aria-label={t("inspector.advanced.deleteItem")}
                        data-tooltip={t("inspector.advanced.deleteItem")}
                        onClick={() => {
                            if (commitInlineEditor())
                                void deleteItem(item.uuid, t);
                        }}
                    >
                        <Trash2 size={16} />
                    </button>
                </div>
            </header>
            {/* --- Name -------------------------------------------------------------------- */}
            <section>
                <h3>{t("inspector.name.heading")}</h3>
                <input
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
                <NameDecorationFields key={item.uuid} item={item} />
            </section>
            {hidden.size > 0 && (
                <div className="fallback-note" data-testid="hidden-elements">
                    {t("inspector.hiding.hiddenSummary", {
                        count: preview.display?.hiddenElements.length ?? 0,
                    })}
                    <ul>
                        {[...hidden.keys()].map((uuid) => {
                            const located = locateBlock(
                                item.presentation.blocks,
                                uuid,
                            );
                            return located ? (
                                <li key={uuid}>
                                    <button
                                        type="button"
                                        className="text-command"
                                        onClick={() => {
                                            if (commitInlineEditor())
                                                store.selectBlock(uuid);
                                        }}
                                    >
                                        {blockLabel(
                                            doc,
                                            viewerLocale,
                                            located.block,
                                            t,
                                        )}
                                    </button>
                                </li>
                            ) : null;
                        })}
                    </ul>
                </div>
            )}

            {/* --- Appearance -------------------------------------------------------------- */}
            <section>
                <h3>{t("inspector.appearance.heading")}</h3>
                <div className="material-row">
                    <ItemIcon
                        materialId={item.definition.material}
                        label={name.text}
                        size={32}
                    />
                    <BufferedInput
                        label={t("inspector.advanced.material")}
                        owner={`${item.uuid}-material`}
                        suggestions={[
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
                            "shulker_box",
                            "chest",
                            "trapped_chest",
                            "barrel",
                        ]}
                        value={item.definition.material.replace(
                            /^minecraft:/,
                            "",
                        )}
                        validate={(raw) => {
                            const material = normalizeMaterial(raw);
                            if (!material)
                                return t("values.errors.namespacedKey");
                            return item.definition.contents.length &&
                                !inferContentComponent(material)
                                ? t("itemDefinition.errors.contentCarrier")
                                : null;
                        }}
                        onCommit={(raw) => {
                            const material = normalizeMaterial(raw);
                            if (!material) return;
                            store.updateItem(item.uuid, (current) => ({
                                ...current,
                                definition: {
                                    ...current.definition,
                                    material,
                                    contentComponent: current.definition
                                        .contents.length
                                        ? inferContentComponent(material)
                                        : null,
                                },
                            }));
                        }}
                        testId="material-input"
                    />
                </div>

                <p className="field-label">{t("inspector.appearance.theme")}</p>
                {doc.schemaVersion === 2 && (
                    <label className="item-theme-inherit">
                        <input
                            type="checkbox"
                            data-testid="item-theme-inherit"
                            checked={item.presentation.theme == null}
                            disabled={!doc.defaultTheme}
                            onChange={(event) => {
                                const inherited = event.target.checked;
                                if (commitInlineEditor())
                                    store.updateItem(item.uuid, (current) => ({
                                        ...current,
                                        presentation: {
                                            ...current.presentation,
                                            theme: inherited
                                                ? null
                                                : itemTheme(
                                                      useEditorStore.getState()
                                                          .document,
                                                      current,
                                                  ),
                                        },
                                    }));
                            }}
                        />
                        <span>
                            {t("projectSettings.inherit", {
                                id: doc.defaultTheme ?? t("inspector.none"),
                            })}
                        </span>
                    </label>
                )}
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
                            onContextMenu={(event) =>
                                describeContext(event, {
                                    label: theme.id,
                                    items: [
                                        {
                                            id: "apply-theme",
                                            label: t("menus.applyTheme"),
                                            checked:
                                                item.presentation.theme ===
                                                theme.id,
                                            run: () =>
                                                store.updateItem(
                                                    item.uuid,
                                                    (current) => ({
                                                        ...current,
                                                        presentation: {
                                                            ...current.presentation,
                                                            theme: theme.id,
                                                        },
                                                    }),
                                                ),
                                        },
                                        {
                                            id: "edit-theme",
                                            label: t("menus.editTheme"),
                                            run: () => {
                                                if (!commitInlineEditor())
                                                    return;
                                                store.setMode("themes");
                                                store.selectTheme(theme.id);
                                            },
                                        },
                                    ],
                                })
                            }
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
                    {themeSelectorsOf(doc).map((selector) => (
                        <button
                            key={selector.uuid}
                            type="button"
                            className={`theme-card selector-card ${item.presentation.theme === selector.id ? "selected" : ""}`}
                            onClick={() =>
                                store.updateItem(item.uuid, (current) => ({
                                    ...current,
                                    presentation: {
                                        ...current.presentation,
                                        theme: selector.id,
                                    },
                                }))
                            }
                            data-testid={`theme-selector-card-${selector.id.split(":").pop()}`}
                            onContextMenu={(event) =>
                                describeContext(event, {
                                    label: selector.id,
                                    items: [
                                        {
                                            id: "apply-theme",
                                            label: t("menus.applyTheme"),
                                            checked:
                                                item.presentation.theme ===
                                                selector.id,
                                            run: () =>
                                                store.updateItem(
                                                    item.uuid,
                                                    (current) => ({
                                                        ...current,
                                                        presentation: {
                                                            ...current.presentation,
                                                            theme: selector.id,
                                                        },
                                                    }),
                                                ),
                                        },
                                        {
                                            id: "edit-theme",
                                            label: t("menus.editTheme"),
                                            run: () => {
                                                if (!commitInlineEditor())
                                                    return;
                                                store.setMode("themes");
                                                store.selectTheme(selector.id);
                                            },
                                        },
                                    ],
                                })
                            }
                        >
                            <span className="theme-card-name">
                                {humanizePath(
                                    selector.id.split(":").pop() ?? selector.id,
                                )}
                            </span>
                            <span className="theme-card-kind">
                                {t("themeSelector.kind", {
                                    count: selector.cases.length,
                                })}
                            </span>
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
                <SelectField
                    label={t("inspector.appearance.layout")}
                    id="layout-select"
                    value={item.presentation.layout ?? ""}
                    onValueChange={(value) =>
                        store.updateItem(item.uuid, (current) => ({
                            ...current,
                            presentation: {
                                ...current.presentation,
                                layout: value || null,
                            },
                        }))
                    }
                    data-testid="form-layout"
                    options={[
                        ...(doc.schemaVersion === 2
                            ? [
                                  {
                                      value: "",
                                      label: t("projectSettings.inherit", {
                                          id:
                                              doc.defaultLayout ??
                                              t("inspector.none"),
                                      }),
                                      disabled: !doc.defaultLayout,
                                  },
                              ]
                            : []),
                        ...doc.layouts.map((layout) => ({
                            value: layout.id,
                            label: `${humanizePath(layout.id.split(":").pop() ?? layout.id)} - ${t(`inspector.layoutKind.${layout.kind}`)}`,
                        })),
                    ]}
                />
            </section>

            {/* --- Vanilla tooltip --------------------------------------------------------- */}
            <ShownFlagsEditor key={`${item.uuid}-shown-flags`} item={item} />

            {previewSettings}
            <ItemDefinitionEditor key={item.uuid} document={doc} item={item} />
            {/* --- Advanced ---------------------------------------------------------------- */}
            <details className="advanced" data-testid="item-advanced">
                <summary>{t("inspector.advanced.heading")}</summary>
                <label className="field">
                    <span>{t("inspector.advanced.id")}</span>
                    <BufferedInput
                        value={item.id}
                        owner={`${item.uuid}:id`}
                        label={t("inspector.advanced.id")}
                        testId="item-stable-id"
                        validate={(id) => {
                            const issue = itemIdIssue(
                                useEditorStore.getState().document,
                                item.uuid,
                                id,
                            );
                            return issue ? t(`itemIdentity.${issue}`) : null;
                        }}
                        onCommit={(id) =>
                            store.updateDocument((current) =>
                                renameItem(current, item.uuid, id),
                            )
                        }
                    />
                    {item.id !== itemKey(doc, item) && (
                        <code className="item-identity-key">
                            {itemKey(doc, item)}
                        </code>
                    )}
                </label>
                {doc.sourceLayout && (
                    <label className="field">
                        <span>{t("inspector.advanced.sourceFile")}</span>
                        <BufferedInput
                            value={doc.sourceLayout.files[item.uuid] ?? ""}
                            owner={`${item.uuid}:source-file`}
                            label={t("inspector.advanced.sourceFile")}
                            testId="item-source-file"
                            suggestions={itemSourceFiles(doc)}
                            validate={(path) =>
                                path === "" || validSourcePath(path, "items")
                                    ? null
                                    : t("inspector.advanced.sourceFileInvalid")
                            }
                            onCommit={(path) =>
                                store.updateDocument((current) =>
                                    setSourceFile(
                                        current,
                                        item.uuid,
                                        path === "" ? null : path,
                                    ),
                                )
                            }
                        />
                        <span className="muted small">
                            {t("inspector.advanced.sourceFileHint")}
                        </span>
                    </label>
                )}
                <RootGroupFields item={item} />
                <ItemOverflowField item={item} />
                <dl>
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
        const sample = resolveSampleValue(doc, item, dataKey);
        const commit = (value: DataValue) => {
            store.updateItem(item.uuid, (current) => ({
                ...current,
                previewData: [
                    ...current.previewData.filter(
                        (assignment) => assignment.key !== dataKey,
                    ),
                    { key: dataKey, value },
                ],
            }));
        };
        return (
            <div
                className="sample-editor"
                key={`${item.uuid}:${block.uuid}:${dataKey}`}
            >
                <div className="sample-source">
                    <span className="muted small">
                        {t(`values.sources.${sample.source}`)}
                    </span>
                    <button
                        type="button"
                        className="icon-button"
                        disabled={sample.source !== "preview"}
                        aria-label={t("values.resetPreview")}
                        data-tooltip={t("values.resetPreview")}
                        data-testid={`sample-${block.uuid}-reset`}
                        onClick={() =>
                            store.updateItem(item.uuid, (current) => ({
                                ...current,
                                previewData: current.previewData.filter(
                                    (entry) => entry.key !== dataKey,
                                ),
                            }))
                        }
                    >
                        <RotateCcw size={15} />
                    </button>
                </div>
                {sample.value ? (
                    <DataValueEditor
                        value={sample.value}
                        onChange={commit}
                        type={sample.schema?.type}
                        nullable={sample.schema?.nullable ?? true}
                        constraints={sample.schema?.constraints}
                        label={t("inspector.content.sample")}
                        testId={`sample-${block.uuid}`}
                    />
                ) : (
                    sample.schema && (
                        <button
                            type="button"
                            className="text-command"
                            onClick={() =>
                                commit(
                                    initialDataValue(
                                        valueKindForType(sample.schema!.type),
                                        sample.schema!.type,
                                    ),
                                )
                            }
                        >
                            <Plus size={15} />
                            {t("values.setPreview")}
                        </button>
                    )
                )}
            </div>
        );
    };

    // Separators may create a message, so they edit the document in one undo step.
    const applySeparator =
        (
            set: (
                current: PresentationBlock,
                next: FieldSeparator | undefined,
            ) => PresentationBlock,
        ) =>
        (document: ProjectDocument, separator: FieldSeparator | undefined) => ({
            ...document,
            items: document.items.map((entry) =>
                entry.uuid === item.uuid
                    ? {
                          ...entry,
                          presentation: {
                              ...entry.presentation,
                              blocks: editBlockTree(
                                  entry.presentation.blocks,
                                  block.uuid,
                                  (current) => set(current, separator),
                              ),
                          },
                      }
                    : entry,
            ),
        });
    const presentationKeys = itemDataKeys(doc, item)
        .filter((key) => key.presentationReadable)
        .map((key) => key.id);
    const iconIds = doc.glyphs
        .filter((glyph) => glyph.id.startsWith("icon."))
        .map((glyph) => glyph.id);

    const handle = nested ? null : (
        <span
            {...(dragHandleProps ?? {})}
            data-tooltip={t("inspector.content.dragHandle")}
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
        onClick: (event: MouseEvent) => {
            event.stopPropagation();
            if (commitInlineEditor()) store.selectBlock(block.uuid);
        },
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
                            <SelectField
                                label={t("inspector.content.dataLabel")}
                                value={block.data}
                                onValueChange={(value) =>
                                    onReplace({
                                        ...block,
                                        data: value,
                                    })
                                }
                                options={presentationKeys.map((key) => ({
                                    value: key,
                                    label: key.split(":").pop() ?? key,
                                }))}
                            />
                        </label>
                        <label>
                            {t("inspector.content.iconLabel")}
                            <SelectField
                                label={t("inspector.content.iconLabel")}
                                value={block.icon ?? ""}
                                onValueChange={(value) =>
                                    onReplace({
                                        ...block,
                                        icon: value || null,
                                    })
                                }
                                options={[
                                    { value: "", label: t("inspector.none") },
                                    ...iconIds.map((icon) => ({
                                        value: icon,
                                        label: icon.replace("icon.", ""),
                                    })),
                                ]}
                            />
                        </label>
                        <label>
                            {t("inspector.content.formatLabel")}
                            <SelectField
                                label={t("inspector.content.formatLabel")}
                                value={block.format ?? ""}
                                onValueChange={(value) =>
                                    onReplace({
                                        ...block,
                                        format: value || null,
                                    })
                                }
                                options={[
                                    { value: "", label: t("inspector.none") },
                                    ...doc.formats.map((format) => ({
                                        value: format.id,
                                        label:
                                            format.id.split(":").pop() ??
                                            format.id,
                                    })),
                                ]}
                            />
                        </label>
                        <details className="advanced">
                            <summary>
                                {t("inspector.content.moreOptions")}
                            </summary>
                            <SeparatorField
                                value={block.separator}
                                inheritable
                                testId="field-separator"
                                apply={applySeparator((current, separator) => {
                                    if (current.type !== "field")
                                        return current;
                                    const { separator: _previous, ...rest } =
                                        current;
                                    return separator
                                        ? { ...rest, separator }
                                        : rest;
                                })}
                            />
                            <PartStylesFields
                                item={item}
                                value={block.partStyles}
                                testId="field-part-styles"
                                onChange={(partStyles) => {
                                    const { partStyles: _previous, ...rest } =
                                        block;
                                    onReplace(
                                        partStyles
                                            ? { ...rest, partStyles }
                                            : rest,
                                    );
                                }}
                            />
                        </details>
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
                    <ConditionEditor
                        document={doc}
                        item={item}
                        condition={block.condition}
                        testId={`condition-${block.uuid}`}
                        onChange={(condition) =>
                            onReplace({ ...block, condition })
                        }
                    />
                    {controls}
                    <div className="block-nested">
                        <p className="dim small">
                            {t("inspector.content.then")}
                        </p>
                        <NestedRows
                            doc={doc}
                            blocks={block.thenBlocks}
                            locale={locale}
                        />
                        {block.otherwiseBlocks.length > 0 ? (
                            <>
                                <p className="dim small">
                                    {t("inspector.content.otherwise")}
                                </p>
                                <NestedRows
                                    doc={doc}
                                    blocks={block.otherwiseBlocks}
                                    locale={locale}
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
                        <details className="advanced">
                            <summary>
                                {t("inspector.content.moreOptions")}
                            </summary>
                            <SeparatorField
                                value={block.template.separator}
                                inheritable
                                testId="repeat-separator"
                                apply={applySeparator((current, separator) => {
                                    if (current.type !== "repeat")
                                        return current;
                                    const {
                                        separator: _previous,
                                        ...template
                                    } = current.template;
                                    return {
                                        ...current,
                                        template: separator
                                            ? { ...template, separator }
                                            : template,
                                    };
                                })}
                            />
                            <PartStylesFields
                                item={item}
                                value={block.template.partStyles}
                                testId="repeat-part-styles"
                                onChange={(partStyles) => {
                                    const {
                                        partStyles: _previous,
                                        ...template
                                    } = block.template;
                                    onReplace({
                                        ...block,
                                        template: partStyles
                                            ? { ...template, partStyles }
                                            : template,
                                    });
                                }}
                            />
                        </details>
                    </div>
                </li>
            );
        case "group":
            return (
                <li
                    className={rowClass("block-group")}
                    {...rowProps}
                    {...itemProps}
                >
                    {handle}
                    <span className="block-kind">
                        {t("inspector.content.group")}
                    </span>
                    {controls}
                    <GroupFields block={block} onReplace={onReplace} />
                    <div className="block-nested">
                        {block.header && (
                            <>
                                <p className="dim small">
                                    {t("inspector.content.groupHeader")}
                                </p>
                                <NestedRows
                                    doc={doc}
                                    blocks={[block.header]}
                                    locale={locale}
                                />
                            </>
                        )}
                        <p className="dim small">
                            {t("inspector.content.groupChildren")}
                        </p>
                        <NestedRows
                            doc={doc}
                            blocks={block.children}
                            locale={locale}
                        />
                    </div>
                </li>
            );
        case "row":
            return (
                <li className={rowClass()} {...rowProps} {...itemProps}>
                    {handle}
                    <span className="block-kind">
                        {t("inspector.content.row")}
                    </span>
                    {controls}
                    <RowFields
                        item={item}
                        block={block}
                        onReplace={onReplace}
                    />
                </li>
            );
        case "rule":
            return (
                <li className={rowClass()} {...rowProps} {...itemProps}>
                    {handle}
                    <span className="block-kind">
                        {t("inspector.content.rule")}
                    </span>
                    {controls}
                    <RuleFields
                        item={item}
                        block={block}
                        onReplace={onReplace}
                    />
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
    blocks,
    locale,
}: {
    doc: ProjectDocument;
    blocks: readonly PresentationBlock[];
    locale: string;
}) {
    const { t } = useTranslation();
    const selectBlock = useEditorStore((state) => state.selectBlock);
    return (
        <ol className="branch-list">
            {blocks.map((nested) => {
                const label = blockLabel(doc, locale, nested, t);
                return (
                    <li key={nested.uuid}>
                        <button
                            type="button"
                            data-testid={`select-child-${nested.uuid}`}
                            onClick={(event) => {
                                event.stopPropagation();
                                if (!commitInlineEditor()) return;
                                selectBlock(nested.uuid);
                            }}
                        >
                            {label}
                        </button>
                    </li>
                );
            })}
        </ol>
    );
}
