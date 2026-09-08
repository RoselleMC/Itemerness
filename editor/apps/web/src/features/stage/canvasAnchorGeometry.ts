import {
    componentTop,
    measureLine,
    type PresentationFonts,
    type TooltipGeometry,
} from "@itemerness/mc-render";
import type { ProjectDocument, ThemeNode } from "@itemerness/protocol";

export function canvasAnchorOrigin(
    document: ProjectDocument,
    theme: ThemeNode,
    fonts: PresentationFonts,
    geometry: TooltipGeometry,
): { x: number; y: number } {
    const canvas = theme.canvas;
    let visualOrigin = 0;
    if (canvas?.normalizeVisualOrigin && canvas.layers.length) {
        const tops = canvas.layers.flatMap((layer) => {
            const glyph = document.glyphs.find(
                (entry) => entry.id === layer.asset,
            );
            if (!glyph) return [];
            const measured = measureLine(
                [
                    {
                        text: String.fromCodePoint(glyph.codePoint),
                        kind: "BITMAP",
                        unbreakable: true,
                        style: {
                            color: null,
                            font: glyph.font,
                            bold: false,
                            italic: false,
                            underlined: theme.styles.frame?.underlined ?? false,
                            strikethrough:
                                theme.styles.frame?.strikethrough ?? false,
                        },
                    },
                ],
                fonts,
                { lenient: true },
            );
            return [
                layer.baselineLine * geometry.profile.lineHeightPixels +
                    measured.visualBounds.top,
            ];
        });
        if (tops.length) visualOrigin = Math.min(...tops);
    }
    // Canvas coordinates start at its normalized visual origin, not at a rounded lore row.
    return {
        x: geometry.contentOriginPixels.x,
        y:
            geometry.contentOriginPixels.y +
            componentTop(1, geometry.profile) +
            geometry.profile.textAscentPixels +
            visualOrigin,
    };
}

export function draggedCanvasAnchor(
    origin: { x: number; y: number; width: number },
    mode: "move" | "resize",
    deltaX: number,
    deltaY: number,
) {
    return mode === "move"
        ? {
              x: Math.max(0, Math.round(origin.x + deltaX)),
              y: Math.max(0, Math.round(origin.y + deltaY)),
          }
        : { width: Math.max(1, Math.round(origin.width + deltaX)) };
}
