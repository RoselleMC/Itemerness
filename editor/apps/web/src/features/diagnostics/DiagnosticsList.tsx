import { useTranslation } from "react-i18next";
import type { Diagnostic } from "@itemerness/protocol";
import { useEditorStore } from "../../state/store.js";
import type { PreviewBundle } from "../preview/usePreview.js";

/**
 * Diagnostics.
 *
 * Nothing here renders a sentence that arrived pre-written. Producers send a stable `code`, a
 * `messageKey`, and typed `params`; the text is assembled from this browser's own catalog, which
 * is what makes a Chinese editor see Chinese diagnostics from an English-speaking server.
 */
export function DiagnosticsList({ preview }: { preview: PreviewBundle }) {
    const { t } = useTranslation();
    const state = useEditorStore();

    const serverDiagnostics: readonly Diagnostic[] =
        preview.server.status === "verified" || preview.server.status === "mock"
            ? preview.server.artifact.diagnostics
            : [];
    const diagnostics: readonly Diagnostic[] = [
        ...(preview.local?.diagnostics ?? []),
        ...serverDiagnostics,
        ...state.diagnostics,
    ];

    return (
        <section className="diagnostics" aria-label={t("diagnostics.heading")}>
            <h2>{t("diagnostics.heading")}</h2>
            {diagnostics.length === 0 ? (
                <p className="muted" data-testid="diagnostics-empty">
                    {t("diagnostics.empty")}
                </p>
            ) : (
                <ul data-testid="diagnostics-list">
                    {diagnostics.map((diagnostic, index) => (
                        <li
                            key={`${diagnostic.code}-${index}`}
                            className={`severity-${diagnostic.severity}`}
                        >
                            <span className="tag">
                                {t(
                                    `diagnostics.severity.${diagnostic.severity}`,
                                )}
                            </span>
                            <span className="tag muted">
                                {t(`diagnostics.origin.${diagnostic.origin}`)}
                            </span>
                            <span>
                                {t(
                                    diagnostic.messageKey.replace(
                                        /^diagnostics\./u,
                                        "",
                                    ),
                                    {
                                        ...diagnostic.params,
                                        ns: "diagnostics",
                                    },
                                )}
                            </span>
                            <code className="muted small">
                                {diagnostic.code}
                            </code>
                        </li>
                    ))}
                </ul>
            )}
        </section>
    );
}
