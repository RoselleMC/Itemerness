import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { overallFidelity, type TooltipGeometry } from "@itemerness/mc-render";
import { useEditorStore } from "../../state/store.js";
import { TooltipCanvas } from "../preview/TooltipCanvas.js";
import { PersonaPanel } from "./PersonaPanel.js";
import { CanvasOverlay } from "./CanvasOverlay.js";
import type { PreviewBundle } from "../preview/usePreview.js";

/**
 * The stage: the tooltip, as large and unobstructed as the layout allows.
 *
 * Everything else here is deliberately quiet. Language and scale are one-tap chips because they
 * are the two things an editor flips constantly; the honesty apparatus — origin, per-aspect
 * fidelity, fallback reasons — is compressed into a pill and a fold-out, present but not shouting
 * over the content being edited.
 */
export function PreviewStage({
    preview,
    onGeometry,
    onOpenDiagnostics,
}: {
    preview: PreviewBundle;
    onGeometry: (geometry: TooltipGeometry, spritesAvailable: boolean) => void;
    onOpenDiagnostics: () => void;
}) {
    const { t } = useTranslation();
    const state = useEditorStore();
    const [geometry, setGeometry] = useState<TooltipGeometry | null>(null);
    const [openPanel, setOpenPanel] = useState<"persona" | "fidelity" | null>(
        null,
    );

    const handleGeometry = useCallback(
        (next: TooltipGeometry, sprites: boolean) => {
            setGeometry(next);
            onGeometry(next, sprites);
        },
        [onGeometry],
    );

    if (!preview.display) {
        return (
            <section className="stage stage-empty">
                <p className="muted">{t("stage.noItem")}</p>
            </section>
        );
    }

    const displayNameText = preview.display.displayName.runs
        .map((run) => run.text)
        .join("");
    const overall = overallFidelity(preview.claims);
    const targetItem = state.document.items.find(
        (entry) =>
            `${state.document.namespace}:${entry.id}` === preview.targetItemId,
    );

    return (
        <section className="stage" aria-label={t("stage.heading")}>
            <div className="stage-top">
                <div
                    className="chip-group"
                    role="group"
                    aria-label={t("stage.previewLanguage")}
                >
                    {state.document.locales.map((locale) => (
                        <button
                            key={locale.locale}
                            type="button"
                            className={`chip ${state.viewerLocale === locale.locale ? "chip-on" : ""}`}
                            onClick={() => state.setViewerLocale(locale.locale)}
                            data-testid={`locale-chip-${locale.locale}`}
                        >
                            {locale.locale}
                        </button>
                    ))}
                    <button
                        type="button"
                        className={`chip chip-ghost ${state.compareLocales ? "chip-on" : ""}`}
                        onClick={() =>
                            state.setCompareLocales(!state.compareLocales)
                        }
                        data-testid="compare-toggle"
                    >
                        {t("stage.compare")}
                    </button>
                </div>
                <PersonaPanel
                    open={openPanel === "persona"}
                    onOpenChange={(open) =>
                        setOpenPanel((current) =>
                            open
                                ? "persona"
                                : current === "persona"
                                  ? null
                                  : current,
                        )
                    }
                />
                <span
                    className={`origin-badge origin-${preview.origin}`}
                    title={t(`stage.originHint.${preview.origin}`)}
                    data-testid="preview-origin"
                >
                    {t(`stage.origin.${preview.origin}`)}
                </span>
            </div>

            <div className="stage-canvas-area">
                <figure>
                    <figcaption data-testid="preview-name">
                        {displayNameText}
                    </figcaption>
                    <div className="canvas-wrap">
                        <TooltipCanvas
                            display={preview.display}
                            fonts={preview.fonts}
                            onGeometry={handleGeometry}
                        />
                        {geometry && targetItem && state.mode === "items" ? (
                            <CanvasOverlay
                                display={preview.display}
                                geometry={geometry}
                                lineOrigins={preview.local?.lineOrigins ?? []}
                                item={targetItem}
                                layout={state.document.layouts.find(
                                    (entry) =>
                                        entry.id ===
                                        targetItem.presentation.layout,
                                )}
                                guiScale={state.guiScale}
                            />
                        ) : null}
                    </div>
                </figure>
                {preview.comparison ? (
                    <figure data-testid="comparison-figure">
                        <figcaption>{preview.comparison.locale}</figcaption>
                        <TooltipCanvas
                            display={preview.comparison.display}
                            fonts={preview.fonts}
                        />
                    </figure>
                ) : null}
            </div>

            <div className="stage-bottom">
                <div
                    className="chip-group"
                    role="group"
                    aria-label={t("stage.scale")}
                >
                    {[1, 2, 3, 4, 5, 6].map((scale) => (
                        <button
                            key={scale}
                            type="button"
                            className={`chip ${state.guiScale === scale ? "chip-on" : ""}`}
                            onClick={() => state.setGuiScale(scale)}
                            data-testid={`gui-scale-${scale}`}
                        >
                            {scale}x
                        </button>
                    ))}
                </div>

                <label className="chip chip-check">
                    <input
                        type="checkbox"
                        checked={state.annotations}
                        onChange={(event) =>
                            state.setAnnotations(event.target.checked)
                        }
                        data-testid="annotations-toggle"
                    />
                    {t("stage.overlay")}
                </label>

                <span className="muted small" data-testid="tooltip-size">
                    {geometry
                        ? `${geometry.totalWidthPixels} x ${geometry.totalHeightPixels} px`
                        : "—"}
                </span>

                {preview.diagnosticsCount > 0 ? (
                    <button
                        type="button"
                        className="chip chip-warn"
                        onClick={onOpenDiagnostics}
                        data-testid="open-diagnostics-chip"
                    >
                        {t("stage.problems", {
                            count: preview.diagnosticsCount,
                        })}
                    </button>
                ) : null}

                <details
                    className="fidelity-fold"
                    data-testid="fidelity"
                    open={openPanel === "fidelity"}
                    onToggle={(event) => {
                        const open = event.currentTarget.open;
                        setOpenPanel((current) =>
                            open
                                ? "fidelity"
                                : current === "fidelity"
                                  ? null
                                  : current,
                        );
                    }}
                >
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
                                        claim.reasonKey.replace(
                                            /^fidelity\./u,
                                            "",
                                        ),
                                        {
                                            ...claim.params,
                                            ns: "fidelity",
                                        },
                                    )}
                                </span>
                            </li>
                        ))}
                    </ul>
                </details>
            </div>
        </section>
    );
}
