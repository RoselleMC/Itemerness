import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { isTauri, invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { Save } from "lucide-react";
import { flushServerWorkspace } from "../../state/serverWorkspace.js";
import { flushServerAlias } from "../../state/serverAlias.js";
import type { DocumentSync } from "./useDocumentSync.js";
import { hasUnsavedChanges } from "./useSaveCommands.js";
import { useConnectionStore } from "../../state/connection.js";
import { useLocalOperationsStore } from "../../state/localOperations.js";
import {
    commitInlineEditor,
    hasPendingInlineEdits,
} from "../common/inlineEdit.js";

type LeaveAction = "exit" | "disconnect" | "replace";
export function useUnsavedChanges(sync: DocumentSync) {
    const { t } = useTranslation();
    const current = useRef(sync);
    current.current = sync;
    const [pending, setPending] = useState<LeaveAction | null>(null);
    const pendingAction = useRef<LeaveAction | null>(null);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState(false);
    const dialog = useRef<HTMLDialogElement>(null);
    const cancel = useRef<HTMLButtonElement>(null);
    const previousFocus = useRef<HTMLElement | null>(null);
    const client = useConnectionStore((state) => state.client);
    const localDirty = useLocalOperationsStore((state) => state.dirty);
    const localBusy = useLocalOperationsStore((state) => state.busy);
    const localNeedsSave = () => {
        const local = useLocalOperationsStore.getState();
        return local.dirty || local.busy;
    };
    const needsSave = (action: LeaveAction) =>
        hasUnsavedChanges(current.current) ||
        (action === "exit" && localNeedsSave());
    const replacement = useRef<{
        client: typeof client;
        resolve: (accepted: boolean) => void;
    } | null>(null);
    const settleReplacement = (accepted: boolean) => {
        replacement.current?.resolve(
            accepted &&
                replacement.current.client ===
                    useConnectionStore.getState().client,
        );
        replacement.current = null;
    };
    const cancelPending = () => {
        if (pendingAction.current === "exit" && isTauri())
            void invoke("cancel_editor_exit").catch(() => setError(true));
        pendingAction.current = null;
        settleReplacement(false);
        setError(false);
        setPending(null);
    };
    const perform = async (action: LeaveAction) => {
        if (action === "disconnect") useConnectionStore.getState().disconnect();
        else if (action === "replace") settleReplacement(true);
        else if (isTauri()) {
            await flushServerWorkspace();
            await flushServerAlias();
            await invoke("confirm_editor_exit");
        }
        pendingAction.current = null;
        setPending(null);
    };
    const request = (action: LeaveAction) => {
        if (pendingAction.current === action) return;
        pendingAction.current = action;
        if (action !== "replace") settleReplacement(false);
        const committed = commitInlineEditor();
        if (!committed || needsSave(action)) {
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
        if (replacement.current && replacement.current.client !== client)
            cancelPending();
    }, [client]);
    useEffect(() => () => settleReplacement(false), []);
    useEffect(() => {
        const beforeUnload = (event: BeforeUnloadEvent) => {
            if (!commitInlineEditor() || needsSave("exit")) {
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
                cancelPending();
            }
            if (event.key !== "Tab") return;
            const buttons = [
                ...(dialog.current?.querySelectorAll<HTMLButtonElement>(
                    "button:not(:disabled)",
                ) ?? []),
                ...document.querySelectorAll<HTMLButtonElement>(
                    ".window-controls button:not(:disabled)",
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
        if (!sync.ready && pending === "disconnect") {
            pendingAction.current = null;
            setPending(null);
        }
    }, [sync.ready, pending]);
    useEffect(() => {
        if (
            pending &&
            !saving &&
            !hasPendingInlineEdits() &&
            !needsSave(pending)
        )
            void perform(pending).catch(() => setError(true));
    }, [pending, saving, sync.status.kind, localDirty, localBusy]);
    const saveBeforeLeave = async (action: LeaveAction) => {
        if (!commitInlineEditor()) return false;
        if (
            hasUnsavedChanges(current.current) &&
            !(await current.current.save())
        )
            return false;
        if (action === "exit") {
            const local = useLocalOperationsStore.getState();
            if (local.busy) return false;
            if (local.dirty && !(await local.exportCurrent())) return false;
            if (localNeedsSave()) return false;
        }
        return !hasUnsavedChanges(current.current);
    };
    return {
        open: pending !== null,
        error: error && pending === null,
        disconnect: () => request("disconnect"),
        confirmReplace: () =>
            new Promise<boolean>((resolve) => {
                settleReplacement(false);
                replacement.current = {
                    client: useConnectionStore.getState().client,
                    resolve,
                };
                request("replace");
            }),
        dialog: pending && (
            <div className="unsaved-backdrop">
                <dialog
                    ref={dialog}
                    open
                    aria-modal="false"
                    className="unsaved-dialog"
                    data-testid="unsaved-dialog"
                    aria-labelledby="unsaved-heading"
                    onCancel={(event) => {
                        event.preventDefault();
                        if (!saving) {
                            cancelPending();
                        }
                    }}
                >
                    <h2 id="unsaved-heading">{t("settings.unsavedHeading")}</h2>
                    <p>
                        {t(
                            pending === "exit" && (localDirty || localBusy)
                                ? "localExit.prompt"
                                : "settings.savePrompt",
                        )}
                    </p>
                    {error && (
                        <p className="error" role="alert">
                            {t(
                                pending === "exit" && (localDirty || localBusy)
                                    ? "localExit.failed"
                                    : "settings.saveFailed",
                            )}
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
                            onClick={() => {
                                cancelPending();
                            }}
                        >
                            {t("settings.cancel")}
                        </button>
                        <button
                            type="button"
                            className="primary-command"
                            data-testid="leave-save"
                            disabled={
                                saving ||
                                (pending === "exit" && localBusy) ||
                                (!sync.ready &&
                                    !(pending === "exit" && localDirty))
                            }
                            onClick={() => {
                                setSaving(true);
                                setError(false);
                                void saveBeforeLeave(pending)
                                    .then(async (saved) => {
                                        if (saved) await perform(pending);
                                        else setError(true);
                                    })
                                    .catch(() => setError(true))
                                    .finally(() => setSaving(false));
                            }}
                        >
                            <Save size={15} />
                            {t(
                                pending === "exit" && localDirty
                                    ? "localExit.save"
                                    : "settings.save",
                            )}
                        </button>
                    </div>
                </dialog>
            </div>
        ),
    };
}
