import { useTranslation } from "react-i18next";
import {
    namespacedIdSchema,
    type BitmapNode,
    type GlyphNode,
    type ProjectDocument,
} from "@itemerness/protocol";
import {
    AssetBounds,
    AssetNumber,
    AssetSelect,
    AssetText,
    codePointError,
    parseCodePoint,
} from "./AssetFields.js";
import { AssetTexture } from "./AssetTexture.js";

export function GlyphForm({
    glyph,
    document,
    update,
}: {
    glyph: GlyphNode;
    document: ProjectDocument;
    update(change: (source: GlyphNode) => GlyphNode): void;
}) {
    const { t } = useTranslation();
    const bitmap = document.bitmaps.find((entry) => entry.id === glyph.bitmap);
    return (
        <>
            <section>
                <h3>{t("assetAuthoring.glyph")}</h3>
                <AssetSelect
                    name="font"
                    value={glyph.font}
                    options={document.fonts.map((entry) => ({
                        value: entry.id,
                        label: entry.id,
                        disabled: entry.metrics.startsWith("builtin:"),
                    }))}
                    onChange={(font) =>
                        update((source) => ({ ...source, font }))
                    }
                />
                <AssetText
                    name="codePoint"
                    value={`U+${glyph.codePoint.toString(16).toUpperCase().padStart(4, "0")}`}
                    owner={glyph.uuid}
                    validate={(value) =>
                        codePointError(value) ??
                        (document.glyphs.some(
                            (entry) =>
                                entry.uuid !== glyph.uuid &&
                                entry.font === glyph.font &&
                                entry.codePoint === parseCodePoint(value),
                        )
                            ? "duplicateCodePoint"
                            : null)
                    }
                    onChange={(value) =>
                        update((source) => ({
                            ...source,
                            codePoint: parseCodePoint(value),
                        }))
                    }
                />
                <AssetNumber
                    name="advancePixels"
                    value={glyph.advancePixels}
                    owner={glyph.uuid}
                    onChange={(value) =>
                        update((source) => ({
                            ...source,
                            advancePixels: value!,
                        }))
                    }
                />
                <AssetSelect
                    name="bitmap"
                    value={glyph.bitmap ?? ""}
                    options={[
                        { value: "", label: t("inspector.none") },
                        ...document.bitmaps.map((entry) => ({
                            value: entry.id,
                            label: entry.id,
                        })),
                    ]}
                    onChange={(value) =>
                        update((source) => ({
                            ...source,
                            bitmap: value || null,
                        }))
                    }
                />
            </section>
            <AssetBounds
                bounds={glyph.visualBounds}
                owner={glyph.uuid}
                maximumWidth={document.budgets.maximumWidthPixels}
                maximumHeight={document.budgets.maximumHeightPixels}
                onChange={(changes) =>
                    update((source) => ({
                        ...source,
                        visualBounds: { ...source.visualBounds, ...changes },
                    }))
                }
            />
            {bitmap && <AssetTexture texture={bitmap.texture} />}
        </>
    );
}

export function BitmapForm({
    bitmap,
    document,
    update,
}: {
    bitmap: BitmapNode;
    document: ProjectDocument;
    update(change: (source: BitmapNode) => BitmapNode): void;
}) {
    const { t } = useTranslation();
    return (
        <>
            <section>
                <h3>{t("assetAuthoring.source")}</h3>
                <AssetText
                    name="texture"
                    value={bitmap.texture ?? ""}
                    owner={bitmap.uuid}
                    validate={(value) =>
                        namespacedIdSchema.safeParse(value).success
                            ? null
                            : "namespacedId"
                    }
                    onChange={(texture) =>
                        update((source) => ({ ...source, texture }))
                    }
                />
                <div className="asset-field-grid">
                    {(["sourceWidthPixels", "sourceHeightPixels"] as const).map(
                        (name) => (
                            <AssetNumber
                                key={name}
                                name={name}
                                value={bitmap[name]}
                                owner={bitmap.uuid}
                                integer
                                minimum={1}
                                maximum={2147483647}
                                onChange={(value) =>
                                    update((source) => ({
                                        ...source,
                                        [name]: value!,
                                    }))
                                }
                            />
                        ),
                    )}
                </div>
                <AssetTexture
                    texture={bitmap.texture}
                    onDimensions={(width, height) =>
                        update((source) => ({
                            ...source,
                            sourceWidthPixels: width,
                            sourceHeightPixels: height,
                        }))
                    }
                />
            </section>
            <section>
                <h3>{t("assetAuthoring.renderGeometry")}</h3>
                <div className="asset-field-grid">
                    {(["renderWidthPixels", "renderHeightPixels"] as const).map(
                        (name) => (
                            <AssetNumber
                                key={name}
                                name={name}
                                value={bitmap[name]}
                                owner={bitmap.uuid}
                                integer
                                minimum={1}
                                maximum={
                                    name === "renderWidthPixels"
                                        ? document.budgets.maximumWidthPixels
                                        : document.budgets.maximumHeightPixels
                                }
                                onChange={(value) =>
                                    update((source) => ({
                                        ...source,
                                        [name]: value!,
                                    }))
                                }
                            />
                        ),
                    )}
                    <AssetNumber
                        name="ascentPixels"
                        value={bitmap.ascentPixels}
                        owner={bitmap.uuid}
                        integer
                        minimum={0}
                        maximum={bitmap.renderHeightPixels}
                        onChange={(value) =>
                            update((source) => ({
                                ...source,
                                ascentPixels: value!,
                            }))
                        }
                    />
                </div>
                <AssetText
                    name="baselineVariant"
                    value={bitmap.baselineVariant ?? ""}
                    owner={bitmap.uuid}
                    validate={() => null}
                    onChange={(value) =>
                        update((source) => ({
                            ...source,
                            baselineVariant: value,
                        }))
                    }
                />
            </section>
            <AssetBounds
                bounds={bitmap.visualBounds}
                owner={bitmap.uuid}
                maximumWidth={document.budgets.maximumWidthPixels}
                maximumHeight={document.budgets.maximumHeightPixels}
                absolute={false}
                onChange={(changes) =>
                    update((source) => ({
                        ...source,
                        visualBounds: { ...source.visualBounds, ...changes },
                    }))
                }
            />
        </>
    );
}
