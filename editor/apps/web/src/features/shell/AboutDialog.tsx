import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { version } from "../../../package.json";
import icon from "../../../src-tauri/icons/128x128.png";

export function AboutDialog({ onClose }: { onClose(): void }) {
    const { t } = useTranslation();
    const close = useRef<HTMLButtonElement>(null);
    useEffect(() => {
        const previous = document.activeElement;
        close.current?.focus();
        const key = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                event.preventDefault();
                onClose();
            }
            if (event.key === "Tab") {
                event.preventDefault();
                const controls = [
                    close.current,
                    ...document.querySelectorAll<HTMLButtonElement>(
                        ".window-controls button",
                    ),
                ].filter(
                    (element): element is HTMLButtonElement => element !== null,
                );
                const index = controls.indexOf(
                    document.activeElement as HTMLButtonElement,
                );
                controls[
                    (index + (event.shiftKey ? -1 : 1) + controls.length) %
                        controls.length
                ]?.focus();
            }
        };
        window.addEventListener("keydown", key);
        return () => {
            window.removeEventListener("keydown", key);
            if (previous instanceof HTMLElement && previous.isConnected)
                previous.focus();
        };
    }, [onClose]);
    return (
        <div className="unsaved-backdrop">
            <dialog
                open
                className="unsaved-dialog about-dialog"
                aria-labelledby="about-heading"
                data-testid="about-dialog"
                data-ui-popup
            >
                <button
                    ref={close}
                    type="button"
                    className="icon-button"
                    aria-label={t("common.close")}
                    data-tooltip={t("common.close")}
                    onClick={onClose}
                >
                    <X size={17} />
                </button>
                <img src={icon} width={64} height={64} alt="" />
                <h2 id="about-heading">Itemerness Editor</h2>
                <p>{version}</p>
            </dialog>
        </div>
    );
}
