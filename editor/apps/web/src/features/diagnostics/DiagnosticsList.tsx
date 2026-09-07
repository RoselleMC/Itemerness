import { useTranslation } from "react-i18next";
import type { Diagnostic } from "@itemerness/protocol";
import { describeContext } from "../../state/interface.js";
import { copyAction } from "../common/contextActions.js";

/**
 * Diagnostics.
 *
 * Nothing here renders a sentence that arrived pre-written. Producers send a stable `code`, a
 * `messageKey`, and typed `params`; the text is assembled from this browser's own catalog, which
 * is what makes a Chinese editor see Chinese diagnostics from an English-speaking server.
 */
export function DiagnosticsList({
    diagnostics,
}: {
    diagnostics: readonly Diagnostic[];
}) {
    const { t } = useTranslation();

    return (
        <section className="diagnostics" aria-label={t("diagnostics.heading")}>
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
                            tabIndex={0}
                            onContextMenu={(event) =>
                                describeContext(event, {
                                    label: diagnostic.code,
                                    items: [
                                        copyAction(
                                            "copy-diagnostic",
                                            t("menus.copyMessage"),
                                            `${diagnostic.code}: ${t(diagnostic.messageKey.replace(/^diagnostics\./u, ""), { ...diagnostic.params, ns: "diagnostics" })}`,
                                        ),
                                        copyAction(
                                            "copy-code",
                                            t("menus.copyCode"),
                                            diagnostic.code,
                                        ),
                                    ],
                                })
                            }
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
