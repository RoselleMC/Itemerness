import { useEffect, useRef, type SyntheticEvent } from "react";
import { useEditorStore } from "../../state/store.js";
import { documentInput } from "../common/textMenu.js";
import { commitInlineEditor } from "../common/inlineEdit.js";
import {
    deleteSelectedContent,
    duplicateSelectedContent,
    moveSelectedContent,
} from "../../state/contentActions.js";

const textInput = (element: Element | null) =>
    !!element?.closest('input,textarea,select,[contenteditable="true"]');

export function useEditingShortcuts(enabled: boolean) {
    const groups = useRef(new WeakMap<Element, string>());
    const nextGroup = useRef(0);
    useEffect(() => {
        if (!enabled) return;
        const key = (event: KeyboardEvent) => {
            if (event.isComposing || event.defaultPrevented) return;
            const element =
                event.target instanceof Element ? event.target : null;
            const typing = textInput(element);
            if (document.querySelector(".unsaved-dialog[open]")) return;
            const state = useEditorStore.getState();
            const command = (event.metaKey || event.ctrlKey) && !event.altKey;
            if (
                command &&
                (event.key.toLowerCase() === "z" ||
                    event.key.toLowerCase() === "y")
            ) {
                if (typing && (!element || !documentInput(element))) return;
                event.preventDefault();
                if (!commitInlineEditor()) return;
                if (event.shiftKey || event.key.toLowerCase() === "y")
                    state.redo();
                else state.undo();
                return;
            }
            if (
                typing ||
                state.mode !== "items" ||
                !element?.closest(".editor-workspace:not([hidden])")
            )
                return;
            if (event.key === "Delete" || event.key === "Backspace") {
                event.preventDefault();
                deleteSelectedContent();
            }
            if (command && event.key.toLowerCase() === "d") {
                event.preventDefault();
                duplicateSelectedContent();
            }
            if (
                event.altKey &&
                (event.key === "ArrowUp" || event.key === "ArrowDown")
            ) {
                event.preventDefault();
                moveSelectedContent(event.key === "ArrowUp" ? -1 : 1);
            }
        };
        const beforeInput = (event: InputEvent) => {
            if (
                event.target instanceof Element &&
                documentInput(event.target) &&
                ["historyUndo", "historyRedo"].includes(event.inputType)
            ) {
                event.preventDefault();
                if (!commitInlineEditor()) return;
                if (event.inputType === "historyUndo")
                    useEditorStore.getState().undo();
                else useEditorStore.getState().redo();
            }
        };
        window.addEventListener("keydown", key);
        document.addEventListener("beforeinput", beforeInput);
        return () => {
            window.removeEventListener("keydown", key);
            document.removeEventListener("beforeinput", beforeInput);
        };
    }, [enabled]);
    const groupInput = (event: SyntheticEvent) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        if (
            !documentInput(target) ||
            !(
                target instanceof HTMLInputElement ||
                target instanceof HTMLTextAreaElement
            )
        )
            return;
        if (
            target instanceof HTMLInputElement &&
            ["checkbox", "radio", "file", "button"].includes(target.type)
        )
            return;
        if (!groups.current.has(target))
            groups.current.set(target, `field-${++nextGroup.current}`);
        useEditorStore.getState().setEditGroup(groups.current.get(target)!);
    };
    return {
        onFocusCapture: groupInput,
        onInputCapture: groupInput,
        onBlurCapture: () => useEditorStore.getState().setEditGroup(null),
    };
}
