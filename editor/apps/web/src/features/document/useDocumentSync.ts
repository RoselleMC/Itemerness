import { useCallback, useEffect, useRef, useState } from "react";
import {
    contentHash,
    projectDocumentSchema,
    type ProjectDocument,
} from "@itemerness/protocol";
import { PluginHttpError, type PluginClient } from "../../api/client.js";
import { notify } from "../../state/toasts.js";
import i18next from "../../i18n/index.js";
import {
    SerialDocumentAutosave,
    type DocumentSyncStatus,
} from "../../api/documentAutosave.js";
import { useEditorStore } from "../../state/store.js";
import { useConnectionStore } from "../../state/connection.js";
import { usePreferences } from "../../state/preferences.js";
import {
    commitInlineEditor,
    hasPendingInlineEdits,
} from "../common/inlineEdit.js";

export interface DocumentSync {
    /** Editing is allowed only after this connection has supplied a validated document. */
    readonly ready: boolean;
    readonly status: DocumentSyncStatus;
    readonly resolve: () => void;
    readonly save: () => Promise<boolean>;
    readonly isDirty: () => boolean;
    /** An explicit import persists through CAS before replacing the visible workspace. */
    readonly replaceDocument: (
        candidate: ProjectDocument,
        expectedLocalHash: string,
    ) => Promise<boolean>;
}

interface Session {
    client: PluginClient | null;
    ready: boolean;
    status: DocumentSyncStatus;
}

export function useDocumentSync(): DocumentSync {
    const automatic = usePreferences((state) => state.autoSave);
    const document = useEditorStore((state) => state.document);
    const persistenceDocument = useEditorStore(
        (state) => state.persistenceDocument,
    );
    const transaction = useEditorStore((state) => state.historyTransactionId);
    const client = useConnectionStore((state) => state.client);
    const connecting = useConnectionStore(
        (state) => state.status === "connecting",
    );
    const recovery = useConnectionStore((state) => state.recovery);
    const connectionError = useConnectionStore((state) => state.error);
    const [session, setSession] = useState<Session>({
        client: null,
        ready: false,
        status: { kind: "disconnected" },
    });
    const [pendingInline, setPendingInline] = useState(false);
    useEffect(() => {
        const update = () => setPendingInline(hasPendingInlineEdits());
        window.addEventListener("itemerness:inline-dirty", update);
        return () =>
            window.removeEventListener("itemerness:inline-dirty", update);
    }, []);
    const documentRef = useRef(document);
    const autosaveRef = useRef<SerialDocumentAutosave | null>(null);
    const reloadRef = useRef<() => void>(() => undefined);
    const replaceRef = useRef<DocumentSync["replaceDocument"]>(
        async () => false,
    );
    documentRef.current = document;
    const ready = client !== null && session.client === client && session.ready;

    useEffect(() => {
        let disposed = false;
        let fetching = false;
        let initialized = false;
        let firstLoad = true;
        let replacing = false;
        let failedReplacement = false;
        let documentGeneration = 0;
        let timer: ReturnType<typeof setTimeout> | null = null;
        autosaveRef.current?.dispose();
        autosaveRef.current = null;
        reloadRef.current = () => undefined;
        replaceRef.current = async () => false;
        useEditorStore.getState().resetDraft();
        if (!client) return;

        const current = () =>
            !disposed && useConnectionStore.getState().client === client;
        const update = (status: DocumentSyncStatus, ready: boolean) => {
            if (current()) setSession({ client, status, ready });
        };
        const interrupted = (error: unknown) => {
            if (!current()) return;
            autosaveRef.current?.setSuspended(true);
            useConnectionStore.getState().interrupted(client, error);
        };
        const restored = () => {
            if (!current()) return;
            const wasInterrupted =
                useConnectionStore.getState().recovery !== "none";
            useConnectionStore.getState().restored(client);
            autosaveRef.current?.setSuspended(false);
            if (wasInterrupted)
                notify(
                    String(i18next.t("connection.recovered")),
                    "success",
                    "connection-recovered",
                );
        };
        update({ kind: "loading" }, false);
        const createAutosave = (initialHash: string) =>
            new SerialDocumentAutosave({
                initialHash,
                automatic: usePreferences.getState().autoSave,
                save: async (draft, expected) => {
                    try {
                        return await client.saveDocument(draft, expected);
                    } catch (error) {
                        const message =
                            error instanceof Error ? error.message : error;
                        if (
                            error instanceof TypeError ||
                            (error instanceof Error &&
                                error.name === "AbortError") ||
                            [
                                "NETWORK_UNAVAILABLE",
                                "CONNECTION_INTERRUPTED",
                                "SERVER_IDENTITY_CHANGED",
                            ].includes(String(message)) ||
                            (error instanceof PluginHttpError &&
                                (error.status >= 500 ||
                                    [401, 403, 408, 429].includes(
                                        error.status,
                                    )))
                        )
                            interrupted(error);
                        throw error;
                    }
                },
                onStatus: (status) => update(status, initialized),
                onSaved: (result) => {
                    if (
                        current() &&
                        result.snapshotHash ===
                            useEditorStore.getState().snapshotHash
                    )
                        useEditorStore
                            .getState()
                            .setDiagnostics(result.diagnostics);
                },
            });

        const load = async (discard = false) => {
            if (fetching || replacing || !current()) return;
            fetching = true;
            const generation = documentGeneration;
            const before = contentHash(documentRef.current);
            try {
                if (!firstLoad) {
                    const negotiated = await client.handshake();
                    if (!current() || generation !== documentGeneration) return;
                    if (
                        contentHash(negotiated.info) !==
                        contentHash(useConnectionStore.getState().info)
                    )
                        useConnectionStore.setState(negotiated);
                }
                firstLoad = false;
                const envelope = await client.loadDocument();
                if (
                    !current() ||
                    replacing ||
                    generation !== documentGeneration
                )
                    return;
                // Transport recovery alone cannot release writes before this document is classified.
                if (
                    failedReplacement &&
                    !discard &&
                    (!envelope ||
                        (envelope.snapshotHash !==
                            contentHash(documentRef.current) &&
                            (autosaveRef.current?.isDirty(
                                envelope.snapshotHash,
                            ) ??
                                true)))
                ) {
                    if (autosaveRef.current)
                        autosaveRef.current.markConflict(
                            envelope?.snapshotHash ?? "",
                        );
                    else
                        update(
                            {
                                kind: "conflict",
                                actualHash: envelope?.snapshotHash ?? "",
                            },
                            initialized,
                        );
                    restored();
                    return;
                }
                if (!envelope) {
                    if (
                        initialized &&
                        !discard &&
                        (hasPendingInlineEdits() ||
                            autosaveRef.current?.isDirty(
                                contentHash(documentRef.current),
                            ))
                    ) {
                        autosaveRef.current?.markConflict("");
                        restored();
                        return;
                    }
                    update({ kind: "empty" }, false);
                    autosaveRef.current?.dispose();
                    autosaveRef.current = null;
                    if (initialized) useEditorStore.getState().resetDraft();
                    initialized = false;
                    restored();
                    return;
                }
                if (
                    initialized &&
                    discard &&
                    before !== contentHash(documentRef.current)
                ) {
                    autosaveRef.current?.markConflict(envelope.snapshotHash);
                    restored();
                    return;
                }
                if (!initialized || discard) {
                    autosaveRef.current?.dispose();
                    documentRef.current = envelope.document;
                    useEditorStore.getState().setDocument(envelope.document);
                    useEditorStore.getState().setDiagnostics([]);
                    initialized = true;
                    failedReplacement = false;
                    autosaveRef.current = createAutosave(envelope.snapshotHash);
                    update({ kind: "saved" }, true);
                } else {
                    const disposition =
                        autosaveRef.current?.observeRemoteUpdate(
                            envelope.snapshotHash,
                            documentRef.current,
                        );
                    if (disposition === "reload") {
                        if (hasPendingInlineEdits()) {
                            autosaveRef.current?.markConflict(
                                envelope.snapshotHash,
                            );
                            restored();
                            return;
                        }
                        documentRef.current = envelope.document;
                        useEditorStore
                            .getState()
                            .setDocument(envelope.document);
                        autosaveRef.current?.observeRemoteUpdate(
                            envelope.snapshotHash,
                            envelope.document,
                        );
                    }
                }
                restored();
            } catch (error) {
                if (
                    current() &&
                    !replacing &&
                    generation === documentGeneration
                ) {
                    interrupted(error);
                    update(
                        {
                            kind: "offline",
                            message:
                                error instanceof Error
                                    ? error.message
                                    : "CONNECTION_FAILED",
                        },
                        initialized,
                    );
                }
            } finally {
                fetching = false;
                schedule();
            }
        };
        const schedule = () => {
            if (timer) clearTimeout(timer);
            timer = null;
            if (!current() || replacing || fetching) return;
            const state = useConnectionStore.getState();
            if (state.recovery === "manual" || state.recovery === "blocked")
                return;
            const delay =
                state.recovery === "retrying"
                    ? 0
                    : state.retryAt === null
                      ? 3000
                      : Math.max(0, state.retryAt - Date.now());
            timer = setTimeout(() => void load(), delay);
        };
        const unsubscribe = useConnectionStore.subscribe((state, previous) => {
            if (
                state.retryRequest !== previous.retryRequest ||
                state.recovery !== previous.recovery
            )
                schedule();
        });
        const retryOnline = () => {
            const state = useConnectionStore.getState();
            if (
                current() &&
                state.recovery === "waiting" &&
                usePreferences.getState().reconnectMode === "automatic"
            )
                state.retry();
        };
        const stopPreference = usePreferences.subscribe((state, previous) => {
            if (!current() || state.reconnectMode === previous.reconnectMode)
                return;
            const connection = useConnectionStore.getState();
            if (
                state.reconnectMode === "automatic" &&
                connection.recovery === "manual"
            )
                connection.retry();
            else if (
                state.reconnectMode === "manual" &&
                connection.recovery === "waiting"
            )
                useConnectionStore.setState({
                    recovery: "manual",
                    retryAt: null,
                    status: "error",
                });
        });
        window.addEventListener("online", retryOnline);
        window.addEventListener("focus", retryOnline);
        void load();
        reloadRef.current = () => {
            if (timer) clearTimeout(timer);
            void load(true);
        };
        replaceRef.current = async (candidate, expectedLocalHash) => {
            if (
                !current() ||
                useConnectionStore.getState().recovery !== "none" ||
                replacing ||
                contentHash(documentRef.current) !== expectedLocalHash ||
                useEditorStore.getState().historyTransactionId !== null
            )
                return false;
            projectDocumentSchema.parse(candidate);
            replacing = true;
            documentGeneration++;
            if (timer) clearTimeout(timer);
            const hadDocument = initialized;
            const queue = autosaveRef.current ?? createAutosave("");
            autosaveRef.current = queue;
            try {
                const saved = await queue.saveNow(candidate);
                if (!current()) return false;
                if (
                    saved &&
                    useEditorStore.getState().snapshotHash === expectedLocalHash
                ) {
                    documentRef.current = candidate;
                    useEditorStore.getState().setDocument(candidate);
                    useEditorStore.getState().setDiagnostics([]);
                    initialized = true;
                    failedReplacement = false;
                    update({ kind: "saved" }, true);
                    return true;
                }
                failedReplacement = true;
                if (hadDocument)
                    queue.queue(useEditorStore.getState().persistenceDocument);
                else {
                    queue.dispose();
                    autosaveRef.current = null;
                }
                return false;
            } finally {
                replacing = false;
                if (current()) {
                    schedule();
                }
            }
        };
        return () => {
            disposed = true;
            unsubscribe();
            stopPreference();
            window.removeEventListener("online", retryOnline);
            window.removeEventListener("focus", retryOnline);
            if (timer) clearTimeout(timer);
            autosaveRef.current?.dispose();
            autosaveRef.current = null;
        };
    }, [client]);

    useEffect(() => {
        autosaveRef.current?.setAutomatic(automatic);
    }, [automatic]);

    useEffect(() => {
        if (
            !ready ||
            !client ||
            useConnectionStore.getState().client !== client
        )
            return;
        autosaveRef.current?.queue(persistenceDocument);
        // Best-effort recovery evidence is scoped to its source, never automatically displayed or
        // uploaded. The legacy unscoped local draft is deliberately left untouched and unread.
        try {
            localStorage.setItem(
                `itemerness.recovery.v2:${encodeURIComponent(client.baseUrl)}`,
                JSON.stringify({
                    serverId: useConnectionStore.getState().info?.serverId,
                    document: persistenceDocument,
                }),
            );
        } catch {
            /* Server autosave, not this optional copy, determines save status. */
        }
    }, [persistenceDocument, ready, client]);

    const status: DocumentSyncStatus = !client
        ? { kind: connecting ? "loading" : "disconnected" }
        : session.client === client
          ? session.status
          : { kind: "loading" };
    const save = useCallback(async () => {
        if (useConnectionStore.getState().recovery !== "none") return false;
        if (!commitInlineEditor()) return false;
        const state = useEditorStore.getState();
        if (
            !ready ||
            !client ||
            useConnectionStore.getState().client !== client ||
            state.historyTransactionId !== null
        )
            return false;
        const document = state.persistenceDocument;
        const result = await autosaveRef.current?.saveNow(document);
        return (
            !!result &&
            useConnectionStore.getState().client === client &&
            useEditorStore.getState().snapshotHash === contentHash(document)
        );
    }, [ready, client]);
    const resolve = useCallback(() => {
        if (useConnectionStore.getState().recovery !== "none")
            useConnectionStore.getState().retry();
        else if (status.kind === "error") void save();
        else reloadRef.current();
    }, [status.kind, save]);
    const isDirty = useCallback(
        () =>
            ready &&
            client === useConnectionStore.getState().client &&
            (hasPendingInlineEdits() ||
                !!autosaveRef.current?.isDirty(
                    useEditorStore.getState().snapshotHash,
                )),
        [ready, client],
    );
    const replaceDocument = useCallback<DocumentSync["replaceDocument"]>(
        (candidate, expectedLocalHash) =>
            replaceRef.current(candidate, expectedLocalHash),
        [],
    );
    return {
        ready,
        status:
            recovery !== "none"
                ? {
                      kind: "offline",
                      message: connectionError ?? "CONNECTION_FAILED",
                  }
                : ready && pendingInline && status.kind === "saved"
                  ? { kind: "unsaved" }
                  : transaction !== null && status.kind === "saved"
                    ? { kind: "pending" }
                    : status,
        resolve,
        save,
        isDirty,
        replaceDocument,
    };
}
