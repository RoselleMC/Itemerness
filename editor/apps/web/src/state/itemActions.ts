import { itemKey } from "@itemerness/protocol";
import type { TFunction } from "i18next";
import { useEditorStore } from "./store.js";
import { confirmAction, contextOwner } from "./interface.js";
import { resolveMessage } from "../features/common/messages.js";
import { freshItemCopyId } from "./itemIdentity.js";
import { copyItemDocument } from "./itemCreation.js";
import { useItemCreationDialog } from "./itemCreationDialog.js";
import { commitInlineEditor } from "../features/common/inlineEdit.js";
import { setSourceFile } from "./sourceLayout.js";

export function openItemCreation() {
    if (!commitInlineEditor()) return;
    const state = useEditorStore.getState();
    state.setMode("items");
    useItemCreationDialog.setState({
        request: { owner: contextOwner(), document: state.document },
    });
}

export async function deleteItem(uuid: string, t: TFunction) {
    const state = useEditorStore.getState();
    const item = state.document.items.find((entry) => entry.uuid === uuid);
    if (!item) return;
    const name = resolveMessage(
        state.document,
        state.viewerLocale,
        item.presentation.nameMessage,
    ).text;
    if (
        await confirmAction({
            title: t("menus.deleteItem"),
            message: t("inspector.advanced.deleteConfirm", { name }),
            accept: t("menus.delete"),
        })
    )
        useEditorStore.getState().removeItem(uuid);
}

export function duplicateItem(uuid: string, t: TFunction) {
    const state = useEditorStore.getState();
    const original = state.document.items.find((entry) => entry.uuid === uuid);
    if (!original) return;
    const id = freshItemCopyId(state.document, original);
    const transaction = state.beginTransaction();
    state.updateDocument((document) =>
        copyItemDocument(document, original, id, {
            nameForLocale: (locale, name) =>
                `${name} (${t("menus.copySuffix", { lng: locale.startsWith("zh") ? "zh-CN" : "en-US" })})`,
        }),
    );
    // A copy belongs next to its original when the document remembers catalog files.
    const sourceFile = state.document.sourceLayout?.files[original.uuid];
    const copy = useEditorStore
        .getState()
        .document.items.find((entry) => entry.id === id);
    if (sourceFile && copy)
        state.updateDocument((document) =>
            setSourceFile(document, copy.uuid, sourceFile),
        );
    state.selectItem(itemKey(state.document, id));
    state.commitTransaction(transaction);
}
