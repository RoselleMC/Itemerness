import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
    composeLocalPreview,
    type PresentationFonts,
} from "@itemerness/mc-render";
import type { Diagnostic } from "@itemerness/protocol";
import {
    presentationFontsOf,
    useEditorStore,
    viewerOf,
} from "../../state/store.js";

/**
 * Diagnostics.
 *
 * Nothing here renders a sentence that arrived pre-written. Producers send a stable `code`, a
 * `messageKey`, and typed `params`; the text is assembled from this browser's own catalog, which
 * is what makes a Chinese editor see Chinese diagnostics from an English-speaking server.
 */
export function DiagnosticsList() {
    const { t } = useTranslation();
    const state = useEditorStore();

    const fonts: PresentationFonts = useMemo(
        () => presentationFontsOf(state),
        [state.document, state.packs, state.artifact],
    );
    const diagnostics: readonly Diagnostic[] = useMemo(() => {
        if (!state.selectedItemId) return state.diagnostics;
        const preview = composeLocalPreview({
            document: state.document,
            itemId: state.selectedItemId,
            viewer: viewerOf(state),
            fonts,
        });
        return [...preview.diagnostics, ...state.diagnostics];
    }, [state, fonts]);

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
