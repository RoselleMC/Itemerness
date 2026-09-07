import { useState } from "react";
import { useTranslation } from "react-i18next";
import { describeContext } from "../../state/interface.js";
import {
    itemActions,
    newItemAction,
    copyAction,
    relatedItems,
    blockUses,
} from "../common/contextActions.js";
import { useEditorStore, type EditorMode } from "../../state/store.js";
import {
    humanizePath,
    itemDisplayName,
    resolveMessage,
} from "../common/messages.js";
import { ItemIcon } from "../common/ItemIcon.js";
import {
    CircleCheck,
    CircleX,
    CircleDashed,
    LoaderCircle,
    CircleSlash,
} from "lucide-react";
import type { PreviewItemState } from "../../api/previewCache.js";

/**
 * The library rail.
 *
 * Four modes — items, themes, layouts, data — share one list. Rows lead with what a human
 * recognises: the item's texture and localized name, a theme's colour swatch, a data key's label.
 * The namespaced ids still exist and are stable; they live in each inspector's advanced fold.
 */
export function Sidebar({
    itemStates,
}: {
    itemStates: Readonly<Record<string, PreviewItemState>>;
}) {
    const { t } = useTranslation();
    const store = useEditorStore();
    const { document } = store;
    const [queries, setQueries] = useState<Record<EditorMode, string>>({
        items: "",
        themes: "",
        layouts: "",
        data: "",
    });
    const query = queries[store.mode];
    const count =
        store.mode === "items"
            ? document.items.length
            : store.mode === "themes"
              ? document.themes.length
              : store.mode === "layouts"
                ? document.layouts.length
                : document.dataSchemas.reduce(
                      (total, schema) => total + schema.keys.length,
                      0,
                  );

    const matches = (text: string) =>
        query === "" || text.toLowerCase().includes(query.toLowerCase());

    return (
        <aside
            className="sidebar"
            aria-labelledby="library-heading"
            onContextMenu={(event) => {
                if (store.mode === "items")
                    describeContext(event, {
                        label: t("sidebar.mode.items"),
                        items: [newItemAction(t)],
                    });
            }}
        >
            <header className="sidebar-head">
                <div className="library-heading">
                    <h2 id="library-heading" data-testid="library-heading">
                        {t(`sidebar.mode.${store.mode}`)}
                    </h2>
                    <span>{count}</span>
                </div>
                <input
                    type="search"
                    className="sidebar-search"
                    placeholder={t(`sidebar.searchByMode.${store.mode}`)}
                    aria-label={t(`sidebar.searchByMode.${store.mode}`)}
                    value={query}
                    onChange={(event) =>
                        setQueries((previous) => ({
                            ...previous,
                            [store.mode]: event.target.value,
                        }))
                    }
                    data-testid="item-search"
                />
            </header>

            {store.mode === "items" ? (
                <>
                    <ul className="item-list" data-testid="item-tree">
                        {document.items
                            .map((item) => ({
                                item,
                                id: `${document.namespace}:${item.id}`,
                                name: itemDisplayName(
                                    document,
                                    store.viewerLocale,
                                    item.presentation.nameMessage,
                                ),
                            }))
                            .filter(
                                (row) =>
                                    matches(row.name) || matches(row.item.id),
                            )
                            .map((row) => (
                                <li key={row.item.uuid}>
                                    <button
                                        type="button"
                                        className={`item-row ${store.selectedItemId === row.id ? "selected" : ""} ${row.item.enabled ? "" : "disabled-item"}`}
                                        onClick={() => store.selectItem(row.id)}
                                        data-testid={`item-${row.item.id}`}
                                        aria-label={row.name}
                                        onContextMenu={(event) => {
                                            store.selectItem(row.id);
                                            describeContext(event, {
                                                label: row.name,
                                                items: itemActions(
                                                    row.item.uuid,
                                                    t,
                                                ),
                                            });
                                        }}
                                    >
                                        <ItemIcon
                                            materialId={
                                                row.item.definition.material
                                            }
                                            label={row.name}
                                            size={24}
                                        />
                                        <span className="item-row-text">
                                            <span className="item-row-name">
                                                {row.name}
                                            </span>
                                            {!row.item.enabled ? (
                                                <span className="item-row-note">
                                                    {t("sidebar.disabled")}
                                                </span>
                                            ) : null}
                                        </span>
                                        <ItemValidation
                                            state={
                                                itemStates[row.id] ??
                                                "unverified"
                                            }
                                            id={row.item.id}
                                        />
                                    </button>
                                </li>
                            ))}
                    </ul>
                    <button
                        type="button"
                        className="add-item"
                        onClick={() => store.addItem(t("sidebar.newItemName"))}
                        data-testid="add-item"
                    >
                        + {t("sidebar.addItem")}
                    </button>
                </>
            ) : null}

            {store.mode === "themes" ? (
                <ul className="item-list" data-testid="theme-list">
                    {document.themes
                        .filter((theme) => matches(theme.id))
                        .map((theme) => {
                            const path = theme.id.split(":").pop() ?? theme.id;
                            const swatch =
                                theme.styles["item-name"]?.color ?? null;
                            return (
                                <li key={theme.uuid}>
                                    <button
                                        type="button"
                                        className={`item-row ${store.selectedThemeId === theme.id ? "selected" : ""}`}
                                        onClick={() =>
                                            store.selectTheme(theme.id)
                                        }
                                        data-testid={`theme-${path}`}
                                        onContextMenu={(event) => {
                                            store.selectTheme(theme.id);
                                            describeContext(event, {
                                                label: humanizePath(path),
                                                items: [
                                                    copyAction(
                                                        "copy-id",
                                                        t("menus.copyId"),
                                                        theme.id,
                                                    ),
                                                    relatedItems(
                                                        document.items.filter(
                                                            (item) =>
                                                                item
                                                                    .presentation
                                                                    .theme ===
                                                                theme.id,
                                                        ),
                                                        t,
                                                    ),
                                                ],
                                            });
                                        }}
                                    >
                                        <span
                                            className="swatch"
                                            style={{
                                                background: swatchColor(swatch),
                                            }}
                                        />
                                        <span className="item-row-text">
                                            <span className="item-row-name">
                                                {humanizePath(path)}
                                            </span>
                                            <span className="item-row-note">
                                                {t(
                                                    `inspector.renderer.${theme.renderer}`,
                                                )}
                                            </span>
                                        </span>
                                    </button>
                                </li>
                            );
                        })}
                </ul>
            ) : null}

            {store.mode === "layouts" ? (
                <ul className="item-list" data-testid="layout-list">
                    {document.layouts
                        .filter((layout) => matches(layout.id))
                        .map((layout) => {
                            const path =
                                layout.id.split(":").pop() ?? layout.id;
                            return (
                                <li key={layout.uuid}>
                                    <button
                                        type="button"
                                        className={`item-row ${store.selectedLayoutId === layout.id ? "selected" : ""}`}
                                        onClick={() =>
                                            store.selectLayout(layout.id)
                                        }
                                        data-testid={`layout-${path}`}
                                        onContextMenu={(event) => {
                                            store.selectLayout(layout.id);
                                            describeContext(event, {
                                                label: humanizePath(path),
                                                items: [
                                                    copyAction(
                                                        "copy-id",
                                                        t("menus.copyId"),
                                                        layout.id,
                                                    ),
                                                    relatedItems(
                                                        document.items.filter(
                                                            (item) =>
                                                                item
                                                                    .presentation
                                                                    .layout ===
                                                                layout.id,
                                                        ),
                                                        t,
                                                    ),
                                                ],
                                            });
                                        }}
                                    >
                                        <span className="item-row-text">
                                            <span className="item-row-name">
                                                {humanizePath(path)}
                                            </span>
                                            <span className="item-row-note">
                                                {t(
                                                    `inspector.layoutKind.${layout.kind}`,
                                                )}
                                            </span>
                                        </span>
                                    </button>
                                </li>
                            );
                        })}
                </ul>
            ) : null}

            {store.mode === "data" ? (
                <ul className="item-list" data-testid="data-list">
                    {document.dataSchemas
                        .flatMap((schema) => schema.keys)
                        .map((key) => {
                            const path = key.id.split(":").pop() ?? key.id;
                            const label = resolveMessage(
                                document,
                                store.viewerLocale,
                                `data.${path}.label`,
                            );
                            return {
                                key,
                                path,
                                name:
                                    label.source === "missing"
                                        ? humanizePath(path)
                                        : label.text,
                            };
                        })
                        .filter(
                            (row) => matches(row.name) || matches(row.key.id),
                        )
                        .map((row) => (
                            <li key={row.key.uuid}>
                                <button
                                    type="button"
                                    className={`item-row ${store.selectedDataKeyId === row.key.id ? "selected" : ""}`}
                                    onClick={() =>
                                        store.selectDataKey(row.key.id)
                                    }
                                    data-testid={`datakey-${row.path}`}
                                    onContextMenu={(event) => {
                                        store.selectDataKey(row.key.id);
                                        describeContext(event, {
                                            label: row.name,
                                            items: [
                                                copyAction(
                                                    "copy-id",
                                                    t("menus.copyId"),
                                                    row.key.id,
                                                ),
                                                relatedItems(
                                                    document.items.filter(
                                                        (item) =>
                                                            item.presentation.blocks.some(
                                                                (block) =>
                                                                    blockUses(
                                                                        block,
                                                                        row.key
                                                                            .id,
                                                                    ),
                                                            ),
                                                    ),
                                                    t,
                                                ),
                                            ],
                                        });
                                    }}
                                >
                                    <span className="item-row-text">
                                        <span className="item-row-name">
                                            {row.name}
                                        </span>
                                        <span className="item-row-note">
                                            {row.path}
                                        </span>
                                    </span>
                                </button>
                            </li>
                        ))}
                </ul>
            ) : null}
        </aside>
    );
}

function ItemValidation({
    state,
    id,
}: {
    state: PreviewItemState;
    id: string;
}) {
    const { t } = useTranslation();
    const Icon = {
        verified: CircleCheck,
        pending: LoaderCircle,
        error: CircleX,
        unverified: CircleDashed,
        unavailable: CircleSlash,
    }[state];
    return (
        <span
            className="item-validation"
            data-testid={`item-status-${id}`}
            data-state={state}
            role="img"
            aria-label={t(`previewStatus.${state}`)}
            data-tooltip={t(`previewStatus.${state}`)}
        >
            <Icon
                size={15}
                aria-hidden="true"
                className={
                    state === "pending" ? "connection-spinner" : undefined
                }
            />
        </span>
    );
}

/** CSS colour for a theme swatch, resolving vanilla names the way the renderer does. */
function swatchColor(color: string | null): string {
    if (!color) return "var(--line-strong)";
    if (color.startsWith("#")) return color;
    const named: Record<string, string> = {
        black: "#000000",
        dark_blue: "#0000aa",
        dark_green: "#00aa00",
        dark_aqua: "#00aaaa",
        dark_red: "#aa0000",
        dark_purple: "#aa00aa",
        gold: "#ffaa00",
        gray: "#aaaaaa",
        dark_gray: "#555555",
        blue: "#5555ff",
        green: "#55ff55",
        aqua: "#55ffff",
        red: "#ff5555",
        light_purple: "#ff55ff",
        yellow: "#ffff55",
        white: "#ffffff",
    };
    return named[color] ?? "var(--line-strong)";
}
