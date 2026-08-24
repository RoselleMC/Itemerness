import { useEffect, useRef } from "react";
import { resolveItemIcon } from "@itemerness/mc-assets";
import { packStackOf, useEditorStore } from "../../state/store.js";

/**
 * A 16x16 item sprite, scaled with nearest-neighbour.
 *
 * Recognition beats reading: an item list where every row starts with the item's actual texture is
 * scannable in a way a column of namespaced ids never is. Without mounted assets, or for 3D block
 * models this preview refuses to fake, the fallback is a letter tile — visibly a placeholder, not
 * a wrong texture.
 */
export function ItemIcon({
    materialId,
    label,
    size = 24,
}: {
    materialId: string;
    label: string;
    size?: number;
}) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const packs = useEditorStore((state) => state.packs);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const scale = Math.max(1, Math.floor(size / 16));
        canvas.width = 16 * scale;
        canvas.height = 16 * scale;
        const context = canvas.getContext("2d");
        if (!context) return;
        context.imageSmoothingEnabled = false;
        context.clearRect(0, 0, canvas.width, canvas.height);

        const icon =
            packs.length > 0
                ? resolveItemIcon(packStackOf(packs), materialId)
                : null;
        if (icon?.kind === "flat") {
            for (const layer of icon.layers) {
                const image = new ImageData(
                    new Uint8ClampedArray(layer.data),
                    layer.width,
                    layer.height,
                );
                const offscreen = document.createElement("canvas");
                offscreen.width = layer.width;
                offscreen.height = layer.height;
                offscreen.getContext("2d")?.putImageData(image, 0, 0);
                context.drawImage(offscreen, 0, 0, canvas.width, canvas.height);
            }
            return;
        }

        // Letter tile fallback: obviously a stand-in, deterministic colour per material.
        let hash = 0;
        for (const character of materialId)
            hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
        context.fillStyle = `hsl(${hash % 360} 32% 30%)`;
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.fillStyle = "rgb(230 232 240 / 0.85)";
        context.font = `${9 * scale}px ui-sans-serif, system-ui`;
        context.textAlign = "center";
        context.textBaseline = "middle";
        context.fillText(
            label.charAt(0).toUpperCase(),
            canvas.width / 2,
            canvas.height / 2 + scale,
        );
    }, [materialId, label, size, packs]);

    return (
        <canvas
            ref={canvasRef}
            className="item-icon"
            style={{ width: size, height: size }}
            aria-hidden="true"
        />
    );
}
