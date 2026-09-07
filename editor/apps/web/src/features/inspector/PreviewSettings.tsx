import { useState } from "react";
import { useTranslation } from "react-i18next";
import { CircleAlert } from "lucide-react";
import { overallFidelity } from "@itemerness/mc-render";
import { useEditorStore } from "../../state/store.js";
import type { PreviewBundle } from "../preview/usePreview.js";
import { PersonaPanel } from "../stage/PersonaPanel.js";

export function PreviewSettings({
    preview,
    onOpenDiagnostics,
}: {
    preview: PreviewBundle;
    onOpenDiagnostics: () => void;
}) {
    const { t } = useTranslation();
    const store = useEditorStore();
    const [persona, setPersona] = useState(false);
    const overall = overallFidelity(preview.claims);
    return (
        <section className="preview-settings" data-testid="preview-settings">
            <h3>{t("stage.heading")}</h3>
            <div
                className="chip-group"
                role="group"
                aria-label={t("stage.previewLanguage")}
            >
                {store.document.locales.map(({ locale }) => (
                    <button
                        key={locale}
                        type="button"
                        className={`chip ${store.viewerLocale === locale ? "chip-on" : ""}`}
                        data-testid={`locale-chip-${locale}`}
                        onClick={() => store.setViewerLocale(locale)}
                    >
                        {locale}
                    </button>
                ))}
            </div>
            <label className="toggle-row">
                <input
                    type="checkbox"
                    checked={store.compareLocales}
                    onChange={(event) =>
                        store.setCompareLocales(event.target.checked)
                    }
                    data-testid="compare-toggle"
                />
                {t("stage.compare")}
            </label>
            <label className="toggle-row">
                <input
                    type="checkbox"
                    checked={store.annotations}
                    onChange={(event) =>
                        store.setAnnotations(event.target.checked)
                    }
                    data-testid="annotations-toggle"
                />
                {t("stage.overlay")}
            </label>
            <PersonaPanel open={persona} onOpenChange={setPersona} />
            {preview.diagnosticsCount > 0 && (
                <button
                    type="button"
                    className="page-command"
                    data-testid="open-diagnostics-chip"
                    onClick={onOpenDiagnostics}
                >
                    <CircleAlert size={15} />
                    {t("stage.problems", { count: preview.diagnosticsCount })}
                </button>
            )}
            <details className="fidelity-fold" data-testid="fidelity">
                <summary data-testid="fidelity-toggle">
                    {t("stage.fidelityHeading")}
                    <span
                        className={`fidelity-chip level-${overall}`}
                        data-testid="fidelity-overall"
                    >
                        {t(`fidelity.level.${overall}`)}
                    </span>
                </summary>
                <ul>
                    {preview.claims.map((claim) => (
                        <li
                            key={claim.aspect}
                            data-testid={`fidelity-${claim.aspect}`}
                        >
                            <span className="aspect">
                                {t(`fidelity.aspect.${claim.aspect}`)}
                            </span>
                            <span
                                className={`fidelity-chip level-${claim.level}`}
                            >
                                {t(`fidelity.level.${claim.level}`)}
                            </span>
                            <span className="muted">
                                {t(
                                    claim.reasonKey.replace(/^fidelity\./u, ""),
                                    { ...claim.params, ns: "fidelity" },
                                )}
                            </span>
                        </li>
                    ))}
                </ul>
            </details>
        </section>
    );
}
