import {
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
    type PointerEvent as ReactPointerEvent,
    type MouseEvent as ReactMouseEvent,
} from "react";
import { useEditorStore } from "../../state/store.js";
import {
    canvasGutter,
    fitZoom,
    wheelZoom,
    smoothZoomStep,
} from "../../state/zoom.js";
import { commitInlineEditor } from "../common/inlineEdit.js";
import { usePreferences } from "../../state/preferences.js";
import { contextOwner } from "../../state/interface.js";

export function useCanvasViewport(
    sizes: readonly { width: number; height: number }[],
    active = true,
) {
    const area = useRef<HTMLDivElement>(null);
    const [viewport, setViewport] = useState({ width: 0, height: 0 });
    const gutter = canvasGutter(viewport);
    const [panMode, setPanMode] = useState(false);
    const [panning, setPanning] = useState(false);
    const targetZoom = useEditorStore((state) => state.guiScale);
    const mode = useEditorStore((state) => state.zoomMode);
    const epoch = useEditorStore((state) => state.workspaceEpoch);
    const itemId = useEditorStore((state) => state.selectedItemId);
    const panButtons = usePreferences((state) => state.canvasPanButtons);
    const [zoom, setZoom] = useState(targetZoom);
    const drawnZoom = useRef(zoom);
    const [pan, setPan] = useState({ x: 0, y: 0 });
    const panRef = useRef(pan);
    const fittedSize = useRef("");
    const anchor = useRef<{
        element: HTMLElement;
        x: number;
        y: number;
        clientX: number;
        clientY: number;
    } | null>(null);
    const drag = useRef<{
        pointer: number;
        x: number;
        y: number;
        pan: typeof pan;
        active: boolean;
        deselect: boolean;
        button: number;
    } | null>(null);
    const rightClick = useRef<{
        target: Element;
        owner: string;
        x: number;
        y: number;
    } | null>(null);
    const space = useRef(false);
    const movePan = (next: typeof pan) => {
        panRef.current = next;
        setPan(next);
    };
    const updateBackground = () => {
        const element = area.current;
        const canvas = element?.querySelector<HTMLElement>(".canvas-wrap");
        if (!element || !canvas) return;
        const viewport = element.getBoundingClientRect();
        const origin = canvas.getBoundingClientRect();
        element.style.backgroundPosition = `${origin.left - viewport.left}px ${origin.top - viewport.top}px`;
        element.style.backgroundSize = `${6 * drawnZoom.current}px ${6 * drawnZoom.current}px`;
    };
    useLayoutEffect(updateBackground);
    useEffect(() => {
        const element = area.current;
        element?.addEventListener("scroll", updateBackground, {
            passive: true,
        });
        return () => element?.removeEventListener("scroll", updateBackground);
    }, []);
    useLayoutEffect(() => {
        const element = area.current;
        if (!element) return;
        const update = () => {
            const next = {
                width: element.clientWidth,
                height: element.clientHeight,
            };
            setViewport((current) =>
                current.width === next.width && current.height === next.height
                    ? current
                    : next,
            );
        };
        update();
        const observer = new ResizeObserver(update);
        observer.observe(element);
        return () => observer.disconnect();
    }, []);
    const stopPan = (cancel = false) => {
        if (drag.current && cancel) movePan(drag.current.pan);
        const pointer = drag.current?.pointer;
        drag.current = null;
        if (pointer !== undefined && area.current?.hasPointerCapture(pointer))
            area.current.releasePointerCapture(pointer);
        setPanning(false);
    };
    useEffect(() => {
        stopPan(true);
        rightClick.current = null;
    }, [active, epoch, itemId, panButtons]);
    useEffect(() => {
        const down = (event: KeyboardEvent) => {
            if (!drag.current) rightClick.current = null;
            if (
                event.code === "Space" &&
                !(
                    event.target instanceof Element &&
                    event.target.closest(
                        'input,textarea,select,[contenteditable="true"]',
                    )
                )
            ) {
                space.current = true;
                if (
                    event.target instanceof Element &&
                    event.target.closest(".stage-canvas-area")
                )
                    event.preventDefault();
            }
            if (event.key === "Escape" && drag.current) {
                event.preventDefault();
                event.stopPropagation();
                stopPan(true);
            }
        };
        const up = (event: KeyboardEvent) => {
            if (event.code === "Space") space.current = false;
        };
        const blur = () => {
            space.current = false;
            stopPan();
        };
        window.addEventListener("keydown", down, true);
        window.addEventListener("keyup", up);
        window.addEventListener("blur", blur);
        return () => {
            window.removeEventListener("keydown", down, true);
            window.removeEventListener("keyup", up);
            window.removeEventListener("blur", blur);
        };
    }, []);
    const rememberAnchor = (
        clientX: number,
        clientY: number,
        target?: EventTarget | null,
    ) => {
        const element =
            (target instanceof Element
                ? target.closest<HTMLElement>(".canvas-wrap")
                : null) ??
            area.current?.querySelector<HTMLElement>(".canvas-wrap");
        if (!element) return;
        const rect = element.getBoundingClientRect();
        anchor.current = {
            element,
            x: (clientX - rect.left) / drawnZoom.current,
            y: (clientY - rect.top) / drawnZoom.current,
            clientX,
            clientY,
        };
    };
    useEffect(() => {
        const element = area.current;
        if (!element) return;
        const wheel = (event: WheelEvent) => {
            if (
                !event.deltaY ||
                drag.current ||
                useEditorStore.getState().historyTransactionId !== null ||
                (event.target instanceof Element &&
                    event.target.closest(
                        '[role="menu"], input, textarea, select',
                    ))
            )
                return;
            event.preventDefault();
            rememberAnchor(event.clientX, event.clientY, event.target);
            const delta =
                event.deltaY *
                (event.deltaMode === 1
                    ? 16
                    : event.deltaMode === 2
                      ? element.clientHeight
                      : 1);
            useEditorStore
                .getState()
                .setGuiScale(
                    wheelZoom(useEditorStore.getState().guiScale, delta),
                );
        };
        element.addEventListener("wheel", wheel, { passive: false });
        return () => element.removeEventListener("wheel", wheel);
    }, []);
    useLayoutEffect(() => {
        if (
            mode !== "fit" ||
            !viewport.width ||
            !viewport.height ||
            !sizes.length
        )
            return;
        anchor.current = null;
        const scale = fitZoom(viewport, sizes, gutter);
        useEditorStore.getState().setGuiScale(scale, "fit");
        movePan({ x: 0, y: 0 });
        if (area.current) {
            area.current.scrollLeft = 0;
            area.current.scrollTop = 0;
        }
        const signature = `${viewport.width}:${viewport.height}|${sizes
            .map((size) => `${size.width}:${size.height}`)
            .join("|")}`;
        if (fittedSize.current !== signature) {
            fittedSize.current = signature;
            drawnZoom.current = scale;
            setZoom(scale);
        }
    }, [
        mode,
        viewport.width,
        viewport.height,
        gutter,
        sizes.map((size) => `${size.width}:${size.height}`).join("|"),
    ]);
    useLayoutEffect(() => {
        if (targetZoom !== useEditorStore.getState().guiScale) return;
        let frame = 0;
        let previous = performance.now() - 8;
        const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
        const tick = (now: number) => {
            const goal = useEditorStore.getState().guiScale;
            const next = reduced
                ? goal
                : smoothZoomStep(drawnZoom.current, goal, now - previous);
            previous = now;
            drawnZoom.current = next;
            setZoom(next);
            if (next !== goal) frame = requestAnimationFrame(tick);
        };
        tick(performance.now());
        return () => cancelAnimationFrame(frame);
    }, [targetZoom]);
    useLayoutEffect(() => {
        const pending = anchor.current;
        if (pending?.element.isConnected) {
            const rect = pending.element.getBoundingClientRect();
            const dx = pending.clientX - rect.left - pending.x * zoom;
            const dy = pending.clientY - rect.top - pending.y * zoom;
            if (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01)
                movePan({ x: panRef.current.x + dx, y: panRef.current.y + dy });
        }
        if (zoom === targetZoom) anchor.current = null;
    }, [zoom, targetZoom]);
    const changeZoom = (value: number) => {
        const rect = area.current?.getBoundingClientRect();
        if (rect)
            rememberAnchor(
                rect.left + rect.width / 2,
                rect.top + rect.height / 2,
            );
        useEditorStore.getState().setGuiScale(value);
    };
    const startPan = (
        event: ReactPointerEvent<HTMLDivElement>,
        forced: boolean,
    ) => {
        if (
            !active ||
            event.defaultPrevented ||
            drag.current ||
            (!forced && event.button !== 0)
        )
            return;
        const target = event.target instanceof Element ? event.target : null;
        if (
            !forced &&
            target?.closest(
                ".line-hit,.canvas-insert,.anchor-box,.inline-editor,[role=menu]",
            )
        )
            return;
        event.preventDefault();
        if (forced) event.stopPropagation();
        anchor.current = null;
        const immediate = forced && event.button !== 2;
        if (immediate) useEditorStore.getState().setGuiScale(drawnZoom.current);
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = {
            pointer: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            pan: panRef.current,
            active: immediate,
            deselect: event.button === 0 && !target?.closest(".canvas-wrap"),
            button: event.button,
        };
        if (event.button === 2 && target)
            rightClick.current = {
                target,
                owner: contextOwner(),
                x: event.clientX,
                y: event.clientY,
            };
        if (immediate) setPanning(true);
    };
    return {
        area,
        viewport,
        gutter,
        zoom,
        targetZoom,
        mode,
        panMode,
        panning,
        pan,
        setPanMode,
        changeZoom,
        fit: () => {
            anchor.current = null;
            movePan({ x: 0, y: 0 });
            useEditorStore.getState().setZoomMode("fit");
            if (area.current) {
                area.current.scrollLeft = 0;
                area.current.scrollTop = 0;
            }
        },
        pointerDownCapture: (event: ReactPointerEvent<HTMLDivElement>) => {
            if (!drag.current) rightClick.current = null;
            const right =
                event.button === 2 &&
                panButtons === "middle-right" &&
                !(
                    event.target instanceof Element &&
                    event.target.closest(
                        'input,textarea,[contenteditable="true"],[role="menu"],[data-ui-popup]',
                    )
                );
            if (
                right ||
                event.button === 1 ||
                (event.button === 0 && (panMode || space.current))
            )
                startPan(event, true);
        },
        pointerDown: (event: ReactPointerEvent<HTMLDivElement>) =>
            startPan(event, false),
        pointerMove: (event: ReactPointerEvent<HTMLDivElement>) => {
            const current = drag.current;
            if (!current || current.pointer !== event.pointerId) return;
            const dx = event.clientX - current.x,
                dy = event.clientY - current.y;
            if (!current.active && Math.hypot(dx, dy) < 4) return;
            if (!current.active)
                useEditorStore.getState().setGuiScale(drawnZoom.current);
            current.active = true;
            setPanning(true);
            movePan({ x: current.pan.x + dx, y: current.pan.y + dy });
        },
        pointerEnd: (event: ReactPointerEvent<HTMLDivElement>) => {
            const current = drag.current;
            if (!current || current.pointer !== event.pointerId) return;
            if (!current.active && current.deselect && commitInlineEditor())
                useEditorStore.getState().selectBlock(null);
            const right = current.button === 2 ? rightClick.current : null;
            const showMenu =
                right && !current.active && event.type === "pointerup";
            stopPan(event.type === "pointercancel");
            // Defer right-click menus until release on every platform, including those
            // that emit contextmenu on press. Capture must not replace the clicked object.
            if (
                showMenu &&
                right.target.isConnected &&
                right.owner === contextOwner()
            ) {
                const context = new MouseEvent("contextmenu", {
                    bubbles: true,
                    cancelable: true,
                    button: 2,
                    clientX: right.x,
                    clientY: right.y,
                });
                right.target.dispatchEvent(context);
            }
        },
        contextMenuCapture: (event: ReactMouseEvent<HTMLDivElement>) => {
            if (rightClick.current && event.nativeEvent.isTrusted) {
                event.preventDefault();
                event.stopPropagation();
            }
        },
        lostPointerCapture: () => {
            if (drag.current) stopPan(true);
        },
    };
}
