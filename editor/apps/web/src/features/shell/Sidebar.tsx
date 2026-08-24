import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { SUPPORTED_UI_LANGUAGES } from "../../i18n/index.js";
import { useEditorStore, type EditorMode } from "../../state/store.js";
import type { DocumentSyncStatus } from "../../api/documentAutosave.js";
import {
    humanizePath,
    itemDisplayName,
    resolveMessage,
} from "../common/messages.js";
import { ItemIcon } from "../common/ItemIcon.js";

/**
 * The library rail.
 *
 * Four modes — items, themes, layouts, data — share one list. Rows lead with what a human
 * recognises: the item's texture and localized name, a theme's colour swatch, a data key's label.
 * The namespaced ids still exist and are stable; they live in each inspector's advanced fold.
 */
const MODES: readonly EditorMode[] = ["items", "themes", "layouts", "data"];

export function Sidebar({
    onOpenOverlay,
    documentSync,
    onResolveDocumentSync,
}: {
    onOpenOverlay: (overlay: "assets" | "translations" | "diagnostics") => void;
    documentSync: DocumentSyncStatus;
    onResolveDocumentSync: () => void;
}) {
    const { t, i18n } = useTranslation();
    const store = useEditorStore();
    const { document } = store;
    const [query, setQuery] = useState("");
    const [agent, setAgent] = useState<{
        connected: boolean;
        serverId: string | null;
    } | null>(null);

    useEffect(() => {
        let cancelled = false;
        const poll = async () => {
            try {
                const response = await fetch("/api/v1/agent/status");
                if (!response.ok) throw new Error();
                const body = (await response.json()) as {
                    connected: boolean;
                    serverId: string | null;
                };
                if (!cancelled)
                    setAgent({
                        connected: body.connected,
                        serverId: body.serverId,
                    });
            } catch {
                if (!cancelled) setAgent(null);
            }
        };
        void poll();
        const timer = setInterval(poll, 15_000);
        return () => {
            cancelled = true;
            clearInterval(timer);
        };
    }, []);

    const matches = (text: string) =>
        query === "" || text.toLowerCase().includes(query.toLowerCase());

    return (
        <aside className="sidebar">
            <header className="sidebar-head">
                <h1>{t("app.title")}</h1>
                <nav className="mode-tabs" role="tablist">
                    {MODES.map((mode) => (
                        <button
                            key={mode}
                            type="button"
                            role="tab"
                            aria-selected={store.mode === mode}
                            className={store.mode === mode ? "selected" : ""}
                            onClick={() => store.setMode(mode)}
                            data-testid={`mode-${mode}`}
                        >
                            {t(`sidebar.mode.${mode}`)}
                        </button>
                    ))}
                </nav>
                <input
                    type="search"
                    className="sidebar-search"
                    placeholder={t("sidebar.search")}
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
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

            <footer className="sidebar-foot">
                <button
                    type="button"
                    onClick={() => onOpenOverlay("assets")}
                    data-testid="open-assets"
                >
                    {t("sidebar.assets")}
                    <span className="muted small">
                        {store.packs.length > 0
                            ? t("sidebar.packsMounted", {
                                  count: store.packs.length,
                              })
                            : t("sidebar.packsNone")}
                    </span>
                </button>
                <button
                    type="button"
                    onClick={() => onOpenOverlay("translations")}
                    data-testid="open-translations"
                >
                    {t("sidebar.translations")}
                </button>
                <button
                    type="button"
                    onClick={() => onOpenOverlay("diagnostics")}
                    data-testid="open-diagnostics"
                >
                    {t("sidebar.diagnostics")}
                </button>

                {documentSync.kind === "conflict" ||
                documentSync.kind === "error" ||
                documentSync.kind === "offline" ? (
                    <button
                        type="button"
                        className="server-pill"
                        onClick={onResolveDocumentSync}
                        data-testid="document-sync-status"
                        data-sync-kind={documentSync.kind}
                    >
                        <span className="dot dot-off" />
                        {t(`sidebar.documentSync.${documentSync.kind}`)}
                    </button>
                ) : (
                    <div
                        className="server-pill"
                        role="status"
                        aria-live="polite"
                        data-testid="document-sync-status"
                        data-sync-kind={documentSync.kind}
                    >
                        <span
                            className={`dot ${documentSync.kind === "saved" ? "dot-on" : "dot-off"}`}
                        />
                        {t(`sidebar.documentSync.${documentSync.kind}`)}
                    </div>
                )}

                <div className="server-pill" data-testid="server-pill">
                    <span
                        className={`dot ${agent?.connected ? "dot-on" : "dot-off"}`}
                    />
                    {agent?.connected
                        ? t("sidebar.serverConnected", {
                              server: agent.serverId,
                          })
                        : t("sidebar.serverOffline")}
                </div>

                <label className="ui-language">
                    {t("sidebar.uiLanguage")}
                    <select
                        value={i18n.resolvedLanguage}
                        onChange={(event) =>
                            void i18n.changeLanguage(event.target.value)
                        }
                        data-testid="ui-language"
                    >
                        {SUPPORTED_UI_LANGUAGES.map((language) => (
                            <option key={language.code} value={language.code}>
                                {language.label}
                            </option>
                        ))}
                    </select>
                </label>
            </footer>
        </aside>
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
