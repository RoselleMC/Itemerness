import { useEffect, useRef, useState } from "react";
import type {
    PreviewArtifact,
    PreviewViewer,
    ProjectDocument,
} from "@itemerness/protocol";
import { contentHash } from "@itemerness/protocol";
import { controlPlane } from "../../api/client.js";

/**
 * Asks a target server to compile the current draft.
 *
 * Two rules make this safe to show next to the optimistic preview:
 *
 * 1. Every request carries the snapshot hash it was derived from, and a response whose hash no
 *    longer matches the draft is discarded. Without that fence a slow compile would repaint the
 *    preview with an older draft the moment it arrived, which looks exactly like a rendering bug.
 * 2. Only a result the control plane marks `agent` is treated as server verified. A `mock` result
 *    is the control plane replaying the browser's own composer, and calling that verified would
 *    make the badge a decoration.
 */

export type ServerPreviewState =
    | { status: "idle" }
    | { status: "pending" }
    | { status: "verified"; artifact: PreviewArtifact }
    | { status: "mock"; artifact: PreviewArtifact }
    | { status: "unavailable"; reason: string };

const DEBOUNCE_MS = 250;

export function useServerPreview(
    document: ProjectDocument,
    itemId: string | null,
    viewer: PreviewViewer,
): ServerPreviewState {
    const [state, setState] = useState<ServerPreviewState>({ status: "idle" });
    const latest = useRef(0);

    const snapshotHash = contentHash(document);
    const viewerKey = JSON.stringify(viewer);

    useEffect(() => {
        if (!itemId) {
            setState({ status: "idle" });
            return;
        }
        const request = ++latest.current;
        const controller = new AbortController();
        setState({ status: "pending" });

        const timer = setTimeout(async () => {
            try {
                const body = await controlPlane.preview(
                    {
                        document,
                        itemId,
                        viewer,
                        snapshotHash,
                        targetServerId: null,
                    },
                    controller.signal,
                );
                if (controller.signal.aborted) return;
                // A superseded request must not repaint the preview, even if it finishes last.
                if (request !== latest.current) return;
                if (
                    body.stale ||
                    body.artifact.digests.snapshot !== snapshotHash
                ) {
                    setState({ status: "unavailable", reason: "stale" });
                    return;
                }
                setState(
                    body.artifact.origin === "agent"
                        ? { status: "verified", artifact: body.artifact }
                        : { status: "mock", artifact: body.artifact },
                );
            } catch (error) {
                if (request !== latest.current) return;
                if ((error as Error).name === "AbortError") return;
                setState({
                    status: "unavailable",
                    reason: (error as Error).message,
                });
            }
        }, DEBOUNCE_MS);

        return () => {
            clearTimeout(timer);
            controller.abort();
        };
    }, [document, itemId, snapshotHash, viewerKey]);

    return state;
}
