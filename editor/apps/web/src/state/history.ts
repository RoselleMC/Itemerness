import type { ProjectDocument } from "@itemerness/protocol";
import type { AssetSection } from "./assetLibrary.js";

export interface DocumentSnapshot {
    document: ProjectDocument;
    snapshotHash: string;
    mode: "items" | "themes" | "layouts" | "data" | "formats" | "facts";
    selectedItemId: string | null;
    selectedThemeId: string | null;
    selectedLayoutId: string | null;
    selectedDataKeyUuid: string | null;
    selectedDataSchemaUuid: string | null;
    selectedFormatUuid: string | null;
    selectedViewerFactUuid: string | null;
    selectedAssetKind: AssetSection;
    selectedAssetUuid: string | null;
    selectedBlockUuid: string | null;
    viewerLocale: string;
}
interface Entry {
    snapshot: DocumentSnapshot;
    bytes: number;
}

/** Immutable snapshots share unchanged subtrees. Limits also bound worst-case retained documents. */
export class DocumentHistory {
    private past: Entry[] = [];
    private future: Entry[] = [];
    private group: string | null = null;
    private lastGroup: string | null = null;
    private lastEdit = 0;
    private sequence = 0;
    transaction: { id: number; before: DocumentSnapshot } | null = null;

    constructor(
        private readonly limit = 100,
        private readonly byteLimit = 32 * 1024 * 1024,
    ) {}
    flags(current: DocumentSnapshot) {
        return {
            canUndo:
                this.past.length > 0 ||
                !!(
                    this.transaction &&
                    this.transaction.before.snapshotHash !==
                        current.snapshotHash
                ),
            canRedo: !this.transaction && this.future.length > 0,
            historyTransactionId: this.transaction?.id ?? null,
        };
    }
    private push(stack: Entry[], snapshot: DocumentSnapshot) {
        stack.push({
            snapshot,
            bytes: JSON.stringify(snapshot.document).length * 2,
        });
        let bytes = stack.reduce((sum, entry) => sum + entry.bytes, 0);
        while (
            stack.length > 1 &&
            (stack.length > this.limit || bytes > this.byteLimit)
        )
            bytes -= stack.shift()!.bytes;
    }
    setGroup(group: string | null) {
        if (group !== this.group) this.lastGroup = null;
        this.group = group;
    }
    record(before: DocumentSnapshot, now = Date.now()) {
        if (this.transaction) return;
        if (
            !this.group ||
            this.group !== this.lastGroup ||
            now - this.lastEdit > 800
        )
            this.push(this.past, before);
        this.future = [];
        this.lastGroup = this.group;
        this.lastEdit = now;
    }
    begin(before: DocumentSnapshot) {
        this.commit(before);
        this.setGroup(null);
        const id = ++this.sequence;
        this.transaction = { id, before };
        return id;
    }
    commit(current: DocumentSnapshot, id = this.transaction?.id) {
        if (!this.transaction || this.transaction.id !== id) return false;
        const before = this.transaction.before;
        this.transaction = null;
        if (before.snapshotHash !== current.snapshotHash) {
            this.push(this.past, before);
            this.future = [];
        }
        return true;
    }
    cancel(id: number) {
        if (this.transaction?.id !== id) return null;
        const before = this.transaction.before;
        this.transaction = null;
        return before;
    }
    undo(current: DocumentSnapshot) {
        this.commit(current);
        this.lastGroup = null;
        const previous = this.past.pop();
        if (!previous) return null;
        this.push(this.future, current);
        return previous.snapshot;
    }
    redo(current: DocumentSnapshot) {
        if (this.transaction) return null;
        this.lastGroup = null;
        const next = this.future.pop();
        if (!next) return null;
        this.push(this.past, current);
        return next.snapshot;
    }
    clear() {
        this.past = [];
        this.future = [];
        this.transaction = null;
        this.group = null;
        this.lastGroup = null;
    }
}

export function documentSnapshot(state: DocumentSnapshot): DocumentSnapshot {
    const {
        document,
        snapshotHash,
        mode,
        selectedItemId,
        selectedThemeId,
        selectedLayoutId,
        selectedDataKeyUuid,
        selectedDataSchemaUuid,
        selectedFormatUuid,
        selectedViewerFactUuid,
        selectedAssetKind,
        selectedAssetUuid,
        selectedBlockUuid,
        viewerLocale,
    } = state;
    return {
        document,
        snapshotHash,
        mode,
        selectedItemId,
        selectedThemeId,
        selectedLayoutId,
        selectedDataKeyUuid,
        selectedDataSchemaUuid,
        selectedFormatUuid,
        selectedViewerFactUuid,
        selectedAssetKind,
        selectedAssetUuid,
        selectedBlockUuid,
        viewerLocale,
    };
}
