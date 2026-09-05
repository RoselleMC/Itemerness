import { useMemo } from "react";
import { resolveItemIcon } from "@itemerness/mc-assets";
import {
    buildFidelityClaims,
    composeLocalPreview,
    previewFontEvidence,
    type LocalPreview,
} from "@itemerness/mc-render";
import {
    itemTemplateRegistryOf,
    type FidelityClaim,
    type PreviewDisplay,
    type PreviewOrigin,
    type ProjectDocument,
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
import {
    catalogItemFromTemplate,
    projectRunoRpgTemplate,
    templateLocalId,
} from "../runorpg/templateProjection.js";

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
    /** Document that owns targetItemId; RunoRPG templates are projected into a one-item document. */
    readonly document: ProjectDocument;
    /** The item the stage is actually previewing (mode-dependent). */
    readonly targetItemId: string | null;
}

export function usePreview(spritesAvailable: boolean): PreviewBundle {
    const state = useEditorStore();

    // A template previews through the same projection as a live item, so a prefab and the items
    // made from it cannot disagree about how the tooltip is built.
    const selectedTemplate = useMemo(() => {
        if (state.mode !== "templates" || !state.selectedTemplateId)
            return null;
        return (
            itemTemplateRegistryOf(state.document).templates.find(
                (template) => template.id === state.selectedTemplateId,
            ) ?? null
        );
    }, [state.mode, state.selectedTemplateId, state.document]);

    const selectedRunoRpgItem = useMemo(
        () =>
            selectedTemplate
                ? catalogItemFromTemplate(selectedTemplate)
                : (state.runoRpgCatalog?.items.find(
                      (item) => item.id === state.selectedItemId,
                  ) ?? null),
        [selectedTemplate, state.runoRpgCatalog, state.selectedItemId],
    );
    const projected = useMemo(
        () =>
            selectedRunoRpgItem
                ? projectRunoRpgTemplate(
                      state.document,
                      selectedRunoRpgItem,
                      state.runoRpgCatalog?.attributes ?? [],
                  )
                : state.document,
        [state.document, state.runoRpgCatalog, selectedRunoRpgItem],
    );

    // The posed persona is laid over the previewed document last, so it applies to a projected
    // RunoRPG fact and an authored Itemerness one through the same path.
    const activeDocument = useMemo(() => {
        const poses = Object.keys(state.factPreviews);
        if (poses.length === 0) return projected;
        return {
            ...projected,
            viewerFacts: projected.viewerFacts.map((fact) =>
                fact.id in state.factPreviews
                    ? { ...fact, previewValue: state.factPreviews[fact.id]! }
                    : fact,
            ),
        };
    }, [projected, state.factPreviews]);

    const fonts = useMemo(
        () => presentationFontsOf({ ...state, document: activeDocument }),
        [
            activeDocument.fonts,
            activeDocument.glyphs,
            activeDocument.spacing,
            state.packs,
            state.artifact,
        ],
    );
    const viewer = useMemo(
        () => viewerOf({ ...state, document: activeDocument }),
        [
            activeDocument,
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
        // The projection re-namespaces every item it emits, so the stage must ask for the id the
        // projected document actually holds rather than the template's own key.
        if (selectedTemplate)
            return `${activeDocument.namespace}:${templateLocalId(selectedTemplate)}`;
        if (state.mode !== "layouts" || !state.selectedLayoutId)
            return state.selectedItemId;
        const using = activeDocument.items.find(
            (item) => item.presentation.layout === state.selectedLayoutId,
        );
        return using
            ? `${activeDocument.namespace}:${using.id}`
            : state.selectedItemId;
    }, [
        selectedTemplate,
        state.mode,
        state.selectedLayoutId,
        state.selectedItemId,
        activeDocument,
    ]);

    const local = useMemo(() => {
        if (!targetItemId) return null;
        return composeLocalPreview({
            document: activeDocument,
            itemId: targetItemId,
            viewer,
            fonts,
        });
    }, [activeDocument, targetItemId, viewer, fonts]);

    const comparison = useMemo(() => {
        if (!state.compareLocales || !targetItemId) return null;
        const other = activeDocument.locales.find(
            (locale) => locale.locale !== state.viewerLocale,
        );
        if (!other) return null;
        const preview = composeLocalPreview({
            document: activeDocument,
            itemId: targetItemId,
            viewer: { ...viewer, locale: other.locale },
            fonts,
        });
        return { locale: other.locale, display: preview.display };
    }, [
        state.compareLocales,
        activeDocument,
        targetItemId,
        state.viewerLocale,
        viewer,
        fonts,
    ]);

    const server = useServerPreview(activeDocument, targetItemId, viewer);
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
        const item = activeDocument.items.find(
            (entry) =>
                `${activeDocument.namespace}:${entry.id}` === targetItemId,
        );
        if (!item) return "absent" as const;
        return resolveItemIcon(
            packStackOf(state.packs),
            item.definition.material,
        ).kind === "flat"
            ? ("flat" as const)
            : ("unsupported" as const);
    }, [activeDocument, targetItemId, state.packs]);

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
        document: activeDocument,
        targetItemId,
    };
}
