import { useTranslation } from "react-i18next";
import { LoaderCircle, ServerOff, File, Plus } from "lucide-react";
import type { ReactNode } from "react";
import type { DocumentSyncStatus } from "../../api/documentAutosave.js";

/** Generic disabled chrome only. Never render a stale or locally seeded configuration here. */
export function LockedWorkspace({
    status,
    importControls,
}: {
    status: DocumentSyncStatus;
    importControls?: ReactNode;
}) {
    const { t } = useTranslation();
    const loading = status.kind === "loading";
    return (
        <>
            <aside
                className="sidebar workspace-disabled"
                aria-disabled="true"
                aria-label={t("sidebar.mode.items")}
            >
                <header className="sidebar-head">
                    <div className="library-heading">
                        <h2>{t("sidebar.mode.items")}</h2>
                        <button
                            type="button"
                            disabled
                            className="icon-button library-create"
                            aria-label={t("sidebar.addItem")}
                            data-tooltip={t("sidebar.addItem")}
                        >
                            <Plus size={16} aria-hidden="true" />
                        </button>
                    </div>
                    <input
                        type="search"
                        disabled
                        className="sidebar-search"
                        placeholder={t("sidebar.searchByMode.items")}
                        aria-label={t("sidebar.searchByMode.items")}
                    />
                </header>
                <div className="locked-library" />
            </aside>
            <section
                className="stage workspace-disabled"
                aria-disabled={importControls ? undefined : true}
                aria-label={t("stage.heading")}
            >
                <header className="stage-top">
                    <span>{t("stage.heading")}</span>
                </header>
                <div
                    className="locked-preview"
                    role="status"
                    data-testid="workspace-status"
                >
                    {loading ? (
                        <LoaderCircle
                            size={26}
                            className="connection-spinner"
                            aria-hidden="true"
                        />
                    ) : status.kind === "empty" ? (
                        <File size={26} aria-hidden="true" />
                    ) : (
                        <ServerOff size={26} aria-hidden="true" />
                    )}
                    <span>
                        {t(
                            status.kind === "empty"
                                ? "workspace.noDocument"
                                : loading
                                  ? "workspace.loading"
                                  : "workspace.disconnected",
                        )}
                    </span>
                    {importControls}
                </div>
            </section>
            <aside
                className="inspector workspace-disabled"
                aria-disabled="true"
                aria-label={t("workspace.inspector")}
            >
                <h3>{t("workspace.inspector")}</h3>
            </aside>
        </>
    );
}
