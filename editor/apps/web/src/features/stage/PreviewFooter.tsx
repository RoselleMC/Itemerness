import { useEffect, useState, type ReactNode } from "react";
import { Popover } from "@base-ui/react/popover";
import {
    CircleAlert,
    Columns2,
    FileWarning,
    FlaskConical,
    MoveVertical,
    ScanLine,
    ShieldCheck,
    UserRound,
    X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { overallFidelity } from "@itemerness/mc-render";
import { DEFAULT_MAXIMUM_HEIGHT_PIXELS } from "@itemerness/protocol";
import { useEditorStore } from "../../state/store.js";
import { SelectField } from "../common/SelectField.js";
import { PersonaPanel } from "./PersonaPanel.js";
import type { PreviewBundle } from "../preview/usePreview.js";
import { commitInlineEditor } from "../common/inlineEdit.js";
import type { CatalogStatus } from "../settings/useCatalogStatus.js";
import { ScenarioPanel } from "./ScenarioPanel.js";
import { useConnectionStore } from "../../state/connection.js";
import "./previewFooter.css";

function FooterPopover({
    open,
    onOpenChange,
    label,
    testId,
    trigger,
    align = "start",
    children,
}: {
    open: boolean;
    onOpenChange(open: boolean): void;
    label: string;
    testId: string;
    trigger: ReactNode;
    align?: "start" | "end";
    children: ReactNode;
}) {
    const { t } = useTranslation();
    return (
        <Popover.Root
            open={open}
            onOpenChange={(next) => {
                if (commitInlineEditor()) onOpenChange(next);
            }}
            modal={false}
        >
            <Popover.Trigger
                className="preview-footer-button"
                data-testid={testId}
                aria-label={label}
                data-tooltip={label}
            >
                {trigger}
            </Popover.Trigger>
            <Popover.Portal>
                <Popover.Positioner
                    side="top"
                    align={align}
                    sideOffset={8}
                    collisionPadding={{ top: 56, left: 8, right: 8, bottom: 8 }}
                    className="ui-positioner"
                >
                    <Popover.Popup
                        className="ui-popup preview-footer-popup"
                        data-ui-popup
                        aria-label={label}
                        onKeyDown={(event) => {
                            if (event.key === "Escape") event.stopPropagation();
                        }}
                    >
                        <div className="preview-popup-heading">
                            <Popover.Title>{label}</Popover.Title>
                            <Popover.Close
                                className="icon-button"
                                aria-label={t("common.close")}
                                data-tooltip={t("common.close")}
                            >
                                <X size={15} />
                            </Popover.Close>
                        </div>
                        {children}
                    </Popover.Popup>
                </Popover.Positioner>
            </Popover.Portal>
        </Popover.Root>
    );
}

export function PreviewFooter({
    preview,
    onOpenDiagnostics,
    catalogStatus,
    onReviewCatalog,
    active,
}: {
    preview: PreviewBundle;
    onOpenDiagnostics(): void;
    catalogStatus: CatalogStatus;
    onReviewCatalog?(): void;
    active: boolean;
}) {
    const { t } = useTranslation();
    const store = useEditorStore();
    const [popup, setPopup] = useState<
        "persona" | "fidelity" | "height" | "baseline" | "scenario" | null
    >(null);
    useEffect(() => {
        if (!active) setPopup(null);
    }, [active]);
    const overall = overallFidelity(preview.claims);
    const verified = preview.claims.filter(
        (claim) => claim.level === "exact-structure",
    ).length;
    const summary = t("stage.fidelitySummary", {
        count: verified,
        total: preview.claims.length,
    });
    // The server owns this limit; a non-default one is worth knowing while authoring tall items.
    const heightLimit = store.document.budgets.maximumHeightPixels;
    const providers = useConnectionStore(
        (state) => state.info?.capabilities.includes("preview.providers") ?? false,
    );
    const scenario = preview.targetItemId
        ? store.previewScenarios[preview.targetItemId]
        : undefined;
    const heightLabel = t("stage.heightLimit.label", { pixels: heightLimit });
    return (
        <footer className="preview-footer" data-testid="preview-footer">
            <div className="preview-footer-view">
                <SelectField
                    value={store.viewerLocale}
                    options={store.document.locales.map(({ locale }) => ({
                        value: locale,
                        label: locale,
                    }))}
                    label={t("stage.previewLanguage")}
                    side="top"
                    data-testid="preview-language"
                    onValueChange={(locale) => {
                        if (commitInlineEditor()) store.setViewerLocale(locale);
                    }}
                />
                <FooterPopover
                    open={popup === "persona"}
                    onOpenChange={(open) => setPopup(open ? "persona" : null)}
                    label={t("stage.persona")}
                    testId="open-persona"
                    trigger={
                        <>
                            <UserRound size={15} />
                            <span className="footer-control-label">
                                {t("stage.persona")}
                            </span>
                        </>
                    }
                >
                    <PersonaPanel />
                </FooterPopover>
                {providers && preview.targetItemId && (
                    <FooterPopover
                        open={popup === "scenario"}
                        onOpenChange={(open) =>
                            setPopup(open ? "scenario" : null)
                        }
                        label={t("stage.scenario.title")}
                        testId="open-scenario"
                        trigger={
                            <>
                                <FlaskConical size={15} />
                                <span className="footer-control-label">
                                    {scenario
                                        ? scenario.id
                                        : t("stage.scenario.button")}
                                </span>
                            </>
                        }
                    >
                        <ScenarioPanel preview={preview} />
                    </FooterPopover>
                )}
                <button
                    type="button"
                    className="preview-footer-button"
                    aria-pressed={store.compareLocales}
                    data-testid="compare-toggle"
                    aria-label={t("stage.compare")}
                    data-tooltip={t("stage.compare")}
                    disabled={store.document.locales.length < 2}
                    onClick={() =>
                        store.setCompareLocales(!store.compareLocales)
                    }
                >
                    <Columns2 size={15} />
                    <span className="footer-control-label">
                        {t("stage.compare")}
                    </span>
                </button>
                <button
                    type="button"
                    className="preview-footer-button"
                    aria-pressed={store.annotations}
                    data-testid="annotations-toggle"
                    aria-label={t("stage.overlay")}
                    data-tooltip={t("stage.overlay")}
                    onClick={() => store.setAnnotations(!store.annotations)}
                >
                    <ScanLine size={15} />
                    <span className="footer-control-label">
                        {t("stage.overlay")}
                    </span>
                </button>
            </div>
            <div className="preview-footer-status">
                {/* Editing a draft whose YAML moved on is legitimate, but it must never look like live config. */}
                {catalogStatus === "changed" && (
                    <FooterPopover
                        open={popup === "baseline"}
                        onOpenChange={(open) =>
                            setPopup(open ? "baseline" : null)
                        }
                        label={t("catalogTransfer.baseline.title")}
                        testId="catalog-baseline"
                        align="end"
                        trigger={
                            <>
                                <FileWarning size={15} />
                                <span className="footer-control-label">
                                    {t("catalogTransfer.baseline.short")}
                                </span>
                            </>
                        }
                    >
                        <div
                            className="footer-height-limit"
                            data-testid="catalog-baseline-notice"
                        >
                            <p>{t("catalogTransfer.baseline.changed")}</p>
                            {onReviewCatalog && (
                                <p>
                                    <button
                                        type="button"
                                        data-testid="catalog-baseline-review"
                                        onClick={() => {
                                            setPopup(null);
                                            onReviewCatalog();
                                        }}
                                    >
                                        {t("catalogTransfer.baseline.review")}
                                    </button>
                                </p>
                            )}
                        </div>
                    </FooterPopover>
                )}
                {heightLimit !== DEFAULT_MAXIMUM_HEIGHT_PIXELS && (
                    <FooterPopover
                        open={popup === "height"}
                        onOpenChange={(open) => setPopup(open ? "height" : null)}
                        label={heightLabel}
                        testId="height-limit"
                        align="end"
                        trigger={
                            <>
                                <MoveVertical size={15} />
                                <span className="footer-control-label">
                                    {t("stage.heightLimit.short", {
                                        pixels: heightLimit,
                                    })}
                                </span>
                            </>
                        }
                    >
                        <div
                            className="footer-height-limit"
                            data-testid="height-limit-notice"
                        >
                            <p>
                                {t(
                                    heightLimit > DEFAULT_MAXIMUM_HEIGHT_PIXELS
                                        ? "stage.heightLimit.raised"
                                        : "stage.heightLimit.lowered",
                                    {
                                        pixels: heightLimit,
                                        standard: DEFAULT_MAXIMUM_HEIGHT_PIXELS,
                                    },
                                )}
                            </p>
                            <p className="muted">
                                {t("stage.heightLimit.source")}
                            </p>
                        </div>
                    </FooterPopover>
                )}
                {preview.diagnosticsCount > 0 && (
                    <button
                        type="button"
                        className="preview-footer-button"
                        data-testid="open-diagnostics-chip"
                        aria-label={t("stage.problems", {
                            count: preview.diagnosticsCount,
                        })}
                        data-tooltip={t("stage.problems", {
                            count: preview.diagnosticsCount,
                        })}
                        onClick={onOpenDiagnostics}
                    >
                        <CircleAlert size={15} />
                        <span>{preview.diagnosticsCount}</span>
                    </button>
                )}
                <FooterPopover
                    open={popup === "fidelity"}
                    onOpenChange={(open) => setPopup(open ? "fidelity" : null)}
                    label={`${t("stage.fidelityHeading")} · ${summary}`}
                    testId="fidelity-toggle"
                    align="end"
                    trigger={
                        <>
                            <ShieldCheck size={15} />
                            <span
                                className="fidelity-summary"
                                data-testid="fidelity-summary"
                            >
                                {verified}/{preview.claims.length}
                            </span>
                        </>
                    }
                >
                    <div data-testid="fidelity" className="footer-fidelity">
                        <span
                            className={`fidelity-chip level-${overall}`}
                            data-testid="fidelity-overall"
                        >
                            {t(`fidelity.level.${overall}`)}
                        </span>
                        <ul>
                            {preview.claims.map((claim) => (
                                <li
                                    key={claim.aspect}
                                    data-testid={`fidelity-${claim.aspect}`}
                                >
                                    <span>
                                        {t(`fidelity.aspect.${claim.aspect}`)}
                                    </span>
                                    <span
                                        className={`fidelity-chip level-${claim.level}`}
                                    >
                                        {t(`fidelity.level.${claim.level}`)}
                                    </span>
                                    <p className="muted">
                                        {t(
                                            claim.reasonKey.replace(
                                                /^fidelity\./u,
                                                "",
                                            ),
                                            { ...claim.params, ns: "fidelity" },
                                        )}
                                    </p>
                                </li>
                            ))}
                        </ul>
                    </div>
                </FooterPopover>
            </div>
        </footer>
    );
}
