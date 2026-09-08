import { itemKey } from "@itemerness/protocol";
import { useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { describeContext } from "../../state/interface.js";
import { itemActions, newItemAction } from "../common/contextActions.js";
import { useEditorStore, type EditorMode } from "../../state/store.js";
import { humanizePath, itemDisplayName } from "../common/messages.js";
import { ItemIcon } from "../common/ItemIcon.js";
import {
    CircleCheck,
    CircleX,
    CircleDashed,
    LoaderCircle,
    CircleSlash,
} from "lucide-react";
import type { PreviewItemState } from "../../api/previewCache.js";
import { DataLibrary } from "./DataLibrary.js";
import { PresentationLibrary } from "./PresentationLibrary.js";
import { addPresentationAction } from "../common/presentationLibraryActions.js";
import { commitInlineEditor } from "../common/inlineEdit.js";
import {
    createThemeLayoutActions,
    themeLayoutActions,
} from "../common/themeLayoutActions.js";
import { NewItemDialog } from "../items/NewItemDialog.js";
import { LibraryCreateControl } from "./LibraryCreateControl.js";

/**
 * The library rail.
 *
 * Four modes — items, themes, layouts, data — share one list. Rows lead with what a human
 * recognises: the item's texture and localized name, a theme's colour swatch, a data key's label.
 * The namespaced ids still exist and are stable; they live in each inspector's advanced fold.
 */
export function Sidebar({
    itemStates,
    active,
}: {
    itemStates: Readonly<Record<string, PreviewItemState>>;
    active: boolean;
}) {
    const { t } = useTranslation();
    const store = useEditorStore();
    const { document } = store;
    const sidebarRef = useRef<HTMLElement>(null);
    const [queries, setQueries] = useState<Record<EditorMode, string>>({
        items: "",
        themes: "",
        layouts: "",
        data: "",
        formats: "",
        facts: "",
    });
    const query = queries[store.mode];
    useLayoutEffect(() => {
        const list = sidebarRef.current?.querySelector<HTMLElement>(
            ":scope > .item-list",
        );
        if (!list) return;
        const revealSelection = () => {
            const selected =
                list.querySelector<HTMLElement>(".item-row.selected");
            if (!selected || list.clientHeight === 0) return;
            const viewport = list.getBoundingClientRect();
            const row = selected.getBoundingClientRect();
            const top = viewport.top + list.clientTop;
            const bottom = top + list.clientHeight;
            // Scroll only this list; scrolling ancestors would move the fitted preview offscreen.
            if (row.top < top) list.scrollTop += row.top - top;
            else if (row.bottom > bottom) list.scrollTop += row.bottom - bottom;
        };
        revealSelection();
        const observer = new ResizeObserver(revealSelection);
        observer.observe(list);
        return () => observer.disconnect();
    }, [
        store.mode,
        store.selectedItemId,
        store.selectedThemeId,
        store.selectedLayoutId,
        query,
    ]);
    const count =
        store.mode === "items"
            ? document.items.length
            : store.mode === "themes"
              ? document.themes.length
              : store.mode === "layouts"
                ? document.layouts.length
                : store.mode === "formats"
                  ? document.formats.length
                  : store.mode === "facts"
                    ? document.viewerFacts.length
                    : document.dataSchemas.reduce(
                          (total, schema) => total + schema.keys.length,
                          0,
                      );

    const matches = (text: string) =>
        query === "" || text.toLowerCase().includes(query.toLowerCase());

    return (
        <aside
            ref={sidebarRef}
            className="sidebar"
            aria-labelledby="library-heading"
            onContextMenu={(event) => {
                if (store.mode === "formats" || store.mode === "facts")
                    describeContext(event, {
                        label: t(`sidebar.mode.${store.mode}`),
                        items: [addPresentationAction(store.mode, t)],
                    });
                if (store.mode === "items")
                    describeContext(event, {
                        label: t("sidebar.mode.items"),
                        items: [newItemAction(t)],
                    });
                else if (store.mode === "themes" || store.mode === "layouts")
                    describeContext(event, {
                        label: t(`sidebar.mode.${store.mode}`),
                        items: createThemeLayoutActions(store.mode, t),
                    });
            }}
        >
            <NewItemDialog />
            <header className="sidebar-head">
                <div className="library-heading">
                    <h2 id="library-heading" data-testid="library-heading">
                        <span>{t(`sidebar.mode.${store.mode}`)}</span>{" "}
                        <span className="library-count">({count})</span>
                    </h2>
                    <LibraryCreateControl mode={store.mode} active={active} />
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
                                id: itemKey(document, item),
                                name: itemDisplayName(
                                    document,
                                    store.viewerLocale,
                                    item.presentation.nameMessage,
                                ),
                            }))
                            .filter(
                                (row) => matches(row.name) || matches(row.id),
                            )
                            .map((row) => (
                                <li key={row.item.uuid}>
                                    <button
                                        type="button"
                                        className={`item-row ${store.selectedItemId === row.id ? "selected" : ""} ${row.item.enabled ? "" : "disabled-item"}`}
                                        onClick={() => {
                                            if (commitInlineEditor())
                                                store.selectItem(row.id);
                                        }}
                                        data-testid={`item-${row.item.id}`}
                                        aria-label={row.name}
                                        onContextMenu={(event) => {
                                            if (!commitInlineEditor()) {
                                                event.preventDefault();
                                                event.stopPropagation();
                                                return;
                                            }
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
                </>
            ) : null}

            {store.mode === "themes" ? (
                <>
                    <ul className="item-list" data-testid="theme-list">
                        {document.themes
                            .filter((theme) => matches(theme.id))
                            .map((theme) => {
                                const path =
                                    theme.id.split(":").pop() ?? theme.id;
                                const swatch =
                                    theme.styles["item-name"]?.color ?? null;
                                return (
                                    <li key={theme.uuid}>
                                        <button
                                            type="button"
                                            className={`item-row ${store.selectedThemeId === theme.id ? "selected" : ""}`}
                                            onClick={() => {
                                                if (commitInlineEditor())
                                                    store.selectTheme(theme.id);
                                            }}
                                            data-testid={`theme-${path}`}
                                            onContextMenu={(event) => {
                                                if (!commitInlineEditor()) {
                                                    event.preventDefault();
                                                    event.stopPropagation();
                                                    return;
                                                }
                                                describeContext(event, {
                                                    label: humanizePath(path),
                                                    items: themeLayoutActions(
                                                        "themes",
                                                        theme.uuid,
                                                        t,
                                                    ),
                                                });
                                            }}
                                        >
                                            <span
                                                className="swatch"
                                                style={{
                                                    background:
                                                        swatchColor(swatch),
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
                </>
            ) : null}

            {store.mode === "layouts" ? (
                <>
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
                                            onClick={() => {
                                                if (commitInlineEditor())
                                                    store.selectLayout(
                                                        layout.id,
                                                    );
                                            }}
                                            data-testid={`layout-${path}`}
                                            onContextMenu={(event) => {
                                                if (!commitInlineEditor()) {
                                                    event.preventDefault();
                                                    event.stopPropagation();
                                                    return;
                                                }
                                                describeContext(event, {
                                                    label: humanizePath(path),
                                                    items: themeLayoutActions(
                                                        "layouts",
                                                        layout.uuid,
                                                        t,
                                                    ),
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
                </>
            ) : null}

            {store.mode === "data" ? <DataLibrary query={query} /> : null}
            {store.mode === "formats" || store.mode === "facts" ? (
                <PresentationLibrary kind={store.mode} query={query} />
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
