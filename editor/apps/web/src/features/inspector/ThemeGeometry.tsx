import { useTranslation } from "react-i18next";
import {
    ArrowDown,
    ArrowUp,
    Copy,
    Plus,
    RotateCcw,
    Trash2,
} from "lucide-react";
import {
    supportsSegmentedFrameDecorations,
    type ProjectDocument,
    type ThemeNode,
} from "@itemerness/protocol";
import { useConnectionStore } from "../../state/connection.js";
import { SelectField } from "../common/SelectField.js";
import { BufferedInput } from "../common/BufferedInput.js";
import { ThemeNumber, ThemeToggle } from "./ThemeFields.js";
import { SOURCE_INT_MIN } from "./presentationNumbers.js";
import {
    availableCanvasGlyphs,
    createCanvasLayer,
    initializeThemeGeometry,
    switchThemeRenderer,
    type ThemeGeometryKind,
    type ThemePatch,
} from "./themeEditing.js";

type Area = NonNullable<ThemeNode["content"]>;

function WidthFields({
    area,
    maximum,
    owner,
    update,
    testPrefix = "theme",
    paddingMustFit = false,
}: {
    area: Area;
    maximum: number;
    owner: string;
    update(patch: Partial<Area>): void;
    testPrefix?: string;
    paddingMustFit?: boolean;
}) {
    const { t } = useTranslation();
    return (
        <>
            <ThemeNumber
                name="minimumWidthPixels"
                value={area.minimumWidthPixels}
                minimum={1}
                maximum={Math.min(maximum, area.maximumWidthPixels)}
                owner={owner}
                testId={`${testPrefix}-minimumWidthPixels`}
                onChange={(minimumWidthPixels) =>
                    update({ minimumWidthPixels })
                }
            />
            <ThemeNumber
                name="maximumWidthPixels"
                value={area.maximumWidthPixels}
                minimum={area.minimumWidthPixels}
                maximum={maximum}
                owner={owner}
                testId={`${testPrefix}-maximumWidthPixels`}
                onChange={(maximumWidthPixels) =>
                    update({ maximumWidthPixels })
                }
            />
            <input
                type="range"
                min={1}
                max={maximum}
                value={area.maximumWidthPixels}
                aria-label={t("themeAuthoring.maximumWidthPixels")}
                data-testid={
                    testPrefix === "theme"
                        ? "max-width-slider"
                        : `${testPrefix}-max-width-slider`
                }
                onChange={(event) => {
                    const value = Number(event.target.value);
                    update({
                        maximumWidthPixels: value,
                        minimumWidthPixels: Math.min(
                            area.minimumWidthPixels,
                            value,
                        ),
                    });
                }}
            />
            {(["leftPaddingPixels", "rightPaddingPixels"] as const).map(
                (name) => (
                    <ThemeNumber
                        key={name}
                        name={name}
                        value={area[name]}
                        owner={owner}
                        testId={`${testPrefix}-${name}`}
                        onChange={(value) => update({ [name]: value })}
                    />
                ),
            )}
            {paddingMustFit &&
                area.leftPaddingPixels + area.rightPaddingPixels >=
                    area.maximumWidthPixels && (
                    <p className="error small">
                        {t("themeAuthoring.paddingExceedsWidth")}
                    </p>
                )}
        </>
    );
}

export function ThemeContent({
    theme,
    document,
    update,
}: {
    theme: ThemeNode;
    document: ProjectDocument;
    update: ThemePatch;
}) {
    const { t } = useTranslation();
    return (
        <section data-testid="theme-content-settings">
            <div className="theme-section-heading">
                <h3>{t("themeAuthoring.content")}</h3>
                {theme.content && (
                    <button
                        type="button"
                        className="icon-button danger"
                        aria-label={t("themeAuthoring.removeContentArea")}
                        data-tooltip={t("themeAuthoring.removeContentArea")}
                        onClick={() =>
                            update((value) => ({ ...value, content: null }))
                        }
                    >
                        <Trash2 size={14} />
                    </button>
                )}
            </div>
            {theme.content ? (
                <WidthFields
                    area={theme.content}
                    maximum={document.budgets.maximumWidthPixels}
                    owner={`${theme.uuid}:content`}
                    testPrefix="theme-content"
                    paddingMustFit
                    update={(patch) =>
                        update((value) => ({
                            ...value,
                            content: { ...value.content!, ...patch },
                        }))
                    }
                />
            ) : (
                <button
                    type="button"
                    className="page-command"
                    data-testid="theme-initialize-content"
                    onClick={() =>
                        update((value) =>
                            initializeThemeGeometry(value, document, "content"),
                        )
                    }
                >
                    <Plus size={15} />
                    {t("themeAuthoring.configure", {
                        kind: t("themeAuthoring.content"),
                    })}
                </button>
            )}
        </section>
    );
}

export function ThemeGeometry({
    theme,
    document,
    update,
}: {
    theme: ThemeNode;
    document: ProjectDocument;
    update: ThemePatch;
}) {
    const { t } = useTranslation();
    const decorationsSupported = useConnectionStore((state) =>
        supportsSegmentedFrameDecorations(state.info?.capabilities),
    );
    const kind: Exclude<ThemeGeometryKind, "content"> | null =
        theme.renderer === "VANILLA_CHARACTER_FRAME"
            ? "characterFrame"
            : theme.renderer === "SEGMENTED_FRAME"
              ? "segmentedFrame"
              : theme.renderer === "BITMAP_CANVAS"
                ? "canvas"
                : null;
    if (!kind) return null;
    const current = theme[kind];
    const owner = `${theme.uuid}:${kind}`;
    if (!current) {
        const possible =
            initializeThemeGeometry(theme, document, kind) !== theme;
        return (
            <section>
                <h3>{t(`themeAuthoring.${kind}`)}</h3>
                <button
                    type="button"
                    className="page-command"
                    disabled={!possible}
                    data-testid="theme-initialize-geometry"
                    onClick={() =>
                        update((value) =>
                            initializeThemeGeometry(value, document, kind),
                        )
                    }
                >
                    <Plus size={15} />
                    {t("themeAuthoring.configure", {
                        kind: t(`themeAuthoring.${kind}`),
                    })}
                </button>
                {!possible && (
                    <p className="error small">
                        {t(
                            kind === "segmentedFrame"
                                ? "themeAuthoring.missingFrameAssets"
                                : "themeAuthoring.missingSpacing",
                        )}
                    </p>
                )}
            </section>
        );
    }
    if (kind === "canvas" && theme.canvas)
        return (
            <CanvasTheme
                theme={theme}
                canvas={theme.canvas}
                document={document}
                update={update}
            />
        );
    const area = current as Area;
    return (
        <section>
            <div className="theme-section-heading">
                <h3>{t(`themeAuthoring.${kind}`)}</h3>
            </div>
            <WidthFields
                area={area}
                maximum={document.budgets.maximumWidthPixels}
                owner={owner}
                update={(patch) =>
                    update((value) => ({
                        ...value,
                        [kind]: { ...value[kind], ...patch },
                    }))
                }
            />
            {kind === "characterFrame" && theme.characterFrame && (
                <>
                    <label className="field-inline">
                        <span>{t("inspector.theme.preset")}</span>
                        <SelectField
                            label={t("inspector.theme.preset")}
                            value={theme.characterFrame.preset}
                            data-testid="frame-preset"
                            options={[
                                "UNICODE_SINGLE",
                                "UNICODE_DOUBLE",
                                "ASCII_SAFE",
                                "BRACKETED_SECTION",
                                "SEPARATOR_ONLY",
                            ].map((preset) => ({
                                value: preset,
                                label: t(`inspector.framePresets.${preset}`),
                            }))}
                            onValueChange={(preset) =>
                                update((value) => ({
                                    ...value,
                                    characterFrame: {
                                        ...value.characterFrame!,
                                        preset: preset as NonNullable<
                                            ThemeNode["characterFrame"]
                                        >["preset"],
                                    },
                                }))
                            }
                        />
                    </label>
                    <ThemeNumber
                        name="alignmentTolerancePixels"
                        value={theme.characterFrame.alignmentTolerancePixels}
                        maximum={8}
                        owner={owner}
                        onChange={(alignmentTolerancePixels) =>
                            update((value) => ({
                                ...value,
                                characterFrame: {
                                    ...value.characterFrame!,
                                    alignmentTolerancePixels,
                                },
                            }))
                        }
                    />
                    <ThemeNumber
                        name="maximumLines"
                        value={theme.characterFrame.maximumLines}
                        minimum={1}
                        maximum={document.budgets.maximumLines}
                        owner={owner}
                        onChange={(maximumLines) =>
                            update((value) => ({
                                ...value,
                                characterFrame: {
                                    ...value.characterFrame!,
                                    maximumLines,
                                },
                            }))
                        }
                    />
                    {!theme.characterFrame.fallbackBidirectionalText && (
                        <div className="error small">
                            <p>
                                {t("themeAuthoring.unsupportedBidirectional")}
                            </p>
                            <button
                                type="button"
                                className="page-command"
                                onClick={() =>
                                    update((value) =>
                                        switchThemeRenderer(
                                            value,
                                            value.renderer,
                                        ),
                                    )
                                }
                            >
                                <RotateCcw size={14} />
                                {t(
                                    "themeAuthoring.restoreBidirectionalFallback",
                                )}
                            </button>
                        </div>
                    )}
                </>
            )}
            {kind === "segmentedFrame" && theme.segmentedFrame && (
                <>
                    <ThemeToggle
                        name="includeName"
                        checked={theme.segmentedFrame.includeName ?? false}
                        disabled={!decorationsSupported}
                        onChange={(includeName) =>
                            update((value) => ({
                                ...value,
                                segmentedFrame: {
                                    ...value.segmentedFrame!,
                                    includeName,
                                },
                            }))
                        }
                    />
                    {!decorationsSupported && (
                        <p
                            className="muted small"
                            data-testid="theme-decorations-unsupported"
                        >
                            {t("themeAuthoring.decorationsUnsupported")}
                        </p>
                    )}
                    {!document.spacing && (
                        <p className="error small">
                            {t("themeAuthoring.missingSpacing")}
                        </p>
                    )}
                    <ThemeToggle
                        name="connector"
                        checked={theme.segmentedFrame.connector !== null}
                        onChange={(enabled) =>
                            update((value) => ({
                                ...value,
                                segmentedFrame: {
                                    ...value.segmentedFrame!,
                                    connector: enabled
                                        ? { ...value.segmentedFrame!.body }
                                        : null,
                                },
                            }))
                        }
                    />
                    {(["top", "body", "connector", "bottom"] as const).map(
                        (row) => {
                            const frameRow = theme.segmentedFrame![row];
                            if (!frameRow) return null;
                            return (
                                <fieldset className="theme-frame-row" key={row}>
                                    <legend>
                                        {t(`themeAuthoring.frameRow.${row}`)}
                                    </legend>
                                    {(
                                        [
                                            "left",
                                            "fill",
                                            "right",
                                            "center",
                                            "kern",
                                        ] as const
                                    ).map((part) => (
                                        <label
                                            className="field-inline"
                                            key={part}
                                        >
                                            <span>
                                                {t(
                                                    `themeAuthoring.framePart.${part}`,
                                                )}
                                            </span>
                                            <SelectField
                                                label={`${t(`themeAuthoring.frameRow.${row}`)}: ${t(`themeAuthoring.framePart.${part}`)}`}
                                                value={frameRow[part] ?? ""}
                                                data-testid={`theme-frame-${row}-${part}`}
                                                disabled={
                                                    (part === "center" ||
                                                        part === "kern") &&
                                                    !decorationsSupported
                                                }
                                                options={[
                                                    ...(part === "center" ||
                                                    part === "kern"
                                                        ? [
                                                              {
                                                                  value: "",
                                                                  label: t(
                                                                      "themeAuthoring.noFramePart",
                                                                  ),
                                                              },
                                                          ]
                                                        : []),
                                                    ...document.glyphs.map(
                                                        (glyph) => ({
                                                            value: glyph.id,
                                                            label: glyph.id,
                                                            group: glyph.font,
                                                        }),
                                                    ),
                                                ]}
                                                onValueChange={(glyph) =>
                                                    update((value) => ({
                                                        ...value,
                                                        segmentedFrame: {
                                                            ...value.segmentedFrame!,
                                                            [row]: {
                                                                ...value
                                                                    .segmentedFrame![
                                                                    row
                                                                ],
                                                                [part]:
                                                                    glyph ||
                                                                    null,
                                                            },
                                                        },
                                                    }))
                                                }
                                            />
                                        </label>
                                    ))}
                                </fieldset>
                            );
                        },
                    )}
                </>
            )}
        </section>
    );
}

function CanvasTheme({
    theme,
    canvas,
    document,
    update,
}: {
    theme: ThemeNode;
    canvas: NonNullable<ThemeNode["canvas"]>;
    document: ProjectDocument;
    update: ThemePatch;
}) {
    const { t } = useTranslation();
    const patch = (changes: Partial<typeof canvas>) =>
        update((current) => ({
            ...current,
            canvas: { ...current.canvas!, ...changes },
        }));
    const owner = `${theme.uuid}:canvas`;
    const glyphs = availableCanvasGlyphs(document);
    const newLayer = createCanvasLayer(document, canvas);
    const updateLayer = (
        index: number,
        changes: Partial<(typeof canvas.layers)[number]>,
    ) =>
        update((current) => ({
            ...current,
            canvas: {
                ...current.canvas!,
                layers: current.canvas!.layers.map((layer, position) =>
                    position === index ? { ...layer, ...changes } : layer,
                ),
            },
        }));
    const move = (index: number, delta: number) => {
        const layers = [...canvas.layers];
        const adjacent = layers[index + delta]!;
        const current = layers[index]!;
        layers[index] = { ...current, drawOrder: adjacent.drawOrder };
        layers[index + delta] = { ...adjacent, drawOrder: current.drawOrder };
        const [layer] = layers.splice(index, 1);
        layers.splice(index + delta, 0, layer!);
        patch({ layers });
    };
    return (
        <>
            <section>
                <h3>{t("themeAuthoring.canvas")}</h3>
                {!document.spacing && (
                    <p className="error small">
                        {t("themeAuthoring.missingSpacing")}
                    </p>
                )}
                <ThemeNumber
                    name="widthPixels"
                    value={canvas.widthPixels}
                    minimum={1}
                    maximum={Math.min(
                        canvas.maximumWidthPixels,
                        document.budgets.maximumWidthPixels,
                    )}
                    owner={owner}
                    onChange={(widthPixels) => patch({ widthPixels })}
                />
                <ThemeNumber
                    name="heightPixels"
                    value={canvas.heightPixels}
                    minimum={1}
                    maximum={Math.min(
                        canvas.maximumHeightPixels,
                        document.budgets.maximumHeightPixels,
                    )}
                    owner={owner}
                    onChange={(heightPixels) => patch({ heightPixels })}
                />
                <ThemeNumber
                    name="maximumWidthPixels"
                    value={canvas.maximumWidthPixels}
                    minimum={canvas.widthPixels}
                    maximum={document.budgets.maximumWidthPixels}
                    owner={owner}
                    onChange={(maximumWidthPixels) =>
                        patch({ maximumWidthPixels })
                    }
                />
                <ThemeNumber
                    name="maximumHeightPixels"
                    value={canvas.maximumHeightPixels}
                    minimum={canvas.heightPixels}
                    maximum={document.budgets.maximumHeightPixels}
                    owner={owner}
                    onChange={(maximumHeightPixels) =>
                        patch({ maximumHeightPixels })
                    }
                />
                <ThemeNumber
                    name="reserveTooltipLines"
                    value={canvas.reserveTooltipLines}
                    minimum={1}
                    maximum={document.budgets.maximumLines}
                    owner={owner}
                    onChange={(reserveTooltipLines) =>
                        patch({ reserveTooltipLines })
                    }
                />
                {(
                    [
                        "measuredAdvancePixels",
                        "finalTooltipWidthPixels",
                    ] as const
                ).map((name) => (
                    <ThemeNumber
                        key={name}
                        name={name}
                        value={canvas[name]}
                        minimum={1}
                        maximum={Math.min(
                            canvas.maximumWidthPixels,
                            document.budgets.maximumWidthPixels,
                        )}
                        owner={owner}
                        onChange={(value) =>
                            patch({
                                measuredAdvancePixels: value,
                                finalTooltipWidthPixels: value,
                            })
                        }
                    />
                ))}
                {canvas.measuredAdvancePixels !==
                    canvas.finalTooltipWidthPixels && (
                    <p className="error small">
                        {t("themeAuthoring.advanceMismatch")}
                    </p>
                )}
                <ThemeNumber
                    name="maximumEmittedComponents"
                    value={canvas.maximumEmittedComponents}
                    minimum={1}
                    maximum={Math.min(4096, document.budgets.maximumRuns)}
                    owner={owner}
                    onChange={(maximumEmittedComponents) =>
                        patch({ maximumEmittedComponents })
                    }
                />
                {(
                    [
                        "rejectNegativeFinalAdvance",
                        "rejectOutOfBoundsLayer",
                        "normalizeVisualOrigin",
                    ] as const
                ).map((name) => (
                    <ThemeToggle
                        key={name}
                        name={name}
                        checked={canvas[name]}
                        onChange={(value) => patch({ [name]: value })}
                    />
                ))}
            </section>
            <section>
                <div className="theme-section-heading">
                    <h3>{t("themeAuthoring.layers")}</h3>
                    <button
                        type="button"
                        className="icon-button"
                        disabled={!newLayer}
                        aria-label={t("themeAuthoring.addLayer")}
                        data-tooltip={t("themeAuthoring.addLayer")}
                        data-testid="theme-add-layer"
                        onClick={() => {
                            if (newLayer)
                                patch({ layers: [...canvas.layers, newLayer] });
                        }}
                    >
                        <Plus size={15} />
                    </button>
                </div>
                {!glyphs.length && (
                    <p className="error small">
                        {t("themeAuthoring.missingBitmapGlyphs")}
                    </p>
                )}
                {canvas.layers.map((layer, index) => (
                    <fieldset className="theme-canvas-layer" key={index}>
                        <legend>
                            {t("themeAuthoring.layerNumber", {
                                index: index + 1,
                            })}
                        </legend>
                        <div className="theme-layer-actions">
                            <button
                                type="button"
                                className="icon-button"
                                disabled={index === 0}
                                aria-label={t("themeAuthoring.moveLayerUp")}
                                data-tooltip={t("themeAuthoring.moveLayerUp")}
                                onClick={() => move(index, -1)}
                            >
                                <ArrowUp size={14} />
                            </button>
                            <button
                                type="button"
                                className="icon-button"
                                disabled={index === canvas.layers.length - 1}
                                aria-label={t("themeAuthoring.moveLayerDown")}
                                data-tooltip={t("themeAuthoring.moveLayerDown")}
                                onClick={() => move(index, 1)}
                            >
                                <ArrowDown size={14} />
                            </button>
                            <button
                                type="button"
                                className="icon-button"
                                disabled={
                                    canvas.layers.length >=
                                    document.budgets.maximumCanvasLayers
                                }
                                aria-label={t("themeAuthoring.duplicateLayer")}
                                data-tooltip={t(
                                    "themeAuthoring.duplicateLayer",
                                )}
                                onClick={() =>
                                    patch({
                                        layers: [
                                            ...canvas.layers.slice(
                                                0,
                                                index + 1,
                                            ),
                                            {
                                                ...layer,
                                                drawOrder: Math.min(
                                                    1024,
                                                    layer.drawOrder + 1,
                                                ),
                                            },
                                            ...canvas.layers.slice(index + 1),
                                        ],
                                    })
                                }
                            >
                                <Copy size={14} />
                            </button>
                            <button
                                type="button"
                                className="icon-button danger"
                                aria-label={t("themeAuthoring.removeLayer")}
                                data-tooltip={t("themeAuthoring.removeLayer")}
                                data-testid={`theme-remove-layer-${index}`}
                                onClick={() =>
                                    patch({
                                        layers: canvas.layers.filter(
                                            (_, position) => position !== index,
                                        ),
                                    })
                                }
                            >
                                <Trash2 size={14} />
                            </button>
                        </div>
                        <label className="field-inline">
                            <span>{t("themeAuthoring.asset")}</span>
                            <SelectField
                                label={t("themeAuthoring.asset")}
                                value={layer.asset}
                                data-testid={`theme-layer-${index}-asset`}
                                options={glyphs.map((glyph) => ({
                                    value: glyph.id,
                                    label: glyph.id,
                                }))}
                                onValueChange={(asset) => {
                                    const glyph = glyphs.find(
                                        (entry) => entry.id === asset,
                                    )!;
                                    const bitmap = document.bitmaps.find(
                                        (entry) => entry.id === glyph.bitmap,
                                    )!;
                                    updateLayer(index, {
                                        asset,
                                        baselineVariant:
                                            bitmap.baselineVariant!,
                                    });
                                }}
                            />
                        </label>
                        <label className="field-inline">
                            <span>{t("themeAuthoring.anchor")}</span>
                            <SelectField
                                label={t("themeAuthoring.anchor")}
                                value={layer.anchor}
                                data-testid={`theme-layer-${index}-anchor`}
                                options={["TOP_LEFT", "TOP_RIGHT"].map(
                                    (anchor) => ({
                                        value: anchor,
                                        label: t(`themeAuthoring.${anchor}`),
                                    }),
                                )}
                                onValueChange={(anchor) =>
                                    updateLayer(index, {
                                        anchor: anchor as typeof layer.anchor,
                                    })
                                }
                            />
                        </label>
                        <ThemeNumber
                            name="xPixels"
                            value={layer.xPixels}
                            minimum={SOURCE_INT_MIN}
                            owner={`${owner}:${index}`}
                            testId={`theme-layer-${index}-xPixels`}
                            onChange={(xPixels) =>
                                updateLayer(index, { xPixels })
                            }
                        />
                        <ThemeNumber
                            name="baselineLine"
                            value={layer.baselineLine}
                            maximum={Math.max(
                                0,
                                canvas.reserveTooltipLines - 1,
                            )}
                            owner={`${owner}:${index}`}
                            testId={`theme-layer-${index}-baselineLine`}
                            onChange={(baselineLine) =>
                                updateLayer(index, { baselineLine })
                            }
                        />
                        <label className="field-inline">
                            <span>{t("themeAuthoring.baselineVariant")}</span>
                            <BufferedInput
                                label={t("themeAuthoring.baselineVariant")}
                                owner={`${owner}:${index}:baselineVariant`}
                                value={layer.baselineVariant}
                                testId={`theme-layer-${index}-baselineVariant`}
                                validate={() => null}
                                onCommit={(baselineVariant) =>
                                    updateLayer(index, { baselineVariant })
                                }
                            />
                        </label>
                        <ThemeNumber
                            name="drawOrder"
                            value={layer.drawOrder}
                            minimum={SOURCE_INT_MIN}
                            owner={`${owner}:${index}`}
                            testId={`theme-layer-${index}-drawOrder`}
                            onChange={(drawOrder) =>
                                updateLayer(index, { drawOrder })
                            }
                        />
                    </fieldset>
                ))}
            </section>
        </>
    );
}
