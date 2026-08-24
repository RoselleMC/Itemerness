import { readFontMetricsArtifact } from "@itemerness/mc-assets";
import { PresentationFonts, composeLocalPreview } from "@itemerness/mc-render";
import {
    contentHash,
    previewArtifactSchema,
    type Diagnostic,
    type PreviewArtifact,
    type PreviewRequest,
} from "@itemerness/protocol";

export interface AgentPreviewPayload {
    readonly document: PreviewRequest["document"];
    readonly itemId: PreviewRequest["itemId"];
    readonly viewer: PreviewRequest["viewer"];
    readonly snapshotHash: PreviewRequest["snapshotHash"];
}

export interface PreviewCompileOptions {
    readonly fontMetricsArtifact?: Uint8Array | null;
    readonly compileWithAgent?: (
        payload: AgentPreviewPayload,
    ) => Promise<unknown>;
}

export interface PreviewCompileResult {
    readonly artifact: PreviewArtifact;
    readonly stale: boolean;
    /** Retained for structured logging by the HTTP layer; never sent to the browser. */
    readonly agentError: unknown | null;
}

/**
 * Compiles exactly the document embedded in a preview request.
 *
 * Autosave is a durability concern, not a preview barrier. Using the control plane's persisted
 * draft here would make every keystroke stale until a save completed and would show the wrong
 * document whenever a save was stopped by an optimistic-concurrency conflict.
 */
export async function compilePreviewRequest(
    request: PreviewRequest,
    options: PreviewCompileOptions = {},
): Promise<PreviewCompileResult> {
    const started = performance.now();
    let agentError: unknown | null = null;

    if (options.compileWithAgent) {
        try {
            const parsed = previewArtifactSchema.parse(
                await options.compileWithAgent({
                    document: request.document,
                    itemId: request.itemId,
                    viewer: request.viewer,
                    snapshotHash: request.snapshotHash,
                }),
            );
            if (parsed.origin !== "agent") {
                throw new Error(
                    `target returned preview origin ${parsed.origin}, expected agent`,
                );
            }
            if (parsed.itemId !== request.itemId) {
                throw new Error("target returned a preview for another item");
            }
            return {
                artifact: parsed,
                stale: parsed.digests.snapshot !== request.snapshotHash,
                agentError: null,
            };
        } catch (error) {
            agentError = error;
        }
    }

    const fonts = new PresentationFonts({
        artifact: options.fontMetricsArtifact
            ? readFontMetricsArtifact(options.fontMetricsArtifact)
            : null,
        fonts: request.document.fonts,
        glyphs: request.document.glyphs,
        spacing: request.document.spacing,
    });
    const composed = composeLocalPreview({
        document: request.document,
        itemId: request.itemId,
        viewer: request.viewer,
        fonts,
    });

    const artifact: PreviewArtifact = {
        schemaVersion: 1,
        // A stand-in compiler is still a stand-in. Only a real agent may claim `agent`.
        origin: "mock",
        itemId: request.itemId,
        viewer: request.viewer,
        display: composed.display,
        fidelity: [],
        diagnostics: composed.diagnostics as Diagnostic[],
        digests: {
            snapshot: request.snapshotHash,
            compiler: null,
            documentSchema: contentHash({
                schemaVersion: request.document.schemaVersion,
            }),
            capability: null,
            asset: null,
        },
        compileMillis: performance.now() - started,
        failure: null,
    };
    return { artifact, stale: false, agentError };
}
