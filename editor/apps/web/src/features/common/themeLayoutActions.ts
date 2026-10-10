import { Copy, Plus, Trash2 } from "lucide-react";
import type { TFunction } from "i18next";
import type { LayoutNode } from "@itemerness/protocol";
import { useEditorStore } from "../../state/store.js";
import { confirmAction, type MenuAction } from "../../state/interface.js";
import {
    newLayout,
    newTheme,
    removeThemeLayout,
    themeLayoutItems,
    themeLayoutReferences,
    type ThemeLayoutKind,
} from "../../state/themeLayoutLibrary.js";
import { commitInlineEditor } from "./inlineEdit.js";
import { copyAction, relatedItems } from "./contextActions.js";
import {
    newThemeSelector,
    removeThemeSelector,
    themeSelectorItems,
    themeSelectorReferences,
    themeSelectorsOf,
    withThemeSelectors,
} from "../../state/themeSelectorLibrary.js";

/** Creates a theme selector, or duplicates one with a fresh uuid, and selects it. */
export function addThemeSelector(sourceUuid?: string) {
    if (!commitInlineEditor()) return;
    const store = useEditorStore.getState();
    const source = themeSelectorsOf(store.document).find(
        (entry) => entry.uuid === sourceUuid,
    );
    if (sourceUuid && !source) return;
    const entry = newThemeSelector(store.document, source);
    if (!entry) return;
    store.updateDocument((document) =>
        withThemeSelectors(document, [...themeSelectorsOf(document), entry]),
    );
    store.selectTheme(entry.id);
}

export function themeSelectorActions(uuid: string, t: TFunction): MenuAction[] {
    const document = useEditorStore.getState().document;
    const entry = themeSelectorsOf(document).find(
        (selector) => selector.uuid === uuid,
    );
    if (!entry) return [];
    return [
        copyAction("copy-id", t("menus.copyId"), entry.id),
        {
            id: "duplicate-theme-selector",
            label: t("themeSelector.duplicate"),
            icon: Copy,
            run: () => addThemeSelector(uuid),
        },
        relatedItems(themeSelectorItems(document, entry.id), t),
        {
            id: "delete-theme-selector",
            label: t("themeSelector.delete"),
            icon: Trash2,
            danger: true,
            disabled: themeSelectorReferences(document, entry.id).length > 0,
            run: async () => {
                if (!commitInlineEditor()) return;
                const source = themeSelectorsOf(
                    useEditorStore.getState().document,
                ).find((selector) => selector.uuid === uuid);
                if (
                    !source ||
                    !(await confirmAction({
                        title: t("themeSelector.delete"),
                        message: t("themeLayoutLibrary.deleteConfirm", {
                            id: source.id,
                        }),
                        accept: t("menus.delete"),
                    }))
                )
                    return;
                const store = useEditorStore.getState();
                store.updateDocument((document) =>
                    removeThemeSelector(document, uuid),
                );
                const current = useEditorStore.getState();
                if (
                    current.selectedThemeId === source.id &&
                    !themeSelectorsOf(current.document).some(
                        (selector) => selector.uuid === uuid,
                    )
                )
                    useEditorStore.setState({
                        selectedThemeId: current.document.themes[0]?.id ?? null,
                    });
                if (current.themeOverride === source.id)
                    store.setThemeOverride(
                        current.mode === "themes"
                            ? (useEditorStore.getState().selectedThemeId ??
                                  null)
                            : null,
                    );
            },
        },
    ];
}

export function addThemeLayout(
    kind: ThemeLayoutKind,
    sourceUuid?: string,
    layoutKind: LayoutNode["kind"] = "flow",
) {
    if (!commitInlineEditor()) return;
    const store = useEditorStore.getState();
    if (kind === "themes") {
        const source = store.document.themes.find(
            (entry) => entry.uuid === sourceUuid,
        );
        if (sourceUuid && !source) return;
        const entry = newTheme(store.document, source);
        store.updateDocument((document) => ({
            ...document,
            themes: [...document.themes, entry],
        }));
        store.selectTheme(entry.id);
    } else {
        const source = store.document.layouts.find(
            (entry) => entry.uuid === sourceUuid,
        );
        if (sourceUuid && !source) return;
        const entry = newLayout(store.document, layoutKind, source);
        store.updateDocument((document) => ({
            ...document,
            layouts: [...document.layouts, entry],
        }));
        store.selectLayout(entry.id);
    }
}

export function createThemeLayoutActions(
    kind: ThemeLayoutKind,
    t: TFunction,
): MenuAction[] {
    if (kind === "themes")
        return [
            {
                id: "add-theme",
                label: t("themeLayoutLibrary.add.theme"),
                icon: Plus,
                run: () => addThemeLayout("themes"),
            },
            {
                id: "add-theme-selector",
                label: t("themeLayoutLibrary.add.selector"),
                icon: Plus,
                // A selector needs at least one concrete theme to fall back to.
                disabled:
                    useEditorStore.getState().document.themes.length === 0,
                run: () => addThemeSelector(),
            },
        ];
    return (["flow", "canvas"] as const).map((type) => ({
        id: `add-${type}`,
        label: t(`themeLayoutLibrary.add.${type}`),
        icon: Plus,
        run: () => addThemeLayout(kind, undefined, type),
    }));
}

export function themeLayoutActions(
    kind: ThemeLayoutKind,
    uuid: string,
    t: TFunction,
): MenuAction[] {
    const document = useEditorStore.getState().document;
    const entry = document[kind].find((entry) => entry.uuid === uuid);
    if (!entry) return [];
    return [
        copyAction("copy-id", t("menus.copyId"), entry.id),
        {
            id: `duplicate-${kind}`,
            label: t(`themeLayoutLibrary.duplicate.${kind}`),
            icon: Copy,
            run: () => addThemeLayout(kind, uuid),
        },
        relatedItems(themeLayoutItems(document, kind, entry.id), t),
        {
            id: `delete-${kind}`,
            label: t(`themeLayoutLibrary.delete.${kind}`),
            icon: Trash2,
            danger: true,
            disabled:
                themeLayoutReferences(document, kind, entry.id).length > 0,
            run: async () => {
                if (!commitInlineEditor()) return;
                const source = useEditorStore
                    .getState()
                    .document[kind].find((entry) => entry.uuid === uuid);
                if (
                    !source ||
                    !(await confirmAction({
                        title: t(`themeLayoutLibrary.delete.${kind}`),
                        message: t("themeLayoutLibrary.deleteConfirm", {
                            id: source.id,
                        }),
                        accept: t("menus.delete"),
                    }))
                )
                    return;
                const store = useEditorStore.getState();
                store.updateDocument((document) =>
                    removeThemeLayout(document, kind, uuid),
                );
                const current = useEditorStore.getState();
                const next = current.document[kind][0]?.id ?? null;
                if (kind === "themes") {
                    if (
                        !current.document.themes.some(
                            (theme) => theme.id === current.selectedThemeId,
                        )
                    )
                        useEditorStore.setState({ selectedThemeId: next });
                    if (current.themeOverride === source.id)
                        store.setThemeOverride(null);
                } else if (
                    !current.document.layouts.some(
                        (layout) => layout.id === current.selectedLayoutId,
                    )
                )
                    useEditorStore.setState({ selectedLayoutId: next });
            },
        },
    ];
}
