import { useEffect, useLayoutEffect, useRef, useState } from "react";

/** Delegated tooltips also cover controls rendered through portals without creating a root per icon. */
export function TooltipLayer() {
    const [tip, setTip] = useState<{ owner: HTMLElement; text: string } | null>(
        null,
    );
    const [position, setPosition] = useState({ left: 0, top: 0 });
    const popup = useRef<HTMLDivElement>(null);
    useEffect(() => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        let owner: HTMLElement | null = null;
        const hide = () => {
            clearTimeout(timer);
            owner = null;
            setTip(null);
        };
        const enter = (event: Event) => {
            const next =
                event.target instanceof Element
                    ? event.target.closest<HTMLElement>("[data-tooltip]")
                    : null;
            if (next === owner) return;
            hide();
            if (!next || next.closest("[inert],[hidden]")) return;
            owner = next;
            timer = setTimeout(() => {
                const text = next.dataset.tooltip;
                if (next.isConnected && text) setTip({ owner: next, text });
            }, 500);
        };
        const leave = (event: PointerEvent) => {
            if (
                owner &&
                !(
                    event.relatedTarget instanceof Node &&
                    owner.contains(event.relatedTarget)
                )
            )
                hide();
        };
        document.addEventListener("pointerover", enter);
        document.addEventListener("pointerout", leave);
        document.addEventListener("focusin", enter);
        document.addEventListener("focusout", hide);
        document.addEventListener("pointerdown", hide, true);
        document.addEventListener("wheel", hide, { passive: true });
        window.addEventListener("blur", hide);
        return () => {
            clearTimeout(timer);
            document.removeEventListener("pointerover", enter);
            document.removeEventListener("pointerout", leave);
            document.removeEventListener("focusin", enter);
            document.removeEventListener("focusout", hide);
            document.removeEventListener("pointerdown", hide, true);
            document.removeEventListener("wheel", hide);
            window.removeEventListener("blur", hide);
        };
    }, []);
    useLayoutEffect(() => {
        if (!tip || !popup.current) return;
        const anchor = tip.owner.getBoundingClientRect(),
            box = popup.current.getBoundingClientRect();
        setPosition({
            left: Math.max(
                8,
                Math.min(
                    anchor.left + anchor.width / 2 - box.width / 2,
                    innerWidth - box.width - 8,
                ),
            ),
            top:
                anchor.bottom + box.height + 8 < innerHeight
                    ? anchor.bottom + 6
                    : Math.max(8, anchor.top - box.height - 6),
        });
    }, [tip]);
    return (
        tip && (
            <div
                ref={popup}
                className="ui-tooltip"
                role="tooltip"
                style={position}
            >
                {tip.text}
            </div>
        )
    );
}
