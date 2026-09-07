import {
    useEffect,
    useRef,
    useState,
    type PointerEvent as ReactPointerEvent,
} from "react";
import { useTranslation } from "react-i18next";
import {
    componentTop,
    type TooltipGeometry,
    type TooltipProfile,
} from "@itemerness/mc-render";
import type {
    ItemNode,
    LayoutNode,
    PresentationBlock,
    PreviewDisplay,
} from "@itemerness/protocol";
import { useEditorStore } from "../../state/store.js";
import { resolveMessage } from "../common/messages.js";
import { ContentMenu } from "./ContentMenu.js";
import { locateBlock } from "../../state/blocks.js";
import { moveBlockTree } from "../../state/blocks.js";
import { ArrowUp, ArrowDown } from "lucide-react";
import { useCanvasReorder } from "./useCanvasReorder.js";
import { describeContext } from "../../state/interface.js";
import { contentActions } from "../common/contextActions.js";

/**
 * The preview as an editing surface.
 *
 * Hovering a tooltip line shows it is interactive, a click selects the block that produced it in
 * the inspector, and a double click opens an in-place text editor right over the pixels. Canvas
 * layouts additionally expose their anchors as draggable regions — position by dragging the thing
 * itself, not by typing coordinates.
 *
 * Provenance is matched to the displayed artifact before hit testing. Unattributed synthetic
 * lines are not editable; a wrapped block shares one pair of insertion controls.
 */

interface InlineEdit {
    readonly messageKey: string;
    readonly initial: string;
    readonly top: number;
    readonly left: number;
    readonly width: number;
}

/** The message key a double-click on a block should edit, or null when it has none. */
function editableMessageKey(
    block: PresentationBlock | undefined,
): string | null {
    if (!block) return null;
    if (block.type === "description") return block.message;
    if (block.type === "field") return block.labelMessage;
    return null;
}

function findBlock(
    blocks: readonly PresentationBlock[],
    uuid: string,
): PresentationBlock | undefined {
    for (const block of blocks) {
        if (block.uuid === uuid) return block;
        if (block.type === "conditional") {
            const nested = findBlock(
                [...block.thenBlocks, ...block.otherwiseBlocks],
                uuid,
            );
            if (nested) return nested;
        }
    }
    return undefined;
}

export function CanvasOverlay({
    display,
    geometry,
    lineOrigins,
    item,
    layout,
    guiScale,
}: {
    display: PreviewDisplay;
    geometry: TooltipGeometry;
    lineOrigins: readonly (string | null)[];
    item: ItemNode;
    layout: LayoutNode | undefined;
    guiScale: number;
}) {
    const { t } = useTranslation();
    const store = useEditorStore();
    const [hovered, setHovered] = useState<number | null>(null);
    const [inlineEdit, setInlineEdit] = useState<InlineEdit | null>(null);
    const inputRef = useRef<HTMLInputElement | null>(null);
    const root = useRef<HTMLDivElement>(null);
    const reorder = useCanvasReorder(root, item.uuid);
    const inlineCancelled = useRef(false);

    useEffect(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
    }, [inlineEdit]);
    useEffect(() => {
        if (store.selectedBlockUuid === null) {
            inlineCancelled.current = true;
            setInlineEdit(null);
        }
    }, [store.selectedBlockUuid]);

    const scale = guiScale;
    const origin = geometry.contentOriginPixels;
    const lineHeight = geometry.profile.lineHeightPixels;

    /** Geometry of tooltip component `componentIndex` (0 = name) in CSS pixels. */
    const lineBox = (componentIndex: number) => ({
        top:
            (origin.y + componentTop(componentIndex, geometry.profile)) * scale,
        left: origin.x * scale,
        width: Math.max(1, geometry.contentWidthPixels) * scale,
        height: lineHeight * scale,
    });

    const originAt = (loreIndex: number): string | null =>
        lineOrigins[loreIndex] ?? null;

    const beginInlineEdit = (componentIndex: number, messageKey: string) => {
        inlineCancelled.current = false;
        const resolved = resolveMessage(
            store.document,
            store.viewerLocale,
            messageKey,
        );
        const box = lineBox(componentIndex);
        setInlineEdit({
            messageKey,
            initial: resolved.source === "missing" ? "" : resolved.text,
            top: box.top - 2,
            left: box.left - 2,
            width: Math.max(box.width + 4, 160),
        });
    };

    const commitInlineEdit = (value: string | null) => {
        if (inlineEdit && value !== null && !inlineCancelled.current)
            store.setMessage(store.viewerLocale, inlineEdit.messageKey, value);
        setInlineEdit(null);
    };
    useEffect(() => {
        const commit = () => {
            if (inputRef.current) commitInlineEdit(inputRef.current.value);
        };
        window.addEventListener("itemerness:commit-inline", commit);
        return () =>
            window.removeEventListener("itemerness:commit-inline", commit);
    }, [inlineEdit, store.viewerLocale]);

    const components: Array<{ componentIndex: number; origin: string | null }> =
        [
            { componentIndex: 0, origin: "__name" },
            ...display.lore.map((_, index) => ({
                componentIndex: index + 1,
                origin: originAt(index),
            })),
        ];
    const isSelected = (uuid: string | null) =>
        uuid !== null &&
        (uuid === store.selectedBlockUuid ||
            locateBlock(item.presentation.blocks, uuid)?.ancestors.some(
                (ancestor) => ancestor.uuid === store.selectedBlockUuid,
            ));
    const selectedComponents = components.filter((component) =>
        isSelected(component.origin),
    );
    const first = selectedComponents[0];
    const last = selectedComponents.at(-1);
    const firstBox = first ? lineBox(first.componentIndex) : null;
    const lastBox = last ? lineBox(last.componentIndex) : null;
    const selectedLocation = store.selectedBlockUuid
        ? locateBlock(item.presentation.blocks, store.selectedBlockUuid)
        : null;
    const moveSelected = (delta: number) => {
        if (!selectedLocation) return;
        store.setEditGroup(null);
        store.updateItem(item.uuid, (current) => ({
            ...current,
            presentation: {
                ...current.presentation,
                blocks: moveBlockTree(
                    current.presentation.blocks,
                    selectedLocation.block.uuid,
                    delta,
                ),
            },
        }));
    };

    return (
        <div
            ref={root}
            className="canvas-overlay"
            data-dragging={!!reorder.dragging}
            onClickCapture={reorder.clickCapture}
            onPointerLeave={() => setHovered(null)}
        >
            {reorder.ghost}
            {components.map(({ componentIndex, origin }) => {
                if (origin === null) return null;
                const box = lineBox(componentIndex);
                const selected = !!isSelected(origin);
                const testid =
                    componentIndex === 0
                        ? "line-hit-name"
                        : `line-hit-${componentIndex - 1}`;
                return (
                    <button
                        type="button"
                        key={componentIndex}
                        className={`line-hit ${hovered === componentIndex ? "hover" : ""} ${selected ? "selected" : ""}`}
                        style={{
                            top: box.top,
                            left: box.left,
                            width: box.width,
                            height: box.height,
                        }}
                        data-tooltip={t("stage.lineTitle")}
                        data-testid={testid}
                        data-origin={origin}
                        onContextMenu={(event) => {
                            store.selectBlock(origin);
                            describeContext(event, {
                                label: t(
                                    origin === "__name"
                                        ? "inspector.name.heading"
                                        : "inspector.content.heading",
                                ),
                                items: contentActions(origin, t),
                            });
                        }}
                        aria-label={
                            componentIndex === 0
                                ? t("inspector.name.heading")
                                : display.lore[componentIndex - 1]?.runs
                                      .map((run) => run.text)
                                      .join("") ||
                                  t("inspector.content.heading")
                        }
                        aria-pressed={selected}
                        onPointerEnter={() => setHovered(componentIndex)}
                        onPointerDown={(event) =>
                            reorder.begin(
                                event,
                                store.selectedBlockUuid &&
                                    locateBlock(
                                        item.presentation.blocks,
                                        origin,
                                    )?.ancestors.some(
                                        (ancestor) =>
                                            ancestor.uuid ===
                                            store.selectedBlockUuid,
                                    )
                                    ? store.selectedBlockUuid
                                    : origin,
                            )
                        }
                        onClick={() => store.selectBlock(origin)}
                        onDoubleClick={() => {
                            const messageKey =
                                origin === "__name"
                                    ? item.presentation.nameMessage
                                    : editableMessageKey(
                                          findBlock(
                                              item.presentation.blocks,
                                              origin,
                                          ),
                                      );
                            if (messageKey)
                                beginInlineEdit(componentIndex, messageKey);
                        }}
                    />
                );
            })}

            {firstBox &&
                lastBox &&
                store.selectedBlockUuid &&
                !reorder.dragging && (
                    <>
                        {store.selectedBlockUuid !== "__name" && (
                            <div
                                className="canvas-insert"
                                style={{
                                    left: Math.max(-46, firstBox.left - 54),
                                    top: firstBox.top - 22,
                                }}
                            >
                                <ContentMenu
                                    key={`${store.selectedBlockUuid}-before`}
                                    anchorUuid={store.selectedBlockUuid}
                                    position="before"
                                />
                                <button
                                    type="button"
                                    className="icon-button"
                                    data-testid="content-move-up"
                                    disabled={
                                        !selectedLocation ||
                                        selectedLocation.index === 0
                                    }
                                    data-tooltip={t("inspector.content.moveUp")}
                                    aria-label={t("inspector.content.moveUp")}
                                    onClick={() => moveSelected(-1)}
                                >
                                    <ArrowUp size={15} />
                                </button>
                            </div>
                        )}
                        <div
                            className="canvas-insert"
                            style={{
                                left: Math.max(-46, lastBox.left - 54),
                                top: lastBox.top + lastBox.height,
                            }}
                        >
                            <ContentMenu
                                key={`${store.selectedBlockUuid}-after`}
                                anchorUuid={store.selectedBlockUuid}
                                position="after"
                            />
                            {selectedLocation && (
                                <button
                                    type="button"
                                    className="icon-button"
                                    data-testid="content-move-down"
                                    disabled={
                                        selectedLocation.index ===
                                        selectedLocation.siblings.length - 1
                                    }
                                    data-tooltip={t(
                                        "inspector.content.moveDown",
                                    )}
                                    aria-label={t("inspector.content.moveDown")}
                                    onClick={() => moveSelected(1)}
                                >
                                    <ArrowDown size={15} />
                                </button>
                            )}
                        </div>
                    </>
                )}

            {layout?.kind === "canvas" &&
            display.renderer === "BITMAP_CANVAS" ? (
                <CanvasAnchors
                    layout={layout}
                    scale={scale}
                    origin={origin}
                    profile={geometry.profile}
                />
            ) : null}

            {inlineEdit ? (
                <input
                    ref={inputRef}
                    className="inline-editor"
                    style={{
                        top: inlineEdit.top,
                        left: inlineEdit.left,
                        width: inlineEdit.width,
                        fontSize: Math.max(12, 7 * scale),
                    }}
                    defaultValue={inlineEdit.initial}
                    aria-label={t("stage.inlineEditor")}
                    data-testid="inline-editor"
                    onKeyDown={(event) => {
                        if (
                            (event.metaKey || event.ctrlKey) &&
                            event.key.toLowerCase() === "s"
                        )
                            commitInlineEdit(event.currentTarget.value);
                        if (event.key === "Enter")
                            commitInlineEdit(event.currentTarget.value);
                        if (event.key === "Escape") {
                            event.preventDefault();
                            event.stopPropagation();
                            inlineCancelled.current = true;
                            commitInlineEdit(null);
                            store.selectBlock(null);
                        }
                    }}
                    onBlur={(event) => {
                        if (!(
                            event.relatedTarget instanceof Element &&
                            event.relatedTarget.closest("[data-ui-popup]")
                        ))
                            commitInlineEdit(event.target.value);
                    }}
                />
            ) : null}
        </div>
    );
}

/**
 * Draggable anchor regions for a canvas layout.
 *
 * The composer maps an anchor's `y` to a tooltip line with `floor(y / 10)`, so vertical drags snap
 * to the ten-pixel line grid — the box lands exactly where the content will land, never between
 * lines. The right edge resizes the wrapping width.
 */
function CanvasAnchors({
    layout,
    scale,
    origin,
    profile,
}: {
    layout: Extract<LayoutNode, { kind: "canvas" }>;
    scale: number;
    origin: TooltipGeometry["contentOriginPixels"];
    profile: TooltipProfile;
}) {
    const { t } = useTranslation();
    const store = useEditorStore();
    const lineHeight = profile.lineHeightPixels;
    const dragState = useRef<{
        name: string;
        mode: "move" | "resize";
        startX: number;
        startY: number;
        origin: { x: number; y: number; width: number };
    } | null>(null);
    const cancelDrag = useRef<(() => void) | null>(null);
    useEffect(() => () => cancelDrag.current?.(), [layout.uuid]);

    const patchAnchor = (
        name: string,
        patch: Partial<{ x: number; y: number; width: number }>,
    ) =>
        store.updateLayout(layout.uuid, (current) =>
            current.kind === "canvas"
                ? {
                      ...current,
                      anchors: {
                          ...current.anchors,
                          [name]: { ...current.anchors[name]!, ...patch },
                      },
                  }
                : current,
        );

    const beginDrag = (
        event: ReactPointerEvent,
        name: string,
        mode: "move" | "resize",
    ) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        const anchor = layout.anchors[name];
        if (!anchor) return;
        cancelDrag.current?.();
        const transaction = store.beginTransaction();
        const pointer = event.pointerId;
        dragState.current = {
            name,
            mode,
            startX: event.clientX,
            startY: event.clientY,
            origin: { x: anchor.x, y: anchor.y, width: anchor.width },
        };
        const onMove = (move: globalThis.PointerEvent) => {
            const drag = dragState.current;
            if (!drag || move.pointerId !== pointer) return;
            if (
                useEditorStore.getState().historyTransactionId !== transaction
            ) {
                finish(true);
                return;
            }
            const deltaX = (move.clientX - drag.startX) / scale;
            const deltaY = (move.clientY - drag.startY) / scale;
            if (drag.mode === "move") {
                patchAnchor(drag.name, {
                    x: Math.max(0, Math.round(drag.origin.x + deltaX)),
                    y: Math.max(
                        0,
                        Math.round((drag.origin.y + deltaY) / lineHeight) *
                            lineHeight,
                    ),
                });
            } else {
                patchAnchor(drag.name, {
                    width: Math.max(20, Math.round(drag.origin.width + deltaX)),
                });
            }
        };
        const finish = (cancel: boolean) => {
            dragState.current = null;
            cancelDrag.current = null;
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
            window.removeEventListener("pointercancel", onCancel);
            window.removeEventListener("blur", onCancel);
            window.removeEventListener("keydown", onKey, true);
            if (cancel) store.cancelTransaction(transaction);
            else store.commitTransaction(transaction);
        };
        const onUp = (event: PointerEvent) => {
            if (event.pointerId === pointer) finish(false);
        };
        const onCancel = () => finish(true);
        const onKey = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                finish(true);
            }
        };
        cancelDrag.current = onCancel;
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
        window.addEventListener("pointercancel", onCancel);
        window.addEventListener("blur", onCancel);
        window.addEventListener("keydown", onKey, true);
    };

    return (
        <>
            {Object.entries(layout.anchors).map(([name, anchor]) => {
                // The name occupies component 0, so canvas line n renders as component n + 1.
                const line = Math.floor(anchor.y / lineHeight);
                const top =
                    (origin.y + componentTop(line + 1, profile)) * scale;
                return (
                    <div
                        key={name}
                        className="anchor-box"
                        style={{
                            top,
                            left: (origin.x + anchor.x) * scale,
                            width: anchor.width * scale,
                            height: Math.max(lineHeight, anchor.height) * scale,
                        }}
                        data-tooltip={t("stage.anchorTitle")}
                        data-testid={`anchor-box-${name}`}
                        onPointerDown={(event) =>
                            beginDrag(event, name, "move")
                        }
                    >
                        <span className="anchor-name">{name}</span>
                        <span
                            className="anchor-resize"
                            onPointerDown={(event) =>
                                beginDrag(event, name, "resize")
                            }
                        />
                    </div>
                );
            })}
        </>
    );
}
