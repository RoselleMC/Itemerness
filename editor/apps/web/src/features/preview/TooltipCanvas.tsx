import { useLayoutEffect, useMemo, useRef } from "react";
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
import type { PreviewDisplay, PreviewOrigin } from "@itemerness/protocol";
import { packStackOf, useEditorStore } from "../../state/store.js";

/**
 * Paints one tooltip.
 *
 * Layout stays in logical client pixels; continuous editor view zoom only repaints the draw list.
 * Backing pixels are bounded independently of CSS zoom. This remains a browser approximation,
 * with the evidence level reported in the global inspector.
 */
export function TooltipCanvas({
    display,
    fonts,
    origin = "local",
    viewZoom,
    onGeometry,
}: {
    display: PreviewDisplay;
    fonts: PresentationFonts;
    origin?: PreviewOrigin;
    viewZoom?: number;
    onGeometry?: (geometry: TooltipGeometry, spritesAvailable: boolean) => void;
}) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const packs = useEditorStore((state) => state.packs);
    const storedScale = useEditorStore((state) => state.guiScale);
    const guiScale = viewZoom ?? storedScale;
    const annotations = useEditorStore((state) => state.annotations);

    const sprites = useMemo(() => {
        const stack = packStackOf(packs);

        let background: Sprite | null = null;
        let frame: Sprite | null = null;
        if (!stack.isEmpty) {
            const names = display.tooltipStyle
                ? tooltipStyleSprites(display.tooltipStyle)
                : VANILLA_TOOLTIP_SPRITES;
            try {
                background = loadSprite(stack, names.background);
                frame = loadSprite(stack, names.frame);
            } catch {
                /* Unreadable sprites use the explicitly approximate fallback. */
            }
        }
        return { background, frame };
    }, [packs, display.tooltipStyle]);
    const rendered = useMemo(
        () =>
            renderTooltip(
                display.lore.length > 0
                    ? [display.displayName, ...display.lore]
                    : [display.displayName],
                fonts,
                {
                    backgroundSprite: sprites.background,
                    frameSprite: sprites.frame,
                    annotations: true,
                },
            ),
        [display, fonts, sprites],
    );
    useLayoutEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const { geometry, drawList } = rendered;
        renderDrawList(canvas, drawList, {
            guiScale,
            showAnnotations: annotations,
            devicePixelRatio: Math.min(2, globalThis.devicePixelRatio || 1),
        });
        canvas.style.width = `${drawList.width * guiScale}px`;
        canvas.style.height = `${drawList.height * guiScale}px`;
        onGeometry?.(
            geometry,
            sprites.background !== null && sprites.frame !== null,
        );
    }, [rendered, sprites, guiScale, annotations, onGeometry]);

    return (
        <canvas
            ref={canvasRef}
            className="tooltip-canvas"
            data-testid="tooltip-canvas"
            data-preview-origin={origin}
            data-logical-width={rendered.geometry.totalWidthPixels}
            data-logical-height={rendered.geometry.totalHeightPixels}
            data-renderer={display.renderer}
            data-theme={display.selectedTheme}
            data-frame-runs={display.lore.reduce(
                (count, line) =>
                    count +
                    line.runs.filter((run) => run.kind === "FRAME").length,
                0,
            )}
        />
    );
}
