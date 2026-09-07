import {
    contentHash,
    type PreviewArtifact,
    type PreviewRequest,
} from "@itemerness/protocol";
import type { PluginClient } from "./client.js";

type Result = Awaited<ReturnType<PluginClient["preview"]>>;
export type PreviewItemState =
    "unverified" | "pending" | "verified" | "error" | "unavailable";
interface Task {
    key: string;
    request: PreviewRequest;
    controller: AbortController;
    promise: Promise<Result>;
    resolve: (result: Result) => void;
    reject: (error: unknown) => void;
    priority: boolean;
}

export function previewKey(
    request: Pick<PreviewRequest, "itemId" | "snapshotHash" | "viewer">,
): string {
    return JSON.stringify([
        request.snapshotHash,
        request.itemId,
        contentHash(request.viewer),
    ]);
}

/** Owned by one connection/compiler identity; no persistence or cross-server reuse. */
export class PreviewCache {
    private readonly entries = new Map<string, PreviewArtifact>();
    private readonly pending = new Map<string, Task>();
    private readonly queue: Task[] = [];
    private readonly active = new Set<Task>();
    private readonly failed = new Set<string>();
    private readonly listeners = new Set<() => void>();
    private revision = 0;
    readonly subscribe = (listener: () => void) => {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    };
    readonly version = () => this.revision;
    private changed(): void {
        this.revision++;
        for (const listener of this.listeners) listener();
    }
    status(key: string): PreviewItemState {
        if (this.entries.has(key)) return "verified";
        if (this.pending.has(key)) return "pending";
        return this.failed.has(key) ? "error" : "unverified";
    }

    constructor(
        private readonly compile: PluginClient["preview"],
        private readonly capacity = 32,
    ) {}

    peek(key: string): PreviewArtifact | undefined {
        return this.entries.get(key);
    }

    load(request: PreviewRequest, priority = false): Promise<Result> {
        const key = previewKey(request);
        const cached = this.entries.get(key);
        if (cached) {
            this.entries.delete(key);
            this.entries.set(key, cached);
            return Promise.resolve({ artifact: cached, stale: false });
        }
        const existing = this.pending.get(key);
        if (existing) {
            existing.priority ||= priority;
            this.pump();
            return existing.promise;
        }
        let resolve!: Task["resolve"];
        let reject!: Task["reject"];
        const promise = new Promise<Result>((done, fail) => {
            resolve = done;
            reject = fail;
        });
        const task: Task = {
            key,
            request,
            priority,
            promise,
            resolve,
            reject,
            controller: new AbortController(),
        };
        this.pending.set(key, task);
        this.failed.delete(key);
        this.queue.push(task);
        this.changed();
        this.pump();
        return promise;
    }

    cancelPending(): void {
        for (const task of this.pending.values()) task.controller.abort();
        for (const task of this.queue.splice(0))
            task.reject(new DOMException("Preview superseded", "AbortError"));
        this.pending.clear();
        this.changed();
    }

    clear(): void {
        this.cancelPending();
        this.entries.clear();
        this.failed.clear();
        this.changed();
    }

    private pump(): void {
        while (this.active.size < 2 && this.queue.length) {
            const selected = this.queue.findIndex((task) => task.priority);
            // Leave one transport slot free for a cold foreground action.
            if (selected < 0 && [...this.active].some((task) => !task.priority))
                break;
            const task = this.queue.splice(Math.max(0, selected), 1)[0]!;
            this.active.add(task);
            void this.run(task);
        }
    }

    private async run(task: Task): Promise<void> {
        try {
            const result = await this.compile(
                task.request,
                task.controller.signal,
            );
            if (task.controller.signal.aborted)
                throw new DOMException("Preview superseded", "AbortError");
            const artifact = result.artifact;
            if (
                !result.stale &&
                artifact.origin === "agent" &&
                artifact.failure === null &&
                artifact.display !== null &&
                artifact.digests.snapshot === task.request.snapshotHash &&
                artifact.itemId === task.request.itemId &&
                contentHash(artifact.viewer) ===
                    contentHash(task.request.viewer)
            ) {
                this.entries.set(task.key, artifact);
                while (this.entries.size > this.capacity)
                    this.entries.delete(this.entries.keys().next().value!);
            }
            if (!this.entries.has(task.key)) this.failed.add(task.key);
            task.resolve(result);
        } catch (error) {
            if (!task.controller.signal.aborted) this.failed.add(task.key);
            task.reject(error);
        } finally {
            if (this.pending.get(task.key) === task)
                this.pending.delete(task.key);
            this.active.delete(task);
            while (this.failed.size > this.capacity)
                this.failed.delete(this.failed.values().next().value!);
            this.changed();
            this.pump();
        }
    }
}
