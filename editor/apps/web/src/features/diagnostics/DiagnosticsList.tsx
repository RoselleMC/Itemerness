import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { Diagnostic } from "@itemerness/protocol";
import { LocateFixed } from "lucide-react";
import { describeContext } from "../../state/interface.js";
import { useEditorStore } from "../../state/store.js";
import { copyAction } from "../common/contextActions.js";
import { commitInlineEditor } from "../common/inlineEdit.js";
import { createDiagnosticResolver } from "./diagnosticTarget.js";
import "./diagnostics.css";

/**
 * Diagnostics.
 *
 * Prefer localized diagnostic templates, retaining server detail for codes newer than this UI.
 */
export function DiagnosticsList({
    diagnostics,
    navigableDiagnostics = [],
    onNavigate,
}: {
    diagnostics: readonly Diagnostic[];
    navigableDiagnostics?: readonly Diagnostic[];
    onNavigate?(): void;
}) {
    const { t, i18n } = useTranslation();
    const document = useEditorStore((state) => state.document);
    const resolveTarget = useMemo(
        () => createDiagnosticResolver(document),
        [document],
    );
    const targets = useMemo(
        () =>
            new Map(
                navigableDiagnostics.map((diagnostic) => [
                    diagnostic,
                    resolveTarget(diagnostic),
                ]),
            ),
        [navigableDiagnostics, resolveTarget],
    );
    const open = (diagnostic: Diagnostic) => {
        if (
            !onNavigate ||
            !commitInlineEditor() ||
            useEditorStore.getState().document !== document
        )
            return;
        const target = targets.get(diagnostic);
        if (!target) return;
        const store = useEditorStore.getState();
        switch (target.kind) {
            case "item":
                store.setMode("items");
                store.selectItem(target.id);
                store.selectBlock(target.blockUuid);
                break;
            case "theme":
                store.setMode("themes");
                store.selectTheme(target.id);
                break;
            case "layout":
                store.setMode("layouts");
                store.selectLayout(target.id);
                break;
            case "schema":
                store.setMode("data");
                store.selectDataSchema(target.uuid);
                break;
            case "key":
                store.setMode("data");
                store.selectDataKey(target.uuid);
                break;
            case "format":
                store.setMode("formats");
                store.selectFormat(target.uuid);
                break;
            case "fact":
                store.setMode("facts");
                store.selectViewerFact(target.uuid);
                break;
        }
        onNavigate();
    };
    const message = (diagnostic: Diagnostic) => {
        const key = diagnostic.messageKey.replace(/^diagnostics\./u, "");
        if (i18n.exists(key, { ns: "diagnostics" }))
            return t(key, { ...diagnostic.params, ns: "diagnostics" });
        return typeof diagnostic.params.detail === "string"
            ? diagnostic.params.detail
            : t("unknown", { ns: "diagnostics", code: diagnostic.code });
    };

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
                                        ...(onNavigate &&
                                        targets.get(diagnostic)
                                            ? [
                                                  {
                                                      id: "open-diagnostic-object",
                                                      label: t("openObject", {
                                                          ns: "diagnostics",
                                                      }),
                                                      icon: LocateFixed,
                                                      run: () =>
                                                          open(diagnostic),
                                                  },
                                              ]
                                            : []),
                                        copyAction(
                                            "copy-diagnostic",
                                            t("menus.copyMessage"),
                                            `${diagnostic.code}: ${message(diagnostic)}`,
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
                            <span>{message(diagnostic)}</span>
                            {typeof diagnostic.params.path === "string" && (
                                <code className="muted small">
                                    {diagnostic.params.path}
                                </code>
                            )}
                            <code className="muted small">
                                {diagnostic.code}
                            </code>
                            {diagnostic.pointer && (
                                <code className="muted small">
                                    {diagnostic.pointer}
                                </code>
                            )}
                            {onNavigate && targets.get(diagnostic) && (
                                <button
                                    type="button"
                                    className="page-command diagnostic-locate"
                                    data-testid="diagnostic-locate"
                                    onClick={() => open(diagnostic)}
                                >
                                    <LocateFixed size={14} />
                                    {t("openObject", { ns: "diagnostics" })}
                                </button>
                            )}
                        </li>
                    ))}
                </ul>
            )}
        </section>
    );
}
