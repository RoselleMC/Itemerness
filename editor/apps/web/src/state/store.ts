import { create } from "zustand";
import {
    FontLibrary,
    PackStack,
    mountArchive,
    readFontMetricsArtifact,
    type FontMetricsArtifact,
    type MountedPack,
} from "@itemerness/mc-assets";
import { PresentationFonts } from "@itemerness/mc-render";
import {
    contentHash,
    type Diagnostic,
    type PreviewViewer,
    type ProjectDocument,
} from "@itemerness/protocol";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";

/**
 * Editor state.
 *
 * Two derived values are rebuilt whenever their inputs change and are cached because they are
 * expensive: the assembled font library (assembling unifont from a mounted pack takes hundreds of
 * milliseconds) and the snapshot hash (which fences late preview responses).
 */

export interface AssetSlot {
    readonly pack: MountedPack;
    readonly entryCount: number;
}

/** Which library the shell is editing. Every mode keeps the list | preview | inspector shape. */
export type EditorMode = "items" | "themes" | "layouts" | "data";

/**
 * Whether the previewed player counts as having accepted the server resource pack.
 * `auto` follows what is mounted in the browser; explicit acceptance exists so an editor can test
 * fallback behaviour without juggling files. Asset profile and runtime tooltip capabilities remain
 * separate persona controls because accepting a pack proves neither one.
 */
export type PackSimulation = "auto" | "loaded" | "none";

interface EditorState {
    document: ProjectDocument;
    snapshotHash: string;
    mode: EditorMode;
    selectedItemId: string | null;
    selectedThemeId: string | null;
    selectedLayoutId: string | null;
    selectedDataKeyId: string | null;
    /** Block uuid highlighted across canvas and inspector, or '__name' for the display name. */
    selectedBlockUuid: string | null;
    packSimulation: PackSimulation;
    /** Explicit persona override; null derives the profile from mounted, bound bytes. */
    assetProfileOverride: string | null;
    /** Simulates the runtime capability that suppresses vanilla-generated tooltip lines. */
    managesVanillaTooltipLines: boolean;
    viewerLocale: string;
    themeOverride: string | null;
    guiScale: number;
    annotations: boolean;
    compareLocales: boolean;
    packs: AssetSlot[];
    artifact: FontMetricsArtifact | null;
    mountError: string | null;
    diagnostics: Diagnostic[];

    setDocument(document: ProjectDocument): void;
    updateDocument(mutate: (draft: ProjectDocument) => ProjectDocument): void;
    setMode(mode: EditorMode): void;
    selectItem(itemId: string | null): void;
    selectTheme(themeId: string): void;
    selectLayout(layoutId: string): void;
    selectDataKey(dataKeyId: string): void;
    selectBlock(blockUuid: string | null): void;
    setPackSimulation(simulation: PackSimulation): void;
    setAssetProfileOverride(assetProfile: string | null): void;
    setManagesVanillaTooltipLines(manages: boolean): void;
    setViewerLocale(locale: string): void;
    setThemeOverride(theme: string | null): void;
    setGuiScale(scale: number): void;
    setAnnotations(enabled: boolean): void;
    setCompareLocales(enabled: boolean): void;
    /** Writes one message in one language. The inspector's inline inputs all land here. */
    setMessage(locale: string, key: string, value: string): void;
    /** Replaces one item by node identity, which survives renames the way an array index cannot. */
    updateItem(
        uuid: string,
        mutate: (
            item: ProjectDocument["items"][number],
        ) => ProjectDocument["items"][number],
    ): void;
    /** Creates a minimal valid item and selects it. Returns the new item id. */
    addItem(defaultName: string): string;
    removeItem(uuid: string): void;
    updateTheme(
        uuid: string,
        mutate: (
            theme: ProjectDocument["themes"][number],
        ) => ProjectDocument["themes"][number],
    ): void;
    updateLayout(
        uuid: string,
        mutate: (
            layout: ProjectDocument["layouts"][number],
        ) => ProjectDocument["layouts"][number],
    ): void;
    updateViewerFact(
        id: string,
        mutate: (
            fact: ProjectDocument["viewerFacts"][number],
        ) => ProjectDocument["viewerFacts"][number],
    ): void;
    updateDataKey(
        id: string,
        mutate: (
            key: ProjectDocument["dataSchemas"][number]["keys"][number],
        ) => ProjectDocument["dataSchemas"][number]["keys"][number],
    ): void;
    movePackTo(from: number, to: number): void;
    mountPack(
        bytes: Uint8Array,
        name: string,
        kind?: "vanilla" | "resource-pack",
    ): void;
    removePack(packId: string): void;
    movePack(packId: string, delta: number): void;
    loadArtifact(bytes: Uint8Array): void;
    setDiagnostics(diagnostics: Diagnostic[]): void;
    resetDraft(): void;
}

let cachedLibrary: { digest: string; library: FontLibrary } | null = null;

export const useEditorStore = create<EditorState>((set, get) => ({
    document: baselineDocument,
    snapshotHash: contentHash(baselineDocument),
    mode: "items",
    selectedItemId: baselineDocument.items[0]
        ? `${baselineDocument.namespace}:${baselineDocument.items[0].id}`
        : null,
    selectedThemeId: baselineDocument.themes[0]?.id ?? null,
    selectedLayoutId: baselineDocument.layouts[0]?.id ?? null,
    selectedDataKeyId: baselineDocument.dataSchemas[0]?.keys[0]?.id ?? null,
    selectedBlockUuid: null,
    packSimulation: "auto",
    assetProfileOverride: null,
    managesVanillaTooltipLines: false,
    viewerLocale: baselineDocument.defaultLocale,
    themeOverride: null,
    guiScale: 3,
    annotations: false,
    compareLocales: false,
    packs: [],
    artifact: null,
    mountError: null,
    diagnostics: [],

    setDocument(document) {
        set((state) => {
            const itemIds = new Set(
                document.items.map(
                    (item) => `${document.namespace}:${item.id}`,
                ),
            );
            const themeIds = new Set(document.themes.map((theme) => theme.id));
            const layoutIds = new Set(
                document.layouts.map((layout) => layout.id),
            );
            const dataKeyIds = new Set(
                document.dataSchemas.flatMap((schema) =>
                    schema.keys.map((key) => key.id),
                ),
            );
            const selectedItemId =
                state.selectedItemId && itemIds.has(state.selectedItemId)
                    ? state.selectedItemId
                    : document.items[0]
                      ? `${document.namespace}:${document.items[0].id}`
                      : null;
            const selectedThemeId =
                state.selectedThemeId && themeIds.has(state.selectedThemeId)
                    ? state.selectedThemeId
                    : (document.themes[0]?.id ?? null);
            return {
                document,
                snapshotHash: contentHash(document),
                selectedItemId,
                selectedThemeId,
                selectedLayoutId:
                    state.selectedLayoutId &&
                    layoutIds.has(state.selectedLayoutId)
                        ? state.selectedLayoutId
                        : (document.layouts[0]?.id ?? null),
                selectedDataKeyId:
                    state.selectedDataKeyId &&
                    dataKeyIds.has(state.selectedDataKeyId)
                        ? state.selectedDataKeyId
                        : (document.dataSchemas[0]?.keys[0]?.id ?? null),
                selectedBlockUuid: null,
                assetProfileOverride:
                    state.assetProfileOverride &&
                    document.assetProfiles.some(
                        (profile) => profile.id === state.assetProfileOverride,
                    )
                        ? state.assetProfileOverride
                        : null,
                viewerLocale: document.locales.some(
                    (locale) => locale.locale === state.viewerLocale,
                )
                    ? state.viewerLocale
                    : document.defaultLocale,
                themeOverride: state.mode === "themes" ? selectedThemeId : null,
            };
        });
    },
    updateDocument(mutate) {
        const document = mutate(get().document);
        set({ document, snapshotHash: contentHash(document) });
    },
    setMode(mode) {
        // The theme library previews by overriding the viewer's requested theme; leaving the mode
        // must drop that override or the item editor would silently show the wrong theme.
        set({
            mode,
            themeOverride: mode === "themes" ? get().selectedThemeId : null,
        });
    },
    selectItem(selectedItemId) {
        set({ selectedItemId, selectedBlockUuid: null });
    },
    selectBlock(selectedBlockUuid) {
        set({ selectedBlockUuid });
    },
    selectTheme(selectedThemeId) {
        set({
            selectedThemeId,
            themeOverride: get().mode === "themes" ? selectedThemeId : null,
        });
    },
    selectLayout(selectedLayoutId) {
        set({ selectedLayoutId });
    },
    selectDataKey(selectedDataKeyId) {
        set({ selectedDataKeyId });
    },
    setPackSimulation(packSimulation) {
        set({ packSimulation });
    },
    setAssetProfileOverride(assetProfileOverride) {
        set({ assetProfileOverride });
    },
    setManagesVanillaTooltipLines(managesVanillaTooltipLines) {
        set({ managesVanillaTooltipLines });
    },
    setViewerLocale(viewerLocale) {
        set({ viewerLocale });
    },
    setThemeOverride(themeOverride) {
        set({ themeOverride });
    },
    setGuiScale(guiScale) {
        set({ guiScale });
    },
    setAnnotations(annotations) {
        set({ annotations });
    },
    setCompareLocales(compareLocales) {
        set({ compareLocales });
    },
    setMessage(locale, key, value) {
        get().updateDocument((draft) => ({
            ...draft,
            locales: draft.locales.map((entry) =>
                entry.locale === locale
                    ? {
                          ...entry,
                          messages: { ...entry.messages, [key]: value },
                      }
                    : entry,
            ),
        }));
    },
    updateItem(uuid, mutate) {
        get().updateDocument((draft) => ({
            ...draft,
            items: draft.items.map((item) =>
                item.uuid === uuid ? mutate(item) : item,
            ),
        }));
    },
    addItem(defaultName) {
        const current = get().document;
        let counter = 1;
        while (current.items.some((item) => item.id === `new-item-${counter}`))
            counter += 1;
        const id = `new-item-${counter}`;
        const nameKey = `item.${id}.name`;
        const textKey = `item.${id}.text.1`;
        // Borrow the schema references of an existing item so the new one compiles immediately;
        // an item that fails validation on creation is a terrible first impression.
        const schemas = current.items[0]?.definition.instance.schemas ?? [];
        const layout = current.layouts[0]?.id ?? "itemerness:plain";
        const theme =
            current.themes.find((entry) => !entry.requiresResourcePack)?.id ??
            current.themes[0]?.id ??
            "itemerness:default";
        get().updateDocument((draft) => ({
            ...draft,
            locales: draft.locales.map((entry) =>
                entry.locale === draft.defaultLocale
                    ? {
                          ...entry,
                          messages: {
                              ...entry.messages,
                              [nameKey]: defaultName,
                              [textKey]: "…",
                          },
                      }
                    : entry,
            ),
            items: [
                ...draft.items,
                {
                    uuid: crypto.randomUUID(),
                    id,
                    enabled: false,
                    definition: {
                        material: "minecraft:paper",
                        baseComponents: [],
                        contentComponent: null,
                        contents: [],
                        definitionData: [],
                        instance: {
                            mode: "FUNGIBLE",
                            idGenerator: null,
                            schemas: [...schemas],
                            defaults: [],
                            generators: [],
                        },
                    },
                    presentation: {
                        layout,
                        theme,
                        nameMessage: nameKey,
                        blocks: [
                            {
                                uuid: crypto.randomUUID(),
                                type: "description",
                                message: textKey,
                                style: "description",
                                anchor: null,
                                wrapping: "body",
                            },
                        ],
                    },
                    previewData: [],
                },
            ],
        }));
        set({ selectedItemId: `${get().document.namespace}:${id}` });
        return id;
    },
    removeItem(uuid) {
        const document = get().document;
        const remaining = document.items.filter((item) => item.uuid !== uuid);
        get().updateDocument((draft) => ({
            ...draft,
            items: draft.items.filter((item) => item.uuid !== uuid),
        }));
        const first = remaining[0];
        set({
            selectedItemId: first ? `${document.namespace}:${first.id}` : null,
        });
    },
    updateTheme(uuid, mutate) {
        get().updateDocument((draft) => ({
            ...draft,
            themes: draft.themes.map((theme) =>
                theme.uuid === uuid ? mutate(theme) : theme,
            ),
        }));
    },
    updateLayout(uuid, mutate) {
        get().updateDocument((draft) => ({
            ...draft,
            layouts: draft.layouts.map((layout) =>
                layout.uuid === uuid ? mutate(layout) : layout,
            ),
        }));
    },
    updateViewerFact(id, mutate) {
        get().updateDocument((draft) => ({
            ...draft,
            viewerFacts: draft.viewerFacts.map((fact) =>
                fact.id === id ? mutate(fact) : fact,
            ),
        }));
    },
    updateDataKey(id, mutate) {
        get().updateDocument((draft) => ({
            ...draft,
            dataSchemas: draft.dataSchemas.map((schema) => ({
                ...schema,
                keys: schema.keys.map((key) =>
                    key.id === id ? mutate(key) : key,
                ),
            })),
        }));
    },
    movePackTo(from, to) {
        set((state) => {
            if (
                from < 0 ||
                from >= state.packs.length ||
                to < 0 ||
                to >= state.packs.length
            )
                return state;
            const packs = [...state.packs];
            const [moved] = packs.splice(from, 1);
            packs.splice(to, 0, moved!);
            return { packs };
        });
    },
    mountPack(bytes, name, kind = "resource-pack") {
        try {
            const pack = mountArchive(bytes, { name, kind });
            const entryCount = pack.list("").length;
            set((state) => ({
                packs: [
                    { pack, entryCount },
                    ...state.packs.filter((slot) => slot.pack.id !== pack.id),
                ],
                mountError: null,
            }));
        } catch (error) {
            set({ mountError: (error as Error).message });
        }
    },
    removePack(packId) {
        set((state) => ({
            packs: state.packs.filter((slot) => slot.pack.id !== packId),
        }));
    },
    movePack(packId, delta) {
        set((state) => {
            const index = state.packs.findIndex(
                (slot) => slot.pack.id === packId,
            );
            const target = index + delta;
            if (index < 0 || target < 0 || target >= state.packs.length)
                return state;
            const packs = [...state.packs];
            const [moved] = packs.splice(index, 1);
            packs.splice(target, 0, moved!);
            return { packs };
        });
    },
    loadArtifact(bytes) {
        set({ artifact: readFontMetricsArtifact(bytes) });
    },
    setDiagnostics(diagnostics) {
        set({ diagnostics });
    },
    resetDraft() {
        set({
            document: baselineDocument,
            snapshotHash: contentHash(baselineDocument),
            diagnostics: [],
        });
    },
}));

export function packStackOf(packs: readonly AssetSlot[]): PackStack {
    return new PackStack(packs.map((slot) => slot.pack));
}

/** Assembled fonts for the current stack. Cached: unifont assembly is not cheap. */
export function fontLibraryOf(packs: readonly AssetSlot[]): FontLibrary | null {
    if (packs.length === 0) return null;
    const stack = packStackOf(packs);
    if (cachedLibrary?.digest === stack.digest) return cachedLibrary.library;
    const library = new FontLibrary(stack);
    cachedLibrary = { digest: stack.digest, library };
    return library;
}

export function presentationFontsOf(state: {
    document: ProjectDocument;
    packs: readonly AssetSlot[];
    artifact: FontMetricsArtifact | null;
}): PresentationFonts {
    return new PresentationFonts({
        library: fontLibraryOf(state.packs),
        artifact: state.artifact,
        fonts: state.document.fonts,
        glyphs: state.document.glyphs,
        spacing: state.document.spacing,
    });
}

export function viewerOf(state: {
    document: ProjectDocument;
    viewerLocale: string;
    themeOverride: string | null;
    packs: readonly AssetSlot[];
    packSimulation: PackSimulation;
    assetProfileOverride: string | null;
    managesVanillaTooltipLines: boolean;
}): PreviewViewer {
    const matchedProfile = matchedAssetProfile(state.document, state.packs);
    // `loaded` can simulate acceptance without local assets, but it cannot manufacture an asset
    // profile. Only an enabled binding whose declared SHA-1 matches the mounted archive may grant
    // profile capabilities or a metrics revision.
    const hasPack =
        state.packSimulation === "loaded"
            ? true
            : state.packSimulation === "none"
              ? false
              : matchedProfile !== null;
    const explicitProfile = state.assetProfileOverride
        ? (state.document.assetProfiles.find(
              (profile) => profile.id === state.assetProfileOverride,
          ) ?? null)
        : null;
    const activeProfile = explicitProfile ?? (hasPack ? matchedProfile : null);
    return {
        locale: state.viewerLocale,
        requestedTheme: state.themeOverride,
        assetProfile: activeProfile?.id ?? null,
        capabilities: [...(activeProfile?.capabilities ?? [])],
        metricsRevision: activeProfile?.metricsRevision ?? null,
        resourcePackLoaded: hasPack,
        // The exact NMS adapter proves this from the physical item implementation and its
        // effective components. A mounted pack says nothing about that independent capability.
        managesVanillaTooltipLines: state.managesVanillaTooltipLines,
        direction: "LEFT_TO_RIGHT",
    };
}

const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

/** Resolves a profile only when mounted bytes identify one unambiguous enabled binding. */
function matchedAssetProfile(
    document: ProjectDocument,
    packs: readonly AssetSlot[],
): ProjectDocument["assetProfiles"][number] | null {
    const matchedProfileIds = new Set<string>();
    for (const slot of packs) {
        if (slot.pack.kind !== "resource-pack") continue;
        for (const binding of document.resourcePackBindings) {
            if (
                binding.enabled &&
                binding.packId !== null &&
                binding.packId !== ZERO_UUID &&
                binding.sha1 !== null &&
                binding.sha1.toLowerCase() === slot.pack.sha1
            ) {
                matchedProfileIds.add(binding.assetProfile);
            }
        }
    }
    if (matchedProfileIds.size !== 1) return null;
    const [profileId] = matchedProfileIds;
    return (
        document.assetProfiles.find((profile) => profile.id === profileId) ??
        null
    );
}
