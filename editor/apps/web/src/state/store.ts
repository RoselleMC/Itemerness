import { itemKey } from "@itemerness/protocol";
import { create } from "zustand";
import { clampZoom } from "./zoom.js";
import { locateBlock } from "./blocks.js";
import { DocumentHistory, documentSnapshot } from "./history.js";
import {
    createItemDocument,
    type ItemCreationOptions,
} from "./itemCreation.js";
import type { AssetSection } from "./assetLibrary.js";
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
    emptyProjectDocument,
    type Diagnostic,
    type PreviewViewer,
    type ProjectDocument,
} from "@itemerness/protocol";

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
export type EditorMode =
    "items" | "themes" | "layouts" | "data" | "formats" | "facts";

/**
 * Whether the previewed player counts as having accepted the server resource pack.
 * `auto` follows what is mounted in the browser; explicit acceptance exists so an editor can test
 * fallback behaviour without juggling files. Asset profile and runtime tooltip capabilities remain
 * separate persona controls because accepting a pack proves neither one.
 */
export type PackSimulation = "auto" | "loaded" | "none";

interface EditorState {
    workspaceEpoch: number;
    document: ProjectDocument;
    persistenceDocument: ProjectDocument;
    canUndo: boolean;
    canRedo: boolean;
    historyTransactionId: number | null;
    beginTransaction(): number;
    commitTransaction(id: number): void;
    cancelTransaction(id: number): void;
    setEditGroup(group: string | null): void;
    undo(): void;
    redo(): void;
    snapshotHash: string;
    mode: EditorMode;
    selectedItemId: string | null;
    selectedThemeId: string | null;
    selectedLayoutId: string | null;
    selectedDataKeyUuid: string | null;
    selectedDataSchemaUuid: string | null;
    selectedFormatUuid: string | null;
    selectedViewerFactUuid: string | null;
    selectedAssetKind: AssetSection;
    selectedAssetUuid: string | null;
    /** Selected content UUID; '__name' keeps global settings. Never stored in the document. */
    selectedBlockUuid: string | null;
    packSimulation: PackSimulation;
    /** Explicit persona override; null derives the profile from mounted, bound bytes. */
    assetProfileOverride: string | null;
    /** Simulates the runtime capability that suppresses vanilla-generated tooltip lines. */
    managesVanillaTooltipLines: boolean;
    viewerLocale: string;
    themeOverride: string | null;
    guiScale: number;
    zoomMode: "manual" | "fit";
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
    selectDataKey(dataKeyUuid: string): void;
    selectDataSchema(schemaUuid: string): void;
    selectFormat(uuid: string | null): void;
    selectViewerFact(uuid: string | null): void;
    selectAsset(kind: AssetSection, uuid?: string | null): void;
    selectBlock(blockUuid: string | null): void;
    setPackSimulation(simulation: PackSimulation): void;
    setAssetProfileOverride(assetProfile: string | null): void;
    setManagesVanillaTooltipLines(manages: boolean): void;
    setViewerLocale(locale: string): void;
    setThemeOverride(theme: string | null): void;
    setGuiScale(scale: number, mode?: "manual" | "fit"): void;
    setZoomMode(mode: "manual" | "fit"): void;
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
    /** Creates one definition from explicit settings or configured project defaults. */
    addItem(defaultName: string, options?: ItemCreationOptions): string;
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
    setMountedPack(pack: MountedPack, replaceId?: string): void;
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

const packStacks = new WeakMap<readonly AssetSlot[], PackStack>();
const fontLibraries = new WeakMap<PackStack, FontLibrary>();
const emptyDocument = () =>
    emptyProjectDocument("00000000-0000-0000-0000-000000000000");
const initialDocument = emptyDocument();

export const useEditorStore = create<EditorState>((set, get) => {
    const history = new DocumentHistory();
    const snapshot = () => documentSnapshot(get());
    const restore = (value: ReturnType<typeof snapshot>) =>
        set({
            ...value,
            persistenceDocument: value.document,
            themeOverride:
                value.mode === "themes" ? value.selectedThemeId : null,
            diagnostics: [],
            ...history.flags(value),
        });
    return {
        workspaceEpoch: 0,
        document: initialDocument,
        persistenceDocument: initialDocument,
        canUndo: false,
        canRedo: false,
        historyTransactionId: null,
        beginTransaction() {
            const id = history.begin(snapshot());
            set(history.flags(snapshot()));
            return id;
        },
        commitTransaction(id) {
            if (history.commit(snapshot(), id))
                set({
                    persistenceDocument: get().document,
                    ...history.flags(snapshot()),
                });
        },
        cancelTransaction(id) {
            const before = history.cancel(id);
            if (before) restore(before);
        },
        setEditGroup(group) {
            history.setGroup(group);
        },
        undo() {
            const before = history.undo(snapshot());
            if (before) restore(before);
            else
                set({
                    persistenceDocument: get().document,
                    ...history.flags(snapshot()),
                });
        },
        redo() {
            const after = history.redo(snapshot());
            if (after) restore(after);
        },
        snapshotHash: contentHash(initialDocument),
        mode: "items",
        selectedItemId: null,
        selectedThemeId: null,
        selectedLayoutId: null,
        selectedDataKeyUuid: null,
        selectedDataSchemaUuid: null,
        selectedFormatUuid: null,
        selectedViewerFactUuid: null,
        selectedAssetKind: "fonts",
        selectedAssetUuid: null,
        selectedBlockUuid: null,
        packSimulation: "auto",
        assetProfileOverride: null,
        managesVanillaTooltipLines: false,
        viewerLocale: initialDocument.defaultLocale,
        themeOverride: null,
        guiScale: 3,
        zoomMode: "fit",
        annotations: false,
        compareLocales: false,
        packs: [],
        artifact: null,
        mountError: null,
        diagnostics: [],

        setDocument(document) {
            history.clear();
            set((state) => {
                const itemIds = new Set(
                    document.items.map((item) => itemKey(document, item)),
                );
                const themeIds = new Set(
                    document.themes.map((theme) => theme.id),
                );
                const layoutIds = new Set(
                    document.layouts.map((layout) => layout.id),
                );
                const dataKeyUuids = new Set(
                    document.dataSchemas.flatMap((schema) =>
                        schema.keys.map((key) => key.uuid),
                    ),
                );
                const selectedItemId =
                    state.selectedItemId && itemIds.has(state.selectedItemId)
                        ? state.selectedItemId
                        : document.items[0]
                          ? itemKey(document, document.items[0])
                          : null;
                const selectedThemeId =
                    state.selectedThemeId && themeIds.has(state.selectedThemeId)
                        ? state.selectedThemeId
                        : (document.themes[0]?.id ?? null);
                return {
                    document,
                    persistenceDocument: document,
                    canUndo: false,
                    canRedo: false,
                    historyTransactionId: null,
                    snapshotHash: contentHash(document),
                    selectedItemId,
                    selectedThemeId,
                    selectedLayoutId:
                        state.selectedLayoutId &&
                        layoutIds.has(state.selectedLayoutId)
                            ? state.selectedLayoutId
                            : (document.layouts[0]?.id ?? null),
                    selectedDataKeyUuid:
                        state.selectedDataKeyUuid &&
                        dataKeyUuids.has(state.selectedDataKeyUuid)
                            ? state.selectedDataKeyUuid
                            : (document.dataSchemas.flatMap(
                                  (schema) => schema.keys,
                              )[0]?.uuid ?? null),
                    selectedDataSchemaUuid: document.dataSchemas.some(
                        (schema) =>
                            schema.uuid === state.selectedDataSchemaUuid,
                    )
                        ? state.selectedDataSchemaUuid
                        : (document.dataSchemas[0]?.uuid ?? null),
                    selectedBlockUuid: null,
                    selectedFormatUuid: document.formats.some(
                        (format) => format.uuid === state.selectedFormatUuid,
                    )
                        ? state.selectedFormatUuid
                        : (document.formats[0]?.uuid ?? null),
                    selectedViewerFactUuid: document.viewerFacts.some(
                        (fact) => fact.uuid === state.selectedViewerFactUuid,
                    )
                        ? state.selectedViewerFactUuid
                        : (document.viewerFacts[0]?.uuid ?? null),
                    selectedAssetUuid:
                        state.selectedAssetKind === "spacing" ||
                        state.selectedAssetKind === "measurement"
                            ? null
                            : document[state.selectedAssetKind].some(
                                    (entry) =>
                                        entry.uuid === state.selectedAssetUuid,
                                )
                              ? state.selectedAssetUuid
                              : (document[state.selectedAssetKind][0]?.uuid ??
                                null),
                    assetProfileOverride:
                        state.assetProfileOverride &&
                        document.assetProfiles.some(
                            (profile) =>
                                profile.id === state.assetProfileOverride,
                        )
                            ? state.assetProfileOverride
                            : null,
                    viewerLocale: document.locales.some(
                        (locale) => locale.locale === state.viewerLocale,
                    )
                        ? state.viewerLocale
                        : document.defaultLocale,
                    themeOverride:
                        state.mode === "themes" ? selectedThemeId : null,
                };
            });
        },
        updateDocument(mutate) {
            const current = get();
            const document = mutate(current.document);
            if (document === current.document) return;
            const snapshotHash = contentHash(document);
            if (snapshotHash === current.snapshotHash) return;
            const selectedUuid = current.document.items.find(
                (entry) =>
                    itemKey(current.document, entry) === current.selectedItemId,
            )?.uuid;
            const item = document.items.find(
                (entry) => entry.uuid === selectedUuid,
            );
            const selectedItemId = item ? itemKey(document, item) : null;
            const selectedBlockUuid =
                current.selectedBlockUuid &&
                current.selectedBlockUuid !== "__name" &&
                (!item ||
                    !locateBlock(
                        item.presentation.blocks,
                        current.selectedBlockUuid,
                    ))
                    ? null
                    : current.selectedBlockUuid;
            history.record(snapshot());
            const next = {
                ...current,
                document,
                snapshotHash,
                selectedItemId,
                selectedBlockUuid,
                selectedFormatUuid: document.formats.some(
                    (format) => format.uuid === current.selectedFormatUuid,
                )
                    ? current.selectedFormatUuid
                    : (document.formats[0]?.uuid ?? null),
                selectedViewerFactUuid: document.viewerFacts.some(
                    (fact) => fact.uuid === current.selectedViewerFactUuid,
                )
                    ? current.selectedViewerFactUuid
                    : (document.viewerFacts[0]?.uuid ?? null),
                selectedAssetUuid:
                    current.selectedAssetKind === "spacing" ||
                    current.selectedAssetKind === "measurement"
                        ? null
                        : document[current.selectedAssetKind].some(
                                (entry) =>
                                    entry.uuid === current.selectedAssetUuid,
                            )
                          ? current.selectedAssetUuid
                          : (document[current.selectedAssetKind][0]?.uuid ??
                            null),
            };
            set({
                document,
                snapshotHash,
                selectedItemId,
                selectedBlockUuid,
                selectedFormatUuid: next.selectedFormatUuid,
                selectedViewerFactUuid: next.selectedViewerFactUuid,
                selectedAssetUuid: next.selectedAssetUuid,
                persistenceDocument: history.transaction
                    ? current.persistenceDocument
                    : document,
                ...history.flags(next),
            });
        },
        setMode(mode) {
            // The theme library previews by overriding the viewer's requested theme; leaving the mode
            // must drop that override or the item editor would silently show the wrong theme.
            set({
                mode,
                selectedBlockUuid: null,
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
        selectDataKey(selectedDataKeyUuid) {
            set((state) => ({
                selectedDataKeyUuid,
                selectedDataSchemaUuid:
                    state.document.dataSchemas.find((schema) =>
                        schema.keys.some(
                            (key) => key.uuid === selectedDataKeyUuid,
                        ),
                    )?.uuid ?? null,
            }));
        },
        selectDataSchema(selectedDataSchemaUuid) {
            set({ selectedDataSchemaUuid, selectedDataKeyUuid: null });
        },
        selectFormat(selectedFormatUuid) {
            set({ selectedFormatUuid, selectedBlockUuid: null });
        },
        selectViewerFact(selectedViewerFactUuid) {
            set({ selectedViewerFactUuid, selectedBlockUuid: null });
        },
        selectAsset(selectedAssetKind, uuid) {
            set({
                selectedAssetKind,
                selectedAssetUuid:
                    uuid ??
                    (selectedAssetKind === "spacing" ||
                    selectedAssetKind === "measurement"
                        ? null
                        : (get().document[selectedAssetKind][0]?.uuid ?? null)),
                selectedBlockUuid: null,
            });
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
        setGuiScale(value, zoomMode = "manual") {
            const guiScale = clampZoom(value);
            if (guiScale !== get().guiScale || zoomMode !== get().zoomMode)
                set({ guiScale, zoomMode });
        },
        setZoomMode(zoomMode) {
            set({ zoomMode });
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
        addItem(defaultName, options) {
            const document = createItemDocument(
                get().document,
                defaultName,
                options,
            );
            const id = document.items.at(-1)!.id;
            const transaction = get().beginTransaction();
            get().updateDocument(() => document);
            set({
                selectedItemId: itemKey(get().document, id),
                selectedBlockUuid: null,
            });
            get().commitTransaction(transaction);
            return id;
        },
        removeItem(uuid) {
            const current = get();
            const document = current.document;
            const removed = document.items.find((item) => item.uuid === uuid);
            if (!removed) return;
            const remaining = document.items.filter(
                (item) => item.uuid !== uuid,
            );
            get().updateDocument((draft) => ({
                ...draft,
                items: draft.items.filter((item) => item.uuid !== uuid),
            }));
            if (current.selectedItemId === itemKey(document, removed)) {
                const first = remaining[0];
                set({
                    selectedItemId: first ? itemKey(document, first) : null,
                    selectedBlockUuid: null,
                });
            }
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
        updateDataKey(uuid, mutate) {
            get().updateDocument((draft) => ({
                ...draft,
                dataSchemas: draft.dataSchemas.map((schema) => ({
                    ...schema,
                    keys: schema.keys.map((key) =>
                        key.uuid === uuid ? mutate(key) : key,
                    ),
                })),
            }));
        },
        movePackTo(from, to) {
            set((state) => {
                if (
                    from === to ||
                    from < 0 ||
                    from >= state.packs.length ||
                    to < 0 ||
                    to >= state.packs.length ||
                    state.packs[from]?.pack.kind === "vanilla" ||
                    state.packs[to]?.pack.kind === "vanilla"
                )
                    return state;
                const packs = [...state.packs];
                const [moved] = packs.splice(from, 1);
                packs.splice(to, 0, moved!);
                return { packs };
            });
        },
        setMountedPack(pack, replaceId) {
            set((state) => {
                const slot = { pack, entryCount: pack.list("").length };
                const custom = state.packs.filter(
                    (entry) => entry.pack.kind !== "vanilla",
                );
                const vanilla = state.packs.filter(
                    (entry) => entry.pack.kind === "vanilla",
                );
                if (pack.kind === "vanilla")
                    return { packs: [...custom, slot], mountError: null };
                const position = custom.findIndex(
                    (entry) =>
                        entry.pack.id === replaceId ||
                        entry.pack.id === pack.id,
                );
                const others = custom.filter(
                    (entry) =>
                        entry.pack.id !== replaceId &&
                        entry.pack.id !== pack.id,
                );
                others.splice(position < 0 ? 0 : position, 0, slot);
                return {
                    packs: [...others, ...vanilla.slice(-1)],
                    mountError: null,
                };
            });
        },
        mountPack(bytes, name, kind = "resource-pack") {
            try {
                const pack = mountArchive(bytes, { name, kind });
                get().setMountedPack(pack);
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
                if (
                    index < 0 ||
                    target === index ||
                    target < 0 ||
                    target >= state.packs.length ||
                    state.packs[index]?.pack.kind === "vanilla" ||
                    state.packs[target]?.pack.kind === "vanilla"
                )
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
            history.clear();
            const document = emptyDocument();
            set({
                document,
                snapshotHash: contentHash(document),
                mode: "items",
                workspaceEpoch: get().workspaceEpoch + 1,
                persistenceDocument: document,
                canUndo: false,
                canRedo: false,
                historyTransactionId: null,
                selectedItemId: null,
                selectedThemeId: null,
                selectedLayoutId: null,
                selectedDataKeyUuid: null,
                selectedDataSchemaUuid: null,
                selectedFormatUuid: null,
                selectedViewerFactUuid: null,
                selectedAssetKind: "fonts",
                selectedAssetUuid: null,
                selectedBlockUuid: null,
                packs: [],
                packSimulation: "auto",
                assetProfileOverride: null,
                managesVanillaTooltipLines: false,
                viewerLocale: document.defaultLocale,
                guiScale: 3,
                zoomMode: "fit",
                annotations: false,
                compareLocales: false,
                themeOverride: null,
                mountError: null,
                diagnostics: [],
            });
        },
    };
});

export function packStackOf(packs: readonly AssetSlot[]): PackStack {
    let stack = packStacks.get(packs);
    if (!stack) {
        stack = new PackStack(packs.map((slot) => slot.pack));
        packStacks.set(packs, stack);
    }
    return stack;
}

/** Assembled fonts for the current stack. Cached: unifont assembly is not cheap. */
export function fontLibraryOf(packs: readonly AssetSlot[]): FontLibrary | null {
    if (packs.length === 0) return null;
    const stack = packStackOf(packs);
    const cached = fontLibraries.get(stack);
    if (cached) return cached;
    const library = new FontLibrary(stack);
    fontLibraries.set(stack, library);
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
        boldExtraAdvancePixels:
            state.document.measurement?.boldExtraAdvancePixels,
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
