import { useEffect, useRef } from "react";
import {
    loadSprite,
    tooltipStyleSprites,
    VANILLA_TOOLTIP_SPRITES,
    type Sprite,
} from "@itemerness/mc-assets";
import {
    renderTooltip,
    type PresentationFonts,
    type TooltipGeometry,
} from "@itemerness/mc-render";
import { renderDrawList } from "@itemerness/mc-render/canvas";
import type { PreviewDisplay } from "@itemerness/protocol";
import { packStackOf, useEditorStore } from "../../state/store.js";

/**
 * Paints one tooltip.
 *
 * The canvas is sized in device pixels and every draw is nearest-neighbour at an integer GUI
 * scale, so what appears on screen is the pixel grid the client would rasterize, magnified. It is
 * still a browser canvas: the fidelity badges next to it say so.
 */
export function TooltipCanvas({
    display,
    fonts,
    onGeometry,
}: {
    display: PreviewDisplay;
    fonts: PresentationFonts;
    onGeometry?: (geometry: TooltipGeometry, spritesAvailable: boolean) => void;
}) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const packs = useEditorStore((state) => state.packs);
    const guiScale = useEditorStore((state) => state.guiScale);
    const annotations = useEditorStore((state) => state.annotations);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const stack = packStackOf(packs);

        let background: Sprite | null = null;
        let frame: Sprite | null = null;
        if (!stack.isEmpty) {
            const names = display.tooltipStyle
                ? tooltipStyleSprites(display.tooltipStyle)
                : VANILLA_TOOLTIP_SPRITES;
            background = loadSprite(stack, names.background);
            frame = loadSprite(stack, names.frame);
        }

        const { geometry, drawList } = renderTooltip(
            display.lore.length > 0
                ? [display.displayName, ...display.lore]
                : [display.displayName],
            fonts,
            {
                backgroundSprite: background,
                frameSprite: frame,
                annotations,
            },
        );
        renderDrawList(canvas, drawList, {
            guiScale,
            showAnnotations: annotations,
            devicePixelRatio: Math.min(2, globalThis.devicePixelRatio || 1),
        });
        canvas.style.width = `${drawList.width * guiScale}px`;
        canvas.style.height = `${drawList.height * guiScale}px`;
        onGeometry?.(geometry, background !== null && frame !== null);
    }, [display, fonts, packs, guiScale, annotations, onGeometry]);

    return (
        <canvas
            ref={canvasRef}
            className="tooltip-canvas"
            data-testid="tooltip-canvas"
        />
    );
}
