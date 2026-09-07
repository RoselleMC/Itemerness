import { useTranslation } from "react-i18next";
import { LoaderCircle, ServerOff } from "lucide-react";
import type { DocumentSyncStatus } from "../../api/documentAutosave.js";

/** Generic disabled chrome only. Never render a stale or locally seeded configuration here. */
export function LockedWorkspace({ status }: { status: DocumentSyncStatus }) {
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
                <button type="button" disabled className="add-item">
                    + {t("sidebar.addItem")}
                </button>
            </aside>
            <section
                className="stage workspace-disabled"
                aria-disabled="true"
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
