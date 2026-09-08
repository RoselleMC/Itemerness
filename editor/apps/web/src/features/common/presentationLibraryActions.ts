import { Copy, Plus, Trash2 } from "lucide-react";
import type { TFunction } from "i18next";
import { useEditorStore } from "../../state/store.js";
import { confirmAction, type MenuAction } from "../../state/interface.js";
import {
    builtinFactType,
    newFormat,
    newViewerFact,
    presentationLibraryItems,
    presentationLibraryReferences,
    removePresentationEntry,
    type PresentationLibraryKind,
} from "../../state/presentationLibrary.js";
import { commitInlineEditor } from "./inlineEdit.js";
import { copyAction, relatedItems } from "./contextActions.js";

export function addPresentationEntry(
    kind: PresentationLibraryKind,
    sourceUuid?: string,
) {
    if (!commitInlineEditor()) return;
    const store = useEditorStore.getState();
    if (kind === "formats") {
        const source = store.document.formats.find(
            (entry) => entry.uuid === sourceUuid,
        );
        if (sourceUuid && !source) return;
        const format = newFormat(store.document, source);
        store.updateDocument((document) => ({
            ...document,
            formats: [...document.formats, format],
        }));
        store.selectFormat(format.uuid);
    } else {
        const source = store.document.viewerFacts.find(
            (entry) => entry.uuid === sourceUuid,
        );
        if ((sourceUuid && !source) || store.document.viewerFacts.length >= 256)
            return;
        const fact = newViewerFact(store.document, source);
        store.updateDocument((document) => ({
            ...document,
            viewerFacts: [...document.viewerFacts, fact],
        }));
        store.selectViewerFact(fact.uuid);
    }
}

export function addPresentationAction(
    kind: PresentationLibraryKind,
    t: TFunction,
): MenuAction {
    const document = useEditorStore.getState().document;
    return {
        id: `add-${kind}`,
        label: t(`presentationLibrary.add.${kind}`),
        icon: Plus,
        disabled: kind === "facts" && document.viewerFacts.length >= 256,
        run: () => addPresentationEntry(kind),
    };
}

export function presentationEntryActions(
    kind: PresentationLibraryKind,
    uuid: string,
    t: TFunction,
): MenuAction[] {
    const document = useEditorStore.getState().document;
    const entries =
        kind === "formats" ? document.formats : document.viewerFacts;
    const node = entries.find((entry) => entry.uuid === uuid);
    if (!node) return [];
    return [
        copyAction("copy-id", t("menus.copyId"), node.id),
        {
            id: `duplicate-${kind}`,
            label: t(`presentationLibrary.duplicate.${kind}`),
            icon: Copy,
            disabled: kind === "facts" && entries.length >= 256,
            run: () => addPresentationEntry(kind, uuid),
        },
        relatedItems(presentationLibraryItems(document, kind, node.id), t),
        {
            id: `delete-${kind}`,
            label: t(`presentationLibrary.delete.${kind}`),
            icon: Trash2,
            danger: true,
            separator: true,
            disabled:
                presentationLibraryReferences(document, kind, node.id).length >
                0,
            run: async () => {
                if (
                    !commitInlineEditor() ||
                    !(await confirmAction({
                        title: t(`presentationLibrary.delete.${kind}`),
                        message: t(
                            kind === "facts" && builtinFactType(node.id)
                                ? "presentationLibrary.deleteBuiltinConfirm"
                                : "presentationLibrary.deleteConfirm",
                            {
                                id: node.id,
                            },
                        ),
                        accept: t("menus.delete"),
                    }))
                )
                    return;
                useEditorStore
                    .getState()
                    .updateDocument((current) =>
                        removePresentationEntry(current, kind, uuid),
                    );
            },
        },
    ];
}
