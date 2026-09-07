import {
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
    type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { createPortal } from "react-dom";
import {
    ListTree,
    ArrowUpToLine,
    ArrowDownToLine,
    ListPlus,
    TextCursorInput,
    GitBranch,
} from "lucide-react";
import type { PresentationBlock } from "@itemerness/protocol";
import { useEditorStore } from "../../state/store.js";
import { insertContent } from "../../state/contentActions.js";
import { resolveMessage } from "../common/messages.js";
import { describeContext } from "../../state/interface.js";
import { contentActions } from "../common/contextActions.js";

export function ContentMenu({
    outlineOnly = false,
    anchorUuid,
    position = "after",
}: {
    outlineOnly?: boolean;
    anchorUuid?: string;
    position?: "before" | "after";
}) {
    const { t } = useTranslation();
    const state = useEditorStore();
    const [open, setOpen] = useState(false);
    const root = useRef<HTMLDivElement>(null);
    const trigger = useRef<HTMLButtonElement>(null);
    const popup = useRef<HTMLDivElement>(null);
    const [popupPosition, setPopupPosition] = useState({ left: 0, top: 0 });
    useLayoutEffect(() => {
        if (!open) return;
        const update = () => {
            const rect = trigger.current?.getBoundingClientRect();
            const menu = popup.current;
            if (!rect || !menu) return;
            setPopupPosition({
                left: Math.max(
                    8,
                    Math.min(
                        rect.left,
                        window.innerWidth - menu.offsetWidth - 8,
                    ),
                ),
                top: Math.max(
                    8,
                    Math.min(
                        rect.bottom + 6,
                        window.innerHeight - menu.offsetHeight - 8,
                    ),
                ),
            });
        };
        update();
        window.addEventListener("resize", update);
        window.addEventListener("scroll", update, true);
        return () => {
            window.removeEventListener("resize", update);
            window.removeEventListener("scroll", update, true);
        };
    }, [open]);
    const item = state.document.items.find(
        (entry) =>
            `${state.document.namespace}:${entry.id}` === state.selectedItemId,
    );
    const keys = state.document.dataSchemas
        .flatMap((schema) => schema.keys)
        .filter((key) => key.presentationReadable);
    const close = () => {
        setOpen(false);
        trigger.current?.focus();
    };
    useEffect(() => {
        if (!open) return;
        popup.current
            ?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')
            ?.focus();
        const dismiss = (event: PointerEvent) => {
            if (
                event.target instanceof Node &&
                !root.current?.contains(event.target) &&
                !popup.current?.contains(event.target)
            )
                setOpen(false);
        };
        document.addEventListener("pointerdown", dismiss, true);
        return () => document.removeEventListener("pointerdown", dismiss, true);
    }, [open]);
    if (!item) return null;

    const add = (kind: "field" | "description" | "conditional") => {
        if (anchorUuid)
            insertContent(
                kind,
                anchorUuid,
                position,
                t("inspector.content.newTextDefault"),
            );
        close();
    };
    const outline = (
        blocks: readonly PresentationBlock[],
        depth = 0,
    ): ReactNode =>
        blocks.map((block) => {
            const key =
                block.type === "field"
                    ? block.labelMessage
                    : block.type === "description"
                      ? block.message
                      : null;
            const label = key
                ? resolveMessage(state.document, state.viewerLocale, key).text
                : t(
                      `inspector.content.${block.type === "conditional" ? "conditional" : block.type === "repeat" ? "repeat" : block.type === "text" ? "value" : "nested"}`,
                  );
            return (
                <div key={block.uuid}>
                    <button
                        type="button"
                        role="menuitem"
                        className="content-outline-row"
                        style={{ paddingLeft: 10 + Math.min(depth, 4) * 12 }}
                        data-testid={`select-content-${block.uuid}`}
                        onContextMenu={(event) => {
                            state.selectBlock(block.uuid);
                            describeContext(event, {
                                label,
                                items: contentActions(block.uuid, t),
                                allowPopup: true,
                            });
                        }}
                        onClick={() => {
                            state.selectBlock(block.uuid);
                            close();
                        }}
                    >
                        {label}
                    </button>
                    {block.type === "conditional" && (
                        <>
                            {outline(block.thenBlocks, depth + 1)}
                            {outline(block.otherwiseBlocks, depth + 1)}
                        </>
                    )}
                </div>
            );
        });
    return (
        <div
            className="content-menu"
            ref={root}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
                if (event.key === "Escape" && open) {
                    event.preventDefault();
                    event.stopPropagation();
                    close();
                }
                if (
                    !["ArrowDown", "ArrowUp", "Home", "End"].includes(
                        event.key,
                    ) ||
                    !open
                )
                    return;
                const entries = [
                    ...popup.current!.querySelectorAll<HTMLButtonElement>(
                        '[role="menuitem"]:not(:disabled)',
                    ),
                ];
                const index = entries.indexOf(
                    document.activeElement as HTMLButtonElement,
                );
                event.preventDefault();
                entries[
                    event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? entries.length - 1
                          : (index +
                                (event.key === "ArrowDown" ? 1 : -1) +
                                entries.length) %
                            entries.length
                ]?.focus();
            }}
        >
            <button
                type="button"
                className="icon-button"
                data-testid={
                    outlineOnly ? "content-menu" : `insert-${position}`
                }
                ref={trigger}
                data-tooltip={t(
                    outlineOnly
                        ? "stage.outline"
                        : `stage.insert${position === "before" ? "Before" : "After"}`,
                )}
                aria-label={t(
                    outlineOnly
                        ? "stage.outline"
                        : `stage.insert${position === "before" ? "Before" : "After"}`,
                )}
                aria-haspopup="menu"
                aria-expanded={open}
                onClick={() => setOpen(!open)}
            >
                {outlineOnly ? (
                    <ListTree size={18} />
                ) : position === "before" ? (
                    <ArrowUpToLine size={15} />
                ) : (
                    <ArrowDownToLine size={15} />
                )}
            </button>
            {open &&
                createPortal(
                    <div
                        role="menu"
                        className="content-menu-popup ui-popup"
                        data-ui-popup
                        ref={popup}
                        style={popupPosition}
                        aria-label={t("inspector.content.heading")}
                    >
                        {!outlineOnly && (
                            <>
                                <button
                                    type="button"
                                    role="menuitem"
                                    data-testid="add-field-row"
                                    disabled={!keys.length}
                                    onClick={() => add("field")}
                                >
                                    <ListPlus size={16} />
                                    {t("inspector.content.addField")}
                                </button>
                                <button
                                    type="button"
                                    role="menuitem"
                                    data-testid="add-text-row"
                                    onClick={() => add("description")}
                                >
                                    <TextCursorInput size={16} />
                                    {t("inspector.content.addText")}
                                </button>
                                <button
                                    type="button"
                                    role="menuitem"
                                    data-testid="add-conditional-row"
                                    disabled={
                                        !state.document.viewerFacts.length
                                    }
                                    onClick={() => add("conditional")}
                                >
                                    <GitBranch size={16} />
                                    {t("inspector.content.conditional")}
                                </button>
                            </>
                        )}
                        {outlineOnly && (
                            <div className="content-outline">
                                <button
                                    type="button"
                                    role="menuitem"
                                    data-testid="select-content-name"
                                    onClick={() => {
                                        state.selectBlock("__name");
                                        close();
                                    }}
                                >
                                    {
                                        resolveMessage(
                                            state.document,
                                            state.viewerLocale,
                                            item.presentation.nameMessage,
                                        ).text
                                    }
                                </button>
                                {outline(item.presentation.blocks)}
                            </div>
                        )}
                    </div>,
                    document.body,
                )}
        </div>
    );
}
