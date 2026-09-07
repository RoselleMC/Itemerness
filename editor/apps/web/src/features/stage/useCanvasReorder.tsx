import {
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
    type PointerEvent as ReactPointerEvent,
    type RefObject,
} from "react";
import { createPortal } from "react-dom";
import type { PresentationBlock } from "@itemerness/protocol";
import { useEditorStore } from "../../state/store.js";
import { locateBlock, moveBlockTree } from "../../state/blocks.js";

interface Ghost {
    bitmap: HTMLCanvasElement;
    x: number;
    y: number;
    width: number;
    height: number;
}

export function useCanvasReorder(
    root: RefObject<HTMLDivElement | null>,
    itemUuid: string,
) {
    const [dragging, setDragging] = useState<string | null>(null);
    const [ghost, setGhost] = useState<Ghost | null>(null);
    const cleanup = useRef<((cancel: boolean) => void) | null>(null);
    const suppressClick = useRef(false);
    useEffect(() => () => cleanup.current?.(true), [itemUuid]);
    const currentItem = () =>
        useEditorStore
            .getState()
            .document.items.find((item) => item.uuid === itemUuid);
    const collectBounds = () => {
        const item = currentItem();
        const result = new Map<
            string,
            { left: number; top: number; width: number; height: number }
        >();
        if (!item || !root.current) return result;
        const ancestry = new Map<string, string[]>();
        const visit = (
            blocks: readonly PresentationBlock[],
            parents: string[] = [],
        ) => {
            for (const block of blocks) {
                const path = [block.uuid, ...parents];
                ancestry.set(block.uuid, path);
                if (block.type === "conditional") {
                    visit(block.thenBlocks, path);
                    visit(block.otherwiseBlocks, path);
                }
            }
        };
        visit(item.presentation.blocks);
        // Read each visual row once per frame, including all its conditional ancestors.
        for (const element of root.current.querySelectorAll<HTMLElement>(
            ".line-hit",
        )) {
            const rect = element.getBoundingClientRect();
            for (const uuid of ancestry.get(element.dataset.origin ?? "") ??
                []) {
                const previous = result.get(uuid);
                const left = Math.min(previous?.left ?? rect.left, rect.left);
                const top = Math.min(previous?.top ?? rect.top, rect.top);
                const right = Math.max(
                    previous ? previous.left + previous.width : rect.right,
                    rect.right,
                );
                const bottom = Math.max(
                    previous ? previous.top + previous.height : rect.bottom,
                    rect.bottom,
                );
                result.set(uuid, {
                    left,
                    top,
                    width: right - left,
                    height: bottom - top,
                });
            }
        }
        return result;
    };
    const begin = (event: ReactPointerEvent, uuid: string) => {
        if (event.button !== 0 || uuid === "__name" || event.detail > 1) return;
        const item = currentItem();
        if (!item || !locateBlock(item.presentation.blocks, uuid)) return;
        event.stopPropagation();
        event.preventDefault();
        (event.currentTarget as HTMLElement).focus({ preventScroll: true });
        cleanup.current?.(true);
        suppressClick.current = false;
        useEditorStore.getState().selectBlock(uuid);
        const pointer = event.pointerId;
        const sourceRoot = root.current!;
        const start = { x: event.clientX, y: event.clientY };
        const epoch = useEditorStore.getState().workspaceEpoch;
        const startHash = useEditorStore.getState().snapshotHash;
        let point = start,
            previousY = start.y,
            direction = 0,
            frame = 0;
        let transaction: number | null = null;
        let snapshot: Ghost | null = null;
        let offset = { x: 0, y: 0 };
        const viewport = sourceRoot.closest<HTMLElement>(".stage-canvas-area")!;
        const update = () => {
            if (
                epoch !== useEditorStore.getState().workspaceEpoch ||
                (transaction === null &&
                    startHash !== useEditorStore.getState().snapshotHash)
            ) {
                finish(true);
                return;
            }
            const boxes = collectBounds();
            if (transaction === null) {
                if (Math.hypot(point.x - start.x, point.y - start.y) < 4)
                    return;
                const box = boxes.get(uuid);
                const canvas =
                    sourceRoot.parentElement?.querySelector("canvas");
                if (!box || !canvas) return;
                const rect = canvas.getBoundingClientRect();
                const ratio = canvas.width / rect.width;
                const bitmap = document.createElement("canvas");
                bitmap.width = Math.max(1, Math.round(box.width * ratio));
                bitmap.height = Math.max(1, Math.round(box.height * ratio));
                bitmap
                    .getContext("2d")
                    ?.drawImage(
                        canvas,
                        (box.left - rect.left) * ratio,
                        (box.top - rect.top) * ratio,
                        bitmap.width,
                        bitmap.height,
                        0,
                        0,
                        bitmap.width,
                        bitmap.height,
                    );
                offset = { x: start.x - box.left, y: start.y - box.top };
                snapshot = {
                    bitmap,
                    x: box.left,
                    y: box.top,
                    width: box.width,
                    height: box.height,
                };
                transaction = useEditorStore.getState().beginTransaction();
                sourceRoot.setPointerCapture(pointer);
                setDragging(uuid);
                suppressClick.current = true;
            }
            if (
                useEditorStore.getState().historyTransactionId !== transaction
            ) {
                finish(true);
                return;
            }
            if (snapshot)
                setGhost((current) =>
                    current?.x === point.x - offset.x &&
                    current?.y === point.y - offset.y
                        ? current
                        : {
                              ...snapshot!,
                              x: point.x - offset.x,
                              y: point.y - offset.y,
                          },
                );
            const rect = viewport.getBoundingClientRect();
            if (point.x < rect.left || point.x > rect.right) return;
            if (point.y < rect.top + 36)
                viewport.scrollTop -= Math.min(
                    14,
                    (rect.top + 36 - point.y) / 3,
                );
            if (point.y > rect.bottom - 36)
                viewport.scrollTop += Math.min(
                    14,
                    (point.y - rect.bottom + 36) / 3,
                );
            const location = locateBlock(
                currentItem()?.presentation.blocks ?? [],
                uuid,
            );
            if (!location) return;
            let target = location.index;
            for (const [index, sibling] of location.siblings.entries()) {
                if (index === location.index) continue;
                const box = boxes.get(sibling.uuid);
                if (!box) continue;
                const center = box.top + box.height / 2;
                if (
                    direction > 0 &&
                    index > location.index &&
                    point.y >= center
                )
                    target = Math.max(target, index);
                if (
                    direction < 0 &&
                    index < location.index &&
                    point.y <= center
                )
                    target = Math.min(target, index);
            }
            if (target !== location.index)
                useEditorStore.getState().updateItem(itemUuid, (current) => ({
                    ...current,
                    presentation: {
                        ...current.presentation,
                        blocks: moveBlockTree(
                            current.presentation.blocks,
                            uuid,
                            target - location.index,
                        ),
                    },
                }));
        };
        const tick = () => {
            frame = 0;
            update();
            if (cleanup.current) frame = requestAnimationFrame(tick);
        };
        const move = (event: PointerEvent) => {
            if (event.pointerId !== pointer) return;
            point = { x: event.clientX, y: event.clientY };
            if (point.y !== previousY)
                direction = Math.sign(point.y - previousY);
            previousY = point.y;
            if (!frame) frame = requestAnimationFrame(tick);
        };
        const finish = (cancel: boolean) => {
            if (!cleanup.current) return;
            cleanup.current = null;
            cancelAnimationFrame(frame);
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
            window.removeEventListener("pointercancel", abort);
            window.removeEventListener("blur", abort);
            window.removeEventListener("keydown", key, true);
            if (sourceRoot.hasPointerCapture(pointer))
                sourceRoot.releasePointerCapture(pointer);
            if (transaction !== null) {
                if (cancel)
                    useEditorStore.getState().cancelTransaction(transaction);
                else useEditorStore.getState().commitTransaction(transaction);
            }
            setDragging(null);
            setGhost(null);
        };
        const up = (event: PointerEvent) => {
            if (event.pointerId === pointer) {
                update();
                finish(false);
            }
        };
        const abort = () => finish(true);
        const key = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                finish(true);
            }
        };
        cleanup.current = finish;
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
        window.addEventListener("pointercancel", abort);
        window.addEventListener("blur", abort);
        window.addEventListener("keydown", key, true);
    };
    return {
        begin,
        dragging,
        ghost: ghost
            ? createPortal(<DragGhost value={ghost} />, document.body)
            : null,
        clickCapture: (event: React.MouseEvent) => {
            if (suppressClick.current) {
                event.preventDefault();
                event.stopPropagation();
                suppressClick.current = false;
            }
        },
    };
}

function DragGhost({ value }: { value: Ghost }) {
    const canvas = useRef<HTMLCanvasElement>(null);
    useLayoutEffect(() => {
        if (!canvas.current) return;
        canvas.current.width = value.bitmap.width;
        canvas.current.height = value.bitmap.height;
        canvas.current.getContext("2d")?.drawImage(value.bitmap, 0, 0);
    }, [value.bitmap]);
    return (
        <canvas
            ref={canvas}
            className="canvas-drag-ghost"
            data-testid="canvas-drag-ghost"
            style={{
                width: value.width,
                height: value.height,
                transform: `translate3d(${value.x}px, ${value.y}px, 0)`,
            }}
        />
    );
}
