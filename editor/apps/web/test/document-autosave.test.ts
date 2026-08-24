import { afterEach, describe, expect, it, vi } from "vitest";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import { contentHash, type ProjectDocument } from "@itemerness/protocol";
import { ControlPlaneHttpError } from "../src/api/client.js";
import {
    SerialDocumentAutosave,
    type DocumentSyncStatus,
} from "../src/api/documentAutosave.js";

function edited(namespace: string): ProjectDocument {
    return { ...baselineDocument, namespace };
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

function saved(document: ProjectDocument, revision: number) {
    return {
        snapshotHash: contentHash(document),
        revision,
        diagnostics: [],
    };
}

afterEach(() => {
    vi.useRealTimers();
});

describe("SerialDocumentAutosave", () => {
    it("debounces edits and never overlaps saves or reuses an old expected hash", async () => {
        vi.useFakeTimers();
        const first = deferred<ReturnType<typeof saved>>();
        const second = deferred<ReturnType<typeof saved>>();
        const documentA = edited("draft_a");
        const documentB = edited("draft_b");
        let active = 0;
        let maximumActive = 0;
        const calls: { document: ProjectDocument; expectedHash: string }[] = [];
        const save = vi.fn(
            async (document: ProjectDocument, expectedHash: string) => {
                calls.push({ document, expectedHash });
                active += 1;
                maximumActive = Math.max(maximumActive, active);
                const result =
                    calls.length === 1
                        ? await first.promise
                        : await second.promise;
                active -= 1;
                return result;
            },
        );
        const statuses: DocumentSyncStatus[] = [];
        const autosave = new SerialDocumentAutosave({
            initialHash: contentHash(baselineDocument),
            debounceMillis: 50,
            save,
            onStatus: (status) => statuses.push(status),
            onSaved: () => undefined,
        });

        autosave.queue(documentA);
        await vi.advanceTimersByTimeAsync(50);
        expect(save).toHaveBeenCalledTimes(1);
        expect(calls[0]?.expectedHash).toBe(contentHash(baselineDocument));

        autosave.queue(documentB);
        await vi.advanceTimersByTimeAsync(500);
        expect(save).toHaveBeenCalledTimes(1);

        first.resolve(saved(documentA, 2));
        await vi.advanceTimersByTimeAsync(50);
        expect(save).toHaveBeenCalledTimes(2);
        expect(calls[1]?.document).toBe(documentB);
        expect(calls[1]?.expectedHash).toBe(contentHash(documentA));

        second.resolve(saved(documentB, 3));
        await vi.runAllTimersAsync();
        expect(maximumActive).toBe(1);
        expect(statuses.at(-1)).toEqual({ kind: "saved" });
        autosave.dispose();
    });

    it("stops on a 409 and keeps the conflict visible across further edits", async () => {
        vi.useFakeTimers();
        const statuses: DocumentSyncStatus[] = [];
        const save = vi.fn(async () => {
            throw new ControlPlaneHttpError(
                409,
                { actualHash: "sha256:remote" },
                "conflict",
            );
        });
        const autosave = new SerialDocumentAutosave({
            initialHash: contentHash(baselineDocument),
            debounceMillis: 10,
            save,
            onStatus: (status) => statuses.push(status),
            onSaved: () => undefined,
        });

        autosave.queue(edited("draft_a"));
        await vi.advanceTimersByTimeAsync(10);
        await Promise.resolve();
        expect(statuses.at(-1)).toEqual({
            kind: "conflict",
            actualHash: "sha256:remote",
        });

        autosave.queue(edited("draft_b"));
        await vi.advanceTimersByTimeAsync(1_000);
        expect(save).toHaveBeenCalledTimes(1);
        expect(statuses.at(-1)?.kind).toBe("conflict");
        autosave.dispose();
    });

    it("distinguishes a clean remote update from a dirty conflict", () => {
        const statuses: DocumentSyncStatus[] = [];
        const autosave = new SerialDocumentAutosave({
            initialHash: contentHash(baselineDocument),
            save: vi.fn(),
            onStatus: (status) => statuses.push(status),
            onSaved: () => undefined,
        });
        const remoteHash = contentHash(edited("remote"));

        expect(autosave.observeRemoteUpdate(remoteHash, baselineDocument)).toBe(
            "reload",
        );

        const local = edited("local");
        autosave.queue(local);
        expect(autosave.observeRemoteUpdate(remoteHash, local)).toBe(
            "conflict",
        );
        expect(statuses.at(-1)).toEqual({
            kind: "conflict",
            actualHash: remoteHash,
        });
        autosave.dispose();
    });
});
