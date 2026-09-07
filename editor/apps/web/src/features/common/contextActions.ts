import type { TFunction } from "i18next";
import {
    ArrowDown,
    ArrowUp,
    Copy,
    Pencil,
    Plus,
    Trash2,
    Check,
    ListTree,
    GitBranch,
    ListPlus,
    TextCursorInput,
    ArrowDownToLine,
    ArrowUpToLine,
} from "lucide-react";
import type { ItemNode, PresentationBlock } from "@itemerness/protocol";
import { useEditorStore } from "../../state/store.js";
import { deleteItem, duplicateItem } from "../../state/itemActions.js";
import {
    deleteSelectedContent,
    duplicateSelectedContent,
    moveSelectedContent,
    insertContent,
} from "../../state/contentActions.js";
import { locateBlock } from "../../state/blocks.js";
import type { MenuAction } from "../../state/interface.js";
import { writeClipboard } from "./clipboard.js";
import { resolveMessage } from "./messages.js";

export const copyAction = (
    id: string,
    label: string,
    text: string,
): MenuAction => ({ id, label, icon: Copy, run: () => writeClipboard(text) });
export function itemActions(uuid: string, t: TFunction): MenuAction[] {
    const state = useEditorStore.getState(),
        item = state.document.items.find((entry) => entry.uuid === uuid);
    if (!item) return [];
    return [
        {
            id: "edit-item",
            label: t("menus.editItem"),
            icon: Pencil,
            run: () => {
                state.setMode("items");
                state.selectItem(`${state.document.namespace}:${item.id}`);
            },
        },
        {
            id: "duplicate-item",
            label: t("menus.duplicateItem"),
            icon: Copy,
            run: () => duplicateItem(uuid, t),
        },
        copyAction(
            "copy-item-id",
            t("menus.copyId"),
            `${state.document.namespace}:${item.id}`,
        ),
        {
            id: "item-enabled",
            label: t("inspector.enabled"),
            icon: Check,
            checked: item.enabled,
            separator: true,
            run: () =>
                state.updateItem(uuid, (current) => ({
                    ...current,
                    enabled: !current.enabled,
                })),
        },
        {
            id: "delete-item",
            label: t("menus.deleteItem"),
            icon: Trash2,
            danger: true,
            separator: true,
            run: () => deleteItem(uuid, t),
        },
    ];
}
export function insertActions(
    anchor: string,
    position: "before" | "after",
    t: TFunction,
): MenuAction[] {
    const state = useEditorStore.getState();
    const add = (kind: "field" | "description" | "conditional") =>
        insertContent(
            kind,
            anchor,
            position,
            t("inspector.content.newTextDefault"),
        );
    return [
        {
            id: "add-field",
            label: t("inspector.content.addField"),
            icon: ListPlus,
            disabled: !state.document.dataSchemas.some((schema) =>
                schema.keys.some((key) => key.presentationReadable),
            ),
            run: () => add("field"),
        },
        {
            id: "add-text",
            label: t("inspector.content.addText"),
            icon: TextCursorInput,
            run: () => add("description"),
        },
        {
            id: "add-condition",
            label: t("inspector.content.conditional"),
            icon: GitBranch,
            disabled: !state.document.viewerFacts.length,
            run: () => add("conditional"),
        },
    ];
}
export function contentActions(uuid: string, t: TFunction): MenuAction[] {
    const state = useEditorStore.getState();
    const item = state.document.items.find(
        (entry) =>
            `${state.document.namespace}:${entry.id}` === state.selectedItemId,
    );
    const found = item ? locateBlock(item.presentation.blocks, uuid) : null;
    const select = () => state.selectBlock(uuid);
    return [
        {
            id: "edit-content",
            label: t(
                uuid === "__name"
                    ? "menus.globalSettings"
                    : "menus.editContent",
            ),
            icon: Pencil,
            run: select,
        },
        ...(uuid !== "__name"
            ? [
                  {
                      id: "insert-before",
                      label: t("stage.insertBefore"),
                      icon: ArrowUpToLine,
                      children: insertActions(uuid, "before", t),
                  },
              ]
            : []),
        {
            id: "insert-after",
            label: t("stage.insertAfter"),
            icon: ArrowDownToLine,
            children: insertActions(uuid, "after", t),
        },
        ...(found
            ? [
                  {
                      id: "move-up",
                      label: t("inspector.content.moveUp"),
                      icon: ArrowUp,
                      separator: true,
                      disabled: found.index === 0,
                      run: () => {
                          select();
                          moveSelectedContent(-1);
                      },
                  },
                  {
                      id: "move-down",
                      label: t("inspector.content.moveDown"),
                      icon: ArrowDown,
                      disabled: found.index === found.siblings.length - 1,
                      run: () => {
                          select();
                          moveSelectedContent(1);
                      },
                  },
                  {
                      id: "duplicate-content",
                      label: t("history.duplicate"),
                      icon: Copy,
                      run: () => {
                          select();
                          duplicateSelectedContent();
                      },
                  },
                  {
                      id: "delete-content",
                      label: t("inspector.content.remove"),
                      icon: Trash2,
                      danger: true,
                      separator: true,
                      run: () => {
                          select();
                          deleteSelectedContent();
                      },
                  },
              ]
            : []),
    ];
}
export function relatedItems(items: ItemNode[], t: TFunction): MenuAction {
    const state = useEditorStore.getState();
    return {
        id: "related-items",
        label: t("menus.relatedItems"),
        icon: ListTree,
        disabled: !items.length,
        children: items.map((item) => ({
            id: `related-${item.uuid}`,
            label: resolveMessage(
                state.document,
                state.viewerLocale,
                item.presentation.nameMessage,
            ).text,
            run: () => {
                state.setMode("items");
                state.selectItem(`${state.document.namespace}:${item.id}`);
            },
        })),
    };
}
export function blockUses(block: PresentationBlock, key: string): boolean {
    if (block.type === "conditional")
        return (
            [block.condition.left, block.condition.right].some(
                (value) => value?.kind === "data" && value.key === key,
            ) ||
            [...block.thenBlocks, ...block.otherwiseBlocks].some((child) =>
                blockUses(child, key),
            )
        );
    return "data" in block && block.data === key;
}
export function newItemAction(t: TFunction): MenuAction {
    return {
        id: "new-item",
        label: t("sidebar.addItem"),
        icon: Plus,
        run: () => {
            useEditorStore.getState().setMode("items");
            useEditorStore.getState().addItem(t("sidebar.newItemName"));
        },
    };
}
