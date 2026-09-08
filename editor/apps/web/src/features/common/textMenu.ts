import type { TFunction } from "i18next";
import {
    Copy,
    ClipboardPaste,
    Scissors,
    TextSelect,
    Trash2,
    Undo2,
    Redo2,
} from "lucide-react";
import { useEditorStore } from "../../state/store.js";
import { contextOwner, type MenuAction } from "../../state/interface.js";
import { readClipboard, writeClipboard } from "./clipboard.js";
import { commitInlineEditor } from "./inlineEdit.js";

export function isTextControl(
    element: Element | null,
): element is HTMLInputElement | HTMLTextAreaElement {
    return (
        element instanceof HTMLTextAreaElement ||
        (element instanceof HTMLInputElement &&
            ![
                "checkbox",
                "radio",
                "range",
                "file",
                "hidden",
                "button",
                "submit",
                "reset",
            ].includes(element.type))
    );
}

export function documentInput(element: Element) {
    return (
        !element.closest("[data-local-operations]") &&
        !(element instanceof HTMLInputElement && element.type === "search") &&
        !!element.closest(
            ".inspector,.workspace-page-content,.inline-editor,.ui-document-popup",
        )
    );
}
export function textMenu(
    element: HTMLInputElement | HTMLTextAreaElement,
    t: TFunction,
): MenuAction[] {
    const owner = contextOwner();
    const before = element.value;
    const start = element.selectionStart ?? 0,
        end = element.selectionEnd ?? before.length;
    const password =
        element instanceof HTMLInputElement && element.type === "password";
    const writable = !element.disabled && !element.readOnly;
    const isDocument = documentInput(element);
    const state = useEditorStore.getState();
    const valid = () =>
        element.isConnected &&
        !element.closest("[hidden],[inert]") &&
        element.value === before &&
        owner === contextOwner();
    const focus = () => {
        element.focus({ preventScroll: true });
        if (element.selectionStart !== null)
            element.setSelectionRange(start, end);
    };
    const replace = (text: string) => {
        if (!valid() || !writable || element.disabled || element.readOnly)
            return;
        if (
            element instanceof HTMLInputElement &&
            element.type === "number" &&
            text !== "" &&
            !Number.isFinite(Number(text))
        )
            return;
        focus();
        const value = before.slice(0, start) + text + before.slice(end);
        const prototype =
            element instanceof HTMLTextAreaElement
                ? HTMLTextAreaElement.prototype
                : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(
            element,
            value,
        );
        element.dispatchEvent(
            new InputEvent("input", {
                bubbles: true,
                inputType: "insertFromPaste",
                data: text,
            }),
        );
        if (element.isConnected && element.selectionStart !== null)
            element.setSelectionRange(start + text.length, start + text.length);
    };
    const inlineChanged =
        (element.classList.contains("inline-editor") &&
            element.value !== element.defaultValue) ||
        element.getAttribute("data-dirty") === "true";
    return [
        {
            id: "undo",
            label: t("history.undo"),
            icon: Undo2,
            disabled:
                !writable ||
                (isDocument
                    ? !state.canUndo && !inlineChanged
                    : !document.queryCommandEnabled("undo")),
            run: () => {
                if (!valid()) return;
                if (isDocument) {
                    if (!commitInlineEditor()) return;
                    state.undo();
                } else {
                    focus();
                    document.execCommand("undo");
                }
            },
        },
        {
            id: "redo",
            label: t("history.redo"),
            icon: Redo2,
            disabled:
                !writable ||
                (isDocument
                    ? !state.canRedo || inlineChanged
                    : !document.queryCommandEnabled("redo")),
            run: () => {
                if (!valid()) return;
                if (isDocument) {
                    if (!commitInlineEditor()) return;
                    state.redo();
                } else {
                    focus();
                    document.execCommand("redo");
                }
            },
        },
        {
            id: "cut",
            label: t("menus.cut"),
            icon: Scissors,
            separator: true,
            disabled: !writable || password || start === end,
            run: async () => {
                await writeClipboard(before.slice(start, end));
                replace("");
            },
        },
        {
            id: "copy",
            label: t(start === end ? "menus.copyValue" : "menus.copy"),
            icon: Copy,
            disabled: password || before.length === 0,
            run: () =>
                writeClipboard(
                    start === end ? before : before.slice(start, end),
                ),
        },
        {
            id: "paste",
            label: t("menus.paste"),
            icon: ClipboardPaste,
            disabled: !writable,
            run: async () => {
                const text = await readClipboard();
                if (text) replace(text);
            },
        },
        {
            id: "delete-selection",
            label: t("menus.deleteSelection"),
            icon: Trash2,
            disabled: !writable || start === end,
            run: () => replace(""),
        },
        {
            id: "select-all",
            label: t("menus.selectAll"),
            icon: TextSelect,
            separator: true,
            disabled: element.disabled || !before.length,
            run: () => {
                if (valid()) {
                    element.focus({ preventScroll: true });
                    element.select();
                }
            },
        },
    ];
}
