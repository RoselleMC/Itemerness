import { itemKey, itemLayout, itemTheme } from "@itemerness/protocol";
import {
    useEffect,
    useMemo,
    useRef,
    useState,
    useSyncExternalStore,
} from "react";
import {
    contentHash,
    type PreviewArtifact,
    type PreviewViewer,
    type ProjectDocument,
} from "@itemerness/protocol";
import { useConnectionStore } from "../../state/connection.js";
import {
    PreviewCache,
    previewKey,
    type PreviewItemState,
} from "../../api/previewCache.js";

export type ServerPreviewState =
    | { status: "idle" }
    | { status: "pending" }
    | { status: "verified"; artifact: PreviewArtifact }
    | { status: "mock"; artifact: PreviewArtifact }
    | { status: "unavailable"; reason: string };

const DEBOUNCE_MS = 250;
const PREWARM_ITEMS = 16;
const noSubscription = () => () => {};
const zeroVersion = () => 0;

export function useServerPreview(
    document: ProjectDocument,
    itemId: string | null,
    viewer: PreviewViewer,
    enabled = true,
): {
    current: ServerPreviewState;
    items: Readonly<Record<string, PreviewItemState>>;
} {
    const client = useConnectionStore((state) => state.client);
    const info = useConnectionStore((state) => state.info);
    const snapshotHash = useMemo(() => contentHash(document), [document]);
    const viewerKey = useMemo(() => contentHash(viewer), [viewer]);
    const item = document.items.find(
        (entry) => itemKey(document, entry) === itemId,
    );
    const selectionKey = JSON.stringify([
        item && itemTheme(document, item),
        item && itemLayout(document, item),
    ]);
    const peerKey = JSON.stringify([
        info?.serverId,
        info?.compilerDigest,
        info?.pluginVersion,
        info?.minecraftVersion,
    ]);
    const supported = !!info?.capabilities.includes("preview.compile");
    const cache = useMemo(
        () =>
            client
                ? new PreviewCache(async (request, signal) => {
                      const result = await client.preview(request, signal);
                      const compiler = result.artifact.digests.compiler;
                      return compiler !== null &&
                          compiler !== info?.compilerDigest
                          ? { ...result, stale: true }
                          : result;
                  })
                : null,
        [client, peerKey],
    );
    const key = JSON.stringify([snapshotHash, itemId, viewerKey]);
    const revision = useSyncExternalStore(
        cache?.subscribe ?? noSubscription,
        cache?.version ?? zeroVersion,
    );
    const items = useMemo(
        () =>
            Object.fromEntries(
                document.items.map((item) => {
                    const id = itemKey(document, item);
                    return [
                        id,
                        !enabled || !cache || !supported
                            ? "unavailable"
                            : cache.status(
                                  JSON.stringify([snapshotHash, id, viewerKey]),
                              ),
                    ];
                }),
            ) as Readonly<Record<string, PreviewItemState>>,
        [
            cache,
            revision,
            document,
            snapshotHash,
            viewerKey,
            supported,
            enabled,
        ],
    );
    const serverId = info?.serverId ?? null;
    const [state, setState] = useState<{
        cache: PreviewCache | null;
        key: string;
        value: ServerPreviewState;
    }>({ cache: null, key: "", value: { status: "idle" } });
    const previous = useRef<{
        cache: PreviewCache;
        itemId: string;
        snapshotHash: string;
        viewerKey: string;
        selectionKey: string;
    } | null>(null);

    useEffect(() => () => cache?.clear(), [cache]);

    useEffect(() => {
        if (!enabled || !itemId || !cache || !supported) return;
        const last = previous.current;
        const editing =
            last?.cache === cache &&
            last.itemId === itemId &&
            last.viewerKey === viewerKey &&
            last.selectionKey === selectionKey &&
            last.snapshotHash !== snapshotHash;
        previous.current = {
            cache,
            itemId,
            snapshotHash,
            viewerKey,
            selectionKey,
        };
        let current = true;
        const publish = (value: ServerPreviewState) => {
            if (current) setState({ cache, key, value });
        };
        const load = () => {
            publish({ status: "pending" });
            void cache
                .load(
                    {
                        document,
                        itemId,
                        viewer,
                        snapshotHash,
                        targetServerId: serverId,
                    },
                    true,
                )
                .then((body) => {
                    if (
                        body.stale ||
                        body.artifact.digests.snapshot !== snapshotHash
                    ) {
                        publish({ status: "unavailable", reason: "stale" });
                    } else
                        publish(
                            body.artifact.origin === "agent"
                                ? {
                                      status: "verified",
                                      artifact: body.artifact,
                                  }
                                : { status: "mock", artifact: body.artifact },
                        );
                })
                .catch((error: Error) => {
                    if (error.name !== "AbortError")
                        publish({
                            status: "unavailable",
                            reason: error.message,
                        });
                });
        };
        // Debounce typing, never navigation. A selected item also promotes any queued warm-up.
        const timer = editing ? setTimeout(load, DEBOUNCE_MS) : null;
        if (!editing) load();
        return () => {
            current = false;
            if (timer !== null) clearTimeout(timer);
        };
    }, [
        cache,
        info,
        key,
        itemId,
        snapshotHash,
        viewerKey,
        selectionKey,
        supported,
        enabled,
        serverId,
        document,
    ]);

    useEffect(() => {
        if (!enabled || !cache || !supported) return;
        const timer = setTimeout(() => {
            for (const item of document.items.slice(0, PREWARM_ITEMS)) {
                const request = {
                    document,
                    itemId: itemKey(document, item),
                    viewer,
                    snapshotHash,
                    targetServerId: serverId,
                };
                if (!cache.peek(previewKey(request)))
                    void cache.load(request).catch(() => {});
            }
        }, DEBOUNCE_MS);
        return () => {
            clearTimeout(timer);
            cache.cancelPending();
        };
    }, [
        cache,
        snapshotHash,
        viewerKey,
        supported,
        enabled,
        serverId,
        document,
    ]);

    if (!enabled || !itemId || !cache || !supported)
        return { current: { status: "idle" }, items };
    // Never show the prior item's artifact for one render while an effect catches up.
    const cached = cache.peek(key);
    if (cached)
        return { current: { status: "verified", artifact: cached }, items };
    return {
        current:
            state.cache === cache && state.key === key
                ? state.value
                : { status: "pending" },
        items,
    };
}
