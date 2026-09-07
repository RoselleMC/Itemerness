import { afterEach, describe, expect, it, vi } from "vitest";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import { contentHash, type ProjectDocument } from "@itemerness/protocol";
import { PluginHttpError } from "../src/api/client.js";
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
    it("continues automatic saving after duplicate explicit requests match a completed PUT", async () => {
        vi.useFakeTimers();
        const first = deferred<ReturnType<typeof saved>>();
        const save = vi.fn(async (document: ProjectDocument) =>
            save.mock.calls.length === 1 ? first.promise : saved(document, 3),
        );
        const queue = new SerialDocumentAutosave({
            initialHash: contentHash(baselineDocument),
            save,
            onStatus: () => {},
            onSaved: () => {},
        });
        const a = queue.saveNow(edited("a"));
        const duplicate = queue.saveNow(edited("a"));
        queue.queue(edited("b"));
        first.resolve(saved(edited("a"), 2));
        await vi.runAllTimersAsync();
        expect(await a).toBe(true);
        expect(await duplicate).toBe(true);
        expect(save.mock.calls.map(([document]) => document.namespace)).toEqual(
            ["a", "b"],
        );
        expect(queue.isDirty(contentHash(edited("b")))).toBe(false);
        queue.dispose();
    });
    it("keeps manual edits unsaved until an explicit request, then captures that snapshot only", async () => {
        vi.useFakeTimers();
        const first = deferred<ReturnType<typeof saved>>();
        const statuses: DocumentSyncStatus[] = [];
        const a = edited("a"),
            b = edited("b"),
            c = edited("c");
        const save = vi.fn(async (document: ProjectDocument) =>
            save.mock.calls.length === 1 ? first.promise : saved(document, 3),
        );
        const queue = new SerialDocumentAutosave({
            initialHash: contentHash(baselineDocument),
            automatic: false,
            save,
            onStatus: (value) => statuses.push(value),
            onSaved: () => {},
        });
        queue.queue(a);
        await vi.advanceTimersByTimeAsync(1000);
        expect(save).not.toHaveBeenCalled();
        expect(statuses.at(-1)?.kind).toBe("unsaved");
        const saveA = queue.saveNow(a);
        const saveB = queue.saveNow(b);
        queue.queue(c);
        first.resolve(saved(a, 2));
        await vi.runAllTimersAsync();
        expect(await saveA).toBe(true);
        expect(await saveB).toBe(true);
        expect(save.mock.calls.map(([document]) => document)).toEqual([a, b]);
        expect(statuses.at(-1)?.kind).toBe("unsaved");
        await vi.advanceTimersByTimeAsync(1000);
        expect(save).toHaveBeenCalledTimes(2);
        expect(await queue.saveNow(c)).toBe(true);
        expect(statuses.at(-1)?.kind).toBe("saved");
        queue.dispose();
    });
    it("disabling automatic mode cancels only automatic timers and enabling it resumes dirty work", async () => {
        vi.useFakeTimers();
        const save = vi.fn(async (document: ProjectDocument) =>
            saved(document, 2),
        );
        const queue = new SerialDocumentAutosave({
            initialHash: contentHash(baselineDocument),
            save,
            onStatus: () => {},
            onSaved: () => {},
        });
        queue.queue(edited("a"));
        queue.setAutomatic(false);
        await vi.advanceTimersByTimeAsync(1000);
        expect(save).not.toHaveBeenCalled();
        queue.setAutomatic(true);
        await vi.advanceTimersByTimeAsync(500);
        expect(save).toHaveBeenCalledTimes(1);
        queue.queue(edited("b"));
        const pending = queue.saveNow(edited("b"));
        queue.setAutomatic(false);
        expect(await pending).toBe(true);
        expect(save).toHaveBeenCalledTimes(2);
        queue.dispose();
    });
    it("supersedes queued manual snapshots and resolves pending commands on disposal", async () => {
        vi.useFakeTimers();
        const first = deferred<ReturnType<typeof saved>>();
        const save = vi.fn(async (document: ProjectDocument) =>
            save.mock.calls.length === 1 ? first.promise : saved(document, 3),
        );
        const queue = new SerialDocumentAutosave({
            initialHash: contentHash(baselineDocument),
            automatic: false,
            save,
            onStatus: () => {},
            onSaved: () => {},
        });
        const a = queue.saveNow(edited("a"));
        const b = queue.saveNow(edited("b"));
        const c = queue.saveNow(edited("c"));
        expect(await b).toBe(false);
        first.resolve(saved(edited("a"), 2));
        await vi.runAllTimersAsync();
        expect(await a).toBe(true);
        expect(await c).toBe(true);
        expect(save.mock.calls.map(([document]) => document.namespace)).toEqual(
            ["a", "c"],
        );
        queue.dispose();
        expect(await queue.saveNow(edited("d"))).toBe(false);
    });
    it("manual save cannot force a conflict and does not save later edits after a mode change", async () => {
        const statuses: DocumentSyncStatus[] = [];
        const save = vi.fn(async () => {
            throw new PluginHttpError(
                409,
                { actualHash: "remote" },
                "conflict",
            );
        });
        const queue = new SerialDocumentAutosave({
            initialHash: contentHash(baselineDocument),
            automatic: false,
            save,
            onStatus: (value) => statuses.push(value),
            onSaved: () => {},
        });
        expect(await queue.saveNow(edited("a"))).toBe(false);
        expect(await queue.saveNow(edited("b"))).toBe(false);
        expect(save).toHaveBeenCalledTimes(1);
        expect(statuses.at(-1)?.kind).toBe("conflict");
        queue.dispose();
    });
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
            throw new PluginHttpError(
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
