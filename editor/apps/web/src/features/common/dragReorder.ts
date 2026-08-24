import {
    useEffect,
    useRef,
    useState,
    type DragEvent,
    type KeyboardEvent,
    type PointerEvent,
} from "react";

/**
 * Drag-to-reorder for vertical lists.
 *
 * A dedicated handle, not a draggable row: rows are full of inputs, and a row that starts dragging
 * mid-text-selection is worse than no dragging at all. `dragstart` reports the draggable element —
 * the row — as its target regardless of where the pointer went down, so "did this drag begin on
 * the handle" is tracked from the handle's own pointerdown instead of inspected on the event.
 * The handle also carries the keyboard path — arrow keys move the focused row — so the mouse
 * gesture never becomes the only way to reorder.
 */
export interface DragReorder {
    /** Spread onto each list item. */
    itemProps(index: number): {
        draggable: boolean;
        onDragStart: (event: DragEvent) => void;
        onDragOver: (event: DragEvent) => void;
        onDrop: (event: DragEvent) => void;
        onDragEnd: () => void;
        "data-drag-over": boolean;
        "data-dragging": boolean;
    };
    /** Spread onto the handle inside each item. */
    handleProps(index: number): {
        className: string;
        role: "button";
        tabIndex: number;
        "aria-label": string;
        onPointerDown: (event: PointerEvent) => void;
        onKeyDown: (event: KeyboardEvent) => void;
    };
}

export function useDragReorder(
    count: number,
    onMove: (from: number, to: number) => void,
    handleLabel: string,
): DragReorder {
    /** Index whose handle is currently held down; only that row may begin a drag. */
    const armed = useRef<number | null>(null);
    const dragFrom = useRef<number | null>(null);
    const [overIndex, setOverIndex] = useState<number | null>(null);
    const [dragging, setDragging] = useState<number | null>(null);

    useEffect(() => {
        // Releasing the pointer disarms; by then a real drag has already fired its dragstart.
        const disarm = () => {
            armed.current = null;
        };
        window.addEventListener("pointerup", disarm);
        return () => window.removeEventListener("pointerup", disarm);
    }, []);

    return {
        itemProps: (index) => ({
            draggable: true,
            onDragStart: (event) => {
                if (armed.current !== index) {
                    event.preventDefault();
                    return;
                }
                dragFrom.current = index;
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", String(index));
                // Deferred: a synchronous re-render inside dragstart replaces the dragged element
                // and Chromium silently cancels the whole drag.
                requestAnimationFrame(() => setDragging(index));
            },
            onDragOver: (event) => {
                if (dragFrom.current === null) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                if (overIndex !== index) setOverIndex(index);
            },
            onDrop: (event) => {
                event.preventDefault();
                const from = dragFrom.current;
                dragFrom.current = null;
                setOverIndex(null);
                setDragging(null);
                if (from !== null && from !== index) onMove(from, index);
            },
            onDragEnd: () => {
                dragFrom.current = null;
                setOverIndex(null);
                setDragging(null);
            },
            "data-drag-over": overIndex === index && dragging !== index,
            "data-dragging": dragging === index,
        }),
        handleProps: (index) => ({
            className: "drag-handle",
            role: "button",
            tabIndex: 0,
            "aria-label": handleLabel,
            onPointerDown: () => {
                armed.current = index;
            },
            onKeyDown: (event) => {
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
