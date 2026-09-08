import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useEditorStore } from "./state/store.js";
import { Sidebar } from "./features/shell/Sidebar.js";
import {
    PrimaryNavigation,
    type WorkspacePage,
} from "./features/shell/PrimaryNavigation.js";
import { LockedWorkspace } from "./features/shell/LockedWorkspace.js";
import { PreviewStage } from "./features/stage/PreviewStage.js";
import { Inspector } from "./features/inspector/Inspector.js";
import { usePreview } from "./features/preview/usePreview.js";
import { AssetPanel } from "./features/assets/AssetPanel.js";
import { useAssetRuntime } from "./features/assets/useAssetRuntime.js";
import { useServerWorkspace } from "./features/settings/useServerWorkspace.js";
import { LocaleMatrix } from "./features/locales/LocaleMatrix.js";
import { DiagnosticsList } from "./features/diagnostics/DiagnosticsList.js";
import { Titlebar } from "./features/shell/Titlebar.js";
import { ArrowLeft, Save, Settings2, Server, Undo2, Redo2 } from "lucide-react";
import { windowPlatform } from "./window/chrome.js";
import metricsUrl from "../../../../itemerness-bukkit/src/main/resources/META-INF/itemerness/font-metrics/minecraft-26.1.2.ifm?url";
import { useDocumentSync } from "./features/document/useDocumentSync.js";
import { useEditingShortcuts } from "./features/document/useEditingShortcuts.js";
import { SettingsPage } from "./features/settings/SettingsPage.js";
import { useSaveCommands } from "./features/document/useSaveCommands.js";
import { useUnsavedChanges } from "./features/document/useUnsavedChanges.js";
import { InterfaceHost } from "./features/common/InterfaceHost.js";
import { commitInlineEditor } from "./features/common/inlineEdit.js";
import { useInterface } from "./state/interface.js";
import { useConnectionStore } from "./state/connection.js";
import { ReconnectDialog } from "./features/shell/ReconnectDialog.js";
import { useApplicationMenu } from "./window/useApplicationMenu.js";
import { AboutDialog } from "./features/shell/AboutDialog.js";

/** Keep the editing workspace mounted while global pages occupy the navigation's right side. */

export function App() {
    const { t } = useTranslation();
    const [platform] = useState(windowPlatform);
    const [navigationExpanded, setNavigationExpanded] = useState(() => {
        try {
            return (
                localStorage.getItem("itemerness.navigation-expanded") ===
                "true"
            );
        } catch {
            return false;
        }
    });
    useEffect(() => {
        try {
            localStorage.setItem(
                "itemerness.navigation-expanded",
                String(navigationExpanded),
            );
        } catch {
            /* The layout remains usable when preference storage is unavailable. */
        }
    }, [navigationExpanded]);
    const documentSync = useDocumentSync();
    const unsavedChanges = useUnsavedChanges(documentSync);
    const [aboutOpen, setAboutOpen] = useState(false);
    const closeAbout = useCallback(() => setAboutOpen(false), []);
    const confirmationOpen = useInterface(
        (state) => state.confirmation !== null,
    );
    const reconnectDecision = useConnectionStore(
        (state) => state.recovery === "manual" || state.recovery === "blocked",
    );
    const interactionBlocked =
        unsavedChanges.open ||
        confirmationOpen ||
        reconnectDecision ||
        aboutOpen;
    const saveMenuError = useSaveCommands(documentSync, interactionBlocked);
    const editingShortcuts = useEditingShortcuts(
        documentSync.ready && !interactionBlocked,
    );
    const [page, setPage] = useState<WorkspacePage>("editor");
    const workspaceRestored = useServerWorkspace(documentSync.ready);
    useAssetRuntime(
        documentSync.ready &&
            workspaceRestored &&
            page === "assets" &&
            !interactionBlocked,
    );
    const showPage = (next: WorkspacePage) => {
        if (commitInlineEditor()) setPage(next);
    };
    const applicationMenu = useApplicationMenu({
        sync: documentSync,
        platform,
        blocked: interactionBlocked,
        page,
        showPage,
        navigationExpanded,
        toggleNavigation: () => setNavigationExpanded((value) => !value),
        disconnect: unsavedChanges.disconnect,
        about: () => setAboutOpen(true),
    });
    const [spritesAvailable, setSpritesAvailable] = useState(false);
    const loadArtifact = useEditorStore((state) => state.loadArtifact);
    const artifact = useEditorStore((state) => state.artifact);
    const storedDiagnostics = useEditorStore((state) => state.diagnostics);

    const preview = usePreview(spritesAvailable, documentSync.ready);
    const navigableDiagnostics = [
        ...(preview.local?.diagnostics ?? []),
        ...(preview.server.status === "verified" ||
        preview.server.status === "mock"
            ? preview.server.artifact.diagnostics
            : []),
    ];
    const diagnostics = [...navigableDiagnostics, ...storedDiagnostics];

    useEffect(() => {
        const clearSelection = (event: KeyboardEvent) => {
            if (
                event.key === "Escape" &&
                !event.defaultPrevented &&
                commitInlineEditor()
            )
                useEditorStore.getState().selectBlock(null);
        };
        window.addEventListener("keydown", clearSelection);
        return () => window.removeEventListener("keydown", clearSelection);
    }, []);

    useEffect(() => {
        if (!documentSync.ready) {
            setPage((current) => (current === "settings" ? current : "editor"));
            setSpritesAvailable(false);
        }
    }, [documentSync.ready]);

    useEffect(() => {
        // Metrics ship inside the desktop bundle and work without a plugin connection.
        if (artifact) return;
        void (async () => {
            try {
                const response = await fetch(metricsUrl);
                if (!response.ok) return;
                loadArtifact(new Uint8Array(await response.arrayBuffer()));
            } catch {
                // Mounted packs still provide metrics; the fidelity panel reports the downgrade.
            }
        })();
    }, [artifact, loadArtifact]);

    const handleGeometry = useCallback(
        (_geometry: unknown, sprites: boolean) => {
            setSpritesAvailable(sprites);
        },
        [],
    );

    return (
        <InterfaceHost
            blocked={unsavedChanges.open || reconnectDecision || aboutOpen}
            defaults={() => {
                const state = useEditorStore.getState();
                return {
                    label: t("app.title"),
                    items: [
                        {
                            id: "undo",
                            label: t("history.undo"),
                            icon: Undo2,
                            disabled: !documentSync.ready || !state.canUndo,
                            run: () => {
                                if (commitInlineEditor()) state.undo();
                            },
                        },
                        {
                            id: "redo",
                            label: t("history.redo"),
                            icon: Redo2,
                            disabled: !documentSync.ready || !state.canRedo,
                            run: () => {
                                if (commitInlineEditor()) state.redo();
                            },
                        },
                        {
                            id: "save",
                            label: t("settings.save"),
                            icon: Save,
                            disabled: !documentSync.ready,
                            separator: true,
                            run: documentSync.save,
                        },
                        {
                            id: "connection",
                            label: t("connection.heading"),
                            icon: Server,
                            run: () =>
                                useInterface.setState({
                                    connectionRequest:
                                        useInterface.getState()
                                            .connectionRequest + 1,
                                }),
                        },
                        {
                            id: "settings",
                            label: t("sidebar.settings"),
                            icon: Settings2,
                            run: () => showPage("settings"),
                        },
                    ],
                };
            }}
        >
            <div
                className="desktop-shell"
                {...editingShortcuts}
                data-platform={platform}
                data-navigation-expanded={navigationExpanded}
            >
                <Titlebar
                    platform={platform}
                    documentSync={documentSync}
                    saveMenuError={
                        saveMenuError ||
                        unsavedChanges.error ||
                        applicationMenu.error
                    }
                    onDisconnect={unsavedChanges.disconnect}
                    interactionBlocked={interactionBlocked}
                    applicationMenu={applicationMenu}
                />
                <div
                    className="app"
                    inert={interactionBlocked}
                    data-testid="workspace"
                    data-ready={documentSync.ready}
                    data-page={page}
                >
                    <PrimaryNavigation
                        expanded={navigationExpanded}
                        onToggle={() =>
                            setNavigationExpanded((current) => !current)
                        }
                        enabled={documentSync.ready}
                        page={page}
                        onPageChange={showPage}
                    />
                    <div
                        className="editor-workspace"
                        hidden={page !== "editor"}
                    >
                        {documentSync.ready ? (
                            <>
                                <Sidebar
                                    itemStates={preview.itemStates}
                                    active={
                                        page === "editor" && !interactionBlocked
                                    }
                                />
                                <PreviewStage
                                    preview={{
                                        ...preview,
                                        diagnosticsCount: diagnostics.length,
                                    }}
                                    onGeometry={handleGeometry}
                                    onOpenDiagnostics={() =>
                                        showPage("diagnostics")
                                    }
                                    active={
                                        page === "editor" && !interactionBlocked
                                    }
                                />
                                <Inspector preview={preview} />
                            </>
                        ) : (
                            <LockedWorkspace status={documentSync.status} />
                        )}
                    </div>
                    <main
                        className="workspace-page"
                        data-testid="workspace-page"
                        data-page={page}
                        hidden={page === "editor"}
                    >
                        <header className="workspace-page-header">
                            {page === "diagnostics" && (
                                <button
                                    type="button"
                                    className="icon-button"
                                    onClick={() => showPage("editor")}
                                    aria-label={t("navigation.backToEditor")}
                                    data-tooltip={t("navigation.backToEditor")}
                                    data-testid="back-to-editor"
                                >
                                    <ArrowLeft size={18} />
                                </button>
                            )}
                            <h2>
                                {page === "assets"
                                    ? t("assets.heading")
                                    : page === "translations"
                                      ? t("locales.heading")
                                      : page === "diagnostics"
                                        ? t("diagnostics.heading")
                                        : t("sidebar.settings")}
                            </h2>
                        </header>
                        <div className="workspace-page-content">
                            {page === "settings" && (
                                <SettingsPage
                                    sync={documentSync}
                                    confirmReplace={
                                        unsavedChanges.confirmReplace
                                    }
                                />
                            )}
                            {documentSync.ready && (
                                <>
                                    <div hidden={page !== "assets"}>
                                        <AssetPanel />
                                    </div>
                                    <div hidden={page !== "translations"}>
                                        <LocaleMatrix />
                                    </div>
                                    {page === "diagnostics" && (
                                        <DiagnosticsList
                                            diagnostics={diagnostics}
                                            navigableDiagnostics={
                                                navigableDiagnostics
                                            }
                                            onNavigate={() =>
                                                showPage("editor")
                                            }
                                        />
                                    )}
                                </>
                            )}
                        </div>
                    </main>
                </div>
                {unsavedChanges.dialog}
                {aboutOpen && <AboutDialog onClose={closeAbout} />}
                {reconnectDecision && !unsavedChanges.open && (
                    <ReconnectDialog onDisconnect={unsavedChanges.disconnect} />
                )}
            </div>
        </InterfaceHost>
    );
}
