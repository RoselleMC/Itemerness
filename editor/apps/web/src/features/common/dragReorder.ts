import {
    useEffect,
    useRef,
    useState,
    type KeyboardEvent,
    type PointerEvent,
} from "react";

// Pointer events coexist with Tauri's native file drops, including on Windows.
// Only the handle starts a gesture; the rest of each row retains native text selection.
export function useDragReorder(
    count: number,
    onMove: (from: number, to: number) => void,
    handleLabel: string,
) {
    const rows = useRef(new Map<number, HTMLElement>());
    const gesture = useRef<{
        from: number;
        to: number;
        pointer: number;
        x: number;
        y: number;
        moved: boolean;
    } | null>(null);
    const move = useRef(onMove);
    move.current = onMove;
    const [dragging, setDragging] = useState<number | null>(null);
    const [over, setOver] = useState<number | null>(null);

    useEffect(() => {
        const cancel = () => {
            gesture.current = null;
            setDragging(null);
            setOver(null);
        };
        const pointerMove = (event: globalThis.PointerEvent) => {
            const current = gesture.current;
            if (!current || current.pointer !== event.pointerId) return;
            if (
                !current.moved &&
                Math.hypot(
                    event.clientX - current.x,
                    event.clientY - current.y,
                ) < 4
            )
                return;
            current.moved = true;
            event.preventDefault();
            setDragging(current.from);
            for (const [index, row] of rows.current) {
                const rect = row.getBoundingClientRect();
                if (
                    event.clientX >= rect.left &&
                    event.clientX <= rect.right &&
                    event.clientY >= rect.top &&
                    event.clientY <= rect.bottom
                ) {
                    current.to = index;
                    setOver(index);
                    break;
                }
            }
        };
        const finish = (event: globalThis.PointerEvent) => {
            const current = gesture.current;
            if (!current || current.pointer !== event.pointerId) return;
            cancel();
            if (current.moved && current.from !== current.to)
                move.current(current.from, current.to);
        };
        const escape = (event: globalThis.KeyboardEvent) => {
            if (event.key === "Escape") cancel();
        };
        window.addEventListener("pointermove", pointerMove, { passive: false });
        window.addEventListener("pointerup", finish);
        window.addEventListener("pointercancel", cancel);
        window.addEventListener("blur", cancel);
        window.addEventListener("keydown", escape);
        return () => {
            gesture.current = null;
            window.removeEventListener("pointermove", pointerMove);
            window.removeEventListener("pointerup", finish);
            window.removeEventListener("pointercancel", cancel);
            window.removeEventListener("blur", cancel);
            window.removeEventListener("keydown", escape);
        };
    }, [count]);

    return {
        itemProps: (index: number) => ({
            ref: (element: HTMLElement | null) => {
                if (element) rows.current.set(index, element);
                else rows.current.delete(index);
            },
            "data-drag-over": over === index && dragging !== index,
            "data-dragging": dragging === index,
        }),
        handleProps: (index: number) => ({
            className: "drag-handle",
            role: "button",
            tabIndex: 0,
            "aria-label": handleLabel,
            style: { touchAction: "none" },
            onPointerDown: (event: PointerEvent<HTMLElement>) => {
                if (event.button !== 0) return;
                event.preventDefault();
                event.currentTarget.focus();
                event.currentTarget.setPointerCapture(event.pointerId);
                gesture.current = {
                    from: index,
                    to: index,
                    pointer: event.pointerId,
                    x: event.clientX,
                    y: event.clientY,
                    moved: false,
                };
            },
            onKeyDown: (event: KeyboardEvent) => {
                if (event.key === "ArrowUp" && index > 0) {
                    event.preventDefault();
                    onMove(index, index - 1);
                } else if (event.key === "ArrowDown" && index < count - 1) {
                    event.preventDefault();
                    onMove(index, index + 1);
                }
            },
        }),
    };
}
