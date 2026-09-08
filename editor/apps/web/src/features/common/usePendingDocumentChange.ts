import { useEffect, useRef } from "react";
import { commitInlineEditor } from "./inlineEdit.js";

export function usePendingDocumentChange(
    active: boolean,
    onAttempt: () => void,
) {
    const current = useRef({ active, onAttempt });
    current.current = { active, onAttempt };
    const applying = useRef(false);
    useEffect(() => {
        const finish = (event: Event) => {
            if (current.current.active && !applying.current) {
                event.preventDefault();
                current.current.onAttempt();
            }
        };
        window.addEventListener("itemerness:commit-inline", finish);
        return () =>
            window.removeEventListener("itemerness:commit-inline", finish);
    }, []);
    useEffect(() => {
        window.dispatchEvent(new Event("itemerness:inline-dirty"));
        return () =>
            queueMicrotask(() =>
                window.dispatchEvent(new Event("itemerness:inline-dirty")),
            );
    }, [active]);
    return () => {
        applying.current = true;
        try {
            return commitInlineEditor();
        } finally {
            applying.current = false;
        }
    };
}
