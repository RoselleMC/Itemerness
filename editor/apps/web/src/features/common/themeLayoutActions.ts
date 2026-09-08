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
    return (kind === "themes" ? ["theme"] : ["flow", "canvas"]).map((type) => ({
        id: `add-${type}`,
        label: t(`themeLayoutLibrary.add.${type}`),
        icon: Plus,
        run: () =>
            addThemeLayout(
                kind,
                undefined,
                type === "canvas" ? "canvas" : "flow",
            ),
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
