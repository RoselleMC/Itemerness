import { itemKey, itemLayout } from "@itemerness/protocol";
import { useMemo } from "react";
import { resolveItemIcon } from "@itemerness/mc-assets";
import type { PreviewItemState } from "../../api/previewCache.js";
import {
    buildFidelityClaims,
    composeLocalPreview,
    previewFontEvidence,
    type LocalPreview,
} from "@itemerness/mc-render";
import {
    hasBlockingDiagnostics,
    type FidelityClaim,
    type PreviewDisplay,
    type PreviewOrigin,
} from "@itemerness/protocol";
import {
    fontLibraryOf,
    packStackOf,
    presentationFontsOf,
    useEditorStore,
    viewerOf,
} from "../../state/store.js";
import {
    useServerPreview,
    type ServerPreviewState,
} from "./useServerPreview.js";
import { alignLineOrigins } from "./lineOrigins.js";
import { dataKeyPreviewItem } from "../inspector/dataKeyEditing.js";
import { presentationLibraryItems } from "../../state/presentationLibrary.js";
import { useConnectionStore } from "../../state/connection.js";

/**
 * One preview pipeline shared by the stage and the inspector.
 *
 * The rules have not moved with the redesign: the local composer gives instant feedback while
 * typing, a connected target's artifact replaces it wholesale (never merged, never re-wrapped),
 * and per-item status and fidelity evidence distinguish verification from local drafting.
 */
export interface PreviewBundle {
    readonly fonts: ReturnType<typeof presentationFontsOf>;
    readonly viewer: ReturnType<typeof viewerOf>;
    readonly local: LocalPreview | null;
    readonly server: ServerPreviewState;
    readonly itemStates: Readonly<Record<string, PreviewItemState>>;
    readonly lineOrigins: readonly (string | null)[];
    /** What the stage draws: the agent artifact when fresh, the local composition otherwise. */
    readonly display: PreviewDisplay | null;
    readonly origin: PreviewOrigin;
    readonly claims: readonly FidelityClaim[];
    readonly comparison: { locale: string; display: PreviewDisplay } | null;
    readonly itemIconKind: "flat" | "unsupported" | "absent";
    readonly diagnosticsCount: number;
    /** The item the stage is actually previewing (mode-dependent). */
    readonly targetItemId: string | null;
}

export function usePreview(
    spritesAvailable: boolean,
    enabled = true,
): PreviewBundle {
    const state = useEditorStore();
    const serverClientVersion = useConnectionStore(
        (connection) => connection.info?.minecraftVersion,
    );

    const fonts = useMemo(
        () => presentationFontsOf(state),
        [
            state.document.fonts,
            state.document.glyphs,
            state.document.spacing,
            state.document.measurement?.boldExtraAdvancePixels,
            state.packs,
            state.artifact,
        ],
    );
    const viewer = useMemo(
        () => viewerOf(state),
        [
            state.document,
            state.viewerLocale,
            state.themeOverride,
            state.packs,
            state.packSimulation,
            state.assetProfileOverride,
            state.managesVanillaTooltipLines,
        ],
    );

    // In the layout library the stage previews an item that actually uses the selected layout, so
    // dragging a width slider re-wraps real content instead of an unrelated item.
    const targetItemId = useMemo(() => {
        if (state.mode === "formats" || state.mode === "facts") {
            const node =
                state.mode === "formats"
                    ? state.document.formats.find(
                          (entry) => entry.uuid === state.selectedFormatUuid,
                      )
                    : state.document.viewerFacts.find(
                          (entry) =>
                              entry.uuid === state.selectedViewerFactUuid,
                      );
            const using = node
                ? presentationLibraryItems(state.document, state.mode, node.id)
                : [];
            const preferred =
                using.find(
                    (item) =>
                        itemKey(state.document, item) === state.selectedItemId,
                ) ?? using[0];
            return preferred ? itemKey(state.document, preferred) : null;
        }
        if (state.mode === "data" && state.selectedDataKeyUuid) {
            const using = dataKeyPreviewItem(
                state.document,
                state.selectedDataKeyUuid,
                state.selectedItemId,
            );
            return using
                ? itemKey(state.document, using)
                : state.selectedItemId;
        }
        if (state.mode !== "layouts" || !state.selectedLayoutId)
            return state.selectedItemId;
        const using = state.document.items.find(
            (item) =>
                itemLayout(state.document, item) === state.selectedLayoutId,
        );
        return using ? itemKey(state.document, using) : state.selectedItemId;
    }, [
        state.mode,
        state.selectedLayoutId,
        state.selectedDataKeyUuid,
        state.selectedFormatUuid,
        state.selectedViewerFactUuid,
        state.selectedItemId,
        state.document,
    ]);

    const local = useMemo(() => {
        if (!targetItemId) return null;
        return composeLocalPreview({
            document: state.document,
            itemId: targetItemId,
            viewer,
            fonts,
        });
    }, [state.document, targetItemId, viewer, fonts]);

    const comparison = useMemo(() => {
        if (!state.compareLocales || !targetItemId) return null;
        const other = state.document.locales.find(
            (locale) => locale.locale !== state.viewerLocale,
        );
        if (!other) return null;
        const preview = composeLocalPreview({
            document: state.document,
            itemId: targetItemId,
            viewer: { ...viewer, locale: other.locale },
            fonts,
        });
        return { locale: other.locale, display: preview.display };
    }, [
        state.compareLocales,
        state.document,
        targetItemId,
        state.viewerLocale,
        viewer,
        fonts,
    ]);

    const { current: server, items: itemStates } = useServerPreview(
        state.document,
        targetItemId,
        viewer,
        enabled && state.historyTransactionId === null,
    );
    const validationStates = useMemo(
        () =>
            state.historyTransactionId === null
                ? itemStates
                : Object.fromEntries(
                      state.document.items.map((item) => {
                          const id = itemKey(state.document, item);
                          return [
                              id,
                              id === targetItemId
                                  ? ("pending" as const)
                                  : ("unverified" as const),
                          ];
                      }),
                  ),
        [itemStates, state.historyTransactionId, state.document, targetItemId],
    );
    const serverArtifact =
        server.status === "verified" || server.status === "mock"
            ? server.artifact
            : null;
    const serverDisplay =
        serverArtifact &&
        !serverArtifact.failure &&
        !hasBlockingDiagnostics(serverArtifact.diagnostics)
            ? serverArtifact.display
            : null;
    const display = serverDisplay ?? local?.display ?? null;
    const lineOrigins = useMemo(
        () =>
            local && display
                ? alignLineOrigins(local.display, local.lineOrigins, display)
                : [],
        [local, display],
    );
    const origin: PreviewOrigin =
        server.status === "verified" && serverDisplay !== null
            ? "agent"
            : server.status === "mock"
              ? "mock"
              : "local";

    const itemIconKind = useMemo(() => {
        if (!targetItemId || state.packs.length === 0) return "absent" as const;
        const item = state.document.items.find(
            (entry) => itemKey(state.document, entry) === targetItemId,
        );
        if (!item) return "absent" as const;
        return resolveItemIcon(
            packStackOf(state.packs),
            item.definition.material,
        ).kind === "flat"
            ? ("flat" as const)
            : ("unsupported" as const);
    }, [state.document, targetItemId, state.packs]);

    const fontEvidence = useMemo(() => {
        if (!display) {
            return previewFontEvidence([], fonts);
        }
        const lines =
            display.lore.length > 0
                ? [display.displayName, ...display.lore]
                : [display.displayName];
        return previewFontEvidence(lines, fonts, fontLibraryOf(state.packs), {
            serverClientVersion,
            measurementClientVersion: state.document.measurement?.clientVersion,
        });
    }, [
        display,
        fonts,
        state.packs,
        serverClientVersion,
        state.document.measurement?.clientVersion,
    ]);

    const claims = useMemo(
        () =>
            buildFidelityClaims({
                origin,
                snapshotMatches:
                    server.status === "verified" && serverDisplay !== null,
                mountedMetricsUsed: fontEvidence.mountedMetricsUsed,
                declaredMetricsUsed: fontEvidence.declaredMetricsUsed,
                mountedRasterUsed: fontEvidence.mountedRasterUsed,
                metricsArtifactLoaded: state.artifact !== null,
                metricsComplete: fontEvidence.metricsComplete,
                metricsVersionMismatch: fontEvidence.metricsVersionMismatch,
                metricsRevisionMismatch: fontEvidence.metricsRevisionMismatch,
                rasterComplete: fontEvidence.rasterComplete,
                tooltipSpritesAvailable: spritesAvailable,
                tooltipStyleRequested: display?.tooltipStyle != null,
                itemIcon: itemIconKind,
                preservesVanillaLines: !viewer.managesVanillaTooltipLines,
            }),
        [
            origin,
            server.status,
            serverDisplay,
            state.artifact,
            fontEvidence,
            spritesAvailable,
            display,
            itemIconKind,
            viewer.managesVanillaTooltipLines,
        ],
    );

    const serverDiagnostics =
        server.status === "verified" || server.status === "mock"
            ? server.artifact.diagnostics.length
            : 0;

    return {
        fonts,
        viewer,
        local,
        server,
        itemStates: validationStates,
        lineOrigins,
        display,
        origin,
        claims,
        comparison,
        itemIconKind,
        diagnosticsCount: (local?.diagnostics.length ?? 0) + serverDiagnostics,
        targetItemId,
    };
}
