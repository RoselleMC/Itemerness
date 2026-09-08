import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
    ChevronDown,
    CircleAlert,
    LoaderCircle,
    Server,
    Unplug,
    X,
    Save,
} from "lucide-react";
import { useConnectionStore } from "../../state/connection.js";
import { ConnectionPanel } from "./ConnectionPanel.js";
import type { DocumentSync } from "../document/useDocumentSync.js";
import { describeContext } from "../../state/interface.js";
import { copyAction } from "../common/contextActions.js";

export function ConnectionCenter({
    open,
    setOpen,
    documentSync,
    onDisconnect,
    interactionBlocked = false,
}: {
    open: boolean;
    setOpen: (open: boolean) => void;
    documentSync: DocumentSync;
    onDisconnect: () => void;
    interactionBlocked?: boolean;
}) {
    const { t } = useTranslation();
    const connection = useConnectionStore();
    const root = useRef<HTMLDivElement>(null);
    const trigger = useRef<HTMLButtonElement>(null);
    const status =
        connection.error === "PROTOCOL_INCOMPATIBLE"
            ? "incompatible"
            : connection.status;
    const label =
        connection.info?.serverAlias ||
        connection.info?.serverName ||
        connection.info?.serverId ||
        (connection.address
            ? endpointLabel(connection.address)
            : t("connection.chooseServer"));
    const StateIcon =
        connection.status === "connecting" ||
        connection.status === "reconnecting"
            ? LoaderCircle
            : connection.status === "error"
              ? CircleAlert
              : connection.status === "connected"
                ? Server
                : Unplug;

    useEffect(() => {
        if (!open) return;
        const dismiss = (event: PointerEvent) => {
            if (
                event.target instanceof Node &&
                !root.current?.contains(event.target) &&
                !(
                    event.target instanceof Element &&
                    event.target.closest(
                        "[data-ui-popup],[data-application-menu]",
                    )
                )
            )
                setOpen(false);
        };
        document.addEventListener("pointerdown", dismiss, true);
        return () => document.removeEventListener("pointerdown", dismiss, true);
    }, [open, setOpen]);

    const close = () => {
        setOpen(false);
        trigger.current?.focus();
    };

    return (
        <div
            className="connection-center"
            inert={interactionBlocked}
            ref={root}
            data-no-drag
            onContextMenu={(event) =>
                describeContext(event, {
                    label: t("connection.heading"),
                    items: [
                        {
                            id: "connection",
                            label: t("connection.heading"),
                            icon: Server,
                            run: () => setOpen(true),
                        },
                        {
                            ...copyAction(
                                "copy-address",
                                t("menus.copyAddress"),
                                connection.address ?? "",
                            ),
                            disabled: !connection.address,
                        },
                        {
                            id: "save",
                            label: t("settings.save"),
                            icon: Save,
                            disabled: !documentSync.ready,
                            run: documentSync.save,
                        },
                        {
                            id: "disconnect",
                            label: t("connection.disconnect"),
                            icon: Unplug,
                            disabled: connection.status === "offline",
                            separator: true,
                            run: onDisconnect,
                        },
                    ],
                })
            }
            onKeyDown={(event) => {
                if (event.key === "Escape" && open) {
                    event.preventDefault();
                    event.stopPropagation();
                    close();
                }
            }}
            onBlur={(event) => {
                if (
                    event.relatedTarget instanceof Node &&
                    !event.currentTarget.contains(event.relatedTarget) &&
                    !(
                        event.relatedTarget instanceof Element &&
                        event.relatedTarget.closest(
                            "[data-ui-popup],[data-application-menu]",
                        )
                    )
                )
                    setOpen(false);
            }}
        >
            <button
                type="button"
                ref={trigger}
                className="connection-trigger"
                data-testid="connection-trigger"
                data-state={connection.status}
                aria-haspopup="dialog"
                aria-expanded={open}
                aria-controls="connection-popup"
                aria-label={`${t("connection.heading")}: ${label}, ${t(`connection.${status}`)}`}
                data-tooltip={`${label} · ${t(`connection.${status}`)}`}
                onClick={() => setOpen(!open)}
                onKeyDown={(event) => {
                    if (event.key === "ArrowDown") {
                        event.preventDefault();
                        setOpen(true);
                    }
                }}
            >
                <StateIcon
                    size={15}
                    className={
                        connection.status === "connecting" ||
                        connection.status === "reconnecting"
                            ? "connection-spinner"
                            : undefined
                    }
                    aria-hidden="true"
                />
                <span className="connection-target">{label}</span>
                <span
                    className="connection-state-label"
                    data-testid="connection-summary"
                    role="status"
                    aria-live="polite"
                >
                    {t(`connection.${status}`)}
                </span>
                <ChevronDown size={13} aria-hidden="true" />
            </button>
            {open && (
                <div
                    className="connection-popup"
                    id="connection-popup"
                    role="dialog"
                    aria-labelledby="connection-heading"
                    data-testid="connection-popup"
                >
                    <header className="connection-popup-heading">
                        <h2 id="connection-heading">
                            {t("connection.heading")}
                        </h2>
                        <button
                            type="button"
                            className="icon-button"
                            aria-label={t("common.close")}
                            data-tooltip={t("common.close")}
                            onClick={close}
                            data-testid="close-connection"
                        >
                            <X size={16} />
                        </button>
                    </header>
                    <ConnectionPanel onDisconnect={onDisconnect} />
                    <div
                        className="connection-draft"
                        data-sync-kind={documentSync.status.kind}
                    >
                        <span>{t("connection.draft")}</span>
                        {documentSync.status.kind === "unsaved" && (
                            <button
                                type="button"
                                data-testid="save-document"
                                onClick={() => void documentSync.save()}
                            >
                                <Save size={14} />
                                {t("settings.save")}
                            </button>
                        )}
                        {["conflict", "error", "offline"].includes(
                            documentSync.status.kind,
                        ) ? (
                            <button
                                type="button"
                                data-testid="connection-resolve-draft"
                                onClick={() => {
                                    documentSync.resolve();
                                    close();
                                }}
                            >
                                {t(
                                    `sidebar.documentSync.${documentSync.status.kind}`,
                                )}
                            </button>
                        ) : (
                            <span>
                                {t(
                                    `sidebar.documentSync.${documentSync.status.kind}`,
                                )}
                            </span>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}

function endpointLabel(address: string): string {
    try {
        const url = new URL(address);
        return url.host + url.pathname.replace(/\/$/, "");
    } catch {
        return address;
    }
}
