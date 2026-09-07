import { contentHash, type ProjectDocument } from "@itemerness/protocol";
import { PluginHttpError, type SaveDocumentResult } from "./client.js";

export type DocumentSyncStatus =
    | { readonly kind: "disconnected" }
    | { readonly kind: "empty" }
    | { readonly kind: "local" }
    | { readonly kind: "loading" }
    | { readonly kind: "saved" }
    | { readonly kind: "pending" }
    | { readonly kind: "unsaved" }
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
    readonly automatic?: boolean;
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
    private automatic: boolean;
    private requested: Snapshot | null = null;
    private readonly waiters = new Set<{
        hash: string;
        resolve: (saved: boolean) => void;
    }>();

    private readonly debounceMillis: number;
    private readonly save: SerialDocumentAutosaveOptions["save"];
    private readonly onStatus: SerialDocumentAutosaveOptions["onStatus"];
    private readonly onSaved: SerialDocumentAutosaveOptions["onSaved"];

    constructor(options: SerialDocumentAutosaveOptions) {
        this.expectedHash = options.initialHash;
        this.automatic = options.automatic ?? true;
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
            this.onStatus({
                kind:
                    this.requested && this.requested.hash !== this.expectedHash
                        ? "pending"
                        : "saved",
            });
            if (this.requested) this.arm(0);
            return;
        }

        this.onStatus(
            this.inFlight
                ? { kind: "saving" }
                : { kind: this.automatic ? "pending" : "unsaved" },
        );
        if (!this.inFlight && this.automatic) this.arm(this.debounceMillis);
    }

    setAutomatic(automatic: boolean): void {
        if (this.disposed || this.automatic === automatic) return;
        this.automatic = automatic;
        this.clearTimer();
        if (this.blocked) return;
        if (this.inFlight) return;
        if (this.requested) this.arm(0);
        else if (this.latest && this.latest.hash !== this.expectedHash) {
            this.onStatus({ kind: automatic ? "pending" : "unsaved" });
            if (automatic) this.arm(this.debounceMillis);
        }
    }

    isDirty(hash: string): boolean {
        return (
            hash !== this.expectedHash ||
            this.inFlight !== null ||
            this.requested !== null
        );
    }

    /** Explicit saves capture this document, not edits made later while a PUT is in flight. */
    saveNow(document: ProjectDocument): Promise<boolean> {
        if (this.disposed || this.blocked === "conflict")
            return Promise.resolve(false);
        this.queue(document);
        const snapshot = this.latest!;
        if (
            this.requested &&
            this.requested.hash !== snapshot.hash &&
            this.requested.hash !== this.inFlight?.hash
        )
            this.settle(this.requested.hash, false);
        if (!this.inFlight && snapshot.hash === this.expectedHash) {
            this.requested = null;
            this.clearTimer();
            this.onStatus({ kind: "saved" });
            return Promise.resolve(true);
        }
        this.requested = snapshot;
        this.blocked = null;
        const result = new Promise<boolean>((resolve) =>
            this.waiters.add({ hash: snapshot.hash, resolve }),
        );
        this.clearTimer();
        if (!this.inFlight) void this.flush();
        return result;
    }

    private settle(hash: string | null, saved: boolean): void {
        for (const waiter of this.waiters)
            if (hash === null || waiter.hash === hash) {
                this.waiters.delete(waiter);
                waiter.resolve(saved);
            }
    }

    retry(): void {
        if (this.disposed || this.blocked !== "error") return;
        this.blocked = null;
        if (!this.latest || this.latest.hash === this.expectedHash) {
            this.onStatus({ kind: "saved" });
            return;
        }
        this.onStatus({ kind: "pending" });
        this.requested = this.latest;
        this.arm(0);
    }

    /** Stops saving and preserves the local draft until the user explicitly reloads it. */
    markConflict(actualHash: string): void {
        if (this.disposed) return;
        this.clearTimer();
        this.blocked = "conflict";
        this.conflictHash = actualHash;
        this.requested = null;
        this.settle(null, false);
        this.onStatus({ kind: "conflict", actualHash });
    }

    /**
     * Classifies a polled update without guessing which document should win.
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
            this.requested = null;
            this.clearTimer();
            this.settle(actualHash, true);
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
        this.requested = null;
        this.settle(null, false);
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
        if (this.disposed || this.inFlight || this.blocked) {
            return;
        }
        const snapshot =
            this.requested ?? (this.automatic ? this.latest : null);
        if (!snapshot) return;
        this.requested = null;
        if (snapshot.hash === this.expectedHash) {
            this.settle(snapshot.hash, true);
            this.onStatus({
                kind:
                    this.latest?.hash === this.expectedHash
                        ? "saved"
                        : this.automatic
                          ? "pending"
                          : "unsaved",
            });
            if (
                this.automatic &&
                this.latest &&
                this.latest.hash !== this.expectedHash
            )
                this.arm(this.debounceMillis);
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
            this.settle(snapshot.hash, true);
            if (!this.latest || this.latest.hash === this.expectedHash) {
                this.onStatus({ kind: "saved" });
            } else {
                this.onStatus({
                    kind:
                        this.automatic || this.requested
                            ? "pending"
                            : "unsaved",
                });
                if (this.requested || this.automatic)
                    this.arm(this.requested ? 0 : this.debounceMillis);
            }
            if (this.requested) this.arm(0);
        } catch (error) {
            if (this.disposed) return;
            this.inFlight = null;
            if (error instanceof PluginHttpError && error.status === 409) {
                const actualHash = conflictActualHash(error.body);
                // Another editor may already have persisted byte-for-byte the same latest draft.
                // In that case there is nothing left to resolve or overwrite.
                if (actualHash && actualHash === this.latest?.hash) {
                    this.expectedHash = actualHash;
                    this.blocked = null;
                    this.conflictHash = null;
                    this.requested = null;
                    this.settle(actualHash, true);
                    this.settle(null, false);
                    this.onStatus({ kind: "saved" });
                    return;
                }
                this.markConflict(actualHash ?? "unknown");
                return;
            }
            this.blocked = "error";
            this.requested = null;
            this.settle(null, false);
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
