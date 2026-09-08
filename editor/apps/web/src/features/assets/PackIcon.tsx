import { useEffect, useMemo, useRef } from "react";
import { ImageOff } from "lucide-react";
import { decodeImage, type MountedPack } from "@itemerness/mc-assets";
import { useEditorStore } from "../../state/store.js";

export function PackIcon({ pack }: { pack?: MountedPack }) {
    const canvas = useRef<HTMLCanvasElement>(null);
    const vanilla = useEditorStore(
        (state) =>
            state.packs.find((slot) => slot.pack.kind === "vanilla")?.pack,
    );
    const image = useMemo(() => {
        for (const bytes of [
            pack?.read("pack.png"),
            vanilla?.read("assets/minecraft/textures/misc/unknown_pack.png"),
        ]) {
            if (!bytes || bytes.length > 2 * 1024 * 1024 || bytes.length < 24)
                continue;
            const header = new DataView(
                bytes.buffer,
                bytes.byteOffset,
                bytes.byteLength,
            );
            if (header.getUint32(16) > 1024 || header.getUint32(20) > 1024)
                continue;
            try {
                return decodeImage(bytes, "pack.png");
            } catch {
                /* Match the client's missing-icon fallback. */
            }
        }
        return null;
    }, [pack, vanilla]);
    useEffect(() => {
        if (!image || !canvas.current) return;
        canvas.current.width = image.width;
        canvas.current.height = image.height;
        canvas.current
            .getContext("2d")
            ?.putImageData(
                new ImageData(
                    new Uint8ClampedArray(image.data),
                    image.width,
                    image.height,
                ),
                0,
                0,
            );
    }, [image]);
    return (
        <div className="pack-icon" aria-hidden="true">
            {image ? (
                <canvas ref={canvas} data-testid="pack-icon-canvas" />
            ) : (
                <ImageOff size={24} />
            )}
        </div>
    );
}
