import {
    useEffect,
    useRef,
    useState,
    type PointerEvent as ReactPointerEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { componentTop, type TooltipGeometry } from "@itemerness/mc-render";
import type {
    ItemNode,
    LayoutNode,
    PresentationBlock,
    PreviewDisplay,
} from "@itemerness/protocol";
import { useEditorStore } from "../../state/store.js";
import { resolveMessage } from "../common/messages.js";

/**
 * The preview as an editing surface.
 *
 * Hovering a tooltip line shows it is interactive, a click selects the block that produced it in
 * the inspector, and a double click opens an in-place text editor right over the pixels. Canvas
 * layouts additionally expose their anchors as draggable regions — position by dragging the thing
 * itself, not by typing coordinates.
 *
 * Line-to-block attribution comes from the local composer's provenance. When the displayed
 * geometry is a server artifact the mapping is aligned by index and clamped; around synthetic
 * spacer lines it can be off by one, which mislabels a click's target but never corrupts an edit —
 * every write still goes through the block uuid it resolved to.
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

    useEffect(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
    }, [inlineEdit]);

    const scale = guiScale;
    const profile = geometry.profile;
    const contentOrigin = profile.paddingPixels + profile.spriteOutsetPixels;
    const lineHeight = profile.lineHeightPixels;

    /** Geometry of tooltip component `componentIndex` (0 = name) in CSS pixels. */
    const lineBox = (componentIndex: number) => ({
        top: (contentOrigin + componentTop(componentIndex, profile)) * scale,
        left: contentOrigin * scale,
        width:
            (geometry.contentWidthPixels ||
                geometry.totalWidthPixels - contentOrigin * 2) * scale,
        height: lineHeight * scale,
    });

    const originAt = (loreIndex: number): string | null =>
        lineOrigins[Math.min(loreIndex, lineOrigins.length - 1)] ?? null;

    const beginInlineEdit = (componentIndex: number, messageKey: string) => {
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
        if (inlineEdit && value !== null)
            store.setMessage(store.viewerLocale, inlineEdit.messageKey, value);
        setInlineEdit(null);
    };

    const components: Array<{ componentIndex: number; origin: string | null }> =
        [
            { componentIndex: 0, origin: "__name" },
            ...display.lore.map((_, index) => ({
                componentIndex: index + 1,
                origin: originAt(index),
            })),
        ];

    return (
        <div className="canvas-overlay" onPointerLeave={() => setHovered(null)}>
            {components.map(({ componentIndex, origin }) => {
                if (origin === null) return null;
                const box = lineBox(componentIndex);
                const selected = store.selectedBlockUuid === origin;
                const testid =
                    componentIndex === 0
                        ? "line-hit-name"
                        : `line-hit-${componentIndex - 1}`;
                return (
                    <div
                        key={componentIndex}
                        className={`line-hit ${hovered === componentIndex ? "hover" : ""} ${selected ? "selected" : ""}`}
                        style={{
                            top: box.top,
                            left: box.left,
                            width: box.width,
                            height: box.height,
                        }}
                        title={t("stage.lineTitle")}
                        data-testid={testid}
                        onPointerEnter={() => setHovered(componentIndex)}
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

            {layout?.kind === "canvas" &&
            display.renderer === "BITMAP_CANVAS" ? (
                <CanvasAnchors
                    layout={layout}
                    scale={scale}
                    padding={contentOrigin}
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
                        if (event.key === "Enter")
                            commitInlineEdit(event.currentTarget.value);
                        if (event.key === "Escape") commitInlineEdit(null);
                    }}
                    onBlur={(event) => commitInlineEdit(event.target.value)}
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
    padding,
}: {
    layout: Extract<LayoutNode, { kind: "canvas" }>;
    scale: number;
    padding: number;
}) {
    const { t } = useTranslation();
    const store = useEditorStore();
    const dragState = useRef<{
        name: string;
        mode: "move" | "resize";
        startX: number;
        startY: number;
        origin: { x: number; y: number; width: number };
    } | null>(null);

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
        event.preventDefault();
        event.stopPropagation();
        const anchor = layout.anchors[name];
        if (!anchor) return;
        dragState.current = {
            name,
            mode,
            startX: event.clientX,
            startY: event.clientY,
            origin: { x: anchor.x, y: anchor.y, width: anchor.width },
        };
        const onMove = (move: globalThis.PointerEvent) => {
            const drag = dragState.current;
            if (!drag) return;
            const deltaX = (move.clientX - drag.startX) / scale;
            const deltaY = (move.clientY - drag.startY) / scale;
            if (drag.mode === "move") {
                patchAnchor(drag.name, {
                    x: Math.max(0, Math.round(drag.origin.x + deltaX)),
                    y: Math.max(
                        0,
                        Math.round((drag.origin.y + deltaY) / 10) * 10,
                    ),
                });
            } else {
                patchAnchor(drag.name, {
                    width: Math.max(20, Math.round(drag.origin.width + deltaX)),
                });
            }
        };
        const onUp = () => {
            dragState.current = null;
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
    };

    return (
        <>
            {Object.entries(layout.anchors).map(([name, anchor]) => {
                // The name occupies component 0, so canvas line n renders as component n + 1.
                const line = Math.floor(anchor.y / 10);
                const top = (padding + componentTop(line + 1)) * scale;
                return (
                    <div
                        key={name}
                        className="anchor-box"
                        style={{
                            top,
                            left: (padding + anchor.x) * scale,
                            width: anchor.width * scale,
                            height: Math.max(10, anchor.height) * scale,
                        }}
                        title={t("stage.anchorTitle")}
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
