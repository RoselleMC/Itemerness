import { useCallback, useEffect, useRef, useState } from "react";
import { contentHash } from "@itemerness/protocol";
import { controlPlane, type DocumentEnvelope } from "../../api/client.js";
import {
    SerialDocumentAutosave,
    type DocumentSyncStatus,
} from "../../api/documentAutosave.js";
import { useEditorStore } from "../../state/store.js";

export interface DocumentSync {
    readonly ready: boolean;
    readonly status: DocumentSyncStatus;
    /** Reload on conflict, retry a failed save, or reconnect after an initial load failure. */
    readonly resolve: () => void;
}

type LoadMode = "initial" | "discard" | "clean-reload" | "reconnect";

/**
 * Keeps the browser document and the control plane's optimistic draft in one ordered timeline.
 */
export function useDocumentSync(): DocumentSync {
    const document = useEditorStore((state) => state.document);
    const setDocument = useEditorStore((state) => state.setDocument);
    const setDiagnostics = useEditorStore((state) => state.setDiagnostics);
    const [ready, setReady] = useState(false);
    const [status, setStatus] = useState<DocumentSyncStatus>({
        kind: "loading",
    });
    const documentRef = useRef(document);
    const autosaveRef = useRef<SerialDocumentAutosave | null>(null);
    const mountedRef = useRef(false);
    const loadGenerationRef = useRef(0);
    const automaticReloadRef = useRef<(hash: string) => void>(() => undefined);

    documentRef.current = document;

    const newAutosave = useCallback(
        (envelope: DocumentEnvelope): SerialDocumentAutosave =>
            new SerialDocumentAutosave({
                initialHash: envelope.snapshotHash,
                save: controlPlane.saveDocument,
                onStatus: (next) => {
                    if (mountedRef.current) setStatus(next);
                },
                onSaved: (result) => {
                    if (mountedRef.current) setDiagnostics(result.diagnostics);
                },
            }),
        [setDiagnostics],
    );

    const install = useCallback(
        (envelope: DocumentEnvelope) => {
            autosaveRef.current?.dispose();
            autosaveRef.current = newAutosave(envelope);
            documentRef.current = envelope.document;
            setDocument(envelope.document);
            setDiagnostics([]);
            setStatus({ kind: "saved" });
        },
        [newAutosave, setDiagnostics, setDocument],
    );

    const fetchAndInstall = useCallback(
        async (mode: LoadMode) => {
            const generation = ++loadGenerationRef.current;
            const localHashAtStart = contentHash(documentRef.current);
            try {
                const envelope = await controlPlane.loadDocument();
                if (
                    !mountedRef.current ||
                    generation !== loadGenerationRef.current
                ) {
                    return;
                }
                const localChanged =
                    contentHash(documentRef.current) !== localHashAtStart;
                if (mode === "clean-reload" && localChanged) {
                    autosaveRef.current?.markConflict(envelope.snapshotHash);
                    return;
                }
                if (
                    mode === "reconnect" &&
                    contentHash(documentRef.current) !== envelope.snapshotHash
                ) {
                    if (!autosaveRef.current)
                        autosaveRef.current = newAutosave(envelope);
                    autosaveRef.current.markConflict(envelope.snapshotHash);
                    return;
                }
                install(envelope);
            } catch (error) {
                if (
                    !mountedRef.current ||
                    generation !== loadGenerationRef.current
                ) {
                    return;
                }
                setStatus({
                    kind: "offline",
                    message:
                        error instanceof Error ? error.message : String(error),
                });
            } finally {
                if (
                    mode === "initial" &&
                    mountedRef.current &&
                    generation === loadGenerationRef.current
                ) {
                    setReady(true);
                }
            }
        },
        [install, newAutosave],
    );

    useEffect(() => {
        mountedRef.current = true;
        void fetchAndInstall("initial");
        return () => {
            mountedRef.current = false;
            loadGenerationRef.current += 1;
            autosaveRef.current?.dispose();
            autosaveRef.current = null;
        };
    }, [fetchAndInstall]);

    useEffect(() => {
        if (!ready) return;
        autosaveRef.current?.queue(document);
    }, [document, ready]);

    const automaticReload = useCallback(
        (announcedHash: string) => {
            const autosave = autosaveRef.current;
            if (!autosave) return;
            const disposition = autosave.observeRemoteUpdate(
                announcedHash,
                documentRef.current,
            );
            if (disposition === "reload") void fetchAndInstall("clean-reload");
        },
        [fetchAndInstall],
    );
    automaticReloadRef.current = automaticReload;

    useEffect(() => {
        let closed = false;
        let socket: WebSocket | null = null;
        let reconnect: ReturnType<typeof setTimeout> | null = null;
        let delay = 1_000;

        const connect = () => {
            if (closed) return;
            const url = new URL("/api/v1/events", window.location.href);
            url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
            socket = new WebSocket(url);
            socket.addEventListener("open", () => {
                delay = 1_000;
            });
            socket.addEventListener("message", (event) => {
                try {
                    const message = JSON.parse(String(event.data)) as {
                        type?: unknown;
                        snapshotHash?: unknown;
                    };
                    if (
                        (message.type === "hello" ||
                            message.type === "draft.updated") &&
                        typeof message.snapshotHash === "string"
                    ) {
                        automaticReloadRef.current(message.snapshotHash);
                    }
                } catch {
                    // Unknown event payloads are forward-compatible and have no document meaning.
                }
            });
            socket.addEventListener("close", () => {
                if (closed) return;
                reconnect = setTimeout(connect, delay);
                delay = Math.min(delay * 2, 10_000);
            });
        };

        connect();
        return () => {
            closed = true;
            if (reconnect !== null) clearTimeout(reconnect);
            socket?.close(1000, "editor unmounted");
        };
    }, []);

    const resolve = useCallback(() => {
        if (status.kind === "conflict") {
            setStatus({ kind: "loading" });
            void fetchAndInstall("discard");
        } else if (status.kind === "error") {
            autosaveRef.current?.retry();
        } else if (status.kind === "offline") {
            setStatus({ kind: "loading" });
            void fetchAndInstall("reconnect");
        }
    }, [fetchAndInstall, status.kind]);

    return { ready, status, resolve };
}
