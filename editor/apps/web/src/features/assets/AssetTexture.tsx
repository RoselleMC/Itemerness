import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { ScanLine } from "lucide-react";
import {
    assetPath,
    decodeImage,
    parseLocation,
    type MountedPack,
} from "@itemerness/mc-assets";
import { packStackOf, useEditorStore } from "../../state/store.js";

export function AssetTexture({
    texture,
    sprite = false,
    onDimensions,
    sourcePack,
}: {
    texture: string | null;
    sprite?: boolean;
    onDimensions?(width: number, height: number): void;
    sourcePack?: MountedPack;
}) {
    const { t } = useTranslation();
    const packs = useEditorStore((state) => state.packs);
    const canvas = useRef<HTMLCanvasElement>(null);
    const source = useMemo(() => {
        if (!texture) return { image: null, error: null };
        try {
            const path =
                assetPath(
                    parseLocation(texture),
                    sprite ? "textures/gui/sprites/" : "textures/",
                ) + (sprite ? ".png" : "");
            const bytes = sourcePack
                ? sourcePack.read(path)
                : packStackOf(packs).read(path);
            return {
                image: bytes ? decodeImage(bytes, texture) : null,
                error: null,
            };
        } catch (error) {
            return {
                image: null,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }, [packs, texture, sprite, sourcePack]);
    const image = source.image;
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
    if (!texture) return null;
    return (
        <div className="asset-texture-preview">
            {image ? (
                <>
                    <canvas
                        ref={canvas}
                        aria-label={texture}
                        data-testid="asset-texture-canvas"
                    />
                    <div className="asset-texture-caption">
                        <span className="muted small">
                            {image.width} x {image.height}
                        </span>
                        {onDimensions && (
                            <button
                                type="button"
                                className="page-command"
                                data-testid="asset-use-source-size"
                                onClick={() =>
                                    onDimensions(image.width, image.height)
                                }
                            >
                                <ScanLine size={14} />
                                {t("assetAuthoring.useSourceDimensions")}
                            </button>
                        )}
                    </div>
                </>
            ) : (
                <p
                    className={`${source.error ? "error" : "muted"} small`}
                    role={source.error ? "alert" : undefined}
                >
                    {source.error
                        ? t("assetAuthoring.textureDecodeError", {
                              message: source.error,
                          })
                        : t("assetAuthoring.textureNotMounted", { texture })}
                </p>
            )}
        </div>
    );
}
