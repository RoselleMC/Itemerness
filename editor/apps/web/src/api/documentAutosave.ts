import { contentHash, type ProjectDocument } from "@itemerness/protocol";
import { ControlPlaneHttpError, type SaveDocumentResult } from "./client.js";

export type DocumentSyncStatus =
    | { readonly kind: "loading" }
    | { readonly kind: "saved" }
    | { readonly kind: "pending" }
    | { readonly kind: "saving" }
    | {
          readonly kind: "conflict";
          readonly actualHash: string;
      }
    | { readonly kind: "error"; readonly message: string }
    | { readonly kind: "offline"; readonly message: string };

interface Snapshot {
    readonly document: ProjectDocument;
    readonly hash: string;
}

export interface SerialDocumentAutosaveOptions {
    readonly initialHash: string;
    readonly debounceMillis?: number;
    readonly save: (
        document: ProjectDocument,
        expectedHash: string,
    ) => Promise<SaveDocumentResult>;
    readonly onStatus: (status: DocumentSyncStatus) => void;
    readonly onSaved: (result: SaveDocumentResult) => void;
}

export type RemoteUpdateDisposition = "known" | "reload" | "conflict";

/**
 * A debounced, single-flight optimistic save queue.
 *
 * The expected hash advances only after the corresponding PUT succeeds. Edits made during a PUT
 * replace the queued snapshot but never start another request, so the next PUT is derived from the
 * first response's hash rather than racing it with the old base.
 */
export class SerialDocumentAutosave {
    private expectedHash: string;
    private latest: Snapshot | null = null;
    private inFlight: Snapshot | null = null;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private blocked: "conflict" | "error" | null = null;
    private conflictHash: string | null = null;
    private disposed = false;

    private readonly debounceMillis: number;
    private readonly save: SerialDocumentAutosaveOptions["save"];
    private readonly onStatus: SerialDocumentAutosaveOptions["onStatus"];
    private readonly onSaved: SerialDocumentAutosaveOptions["onSaved"];

    constructor(options: SerialDocumentAutosaveOptions) {
        this.expectedHash = options.initialHash;
        this.debounceMillis = options.debounceMillis ?? 500;
        this.save = options.save;
        this.onStatus = options.onStatus;
        this.onSaved = options.onSaved;
        this.onStatus({ kind: "saved" });
    }

    queue(document: ProjectDocument): void {
        if (this.disposed) return;
        const snapshot = { document, hash: contentHash(document) };
        this.latest = snapshot;

        if (this.blocked === "conflict") return;
        if (this.blocked === "error") this.blocked = null;
        if (!this.inFlight && snapshot.hash === this.expectedHash) {
            this.clearTimer();
            this.onStatus({ kind: "saved" });
            return;
        }

        this.onStatus(this.inFlight ? { kind: "saving" } : { kind: "pending" });
        if (!this.inFlight) this.arm(this.debounceMillis);
    }

    retry(): void {
        if (this.disposed || this.blocked !== "error") return;
        this.blocked = null;
        if (!this.latest || this.latest.hash === this.expectedHash) {
            this.onStatus({ kind: "saved" });
            return;
        }
        this.onStatus({ kind: "pending" });
        this.arm(0);
    }

    /** Stops saving and preserves the local draft until the user explicitly reloads it. */
    markConflict(actualHash: string): void {
        if (this.disposed) return;
        this.clearTimer();
        this.blocked = "conflict";
        this.conflictHash = actualHash;
        this.onStatus({ kind: "conflict", actualHash });
    }

    /**
     * Classifies a WebSocket update without guessing which document should win.
     * Known own-save events are ignored, a clean editor may reload, and a dirty editor conflicts.
     */
    observeRemoteUpdate(
        actualHash: string,
        currentDocument: ProjectDocument,
    ): RemoteUpdateDisposition {
        const currentHash = contentHash(currentDocument);
        if (
            actualHash === this.expectedHash ||
            actualHash === this.inFlight?.hash
        ) {
            return "known";
        }
        if (actualHash === currentHash && !this.inFlight) {
            this.expectedHash = actualHash;
            this.latest = { document: currentDocument, hash: currentHash };
            this.blocked = null;
            this.onStatus({ kind: "saved" });
            return "known";
        }
        if (!this.inFlight && currentHash === this.expectedHash)
            return "reload";
        this.markConflict(actualHash);
        return "conflict";
    }

    dispose(): void {
        this.disposed = true;
        this.clearTimer();
    }

    private arm(delay: number): void {
        this.clearTimer();
        this.timer = setTimeout(() => {
            this.timer = null;
            void this.flush();
        }, delay);
    }

    private clearTimer(): void {
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = null;
    }

    private async flush(): Promise<void> {
        if (this.disposed || this.inFlight || this.blocked || !this.latest) {
            return;
        }
        const snapshot = this.latest;
        if (snapshot.hash === this.expectedHash) {
            this.onStatus({ kind: "saved" });
            return;
        }

        const expectedHash = this.expectedHash;
        this.inFlight = snapshot;
        this.onStatus({ kind: "saving" });
        try {
            const result = await this.save(snapshot.document, expectedHash);
            if (this.disposed) return;
            this.expectedHash = result.snapshotHash;
            this.onSaved(result);
            this.inFlight = null;

            // A server normalization that changes canonical content cannot be merged without the
            // normalized document. Stop instead of repeatedly saving the same local representation.
            if (result.snapshotHash !== snapshot.hash) {
                this.markConflict(result.snapshotHash);
                return;
            }

            // An external update may have arrived after this save was accepted but before its HTTP
            // response. It remains authoritative and must not be cleared by the late response.
            if (
                this.blocked === "conflict" &&
                this.conflictHash !== result.snapshotHash
            ) {
                this.onStatus({
                    kind: "conflict",
                    actualHash: this.conflictHash!,
                });
                return;
            }
            this.blocked = null;
            this.conflictHash = null;
            if (!this.latest || this.latest.hash === this.expectedHash) {
                this.onStatus({ kind: "saved" });
            } else {
                this.onStatus({ kind: "pending" });
                this.arm(this.debounceMillis);
            }
        } catch (error) {
            if (this.disposed) return;
            this.inFlight = null;
            if (
                error instanceof ControlPlaneHttpError &&
                error.status === 409
            ) {
                const actualHash = conflictActualHash(error.body);
                // Another editor may already have persisted byte-for-byte the same latest draft.
                // In that case there is nothing left to resolve or overwrite.
                if (actualHash && actualHash === this.latest?.hash) {
                    this.expectedHash = actualHash;
                    this.blocked = null;
                    this.conflictHash = null;
                    this.onStatus({ kind: "saved" });
                    return;
                }
                this.markConflict(actualHash ?? "unknown");
                return;
            }
            this.blocked = "error";
            this.onStatus({
                kind: "error",
                message: error instanceof Error ? error.message : String(error),
            });
        }
    }
}

function conflictActualHash(body: unknown): string | null {
    if (typeof body !== "object" || body === null) return null;
    const value = (body as Record<string, unknown>).actualHash;
    return typeof value === "string" ? value : null;
}
