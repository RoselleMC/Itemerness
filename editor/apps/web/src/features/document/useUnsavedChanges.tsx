import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { isTauri, invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { Save } from "lucide-react";
import type { DocumentSync } from "./useDocumentSync.js";
import { hasUnsavedChanges } from "./useSaveCommands.js";
import { useConnectionStore } from "../../state/connection.js";
import { usePreferences } from "../../state/preferences.js";
import { commitInlineEditor } from "../common/inlineEdit.js";

type LeaveAction = "exit" | "disconnect";
export function useUnsavedChanges(sync: DocumentSync) {
    const { t } = useTranslation();
    const current = useRef(sync);
    current.current = sync;
    const [pending, setPending] = useState<LeaveAction | null>(null);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState(false);
    const dialog = useRef<HTMLDialogElement>(null);
    const cancel = useRef<HTMLButtonElement>(null);
    const previousFocus = useRef<HTMLElement | null>(null);
    const perform = async (action: LeaveAction) => {
        if (action === "disconnect") useConnectionStore.getState().disconnect();
        else if (isTauri()) await invoke("confirm_editor_exit");
        setPending(null);
    };
    const request = (action: LeaveAction) => {
        commitInlineEditor();
        if (hasUnsavedChanges(current.current)) {
            if (
                !dialog.current?.open &&
                document.activeElement instanceof HTMLElement
            )
                previousFocus.current = document.activeElement;
            setError(false);
            setPending(action);
        } else
            void perform(action).catch(() => {
                setError(true);
                setPending(action);
            });
    };
    useEffect(() => {
        const beforeUnload = (event: BeforeUnloadEvent) => {
            commitInlineEditor();
            if (hasUnsavedChanges(current.current)) {
                event.preventDefault();
                event.returnValue = "";
            }
        };
        window.addEventListener("beforeunload", beforeUnload);
        let active = true;
        const stops: Array<() => void> = [];
        const register = (promise: Promise<() => void>) => {
            void promise
                .then((stop) => (active ? stops.push(stop) : stop()))
                .catch(() => {
                    if (active) setError(true);
                });
        };
        if (isTauri()) {
            register(
                getCurrentWindow().onCloseRequested((event) => {
                    event.preventDefault();
                    request("exit");
                }),
            );
            register(
                listen("editor-exit-requested", () => {
                    if (active) request("exit");
                }),
            );
        }
        return () => {
            active = false;
            window.removeEventListener("beforeunload", beforeUnload);
            stops.forEach((stop) => stop());
        };
    }, []);
    useEffect(() => {
        if (!pending) return;
        cancel.current?.focus();
        const trap = (event: KeyboardEvent) => {
            if (event.key === "Escape" && !saving) {
                event.preventDefault();
                event.stopPropagation();
                setPending(null);
            }
            if (event.key !== "Tab") return;
            const buttons = [
                ...document.querySelectorAll<HTMLButtonElement>(
                    ".unsaved-dialog button:not(:disabled), .window-controls button:not(:disabled)",
                ),
            ].filter((button) => button.getClientRects().length);
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
        return () => window.removeEventListener("keydown", trap, true);
    }, [pending, saving]);
    useEffect(() => {
        if (!pending) return;
        return () => {
            if (previousFocus.current?.isConnected)
                previousFocus.current.focus({ preventScroll: true });
            previousFocus.current = null;
        };
    }, [pending]);
    useEffect(() => {
        if (!sync.ready && pending === "disconnect") setPending(null);
    }, [sync.ready, pending]);
    useEffect(() => {
        if (pending && !saving && !hasUnsavedChanges(sync))
            void perform(pending).catch(() => setError(true));
    }, [pending, saving, sync.status.kind]);
    return {
        open: pending !== null,
        error: error && pending === null,
        disconnect: () => {
            if (!usePreferences.getState().autoSave) request("disconnect");
            else useConnectionStore.getState().disconnect();
        },
        dialog: pending && (
            <div className="unsaved-backdrop">
                <dialog
                    ref={dialog}
                    open
                    aria-modal="true"
                    className="unsaved-dialog"
                    data-testid="unsaved-dialog"
                    aria-labelledby="unsaved-heading"
                    onCancel={(event) => {
                        event.preventDefault();
                        if (!saving) setPending(null);
                    }}
                >
                    <h2 id="unsaved-heading">{t("settings.unsavedHeading")}</h2>
                    <p>{t("settings.savePrompt")}</p>
                    {error && (
                        <p className="error" role="alert">
                            {t("settings.saveFailed")}
                        </p>
                    )}
                    <div className="dialog-actions">
                        <button
                            type="button"
                            data-testid="leave-discard"
                            disabled={saving}
                            onClick={() =>
                                void perform(pending).catch(() =>
                                    setError(true),
                                )
                            }
                        >
                            {t("settings.discard")}
                        </button>
                        <button
                            type="button"
                            ref={cancel}
                            data-testid="leave-cancel"
                            disabled={saving}
                            onClick={() => setPending(null)}
                        >
                            {t("settings.cancel")}
                        </button>
                        <button
                            type="button"
                            className="primary-command"
                            data-testid="leave-save"
                            disabled={saving || !sync.ready}
                            onClick={() => {
                                setSaving(true);
                                setError(false);
                                void current.current
                                    .save()
                                    .then(async (saved) => {
                                        if (saved) await perform(pending);
                                        else setError(true);
                                    })
                                    .catch(() => setError(true))
                                    .finally(() => setSaving(false));
                            }}
                        >
                            <Save size={15} />
                            {t("settings.save")}
                        </button>
                    </div>
                </dialog>
            </div>
        ),
    };
}
