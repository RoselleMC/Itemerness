import { useCallback, useEffect, useRef, useState } from "react";
import { contentHash } from "@itemerness/protocol";
import { type PluginClient } from "../../api/client.js";
import {
    SerialDocumentAutosave,
    type DocumentSyncStatus,
} from "../../api/documentAutosave.js";
import { useEditorStore } from "../../state/store.js";
import { useConnectionStore } from "../../state/connection.js";
import { usePreferences } from "../../state/preferences.js";
import { commitInlineEditor } from "../common/inlineEdit.js";

export interface DocumentSync {
    /** Editing is allowed only after this connection has supplied a validated document. */
    readonly ready: boolean;
    readonly status: DocumentSyncStatus;
    readonly resolve: () => void;
    readonly save: () => Promise<boolean>;
    readonly isDirty: () => boolean;
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
    const [session, setSession] = useState<Session>({
        client: null,
        ready: false,
        status: { kind: "disconnected" },
    });
    const documentRef = useRef(document);
    const autosaveRef = useRef<SerialDocumentAutosave | null>(null);
    const reloadRef = useRef<() => void>(() => undefined);
    documentRef.current = document;
    const ready = client !== null && session.client === client && session.ready;

    useEffect(() => {
        let disposed = false;
        let fetching = false;
        let initialized = false;
        let firstLoad = true;
        let timer: ReturnType<typeof setTimeout> | null = null;
        autosaveRef.current?.dispose();
        autosaveRef.current = null;
        reloadRef.current = () => undefined;
        useEditorStore.getState().resetDraft();
        if (!client) return;

        const current = () =>
            !disposed && useConnectionStore.getState().client === client;
        const update = (status: DocumentSyncStatus, ready: boolean) => {
            if (current()) setSession({ client, status, ready });
        };
        update({ kind: "loading" }, false);

        const load = async (discard = false) => {
            if (fetching || !current()) return;
            fetching = true;
            const before = contentHash(documentRef.current);
            try {
                if (!firstLoad) {
                    const negotiated = await client.handshake();
                    if (!current()) return;
                    if (
                        contentHash(negotiated.info) !==
                        contentHash(useConnectionStore.getState().info)
                    )
                        useConnectionStore.setState(negotiated);
                }
                firstLoad = false;
                const envelope = await client.loadDocument();
                if (!current()) return;
                if (!envelope) {
                    update({ kind: "empty" }, false);
                    autosaveRef.current?.dispose();
                    autosaveRef.current = null;
                    if (initialized) useEditorStore.getState().resetDraft();
                    initialized = false;
                    return;
                }
                if (
                    initialized &&
                    discard &&
                    before !== contentHash(documentRef.current)
                ) {
                    autosaveRef.current?.markConflict(envelope.snapshotHash);
                    return;
                }
                if (!initialized || discard) {
                    autosaveRef.current?.dispose();
                    documentRef.current = envelope.document;
                    useEditorStore.getState().setDocument(envelope.document);
                    useEditorStore.getState().setDiagnostics([]);
                    autosaveRef.current = new SerialDocumentAutosave({
                        initialHash: envelope.snapshotHash,
                        automatic: usePreferences.getState().autoSave,
                        save: (draft, expected) =>
                            client.saveDocument(draft, expected),
                        onStatus: (status) => update(status, true),
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
                    initialized = true;
                    update({ kind: "saved" }, true);
                } else {
                    const disposition =
                        autosaveRef.current?.observeRemoteUpdate(
                            envelope.snapshotHash,
                            documentRef.current,
                        );
                    if (disposition === "reload") {
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
            } catch (error) {
                if (current()) {
                    useConnectionStore.getState().disconnect();
                    useConnectionStore.setState({
                        status: "error",
                        error:
                            error instanceof Error
                                ? error.message
                                : "CONNECTION_FAILED",
                    });
                }
            } finally {
                fetching = false;
                if (current()) timer = setTimeout(() => void load(), 3_000);
            }
        };
        void load();
        reloadRef.current = () => {
            if (timer) clearTimeout(timer);
            void load(true);
        };
        return () => {
            disposed = true;
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
        commitInlineEditor();
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
        if (status.kind === "error") void save();
        else reloadRef.current();
    }, [status.kind, save]);
    const isDirty = useCallback(
        () =>
            ready &&
            client === useConnectionStore.getState().client &&
            !!autosaveRef.current?.isDirty(
                useEditorStore.getState().snapshotHash,
            ),
        [ready, client],
    );
    return {
        ready,
        status:
            transaction !== null && status.kind === "saved"
                ? { kind: "pending" }
                : status,
        resolve,
        save,
        isDirty,
    };
}
