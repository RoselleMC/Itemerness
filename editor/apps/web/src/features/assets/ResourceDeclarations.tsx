import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Tabs } from "@base-ui/react/tabs";
import { Check, Copy, Plus, Trash2, X } from "lucide-react";
import type {
    AssetProfileNode,
    BitmapNode,
    FontNode,
    GlyphNode,
    ProjectDocument,
    ResourcePackBindingNode,
    TooltipStyleNode,
} from "@itemerness/protocol";
import { useEditorStore } from "../../state/store.js";
import {
    ASSET_KINDS,
    assetError,
    assetIdError,
    assetReferences,
    newAsset,
    removeAsset,
    renameAsset,
    updateAsset,
    type AssetKind,
    type AssetNode,
    type AssetSection,
} from "../../state/assetLibrary.js";
import {
    confirmAction,
    describeContext,
    type MenuAction,
} from "../../state/interface.js";
import { copyAction } from "../common/contextActions.js";
import { commitInlineEditor } from "../common/inlineEdit.js";
import { usePendingDocumentChange } from "../common/usePendingDocumentChange.js";
import { AssetText } from "./AssetFields.js";
import { FontForm } from "./FontForm.js";
import { BitmapForm, GlyphForm } from "./GlyphBitmapForm.js";
import {
    BindingForm,
    ProfileForm,
    TooltipStyleForm,
} from "./ProfileBindingForm.js";
import { ResourcePolicies } from "./ResourcePolicies.js";

const SECTIONS: readonly AssetSection[] = [
    ...ASSET_KINDS,
    "spacing",
    "measurement",
];
type Draft = { kind: AssetKind; node: AssetNode };

export function ResourceDeclarations() {
    const store = useEditorStore();
    return <DeclarationEditor key={store.workspaceEpoch} />;
}

function DeclarationEditor() {
    const { t } = useTranslation();
    const store = useEditorStore();
    const document = store.document;
    const section = store.selectedAssetKind;
    const tabs = useRef<HTMLDivElement>(null);
    const [horizontal, setHorizontal] = useState(
        () => matchMedia("(max-width: 650px)").matches,
    );
    useEffect(() => {
        const query = matchMedia("(max-width: 650px)");
        const update = () => setHorizontal(query.matches);
        query.addEventListener("change", update);
        return () => query.removeEventListener("change", update);
    }, []);
    useEffect(() => {
        const list = tabs.current;
        if (!list || !horizontal) return;
        const reveal = () => {
            const active = list.querySelector<HTMLElement>("[data-active]");
            if (!active) return;
            const parent = list.getBoundingClientRect();
            const child = active.getBoundingClientRect();
            if (child.left < parent.left)
                list.scrollLeft += child.left - parent.left;
            else if (child.right > parent.right)
                list.scrollLeft += child.right - parent.right;
        };
        const observer = new ResizeObserver(reveal);
        observer.observe(list);
        const frame = requestAnimationFrame(reveal);
        return () => {
            observer.disconnect();
            cancelAnimationFrame(frame);
        };
    }, [section, horizontal]);
    const [query, setQuery] = useState("");
    const [draft, setDraft] = useState<Draft | null>(null);
    const pending = useRef(draft);
    const [error, setError] = useState<string | null>(null);
    const finishFields = usePendingDocumentChange(draft !== null, () =>
        setError("pendingDraft"),
    );
    const setPending = (value: Draft | null) => {
        pending.current = value;
        setDraft(value);
        setError(null);
    };
    const kind =
        section === "spacing" || section === "measurement" ? null : section;
    const node =
        pending.current?.node ??
        (kind
            ? (document[kind].find(
                  (entry) => entry.uuid === store.selectedAssetUuid,
              ) ?? document[kind][0])
            : null);
    const create = (kind: AssetKind, source?: AssetNode) => {
        if (!commitInlineEditor()) return;
        setPending({ kind, node: newAsset(document, kind, source) });
    };
    const apply = () => {
        if (!finishFields() || !pending.current) return;
        const value = pending.current;
        const current = useEditorStore.getState();
        const failure = assetError(current.document, value.kind, value.node);
        setError(failure);
        if (failure) return;
        current.updateDocument(
            (source) =>
                ({
                    ...source,
                    [value.kind]: [...source[value.kind], value.node],
                }) as ProjectDocument,
        );
        current.selectAsset(value.kind, value.node.uuid);
        setPending(null);
    };
    const update = (mutate: (source: AssetNode) => AssetNode) => {
        if (pending.current) {
            setPending({
                ...pending.current,
                node: mutate(pending.current.node),
            });
            return;
        }
        if (!kind || !node) return;
        store.updateDocument((source) =>
            updateAsset(source, kind, node.uuid, mutate),
        );
    };
    const remove = async (kind: AssetKind, node: AssetNode) => {
        if (
            !commitInlineEditor() ||
            !(await confirmAction({
                title: t("assetAuthoring.delete"),
                message: t("assetAuthoring.deleteConfirm", { id: node.id }),
                accept: t("menus.delete"),
            }))
        )
            return;
        const current = useEditorStore.getState();
        current.updateDocument((source) =>
            removeAsset(source, kind, node.uuid),
        );
        if (
            kind === "assetProfiles" &&
            current.assetProfileOverride === node.id &&
            !useEditorStore
                .getState()
                .document.assetProfiles.some((entry) => entry.id === node.id)
        )
            current.setAssetProfileOverride(null);
    };
    const actions = (kind: AssetKind, entry: AssetNode): MenuAction[] => [
        copyAction("copy-asset-id", t("menus.copyId"), entry.id),
        {
            id: "duplicate-asset",
            label: t("assetAuthoring.duplicate"),
            icon: Copy,
            disabled:
                !!draft ||
                (kind === "fonts" &&
                    (entry as FontNode).metrics.startsWith("builtin:")),
            run: () => create(kind, entry),
        },
        {
            id: "delete-asset",
            label: t("assetAuthoring.delete"),
            icon: Trash2,
            danger: true,
            separator: true,
            disabled:
                !!draft || assetReferences(document, kind, entry.id).length > 0,
            run: () => remove(kind, entry),
        },
    ];
    const issue =
        error ?? (node && kind ? assetError(document, kind, node) : null);
    const references =
        node && kind && !draft ? assetReferences(document, kind, node.id) : [];
    return (
        <Tabs.Root
            className="resource-declarations"
            orientation={horizontal ? "horizontal" : "vertical"}
            value={section}
            onValueChange={(value, event) => {
                if (!commitInlineEditor()) {
                    event.cancel();
                    return;
                }
                if (
                    typeof value === "string" &&
                    SECTIONS.includes(value as AssetSection)
                ) {
                    store.selectAsset(value as AssetSection);
                    setQuery("");
                    setError(null);
                }
            }}
        >
            <Tabs.List
                ref={tabs}
                className="asset-category-tabs"
                aria-label={t("assetAuthoring.categories")}
            >
                {SECTIONS.map((value) => (
                    <Tabs.Tab
                        key={value}
                        value={value}
                        data-testid={`asset-section-${value}`}
                    >
                        {t(`assetAuthoring.sections.${value}`)}
                        {value !== "spacing" && value !== "measurement" && (
                            <span className="muted">
                                {document[value].length}
                            </span>
                        )}
                    </Tabs.Tab>
                ))}
            </Tabs.List>
            {SECTIONS.map((value) => (
                <Tabs.Panel
                    key={value}
                    value={value}
                    className="asset-category-panel"
                >
                    {section === value &&
                        (kind ? (
                            <div className="asset-library-layout">
                                <div className="asset-library-list">
                                    <input
                                        type="search"
                                        aria-label={t("assetAuthoring.search")}
                                        placeholder={t("assetAuthoring.search")}
                                        value={query}
                                        onChange={(event) =>
                                            setQuery(event.target.value)
                                        }
                                        data-testid="asset-library-search"
                                    />
                                    <ul>
                                        {document[kind]
                                            .filter((entry) =>
                                                entry.id
                                                    .toLowerCase()
                                                    .includes(
                                                        query.toLowerCase(),
                                                    ),
                                            )
                                            .map((entry) => (
                                                <li key={entry.uuid}>
                                                    <button
                                                        type="button"
                                                        className={`asset-library-row ${node?.uuid === entry.uuid ? "selected" : ""}`}
                                                        data-testid={`asset-entry-${entry.id}`}
                                                        onClick={() => {
                                                            if (
                                                                commitInlineEditor()
                                                            ) {
                                                                store.selectAsset(
                                                                    kind,
                                                                    entry.uuid,
                                                                );
                                                                setError(null);
                                                            }
                                                        }}
                                                        onContextMenu={(
                                                            event,
                                                        ) => {
                                                            if (
                                                                !commitInlineEditor()
                                                            ) {
                                                                event.preventDefault();
                                                                event.stopPropagation();
                                                                return;
                                                            }
                                                            describeContext(
                                                                event,
                                                                {
                                                                    label: entry.id,
                                                                    items: actions(
                                                                        kind,
                                                                        entry,
                                                                    ),
                                                                },
                                                            );
                                                        }}
                                                    >
                                                        {entry.id}
                                                    </button>
                                                </li>
                                            ))}
                                    </ul>
                                    <button
                                        type="button"
                                        className="page-command"
                                        data-testid="asset-create"
                                        disabled={!!draft}
                                        onClick={() => create(kind)}
                                    >
                                        <Plus size={15} />
                                        {t("assetAuthoring.create")}
                                    </button>
                                </div>
                                <div
                                    className="asset-detail"
                                    data-buffered-value={
                                        draft ? true : undefined
                                    }
                                    data-dirty={draft ? true : undefined}
                                >
                                    {node ? (
                                        <>
                                            <div className="asset-detail-heading">
                                                <h3>
                                                    {t(
                                                        `assetAuthoring.sections.${kind}`,
                                                    )}
                                                </h3>
                                                <div className="asset-detail-actions">
                                                    {!draft &&
                                                        actions(kind, node)
                                                            .filter(
                                                                (action) =>
                                                                    action.id !==
                                                                    "copy-asset-id",
                                                            )
                                                            .map((action) => {
                                                                const Icon =
                                                                    action.icon!;
                                                                return (
                                                                    <button
                                                                        key={
                                                                            action.id
                                                                        }
                                                                        type="button"
                                                                        className="icon-button"
                                                                        aria-label={
                                                                            action.label
                                                                        }
                                                                        data-tooltip={
                                                                            action.label
                                                                        }
                                                                        disabled={
                                                                            action.disabled
                                                                        }
                                                                        data-testid={
                                                                            action.id
                                                                        }
                                                                        onClick={() =>
                                                                            action.run?.()
                                                                        }
                                                                    >
                                                                        <Icon
                                                                            size={
                                                                                15
                                                                            }
                                                                        />
                                                                    </button>
                                                                );
                                                            })}
                                                </div>
                                            </div>
                                            <AssetText
                                                name="id"
                                                value={node.id}
                                                owner={node.uuid}
                                                validate={(id) =>
                                                    assetIdError(
                                                        document,
                                                        kind,
                                                        node.uuid,
                                                        id,
                                                    )
                                                }
                                                onChange={(id) => {
                                                    if (pending.current) {
                                                        setPending({
                                                            ...pending.current,
                                                            node: {
                                                                ...pending
                                                                    .current
                                                                    .node,
                                                                id,
                                                            },
                                                        });
                                                        return;
                                                    }
                                                    const old = node.id;
                                                    store.updateDocument(
                                                        (source) =>
                                                            renameAsset(
                                                                source,
                                                                kind,
                                                                node.uuid,
                                                                id,
                                                            ),
                                                    );
                                                    if (
                                                        kind ===
                                                            "assetProfiles" &&
                                                        store.assetProfileOverride ===
                                                            old
                                                    )
                                                        store.setAssetProfileOverride(
                                                            id,
                                                        );
                                                }}
                                            />
                                            {references.length > 0 && (
                                                <details className="asset-references">
                                                    <summary>
                                                        {t(
                                                            "assetAuthoring.references",
                                                            {
                                                                count: references.length,
                                                            },
                                                        )}
                                                    </summary>
                                                    <ul>
                                                        {references.map(
                                                            (reference) => (
                                                                <li
                                                                    key={
                                                                        reference
                                                                    }
                                                                >
                                                                    {reference}
                                                                </li>
                                                            ),
                                                        )}
                                                    </ul>
                                                </details>
                                            )}
                                            <ResourceForm
                                                key={node.uuid}
                                                kind={kind}
                                                node={node}
                                                document={document}
                                                update={update}
                                            />
                                            {issue && (
                                                <p
                                                    className="error small"
                                                    role="alert"
                                                    data-testid="asset-validation-error"
                                                >
                                                    {t(
                                                        `assetAuthoring.errors.${issue}`,
                                                    )}
                                                </p>
                                            )}
                                            {draft && (
                                                <div className="asset-draft-actions">
                                                    <button
                                                        type="button"
                                                        className="page-command"
                                                        data-testid="asset-apply"
                                                        onClick={apply}
                                                    >
                                                        <Check size={15} />
                                                        {t(
                                                            "assetAuthoring.apply",
                                                        )}
                                                    </button>
                                                    <button
                                                        type="button"
                                                        className="page-command"
                                                        data-testid="asset-cancel"
                                                        onMouseDown={(event) =>
                                                            event.preventDefault()
                                                        }
                                                        onClick={() =>
                                                            setPending(null)
                                                        }
                                                    >
                                                        <X size={15} />
                                                        {t(
                                                            "assetAuthoring.cancel",
                                                        )}
                                                    </button>
                                                </div>
                                            )}
                                        </>
                                    ) : (
                                        <button
                                            type="button"
                                            className="page-command"
                                            onClick={() => create(kind)}
                                        >
                                            <Plus size={15} />
                                            {t("assetAuthoring.create")}
                                        </button>
                                    )}
                                </div>
                            </div>
                        ) : (
                            <ResourcePolicies
                                document={document}
                                section={section as "spacing" | "measurement"}
                            />
                        ))}
                </Tabs.Panel>
            ))}
        </Tabs.Root>
    );
}

function ResourceForm({
    kind,
    node,
    document,
    update,
}: {
    kind: AssetKind;
    node: AssetNode;
    document: ProjectDocument;
    update(change: (source: AssetNode) => AssetNode): void;
}) {
    switch (kind) {
        case "fonts":
            return (
                <FontForm
                    font={node as FontNode}
                    document={document}
                    update={(change) =>
                        update((source) => change(source as FontNode))
                    }
                />
            );
        case "glyphs":
            return (
                <GlyphForm
                    glyph={node as GlyphNode}
                    document={document}
                    update={(change) =>
                        update((source) => change(source as GlyphNode))
                    }
                />
            );
        case "bitmaps":
            return (
                <BitmapForm
                    bitmap={node as BitmapNode}
                    document={document}
                    update={(change) =>
                        update((source) => change(source as BitmapNode))
                    }
                />
            );
        case "assetProfiles":
            return (
                <ProfileForm
                    profile={node as AssetProfileNode}
                    document={document}
                    update={(change) =>
                        update((source) => change(source as AssetProfileNode))
                    }
                />
            );
        case "resourcePackBindings":
            return (
                <BindingForm
                    binding={node as ResourcePackBindingNode}
                    document={document}
                    update={(change) =>
                        update((source) =>
                            change(source as ResourcePackBindingNode),
                        )
                    }
                />
            );
        case "tooltipStyles":
            return (
                <TooltipStyleForm
                    style={node as TooltipStyleNode}
                    update={(change) =>
                        update((source) => change(source as TooltipStyleNode))
                    }
                />
            );
    }
}
