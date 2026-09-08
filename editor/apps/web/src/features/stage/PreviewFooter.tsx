import { useEffect, useState, type ReactNode } from "react";
import { Popover } from "@base-ui/react/popover";
import {
    CircleAlert,
    Columns2,
    ScanLine,
    ShieldCheck,
    UserRound,
    X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { overallFidelity } from "@itemerness/mc-render";
import { useEditorStore } from "../../state/store.js";
import { SelectField } from "../common/SelectField.js";
import { PersonaPanel } from "./PersonaPanel.js";
import type { PreviewBundle } from "../preview/usePreview.js";
import { commitInlineEditor } from "../common/inlineEdit.js";
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
    active,
}: {
    preview: PreviewBundle;
    onOpenDiagnostics(): void;
    active: boolean;
}) {
    const { t } = useTranslation();
    const store = useEditorStore();
    const [popup, setPopup] = useState<"persona" | "fidelity" | null>(null);
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
