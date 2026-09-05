import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { SUPPORTED_UI_LANGUAGES } from "../../i18n/index.js";
import { useEditorStore, type EditorMode } from "../../state/store.js";
import type { DocumentSyncStatus } from "../../api/documentAutosave.js";
import { humanizePath, resolveMessage } from "../common/messages.js";
import { ItemIcon } from "../common/ItemIcon.js";
import { newItemTemplate } from "../runorpg/templateProjection.js";
import { itemTemplateRegistryOf } from "@itemerness/protocol";

/**
 * The library rail.
 *
 * The item inventory is authoritative RunoRPG content only. Itemerness remains the storage and
 * projection layer; it does not expose a second RPG item, attribute, or affix namespace.
 *
 * Themes come first because a frame is what an author reaches for before anything else; templates
 * define an item kind; the item list is every concrete item made from them. The kind filter lists
 * the templates themselves rather than a second, hand-maintained taxonomy — a template *is* a kind,
 * and two competing lists of kinds would immediately disagree.
 */
const MODES: readonly EditorMode[] = [
    "themes",
    "templates",
    "items",
    "layouts",
    "data",
];

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
    /** Template id, or "all". Only the item library filters; a template list needs no filter. */
    const [kind, setKind] = useState("all");
    const registry = itemTemplateRegistryOf(document);
    const templates = registry.templates;
    const templateOfItem = new Map(
        registry.bindings.map((binding) => [
            binding.instanceId,
            binding.templateId,
        ]),
    );
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
                {store.mode === "items" ? (
                    <label className="template-category-filter">
                        <span>{t("sidebar.category")}</span>
                        <select
                            value={kind}
                            onChange={(event) => setKind(event.target.value)}
                            data-testid="template-category"
                        >
                            <option value="all">
                                {t("sidebar.categoryValue.all")}
                            </option>
                            {templates.map((template) => (
                                <option key={template.uuid} value={template.id}>
                                    {template.displayName}
                                </option>
                            ))}
                            <option value="unbound">
                                {t("sidebar.categoryValue.unbound")}
                            </option>
                        </select>
                    </label>
                ) : null}
            </header>

            {store.mode === "templates" ? (
                <ul className="item-list" data-testid="template-list">
                    <li className="item-list-heading">
                        <span>{t("sidebar.itemTemplates")}</span>
                        <small>{templates.length}</small>
                    </li>
                    {templates
                        .filter(
                            (template) =>
                                matches(template.displayName) ||
                                matches(template.id),
                        )
                        .map((template) => (
                            <li key={template.uuid}>
                                <button
                                    type="button"
                                    className={`item-row ${store.selectedTemplateId === template.id ? "selected" : ""} ${template.enabled ? "" : "disabled-item"}`}
                                    onClick={() =>
                                        store.selectTemplate(template.id)
                                    }
                                    data-testid={`item-template-${template.id.replaceAll(":", "-")}`}
                                >
                                    <ItemIcon
                                        materialId={template.material}
                                        label={template.displayName}
                                        size={24}
                                    />
                                    <span className="item-row-text">
                                        <span className="item-row-name">
                                            {template.displayName}
                                        </span>
                                        <span className="item-row-note">
                                            {t("sidebar.templateInstances", {
                                                count: registry.bindings.filter(
                                                    (binding) =>
                                                        binding.templateId ===
                                                        template.id,
                                                ).length,
                                            })}
                                        </span>
                                    </span>
                                </button>
                            </li>
                        ))}
                    <li>
                        <button
                            type="button"
                            className="item-row add-item"
                            onClick={() =>
                                store.addTemplate(
                                    newItemTemplate(
                                        templates,
                                        t("sidebar.newTemplateName"),
                                    ),
                                )
                            }
                            data-testid="add-template"
                        >
                            {t("sidebar.addTemplate")}
                        </button>
                    </li>
                </ul>
            ) : null}

            {store.mode === "items" ? (
                <>
                    <ul className="item-list" data-testid="item-tree">
                        <li className="item-list-heading">
                            <span>{t("sidebar.runoRpgTemplates")}</span>
                            <small>
                                {store.runoRpgCatalog?.items.length ?? "…"}
                            </small>
                        </li>
                        {(store.runoRpgCatalog?.items ?? [])
                            .filter((item) => {
                                if (
                                    !matches(item.displayName) &&
                                    !matches(item.id) &&
                                    !matches(item.legacyReference ?? "")
                                ) {
                                    return false;
                                }
                                const template = templateOfItem.get(item.id);
                                if (kind === "all") return true;
                                if (kind === "unbound")
                                    return template === undefined;
                                return template === kind;
                            })
                            .map((item) => (
                                <li key={item.id}>
                                    <button
                                        type="button"
                                        className={`item-row ${store.selectedItemId === item.id ? "selected" : ""} ${item.enabled ? "" : "disabled-item"}`}
                                        onClick={() =>
                                            store.selectItem(item.id)
                                        }
                                        data-testid={`runorpg-template-${item.localId.replaceAll("/", "-")}`}
                                    >
                                        <ItemIcon
                                            materialId={item.material}
                                            label={item.displayName}
                                            size={24}
                                        />
                                        <span className="item-row-text">
                                            <span className="item-row-name">
                                                {item.displayName}
                                            </span>
                                            <span className="item-row-note">
                                                {item.enabled
                                                    ? (templates.find(
                                                          (template) =>
                                                              template.id ===
                                                              templateOfItem.get(
                                                                  item.id,
                                                              ),
                                                      )?.displayName ??
                                                      "RunoRPG")
                                                    : t("sidebar.disabled")}
                                            </span>
                                        </span>
                                    </button>
                                </li>
                            ))}
                    </ul>
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
