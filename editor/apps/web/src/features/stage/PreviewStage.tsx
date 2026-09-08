import { itemKey, itemLayout } from "@itemerness/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, Hand, RotateCcw, Scan, ZoomIn } from "lucide-react";
import type { TooltipGeometry } from "@itemerness/mc-render";
import { useEditorStore } from "../../state/store.js";
import { ZOOM_PRESETS } from "../../state/zoom.js";
import { TooltipCanvas } from "../preview/TooltipCanvas.js";
import type { PreviewBundle } from "../preview/usePreview.js";
import { OptionMenu } from "../shell/OptionMenu.js";
import { CanvasOverlay } from "./CanvasOverlay.js";
import { ContentMenu } from "./ContentMenu.js";
import { useCanvasViewport } from "./useCanvasViewport.js";
import { describeContext } from "../../state/interface.js";
import { copyAction } from "../common/contextActions.js";
import { Undo2, Redo2 } from "lucide-react";
import { commitInlineEditor } from "../common/inlineEdit.js";
import { previewAccessibleText } from "./previewAccessibleText.js";
import { PreviewFooter } from "./PreviewFooter.js";

export function PreviewStage({
    preview,
    onGeometry,
    onOpenDiagnostics,
    active = true,
}: {
    preview: PreviewBundle;
    onGeometry: (geometry: TooltipGeometry, sprites: boolean) => void;
    onOpenDiagnostics(): void;
    active?: boolean;
}) {
    const { t } = useTranslation();
    const state = useEditorStore();
    const [geometry, setGeometry] = useState<TooltipGeometry | null>(null);
    const [comparisonGeometry, setComparisonGeometry] =
        useState<TooltipGeometry | null>(null);
    const [zoomOpen, setZoomOpen] = useState(false);
    const sizes = [
        geometry,
        ...(preview.comparison ? [comparisonGeometry] : []),
    ]
        .filter((value): value is TooltipGeometry => value !== null)
        .map((value) => ({
            width: value.totalWidthPixels,
            height: value.totalHeightPixels,
        }));
    const view = useCanvasViewport(sizes, active);
    const currentView = useRef(view);
    currentView.current = view;
    useEffect(() => {
        if (!active) return;
        const command = (event: Event) => {
            const view = currentView.current;
            const id = (event as CustomEvent<string>).detail;
            if (id === "zoom-fit") view.fit();
            if (id === "zoom-reset") view.changeZoom(1);
            if (id === "zoom-in") view.changeZoom(view.targetZoom * 1.2);
            if (id === "zoom-out") view.changeZoom(view.targetZoom / 1.2);
        };
        window.addEventListener("editor-canvas-command", command);
        return () =>
            window.removeEventListener("editor-canvas-command", command);
    }, [active]);
    const handleGeometry = useCallback(
        (value: TooltipGeometry, sprites: boolean) => {
            setGeometry(value);
            onGeometry(value, sprites);
        },
        [onGeometry],
    );
    const handleComparisonGeometry = useCallback(
        (value: TooltipGeometry) => setComparisonGeometry(value),
        [],
    );
    const item = state.document.items.find(
        (entry) => itemKey(state.document, entry) === preview.targetItemId,
    );
    const choices = [...new Set([...ZOOM_PRESETS, view.targetZoom])].sort(
        (a, b) => a - b,
    );
    const percent = (value: number) => `${Number((value * 100).toFixed(1))}%`;
    const width =
        sizes.reduce((sum, size) => sum + size.width * view.zoom, 0) +
        Math.max(0, sizes.length - 1) * 32;
    const height = Math.max(0, ...sizes.map((size) => size.height * view.zoom));
    return (
        <section className="stage" aria-label={t("stage.heading")}>
            <div className="canvas-toolbar">
                <div className="zoom-tools">
                    <OptionMenu
                        id="canvas-zoom"
                        label={t("stage.scale")}
                        Icon={ZoomIn}
                        value={String(view.targetZoom)}
                        options={choices.map((value) => ({
                            value: String(value),
                            label: percent(value),
                        }))}
                        open={zoomOpen}
                        onOpenChange={setZoomOpen}
                        onChange={(value) => view.changeZoom(Number(value))}
                        buttonClassName="zoom-select"
                    >
                        <span>{percent(view.targetZoom)}</span>
                        <ChevronDown size={14} />
                    </OptionMenu>
                    <button
                        type="button"
                        className="icon-button"
                        data-testid="zoom-reset"
                        data-tooltip={t("stage.resetZoom")}
                        aria-label={t("stage.resetZoom")}
                        onClick={() => view.changeZoom(1)}
                    >
                        <RotateCcw size={17} />
                    </button>
                    <button
                        type="button"
                        className="icon-button"
                        data-testid="zoom-fit"
                        data-tooltip={t("stage.fitZoom")}
                        aria-label={t("stage.fitZoom")}
                        aria-pressed={view.mode === "fit"}
                        onClick={view.fit}
                    >
                        <Scan size={17} />
                    </button>
                </div>
                <div
                    className="history-controls"
                    role="group"
                    aria-label={t("applicationMenu.history")}
                >
                    <button
                        type="button"
                        className="icon-button"
                        data-testid="undo"
                        disabled={!state.canUndo}
                        data-tooltip={t("history.undo")}
                        aria-label={t("history.undo")}
                        onClick={() => {
                            if (commitInlineEditor()) state.undo();
                        }}
                    >
                        <Undo2 size={17} />
                    </button>
                    <button
                        type="button"
                        className="icon-button"
                        data-testid="redo"
                        disabled={!state.canRedo}
                        data-tooltip={t("history.redo")}
                        aria-label={t("history.redo")}
                        onClick={() => {
                            if (commitInlineEditor()) state.redo();
                        }}
                    >
                        <Redo2 size={17} />
                    </button>
                </div>
                <div className="canvas-tools">
                    <button
                        type="button"
                        className="icon-button"
                        data-testid="canvas-pan"
                        data-tooltip={t("stage.pan")}
                        aria-label={t("stage.pan")}
                        aria-pressed={view.panMode}
                        onClick={() => view.setPanMode(!view.panMode)}
                    >
                        <Hand size={17} />
                    </button>
                    {item && state.mode === "items" && (
                        <ContentMenu outlineOnly />
                    )}
                </div>
            </div>
            <div
                className="stage-canvas-area"
                ref={view.area}
                data-testid="canvas-viewport"
                data-pan={view.panMode}
                data-panning={view.panning}
                data-zoom={view.zoom}
                data-target-zoom={view.targetZoom}
                onContextMenu={(event) =>
                    describeContext(event, {
                        label: t("stage.heading"),
                        items: [
                            {
                                id: "undo",
                                label: t("history.undo"),
                                icon: Undo2,
                                disabled: !state.canUndo,
                                run: state.undo,
                            },
                            {
                                id: "redo",
                                label: t("history.redo"),
                                icon: Redo2,
                                disabled: !state.canRedo,
                                run: state.redo,
                            },
                            {
                                id: "zoom-reset",
                                label: t("stage.resetZoom"),
                                icon: RotateCcw,
                                separator: true,
                                run: () => view.changeZoom(1),
                            },
                            {
                                id: "zoom-fit",
                                label: t("stage.fitZoom"),
                                icon: Scan,
                                run: view.fit,
                            },
                            {
                                id: "pan",
                                label: t("stage.pan"),
                                icon: Hand,
                                checked: view.panMode,
                                run: () => view.setPanMode(!view.panMode),
                            },
                            {
                                id: "deselect",
                                label: t("menus.deselect"),
                                disabled: !state.selectedBlockUuid,
                                run: () => {
                                    if (commitInlineEditor())
                                        state.selectBlock(null);
                                },
                            },
                            ...(preview.display
                                ? [
                                      copyAction(
                                          "copy-preview",
                                          t("menus.copyPreview"),
                                          [
                                              preview.display.displayName,
                                              ...preview.display.lore,
                                          ]
                                              .map((line) =>
                                                  line.runs
                                                      .filter(
                                                          (run) =>
                                                              run.kind ===
                                                              "TEXT",
                                                      )
                                                      .map((run) => run.text)
                                                      .join(""),
                                              )
                                              .filter(Boolean)
                                              .join("\n"),
                                      ),
                                  ]
                                : []),
                        ],
                    })
                }
                onPointerDownCapture={view.pointerDownCapture}
                onContextMenuCapture={view.contextMenuCapture}
                onPointerDown={view.pointerDown}
                onPointerMove={view.pointerMove}
                onPointerUp={view.pointerEnd}
                onPointerCancel={view.pointerEnd}
                onLostPointerCapture={view.lostPointerCapture}
            >
                <div
                    className="canvas-world"
                    style={{
                        width: Math.max(
                            view.viewport.width,
                            width + view.gutter * 2,
                        ),
                        height: Math.max(
                            view.viewport.height,
                            height + view.gutter * 2,
                        ),
                        padding: view.gutter,
                    }}
                >
                    {preview.display ? (
                        <div
                            className="canvas-cluster"
                            style={{
                                transform: `translate(${view.pan.x}px, ${view.pan.y}px)`,
                            }}
                        >
                            <figure>
                                <figcaption
                                    className="sr-only"
                                    data-testid="preview-name"
                                >
                                    {previewAccessibleText(
                                        preview.display.displayName,
                                    ) || t("inspector.name.heading")}
                                </figcaption>
                                <div className="canvas-wrap">
                                    <TooltipCanvas
                                        display={preview.display}
                                        fonts={preview.fonts}
                                        origin={preview.origin}
                                        viewZoom={view.zoom}
                                        onGeometry={handleGeometry}
                                    />
                                    {geometry &&
                                        item &&
                                        state.mode === "items" && (
                                            <CanvasOverlay
                                                key={item.uuid}
                                                display={preview.display}
                                                geometry={geometry}
                                                lineOrigins={
                                                    preview.lineOrigins
                                                }
                                                item={item}
                                                layout={state.document.layouts.find(
                                                    (entry) =>
                                                        entry.id ===
                                                        itemLayout(
                                                            state.document,
                                                            item,
                                                        ),
                                                )}
                                                guiScale={view.zoom}
                                                fonts={preview.fonts}
                                            />
                                        )}
                                </div>
                            </figure>
                            {preview.comparison && (
                                <figure data-testid="comparison-figure">
                                    <figcaption className="sr-only">
                                        {preview.comparison.locale}
                                    </figcaption>
                                    <div className="canvas-wrap">
                                        <TooltipCanvas
                                            display={preview.comparison.display}
                                            fonts={preview.fonts}
                                            origin="local"
                                            viewZoom={view.zoom}
                                            onGeometry={
                                                handleComparisonGeometry
                                            }
                                        />
                                    </div>
                                </figure>
                            )}
                        </div>
                    ) : (
                        <p className="muted">
                            {t(
                                state.mode === "formats" ||
                                    state.mode === "facts"
                                    ? "presentationLibrary.noPreviewItem"
                                    : "stage.noItem",
                            )}
                        </p>
                    )}
                </div>
            </div>
            <PreviewFooter
                preview={preview}
                onOpenDiagnostics={onOpenDiagnostics}
                active={active}
            />
        </section>
    );
}
