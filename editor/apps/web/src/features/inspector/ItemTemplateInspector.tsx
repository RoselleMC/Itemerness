import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
    ITEM_QUALITY_TIERS,
    ITEM_TEMPLATE_FIELDS,
    itemTemplateOverlay,
    itemTemplateRegistryOf,
    overriddenItemTemplateFields,
    pendingItemTemplateFields,
    qualityThemeOf,
    qualityTierOfTheme,
    type ItemTemplate,
    type ItemTemplateField,
    type RunoRpgCatalogItem,
} from "@itemerness/protocol";
import { useEditorStore } from "../../state/store.js";
import {
    RunoRpgModifierEditor,
    RunoRpgSkillEditor,
} from "../runorpg/RunoRpgContractEditors.js";
import { loadRunoRpgCatalog } from "../runorpg/catalogCache.js";
import {
    createInstanceFromTemplate,
    saveInstance,
    suggestedInstanceLocalId,
} from "../runorpg/templateBinding.js";

/**
 * Template editing.
 *
 * A template is a prefab, so this panel edits exactly the values an instance inherits and nothing
 * else — no id, no display name, no description, because those are what makes one item different
 * from the next one of the same kind.
 *
 * Lore layout is authored on a real item and pulled up here rather than being rebuilt with a second
 * block editor. One block editor means one set of bugs, and "make this item's lore the rule for
 * every sword" is the workflow people actually described.
 */

const APPLY_LABEL_KEYS: Record<ItemTemplateField, string> = {
    material: "inspector.itemTemplate.field.material",
    layout: "inspector.itemTemplate.field.layout",
    theme: "inspector.itemTemplate.field.theme",
    mode: "inspector.itemTemplate.field.mode",
    maxStackSize: "inspector.itemTemplate.field.maxStackSize",
    unbreakable: "inspector.itemTemplate.field.unbreakable",
    itemTier: "inspector.itemTemplate.field.itemTier",
    itemLevel: "inspector.itemTemplate.field.itemLevel",
    itemPrefix: "inspector.itemTemplate.field.itemPrefix",
    modifiers: "inspector.itemTemplate.field.modifiers",
    skills: "inspector.itemTemplate.field.skills",
    presentationBlocks: "inspector.itemTemplate.field.presentationBlocks",
};

export function ItemTemplateInspector() {
    const { t } = useTranslation();
    const store = useEditorStore();
    const registry = itemTemplateRegistryOf(store.document);
    const template = registry.templates.find(
        (entry) => entry.id === store.selectedTemplateId,
    );
    const catalog = store.runoRpgCatalog;
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState<{
        kind: "ok" | "error";
        text: string;
    } | null>(null);
    const [selectedInstances, setSelectedInstances] = useState<
        readonly string[] | null
    >(null);
    const [attachId, setAttachId] = useState("");
    const [newItem, setNewItem] = useState<{
        localId: string;
        displayName: string;
        description: string;
    } | null>(null);

    const bindings = useMemo(
        () =>
            template
                ? registry.bindings.filter(
                      (binding) => binding.templateId === template.id,
                  )
                : [],
        [registry.bindings, template],
    );

    const bound = useMemo(() => {
        if (!template || !catalog) return [];
        return bindings.flatMap((binding) => {
            const item = catalog.items.find(
                (entry) => entry.id === binding.instanceId,
            );
            if (!item) return [];
            return [
                {
                    binding,
                    item,
                    pending: pendingItemTemplateFields(template, binding, item),
                },
            ];
        });
    }, [bindings, catalog, template]);

    if (!template) {
        return (
            <aside className="inspector">
                <p className="muted">{t("inspector.itemTemplate.empty")}</p>
            </aside>
        );
    }

    const patch = (mutate: (current: ItemTemplate) => ItemTemplate) =>
        store.updateTemplate(template.uuid, mutate);

    const staleIds = bound
        .filter((entry) => entry.pending.length > 0)
        .map((entry) => entry.item.id);
    const checked = selectedInstances ?? staleIds;

    const toggleInstance = (id: string) =>
        setSelectedInstances(
            checked.includes(id)
                ? checked.filter((entry) => entry !== id)
                : [...checked, id],
        );

    /**
     * Pushes the template onto the checked instances.
     *
     * Each item is written with only the fields it has not overridden, and its binding is marked as
     * having seen this revision. A failure stops at the item that failed rather than continuing:
     * a half-applied batch that reports success is worse than one the author has to retry.
     */
    const applyToInstances = async () => {
        if (!catalog?.writable) return;
        setBusy(true);
        setMessage(null);
        let applied = 0;
        try {
            for (const entry of bound) {
                if (!checked.includes(entry.item.id)) continue;
                if (entry.pending.length > 0) {
                    await saveInstance(
                        entry.item,
                        itemTemplateOverlay(template, entry.pending),
                    );
                    applied += 1;
                }
                store.setTemplateBinding({
                    ...entry.binding,
                    templateRevisionSeen: template.revision,
                });
            }
            store.setRunoRpgCatalog(await loadRunoRpgCatalog(true));
            setSelectedInstances(null);
            setMessage({
                kind: "ok",
                text: t("inspector.itemTemplate.applied", { count: applied }),
            });
        } catch (error) {
            setMessage({ kind: "error", text: (error as Error).message });
        } finally {
            setBusy(false);
        }
    };

    /**
     * Creates one item from this template and hands the author straight to it.
     *
     * This is the only way an item is born: the template supplies material, frame, base attributes
     * and lore layout, the item file that lands on the server is an ordinary flat definition, and
     * the binding remembers where it came from so a later template edit can be offered to it.
     */
    const createItem = async () => {
        if (!newItem || !catalog?.writable) return;
        setBusy(true);
        setMessage(null);
        try {
            // Enabled from the start: an item created deliberately from a template is meant to
            // exist, and a draft that silently does nothing in game is a worse default.
            const created = await createInstanceFromTemplate(template, {
                ...newItem,
                enabled: true,
            });
            store.setTemplateBinding({
                instanceId: created,
                templateId: template.id,
                overriddenFields: [],
                templateRevisionSeen: template.revision,
            });
            store.setRunoRpgCatalog(await loadRunoRpgCatalog(true));
            setNewItem(null);
            store.selectItem(created);
            store.setMode("items");
        } catch (error) {
            setMessage({ kind: "error", text: (error as Error).message });
        } finally {
            setBusy(false);
        }
    };

    /** Adopts an existing catalogue item, recording everything it already differs on. */
    const attachInstance = (item: RunoRpgCatalogItem) => {
        store.setTemplateBinding({
            instanceId: item.id,
            templateId: template.id,
            overriddenFields: overriddenItemTemplateFields(template, {
                ...item,
                layout: item.layout ?? template.layout,
                theme: item.theme ?? template.theme,
            }),
            templateRevisionSeen: template.revision,
        });
        setAttachId("");
    };

    const unbound = (catalog?.items ?? []).filter(
        (item) =>
            !registry.bindings.some(
                (binding) => binding.instanceId === item.id,
            ),
    );

    const importBlocksFrom = (item: RunoRpgCatalogItem) =>
        patch((current) => ({
            ...current,
            presentationBlocks: structuredClone(item.presentationBlocks),
            presentationMessages: { ...item.presentationMessages },
        }));

    return (
        <aside
            className="inspector"
            aria-label={t("inspector.itemTemplate.heading")}
            data-testid="item-template-inspector"
        >
            <section>
                <h3>{t("inspector.itemTemplate.heading")}</h3>
                <label className="field">
                    <span>{t("inspector.itemTemplate.displayName")}</span>
                    <input
                        value={template.displayName}
                        onChange={(event) =>
                            patch((current) => ({
                                ...current,
                                displayName: event.target.value,
                            }))
                        }
                        data-testid="template-display-name"
                    />
                </label>
                <label className="field">
                    <span>{t("inspector.itemTemplate.id")}</span>
                    <input
                        value={template.id}
                        onChange={(event) =>
                            patch((current) => ({
                                ...current,
                                id: event.target.value,
                            }))
                        }
                        data-testid="template-id"
                    />
                </label>
                <label className="field">
                    <span>{t("inspector.itemTemplate.description")}</span>
                    <textarea
                        rows={2}
                        value={template.description}
                        onChange={(event) =>
                            patch((current) => ({
                                ...current,
                                description: event.target.value,
                            }))
                        }
                    />
                </label>
                <label className="checkbox">
                    <input
                        type="checkbox"
                        checked={template.enabled}
                        onChange={(event) =>
                            patch((current) => ({
                                ...current,
                                enabled: event.target.checked,
                            }))
                        }
                    />
                    <span>{t("inspector.itemTemplate.enabled")}</span>
                </label>
                <p className="muted small">
                    {t("inspector.itemTemplate.revision", {
                        revision: template.revision,
                    })}
                </p>
            </section>

            <section>
                <h3>{t("inspector.itemTemplate.appearance")}</h3>
                <label className="field">
                    <span>{t("inspector.itemTemplate.field.material")}</span>
                    <input
                        value={template.material}
                        onChange={(event) =>
                            patch((current) => ({
                                ...current,
                                material: event.target.value,
                            }))
                        }
                        data-testid="template-material"
                    />
                </label>
                <label className="field">
                    <span>{t("inspector.itemTemplate.field.layout")}</span>
                    <select
                        value={template.layout}
                        onChange={(event) =>
                            patch((current) => ({
                                ...current,
                                layout: event.target.value,
                            }))
                        }
                    >
                        {store.document.layouts.map((layout) => (
                            <option key={layout.uuid} value={layout.id}>
                                {layout.id}
                            </option>
                        ))}
                    </select>
                </label>
                <label className="field">
                    <span>{t("inspector.itemTemplate.field.theme")}</span>
                    <select
                        value={template.theme}
                        onChange={(event) =>
                            patch((current) => ({
                                ...current,
                                theme: event.target.value,
                            }))
                        }
                    >
                        {store.document.themes.map((theme) => (
                            <option key={theme.uuid} value={theme.id}>
                                {theme.id}
                            </option>
                        ))}
                    </select>
                </label>
                <label className="field">
                    <span>{t("inspector.itemTemplate.field.mode")}</span>
                    <select
                        value={template.mode}
                        onChange={(event) =>
                            patch((current) => ({
                                ...current,
                                mode: event.target.value as
                                    "unique" | "fungible",
                                maxStackSize:
                                    event.target.value === "unique"
                                        ? 1
                                        : current.maxStackSize,
                            }))
                        }
                    >
                        <option value="unique">
                            {t("runorpg.mode.unique")}
                        </option>
                        <option value="fungible">
                            {t("runorpg.mode.fungible")}
                        </option>
                    </select>
                </label>
                <label className="field">
                    <span>
                        {t("inspector.itemTemplate.field.maxStackSize")}
                    </span>
                    <input
                        type="number"
                        min={1}
                        max={99}
                        value={template.maxStackSize}
                        disabled={template.mode === "unique"}
                        onChange={(event) =>
                            patch((current) => ({
                                ...current,
                                maxStackSize: Math.min(
                                    99,
                                    Math.max(
                                        1,
                                        Number(event.target.value) || 1,
                                    ),
                                ),
                            }))
                        }
                    />
                </label>
                <label className="checkbox">
                    <input
                        type="checkbox"
                        checked={template.unbreakable}
                        onChange={(event) =>
                            patch((current) => ({
                                ...current,
                                unbreakable: event.target.checked,
                            }))
                        }
                    />
                    <span>{t("inspector.itemTemplate.field.unbreakable")}</span>
                </label>
            </section>

            <section>
                <h3>{t("inspector.itemTemplate.defaults")}</h3>
                <label className="field">
                    <span>{t("inspector.itemTemplate.field.itemTier")}</span>
                    <select
                        value={
                            qualityTierOfTheme(template.theme) ??
                            template.itemTier.trim().toLowerCase()
                        }
                        onChange={(event) => {
                            // Same rule as an item: the tier owns the frame, so the two cannot
                            // drift apart in a prefab either.
                            const tier = event.target.value;
                            patch((current) => ({
                                ...current,
                                itemTier: tier,
                                theme: qualityThemeOf(tier) ?? current.theme,
                            }));
                        }}
                        data-testid="template-item-tier"
                    >
                        {ITEM_QUALITY_TIERS.map((tier) => (
                            <option key={tier} value={tier}>
                                {t(`inspector.quality.${tier}`)}
                            </option>
                        ))}
                    </select>
                </label>
                <label className="field">
                    <span>{t("inspector.itemTemplate.field.itemLevel")}</span>
                    <input
                        type="number"
                        min={0}
                        value={template.itemLevel}
                        onChange={(event) =>
                            patch((current) => ({
                                ...current,
                                itemLevel: Math.max(
                                    0,
                                    Number(event.target.value) || 0,
                                ),
                            }))
                        }
                    />
                </label>
                <label className="field">
                    <span>{t("inspector.itemTemplate.field.itemPrefix")}</span>
                    <input
                        value={template.itemPrefix}
                        onChange={(event) =>
                            patch((current) => ({
                                ...current,
                                itemPrefix: event.target.value,
                            }))
                        }
                    />
                </label>
            </section>

            <section>
                <h3>{t("inspector.itemTemplate.field.modifiers")}</h3>
                <RunoRpgModifierEditor
                    attributes={catalog?.attributes ?? []}
                    itemId={template.id}
                    modifiers={template.baseModifiers}
                    onChange={(baseModifiers) =>
                        patch((current) => ({ ...current, baseModifiers }))
                    }
                />
            </section>

            <section>
                <h3>{t("inspector.itemTemplate.field.skills")}</h3>
                <RunoRpgSkillEditor
                    skills={template.baseSkills}
                    onChange={(baseSkills) =>
                        patch((current) => ({ ...current, baseSkills }))
                    }
                />
            </section>

            <section>
                <h3>{t("inspector.itemTemplate.lore")}</h3>
                <p className="muted small">
                    {t("inspector.itemTemplate.loreHint")}
                </p>
                <p className="muted small">
                    {t("inspector.itemTemplate.loreCount", {
                        count: template.presentationBlocks.length,
                    })}
                </p>
                <label className="field">
                    <span>{t("inspector.itemTemplate.loreImport")}</span>
                    <select
                        value=""
                        onChange={(event) => {
                            const item = catalog?.items.find(
                                (entry) => entry.id === event.target.value,
                            );
                            if (item) importBlocksFrom(item);
                        }}
                        data-testid="template-lore-import"
                    >
                        <option value="">—</option>
                        {(catalog?.items ?? []).map((item) => (
                            <option key={item.id} value={item.id}>
                                {item.displayName}
                            </option>
                        ))}
                    </select>
                </label>
                {template.presentationBlocks.length > 0 ? (
                    <button
                        type="button"
                        onClick={() =>
                            patch((current) => ({
                                ...current,
                                presentationBlocks: [],
                                presentationMessages: {},
                            }))
                        }
                    >
                        {t("inspector.itemTemplate.loreClear")}
                    </button>
                ) : null}
            </section>

            <section>
                <h3>{t("inspector.itemTemplate.create")}</h3>
                {newItem ? (
                    <>
                        <label className="field">
                            <span>{t("runorpg.localId")}</span>
                            <input
                                value={newItem.localId}
                                onChange={(event) =>
                                    setNewItem({
                                        ...newItem,
                                        localId:
                                            event.target.value.toLowerCase(),
                                    })
                                }
                                data-testid="template-new-item-id"
                            />
                        </label>
                        <label className="field">
                            <span>{t("runorpg.displayName")}</span>
                            <input
                                value={newItem.displayName}
                                onChange={(event) =>
                                    setNewItem({
                                        ...newItem,
                                        displayName: event.target.value,
                                    })
                                }
                                data-testid="template-new-item-name"
                            />
                        </label>
                        <label className="field">
                            <span>{t("runorpg.description")}</span>
                            <input
                                value={newItem.description}
                                onChange={(event) =>
                                    setNewItem({
                                        ...newItem,
                                        description: event.target.value,
                                    })
                                }
                            />
                        </label>
                        <div className="runorpg-create-actions">
                            <button
                                type="button"
                                onClick={() => setNewItem(null)}
                                disabled={busy}
                            >
                                {t("common.close")}
                            </button>
                            <button
                                type="button"
                                className="primary-command"
                                onClick={() => void createItem()}
                                disabled={
                                    busy ||
                                    newItem.localId.trim() === "" ||
                                    newItem.displayName.trim() === ""
                                }
                                data-testid="template-create-item-confirm"
                            >
                                {t("inspector.itemTemplate.createConfirm")}
                            </button>
                        </div>
                    </>
                ) : (
                    <button
                        type="button"
                        className="primary-command"
                        disabled={!catalog?.writable}
                        onClick={() =>
                            setNewItem({
                                localId: suggestedInstanceLocalId(
                                    template,
                                    (catalog?.items ?? []).map(
                                        (item) => item.id,
                                    ),
                                ),
                                displayName: template.displayName,
                                description: template.description,
                            })
                        }
                        data-testid="template-create-item"
                    >
                        {t("inspector.itemTemplate.create")}
                    </button>
                )}
                <p className="muted small">
                    {t("inspector.itemTemplate.createHint")}
                </p>
            </section>

            <section>
                <h3>{t("inspector.itemTemplate.instances")}</h3>
                {bound.length === 0 ? (
                    <p className="muted small">
                        {t("inspector.itemTemplate.noInstances")}
                    </p>
                ) : (
                    <ul className="template-instance-list">
                        {bound.map((entry) => (
                            <li key={entry.item.id}>
                                <label className="checkbox">
                                    <input
                                        type="checkbox"
                                        checked={checked.includes(
                                            entry.item.id,
                                        )}
                                        onChange={() =>
                                            toggleInstance(entry.item.id)
                                        }
                                    />
                                    <span>{entry.item.displayName}</span>
                                </label>
                                <span className="dim small">
                                    {entry.pending.length === 0
                                        ? t("inspector.itemTemplate.upToDate")
                                        : entry.pending
                                              .map((field) =>
                                                  t(APPLY_LABEL_KEYS[field]),
                                              )
                                              .join("、")}
                                </span>
                                {entry.binding.overriddenFields.length > 0 ? (
                                    <span className="dim small">
                                        {t(
                                            "inspector.itemTemplate.overridden",
                                            {
                                                fields: entry.binding.overriddenFields
                                                    .map((field) =>
                                                        t(
                                                            APPLY_LABEL_KEYS[
                                                                field
                                                            ],
                                                        ),
                                                    )
                                                    .join("、"),
                                            },
                                        )}
                                    </span>
                                ) : null}
                                <button
                                    type="button"
                                    onClick={() =>
                                        store.removeTemplateBinding(
                                            entry.item.id,
                                        )
                                    }
                                >
                                    {t("inspector.itemTemplate.detach")}
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
                <button
                    type="button"
                    className="primary-command"
                    onClick={() => void applyToInstances()}
                    disabled={
                        busy || staleIds.length === 0 || !catalog?.writable
                    }
                    data-testid="template-apply-all"
                >
                    {t("inspector.itemTemplate.apply", {
                        count: checked.length,
                    })}
                </button>
                <label className="field">
                    <span>{t("inspector.itemTemplate.attach")}</span>
                    <select
                        value={attachId}
                        onChange={(event) => {
                            const item = unbound.find(
                                (entry) => entry.id === event.target.value,
                            );
                            if (item) attachInstance(item);
                        }}
                        data-testid="template-attach-instance"
                    >
                        <option value="">—</option>
                        {unbound.map((item) => (
                            <option key={item.id} value={item.id}>
                                {item.displayName}
                            </option>
                        ))}
                    </select>
                </label>
                {message ? (
                    <p
                        className={
                            message.kind === "error" ? "error" : "muted small"
                        }
                        role="status"
                    >
                        {message.text}
                    </p>
                ) : null}
            </section>

            <section>
                <button
                    type="button"
                    onClick={() => store.removeTemplate(template.uuid)}
                    data-testid="template-delete"
                >
                    {t("inspector.itemTemplate.delete")}
                </button>
                <p className="muted small">
                    {t("inspector.itemTemplate.deleteHint")}
                </p>
            </section>
        </aside>
    );
}

/** Exported for tests: every template field must carry a label. */
export const ITEM_TEMPLATE_FIELD_LABEL_KEYS = ITEM_TEMPLATE_FIELDS.map(
    (field) => APPLY_LABEL_KEYS[field],
);
