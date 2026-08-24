import { useMemo } from "react";
import { resolveItemIcon } from "@itemerness/mc-assets";
import {
    buildFidelityClaims,
    composeLocalPreview,
    previewFontEvidence,
    type LocalPreview,
} from "@itemerness/mc-render";
import type {
    FidelityClaim,
    PreviewDisplay,
    PreviewOrigin,
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

/**
 * One preview pipeline shared by the stage and the inspector.
 *
 * The rules have not moved with the redesign: the local composer gives instant feedback while
 * typing, a connected target's artifact replaces it wholesale (never merged, never re-wrapped),
 * and the origin badge tells the truth about which one is on screen.
 */
export interface PreviewBundle {
    readonly fonts: ReturnType<typeof presentationFontsOf>;
    readonly viewer: ReturnType<typeof viewerOf>;
    readonly local: LocalPreview | null;
    readonly server: ServerPreviewState;
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

export function usePreview(spritesAvailable: boolean): PreviewBundle {
    const state = useEditorStore();

    const fonts = useMemo(
        () => presentationFontsOf(state),
        [
            state.document.fonts,
            state.document.glyphs,
            state.document.spacing,
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
        if (state.mode !== "layouts" || !state.selectedLayoutId)
            return state.selectedItemId;
        const using = state.document.items.find(
            (item) => item.presentation.layout === state.selectedLayoutId,
        );
        return using
            ? `${state.document.namespace}:${using.id}`
            : state.selectedItemId;
    }, [
        state.mode,
        state.selectedLayoutId,
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

    const server = useServerPreview(state.document, targetItemId, viewer);
    const serverDisplay =
        server.status === "verified" || server.status === "mock"
            ? server.artifact.display
            : null;
    const display = serverDisplay ?? local?.display ?? null;
    const origin: PreviewOrigin =
        server.status === "verified"
            ? "agent"
            : server.status === "mock"
              ? "mock"
              : "local";

    const itemIconKind = useMemo(() => {
        if (!targetItemId || state.packs.length === 0) return "absent" as const;
        const item = state.document.items.find(
            (entry) =>
                `${state.document.namespace}:${entry.id}` === targetItemId,
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
        return previewFontEvidence(lines, fonts, fontLibraryOf(state.packs));
    }, [display, fonts, state.packs]);

    const claims = useMemo(
        () =>
            buildFidelityClaims({
                origin,
                snapshotMatches: server.status === "verified",
                mountedMetricsUsed: fontEvidence.mountedMetricsUsed,
                mountedRasterUsed: fontEvidence.mountedRasterUsed,
                metricsArtifactLoaded: state.artifact !== null,
                metricsComplete: fontEvidence.metricsComplete,
                rasterComplete: fontEvidence.rasterComplete,
                tooltipSpritesAvailable: spritesAvailable,
                tooltipStyleRequested: display?.tooltipStyle != null,
                itemIcon: itemIconKind,
                preservesVanillaLines: !viewer.managesVanillaTooltipLines,
            }),
        [
            origin,
            server.status,
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
        display,
        origin,
        claims,
        comparison,
        itemIconKind,
        diagnosticsCount: (local?.diagnostics.length ?? 0) + serverDiagnostics,
        targetItemId,
    };
}
