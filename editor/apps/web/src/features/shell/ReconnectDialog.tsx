import { useEffect, useRef } from "react";
import { RefreshCw, Unplug } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useConnectionStore } from "../../state/connection.js";

export function ReconnectDialog({ onDisconnect }: { onDisconnect(): void }) {
    const { t } = useTranslation();
    const connection = useConnectionStore();
    const root = useRef<HTMLDialogElement>(null);
    const blocked = connection.recovery === "blocked";
    useEffect(() => {
        const previous = document.activeElement;
        root.current
            ?.querySelector<HTMLButtonElement>("[data-primary]")
            ?.focus();
        const trap = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                event.preventDefault();
                event.stopImmediatePropagation();
            }
            if (event.key !== "Tab") return;
            const buttons = [
                ...(root.current?.querySelectorAll<HTMLButtonElement>(
                    "button:not(:disabled)",
                ) ?? []),
                ...document.querySelectorAll<HTMLButtonElement>(
                    ".window-controls button:not(:disabled)",
                ),
            ];
            const index = buttons.indexOf(
                document.activeElement as HTMLButtonElement,
            );
            event.preventDefault();
            buttons[
                (index + (event.shiftKey ? -1 : 1) + buttons.length) %
                    buttons.length
            ]?.focus();
        };
        window.addEventListener("keydown", trap, true);
        return () => {
            window.removeEventListener("keydown", trap, true);
            if (
                previous instanceof HTMLElement &&
                previous.isConnected &&
                !previous.closest("[inert]")
            )
                previous.focus({ preventScroll: true });
        };
    }, []);
    return (
        <div className="unsaved-backdrop reconnect-backdrop">
            <dialog
                ref={root}
                open
                className="unsaved-dialog"
                aria-modal="false"
                aria-labelledby="reconnect-heading"
                data-testid="reconnect-dialog"
                data-ui-popup
                onCancel={(event) => event.preventDefault()}
            >
                <h2 id="reconnect-heading">
                    {t(
                        blocked
                            ? "connection.identityHeading"
                            : "connection.lostHeading",
                    )}
                </h2>
                <p>
                    {connection.info?.serverAlias ||
                        connection.info?.serverName ||
                        connection.address}
                </p>
                <p className="muted">
                    {t(
                        blocked
                            ? "connection.identityBody"
                            : "connection.lostBody",
                    )}
                </p>
                <div className="dialog-actions">
                    <button
                        type="button"
                        data-primary={blocked || undefined}
                        data-testid="reconnect-disconnect"
                        onClick={onDisconnect}
                    >
                        <Unplug size={15} />
                        {t("connection.disconnect")}
                    </button>
                    {!blocked && (
                        <button
                            type="button"
                            data-primary
                            className="primary-command"
                            data-testid="reconnect-confirm"
                            onClick={connection.retry}
                        >
                            <RefreshCw size={15} />
                            {t("connection.retry")}
                        </button>
                    )}
                </div>
            </dialog>
        </div>
    );
}
