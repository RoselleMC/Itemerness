import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Download, FolderInput, LoaderCircle, X } from "lucide-react";
import {
    diagnosticSchema,
    type CatalogRead,
    type Diagnostic,
} from "@itemerness/protocol";
import { PluginHttpError } from "../../api/client.js";
import { useEditorStore } from "../../state/store.js";
import { useConnectionStore } from "../../state/connection.js";
import { contextOwner } from "../../state/interface.js";
import { commitInlineEditor } from "../common/inlineEdit.js";
import type { DocumentSync } from "../document/useDocumentSync.js";
import { saveCatalogArchive } from "./catalogArchive.js";
import { CatalogImportSummary } from "./CatalogImportSummary.js";
import { DiagnosticsList } from "../diagnostics/DiagnosticsList.js";
import "./catalog-controls.css";

type Operation = {
    owner: string;
    abort: AbortController;
    client: NonNullable<
        ReturnType<typeof useConnectionStore.getState>["client"]
    >;
};
type Phase = "read" | "review" | "confirm" | "replace" | "export" | null;
// A recoverable transport failure must leave the same session's import review visible.
const catalogOwner = () =>
    contextOwner(undefined, { includeConnectionStatus: false });
const errorCodes = new Set([
    "CATALOG_SETTINGS_INVALID",
    "CATALOG_INVALID",
    "CATALOG_DOCUMENT_TOO_LARGE",
    "CATALOG_UPGRADE_REQUIRED",
    "CATALOG_DEFAULTS_REQUIRED",
    "CATALOG_ASSET_METADATA_MISSING",
    "CATALOG_EXPORT_INVALID",
    "CATALOG_EXPORT_LOSSY",
    "CATALOG_RESPONSE_TOO_LARGE",
    "RESPONSE_TOO_LARGE",
    "REQUEST_TOO_LARGE",
    "DOCUMENT_SCHEMA_INCOMPATIBLE",
    "DRAFT_CONFLICT",
    "TOKEN_REQUIRED",
    "TARGET_SERVER_MISMATCH",
    "CATALOG_BUSY",
    "EXPORT_SIZE_INVALID",
    "EXPORT_SAVE_FAILED",
]);

export function CatalogControls({
    sync,
    confirmReplace,
}: {
    sync: DocumentSync;
    confirmReplace(): Promise<boolean>;
}) {
    const { t } = useTranslation();
    const connection = useConnectionStore();
    const document = useEditorStore((state) => state.document);
    const [review, setReview] = useState<CatalogRead | null>(null);
    const [phase, setPhase] = useState<Phase>(null);
    const [error, setError] = useState<string | null>(null);
    const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);
    const operation = useRef<Operation | null>(null);
    const closeButton = useRef<HTMLButtonElement>(null);
    const returnFocus = useRef<HTMLElement | null>(null);
    const phaseRef = useRef(phase);
    phaseRef.current = phase;
    const close = () => {
        operation.current?.abort.abort();
        operation.current = null;
        setReview(null);
        setPhase(null);
    };
    useEffect(() => {
        if (!review) return;
        returnFocus.current =
            window.document.activeElement instanceof HTMLElement
                ? window.document.activeElement
                : null;
        closeButton.current?.focus();
        return () => {
            if (returnFocus.current?.isConnected)
                returnFocus.current.focus({ preventScroll: true });
            returnFocus.current = null;
        };
    }, [review]);
    const current = (active: Operation) =>
        operation.current === active &&
        active.client === useConnectionStore.getState().client &&
        active.owner === catalogOwner();
    useEffect(() => {
        const cancelStale = () => {
            const active = operation.current;
            if (active && !current(active)) close();
        };
        const stopDocument = useEditorStore.subscribe(cancelStale);
        const stopConnection = useConnectionStore.subscribe(cancelStale);
        const blockReplacement = (event: Event) => {
            if (phaseRef.current === "replace") event.preventDefault();
        };
        window.addEventListener("itemerness:commit-inline", blockReplacement);
        return () => {
            stopDocument();
            stopConnection();
            window.removeEventListener(
                "itemerness:commit-inline",
                blockReplacement,
            );
            operation.current?.abort.abort();
            operation.current = null;
        };
    }, []);
    const fail = (reason: unknown) => {
        const code = reason instanceof Error ? reason.message : "";
        setError(errorCodes.has(code) ? code : "REQUEST_FAILED");
        if (
            reason instanceof PluginHttpError &&
            reason.body &&
            typeof reason.body === "object"
        ) {
            const parsed = diagnosticSchema
                .array()
                .max(4096)
                .safeParse(
                    (reason.body as Record<string, unknown>).diagnostics,
                );
            if (parsed.success) setDiagnostics(parsed.data);
        }
    };
    const begin = (): Operation | null => {
        const client = useConnectionStore.getState().client;
        if (!client || operation.current) return null;
        const active = {
            client,
            owner: catalogOwner(),
            abort: new AbortController(),
        };
        operation.current = active;
        setError(null);
        setDiagnostics([]);
        return active;
    };
    const read = async () => {
        // Reading is non-destructive even when an unfinished field needs an explicit Discard later.
        commitInlineEditor();
        const active = begin();
        if (!active) return;
        setPhase("read");
        try {
            const result = await active.client.readCatalog(active.abort.signal);
            if (!current(active)) return;
            setReview(result);
            setDiagnostics(result.diagnostics);
            setPhase("review");
        } catch (reason) {
            if (current(active)) {
                fail(reason);
                close();
            }
        }
    };
    const replace = async () => {
        const active = operation.current;
        const candidate = review;
        if (!active || !candidate || !current(active)) return;
        setPhase("confirm");
        try {
            if (!(await confirmReplace())) {
                if (current(active)) setPhase("review");
                return;
            }
            if (!current(active)) return;
            const expected = useEditorStore.getState().snapshotHash;
            phaseRef.current = "replace";
            setPhase("replace");
            const saved = await sync.replaceDocument(
                candidate.document,
                expected,
            );
            if (!current(active)) return;
            if (saved) close();
            else {
                setError("REPLACE_FAILED");
                setPhase("review");
            }
        } catch (reason) {
            if (current(active)) {
                fail(reason);
                setPhase("review");
            }
        }
    };
    const exportZip = async () => {
        if (!commitInlineEditor()) return;
        const active = begin();
        if (!active) return;
        setPhase("export");
        try {
            const source = useEditorStore.getState().document;
            const result = await active.client.exportCatalog(
                source,
                useConnectionStore.getState().info!.serverId,
                active.abort.signal,
            );
            if (!current(active)) return;
            setDiagnostics(result.diagnostics);
            if (
                result.diagnostics.some((entry) => entry.severity === "ERROR")
            ) {
                setError("CATALOG_INVALID");
                return;
            }
            await saveCatalogArchive(result);
        } catch (reason) {
            if (current(active)) fail(reason);
        } finally {
            if (current(active)) close();
        }
    };
    const exportRequirement =
        document.schemaVersion !== 2
            ? "CATALOG_UPGRADE_REQUIRED"
            : !document.defaultLayout || !document.defaultTheme
              ? "CATALOG_DEFAULTS_REQUIRED"
              : null;
    const readSupported =
        connection.info?.capabilities.includes("catalog.read") ?? false;
    const exportSupported =
        connection.info?.capabilities.includes("catalog.export") ?? false;
    const messages = (
        <>
            {error && (
                <p className="error" role="alert" data-testid="catalog-error">
                    {t(`catalogTransfer.errors.${error}`)}
                </p>
            )}
            {diagnostics.length > 0 && (
                <div className="catalog-diagnostics">
                    <DiagnosticsList diagnostics={diagnostics} />
                </div>
            )}
        </>
    );
    return (
        <section
            className="settings-section catalog-controls"
            data-testid="catalog-controls"
        >
            <h3>{t("catalogTransfer.heading")}</h3>
            <div className="catalog-commands">
                <button
                    type="button"
                    data-testid="catalog-read"
                    disabled={
                        !readSupported ||
                        phase !== null ||
                        connection.recovery !== "none"
                    }
                    onClick={() => void read()}
                >
                    {phase === "read" ? (
                        <LoaderCircle size={15} />
                    ) : (
                        <FolderInput size={15} />
                    )}
                    {t("catalogTransfer.read")}
                </button>
                <button
                    type="button"
                    data-testid="catalog-export"
                    disabled={
                        !sync.ready ||
                        connection.recovery !== "none" ||
                        !exportSupported ||
                        !!exportRequirement ||
                        phase !== null
                    }
                    onClick={() => void exportZip()}
                >
                    {phase === "export" ? (
                        <LoaderCircle size={15} />
                    ) : (
                        <Download size={15} />
                    )}
                    {t("catalogTransfer.export")}
                </button>
            </div>
            {!readSupported && !exportSupported && (
                <p className="muted small">
                    {t("catalogTransfer.unavailable")}
                </p>
            )}
            {exportSupported && (
                <p className="muted small">
                    {t("catalogTransfer.patchNotice")}
                </p>
            )}
            {sync.ready && exportSupported && exportRequirement && (
                <p className="muted small">
                    {t(`catalogTransfer.errors.${exportRequirement}`)}
                </p>
            )}
            {!review && messages}
            {review && (
                <div className="unsaved-backdrop catalog-review-backdrop">
                    <dialog
                        open
                        aria-modal="false"
                        className="unsaved-dialog catalog-review-dialog"
                        data-testid="catalog-review"
                        aria-labelledby="catalog-review-heading"
                        onCancel={(event) => {
                            event.preventDefault();
                            if (phase === "review") close();
                        }}
                        onKeyDown={(event) => {
                            if (event.key === "Escape" && phase === "review") {
                                event.preventDefault();
                                event.stopPropagation();
                                close();
                            }
                        }}
                    >
                        <header>
                            <h2 id="catalog-review-heading">
                                {t("catalogTransfer.review")}
                            </h2>
                            <button
                                type="button"
                                ref={closeButton}
                                className="icon-button"
                                data-testid="catalog-review-close"
                                aria-label={t("settings.cancel")}
                                data-tooltip={t("settings.cancel")}
                                disabled={phase !== "review"}
                                onClick={close}
                            >
                                <X size={16} />
                            </button>
                        </header>
                        <div className="catalog-review-body">
                            <p>{t("catalogTransfer.replaceWarning")}</p>
                            <CatalogImportSummary
                                current={sync.ready ? document : null}
                                candidate={review.document}
                            />
                            <details>
                                <summary>{t("catalogTransfer.source")}</summary>
                                <code className="catalog-source-hash">
                                    {review.sourceHash}
                                </code>
                            </details>
                            {messages}
                        </div>
                        <footer className="dialog-actions">
                            <button
                                type="button"
                                disabled={phase !== "review"}
                                onClick={close}
                            >
                                {t("settings.cancel")}
                            </button>
                            <button
                                type="button"
                                className="primary-command"
                                data-testid="catalog-replace"
                                disabled={
                                    phase !== "review" ||
                                    connection.recovery !== "none" ||
                                    diagnostics.some(
                                        (entry) => entry.severity === "ERROR",
                                    )
                                }
                                onClick={() => void replace()}
                            >
                                {phase === "replace" ? (
                                    <LoaderCircle size={15} />
                                ) : (
                                    <FolderInput size={15} />
                                )}
                                {t("catalogTransfer.replace")}
                            </button>
                        </footer>
                    </dialog>
                </div>
            )}
        </section>
    );
}
